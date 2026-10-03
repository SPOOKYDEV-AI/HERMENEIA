import test from "node:test";
import assert from "node:assert/strict";

import {
  SqlTransactionManager,
} from "../.build/packages/persistence/src/index.js";
import {
  PostgresMessagingRepository,
  PostgresSessionRepository,
  evaluateSyncCursor,
} from "../.build/packages/persistence-postgres/src/index.js";

class ScriptedConnection {
  constructor(responses = []) {
    this.responses = [...responses];
    this.queries = [];
    this.released = false;
  }

  async query(text, params = []) {
    this.queries.push({ text, params: [...params] });

    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }

    if (!this.responses.length) {
      return { rows: [], rowCount: 0 };
    }

    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  release() {
    this.released = true;
  }
}

class SingleConnectionPool {
  constructor(connection) {
    this.connection = connection;
  }

  async connect() {
    return this.connection;
  }
}

function actor() {
  return {
    tenantId: "tenant-1",
    userId: "user-1",
    deviceId: "device-1",
  };
}

test("transaction manager commits and releases on success", async () => {
  const connection = new ScriptedConnection([
    { rows: [{ value: 42 }], rowCount: 1 },
  ]);
  const manager = new SqlTransactionManager(
    new SingleConnectionPool(connection),
  );

  const result = await manager.withTransaction(async (tx) => {
    return tx.query("SELECT $1::int AS value", [42]);
  });

  assert.equal(result.rows[0].value, 42);
  assert.deepEqual(
    connection.queries.map((query) => query.text),
    ["BEGIN", "SELECT $1::int AS value", "COMMIT"],
  );
  assert.equal(connection.released, true);
});

test("transaction manager rolls back and releases on failure", async () => {
  const connection = new ScriptedConnection([
    new Error("forced failure"),
  ]);
  const manager = new SqlTransactionManager(
    new SingleConnectionPool(connection),
  );

  await assert.rejects(
    () =>
      manager.withTransaction(async (tx) => {
        await tx.query("INSERT INTO x VALUES ($1)", ["boom"]);
      }),
    /forced failure/,
  );

  assert.deepEqual(
    connection.queries.map((query) => query.text),
    ["BEGIN", "INSERT INTO x VALUES ($1)", "ROLLBACK"],
  );
  assert.equal(connection.released, true);
});

test("message sequence allocation is parameterized and membership-scoped", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        message_seq: 7,
        op_seq: 11,
        membership_epoch: 2,
        erasure_epoch: 3,
        policy_version: 4,
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const maliciousConversationId = "conv-' OR TRUE --";
  const result = await repository.withTransaction((tx) =>
    repository.allocateMessageAndOperationSequence(
      tx,
      actor(),
      maliciousConversationId,
    ),
  );

  assert.deepEqual(result, {
    messageSeq: 7,
    opSeq: 11,
    membershipEpoch: 2,
    erasureEpoch: 3,
    policyVersion: 4,
  });

  const sql = connection.queries[1];
  assert.match(sql.text, /UPDATE conversations/);
  assert.match(sql.text, /conversation_members/);
  assert.equal(sql.text.includes(maliciousConversationId), false);
  assert.deepEqual(sql.params, [
    "tenant-1",
    maliciousConversationId,
    "user-1",
  ]);
});

test("ACK purges protected payload and advances last acknowledged device offset", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        status: "PENDING",
        inbox_epoch: 4,
        offset_value: 18,
      }],
      rowCount: 1,
    },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const result = await repository.withTransaction((tx) =>
    repository.acknowledgeEnvelope(tx, {
      tenantId: "tenant-1",
      deviceId: "device-1",
      envelopeId: "envelope-1",
      ackedAt: "2026-10-03T22:30:00.000Z",
    }),
  );

  assert.equal(result, "ACKED");

  const queryTexts = connection.queries.map((query) => query.text);
  assert.match(queryTexts[2], /protected_payload/);
  assert.match(queryTexts[2], /status = 'ACKED'/);
  assert.match(queryTexts[3], /last_acked_offset = GREATEST/);
  assert.deepEqual(connection.queries[2].params, [
    "tenant-1",
    "envelope-1",
    "device-1",
    "2026-10-03T22:30:00.000Z",
  ]);
  assert.equal(queryTexts.at(-1), "COMMIT");
});

test("already ACKed envelope is idempotent and does not re-run purge updates", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        status: "ACKED",
        inbox_epoch: 1,
        offset_value: 2,
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const result = await repository.withTransaction((tx) =>
    repository.acknowledgeEnvelope(tx, {
      tenantId: "tenant-1",
      deviceId: "device-1",
      envelopeId: "envelope-1",
      ackedAt: "2026-10-03T22:30:00.000Z",
    }),
  );

  assert.equal(result, "ALREADY_ACKED");
  assert.deepEqual(
    connection.queries.map((query) => query.text),
    [
      "BEGIN",
      connection.queries[1].text,
      "COMMIT",
    ],
  );
});

test("sync cursor reset is required for wrong epoch or purged history", () => {
  assert.deepEqual(
    evaluateSyncCursor(
      { inboxEpoch: 4, lastAckedOffset: 20 },
      { inboxEpoch: 3, afterOffset: 20 },
    ),
    {
      kind: "RESET_EPOCH",
      currentEpoch: 4,
    },
  );

  assert.deepEqual(
    evaluateSyncCursor(
      { inboxEpoch: 4, lastAckedOffset: 20 },
      { inboxEpoch: 4, afterOffset: 19 },
    ),
    {
      kind: "RESET_PURGED",
      minimumRecoverableOffset: 20,
    },
  );

  assert.deepEqual(
    evaluateSyncCursor(
      { inboxEpoch: 4, lastAckedOffset: 20 },
      { inboxEpoch: 4, afterOffset: 20 },
    ),
    {
      kind: "CONTINUE",
      afterOffset: 20,
    },
  );
});

test("persistent session lookup binds to the tenant stored on the session", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        tenant_id: "tenant-b",
        user_id: "user-1",
        device_id: "device-1",
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresSessionRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const result = await repository.findActiveActorByCredentialReference(
    "credential-ref",
    "2026-10-03T22:30:00.000Z",
  );

  assert.deepEqual(result, {
    tenantId: "tenant-b",
    userId: "user-1",
    deviceId: "device-1",
  });

  const sql = connection.queries[1];
  assert.match(sql.text, /SELECT s\.tenant_id/);
  assert.match(sql.text, /tm\.tenant_id = s\.tenant_id/);
  assert.equal(sql.text.includes("ORDER BY tm.tenant_id"), false);
  assert.deepEqual(sql.params, [
    "credential-ref",
    "2026-10-03T22:30:00.000Z",
  ]);
});

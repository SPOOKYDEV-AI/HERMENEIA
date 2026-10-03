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
    "device-1",
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


test("client_message_id lookup always compares revision 1 source fingerprint", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        message_id: "message-1",
        conversation_id: "conversation-1",
        reply_to_message_id: null,
        message_seq: 8,
        accepted_at: "2026-10-03T22:00:00.000Z",
        client_authored_at: "2026-10-03 21:59:00+00",
        source_hash: "opaque-original-fingerprint",
        accepted_result: {
          protocol_version: 1,
          status: "ACCEPTED",
          message_id: "message-1",
          message_seq: 8,
          source_revision: 1,
          accepted_at: "2026-10-03T22:00:00.000Z",
          translation_status: "SOURCE_REQUIRED",
        },
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const result = await repository.withTransaction((tx) =>
    repository.findAcceptedMessageByClientId(
      tx,
      actor(),
      "client-message-1",
    ),
  );

  assert.deepEqual(result, {
    messageId: "message-1",
    conversationId: "conversation-1",
    replyToMessageId: null,
    messageSeq: 8,
    acceptedAt: "2026-10-03T22:00:00.000Z",
    clientAuthoredAt: "2026-10-03 21:59:00+00",
    originalSourceHash: "opaque-original-fingerprint",
    acceptedResult: {
      protocol_version: 1,
      status: "ACCEPTED",
      message_id: "message-1",
      message_seq: 8,
      source_revision: 1,
      accepted_at: "2026-10-03T22:00:00.000Z",
      translation_status: "SOURCE_REQUIRED",
    },
  });

  const sql = connection.queries[1];
  assert.match(sql.text, /mr\.revision = 1/);
  assert.match(sql.text, /mm\.client_authored_at::text AS client_authored_at/);
  assert.match(sql.text, /LEFT JOIN LATERAL/);
  assert.match(sql.text, /result_ref->>'message_id'/);
  assert.doesNotMatch(sql.text, /mr\.revision = mm\.current_revision/);
});

test("recipient delivery plan preserves sender secondary devices and exposes recipients with no device", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [
        {
          user_id: "user-a",
          device_id: "device-a2",
          credential_version: 2,
          public_material_ref: "pub:a2",
        },
        {
          user_id: "user-b",
          device_id: "device-b",
          credential_version: 5,
          public_material_ref: "pub:b",
        },
        {
          user_id: "user-c",
          device_id: null,
          credential_version: null,
          public_material_ref: null,
        },
      ],
      rowCount: 3,
    },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const targets = await repository.withTransaction((tx) =>
    repository.listRecipientDeliveryTargets(
      tx,
      actor(),
      "conversation-1",
    ),
  );

  assert.deepEqual(targets, [
    {
      userId: "user-a",
      devices: [{
        userId: "user-a",
        deviceId: "device-a2",
        credentialVersion: 2,
        publicMaterialRef: "pub:a2",
      }],
    },
    {
      userId: "user-b",
      devices: [{
        userId: "user-b",
        deviceId: "device-b",
        credentialVersion: 5,
        publicMaterialRef: "pub:b",
      }],
    },
    {
      userId: "user-c",
      devices: [],
    },
  ]);

  const sql = connection.queries[1];
  assert.match(sql.text, /LEFT JOIN devices/);
  assert.match(sql.text, /d\.device_id <> \$3/);
  assert.match(sql.text, /length\(d\.public_material_ref\) > 0/);
  assert.deepEqual(sql.params, [
    "tenant-1",
    "conversation-1",
    "device-1",
  ]);
});

test("command receipts persist and retrieve command fingerprint", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        actor_user_id: "user-1",
        actor_device_id: "device-1",
        command_type: "message.send",
        command_fingerprint: "fingerprint-1",
        status: "SUCCEEDED",
        result_ref: { status: "ACCEPTED" },
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const receipt = await repository.withTransaction((tx) =>
    repository.findCommandReceipt(tx, actor(), "command-1"),
  );

  assert.deepEqual(receipt, {
    actorUserId: "user-1",
    actorDeviceId: "device-1",
    commandType: "message.send",
    commandFingerprint: "fingerprint-1",
    status: "SUCCEEDED",
    result: { status: "ACCEPTED" },
  });

  const sql = connection.queries[1];
  assert.match(sql.text, /command_fingerprint/);
});


test("command claim persists IN_PROGRESS fingerprint and returns existing conflict record", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 0 },
    {
      rows: [{
        actor_user_id: "user-1",
        actor_device_id: "device-1",
        command_type: "message.send",
        command_fingerprint: "fingerprint-1",
        status: "SUCCEEDED",
        result_ref: { status: "ACCEPTED" },
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const claim = await repository.withTransaction((tx) =>
    repository.claimCommand(tx, {
      actor: actor(),
      commandId: "command-1",
      commandType: "message.send",
      commandFingerprint: "fingerprint-1",
      now: "2026-10-03T22:30:00.000Z",
    }),
  );

  assert.equal(claim.claimed, false);
  assert.equal(claim.existing.commandFingerprint, "fingerprint-1");

  const insert = connection.queries[1];
  assert.match(insert.text, /IN_PROGRESS/);
  assert.match(insert.text, /ON CONFLICT/);
  assert.deepEqual(insert.params, [
    "tenant-1",
    "command-1",
    "user-1",
    "device-1",
    "message.send",
    "fingerprint-1",
    "2026-10-03T22:30:00.000Z",
  ]);
  assert.match(connection.queries[2].text, /FOR UPDATE/);
});

test("client message advisory lock is parameterized and actor scoped", async () => {
  const connection = new ScriptedConnection([]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  await repository.withTransaction((tx) =>
    repository.lockClientMessageKey(
      tx,
      actor(),
      "client-message-1",
    ),
  );

  const query = connection.queries[1];
  assert.match(query.text, /pg_advisory_xact_lock/);
  assert.match(query.text, /hashtextextended/);
  assert.deepEqual(query.params, [
    "tenant-1:user-1:client-message-1",
  ]);
});

test("markCommandSucceeded fences by actor type fingerprint and IN_PROGRESS state", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  await repository.withTransaction((tx) =>
    repository.markCommandSucceeded(tx, {
      tenantId: "tenant-1",
      commandId: "command-1",
      actorUserId: "user-1",
      actorDeviceId: "device-1",
      commandType: "message.send",
      commandFingerprint: "fingerprint-1",
      result: { status: "ACCEPTED" },
      now: "2026-10-03T22:30:00.000Z",
    }),
  );

  const query = connection.queries[1];
  assert.match(query.text, /status = 'SUCCEEDED'/);
  assert.match(query.text, /status = 'IN_PROGRESS'/);
  assert.match(query.text, /command_fingerprint = \$6/);
  assert.equal(query.params[6], JSON.stringify({ status: "ACCEPTED" }));
});

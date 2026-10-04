import test from "node:test";
import assert from "node:assert/strict";

import {
  SqlTransactionManager,
} from "../.build/packages/persistence/src/index.js";
import {
  PostgresMessagingRepository,
  PostgresOutboxRepository,
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

test("ACK purges protected payload and advances only the contiguous terminal prefix", async () => {
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
    {
      rows: [{
        inbox_epoch: 4,
        next_offset: 20,
        last_acked_offset: 17,
      }],
      rowCount: 1,
    },
    {
      rows: [{ first_blocking_offset: null }],
      rowCount: 1,
    },
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
  assert.match(queryTexts[3], /device_sync_states/);
  assert.match(queryTexts[3], /FOR UPDATE/);
  assert.match(queryTexts[4], /MIN\(die\.offset_value\)/);
  assert.match(queryTexts[5], /last_acked_offset = GREATEST/);
  assert.deepEqual(connection.queries[2].params, [
    "tenant-1",
    "envelope-1",
    "device-1",
    "2026-10-03T22:30:00.000Z",
  ]);
  assert.deepEqual(connection.queries[5].params, [
    "tenant-1",
    "device-1",
    19,
    "2026-10-03T22:30:00.000Z",
    4,
  ]);
  assert.equal(queryTexts.at(-1), "COMMIT");
});

test("out-of-order ACK cannot skip an earlier pending inbox event", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        status: "PENDING",
        inbox_epoch: 4,
        offset_value: 19,
      }],
      rowCount: 1,
    },
    { rows: [], rowCount: 1 },
    {
      rows: [{
        inbox_epoch: 4,
        next_offset: 20,
        last_acked_offset: 17,
      }],
      rowCount: 1,
    },
    {
      rows: [{ first_blocking_offset: 18 }],
      rowCount: 1,
    },
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const result = await repository.withTransaction((tx) =>
    repository.acknowledgeEnvelope(tx, {
      tenantId: "tenant-1",
      deviceId: "device-1",
      envelopeId: "envelope-19",
      ackedAt: "2026-10-03T22:30:00.000Z",
    }),
  );

  assert.equal(result, "ACKED");
  assert.deepEqual(connection.queries[5].params, [
    "tenant-1",
    "device-1",
    17,
    "2026-10-03T22:30:00.000Z",
    4,
  ]);
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

test("inbox offset allocation creates tenant-scoped sync state", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{ inbox_epoch: 3, offset_value: 12 }],
      rowCount: 1,
    },
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const result = await repository.withTransaction((tx) =>
    repository.allocateDeviceInboxOffset(
      tx,
      "tenant-1",
      "device-1",
    ),
  );

  assert.deepEqual(result, {
    inboxEpoch: 3,
    offset: 12,
  });
  assert.match(
    connection.queries[2].text,
    /INSERT INTO tenant_device_sync_states/,
  );
  assert.deepEqual(connection.queries[2].params, [
    "tenant-1",
    "device-1",
    3,
  ]);
});

test("device sync state is authorised and isolated by tenant", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        inbox_epoch: 4,
        next_offset: 21,
        last_acked_offset: 8,
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const state = await repository.withTransaction((tx) =>
    repository.getDeviceSyncState(tx, actor()),
  );

  assert.deepEqual(state, {
    inboxEpoch: 4,
    nextOffset: 21,
    lastAckedOffset: 8,
  });

  const sql = connection.queries[1];
  assert.match(sql.text, /tenant_memberships/);
  assert.match(sql.text, /tenant_device_sync_states/);
  assert.deepEqual(sql.params, [
    "tenant-1",
    "user-1",
    "device-1",
  ]);
});

test("inbox event replay is filtered by authenticated tenant and device", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        inbox_epoch: 4,
        offset_value: 9,
        event_id: "event-9",
        event_type: "message.available",
        tenant_id: "tenant-1",
        conversation_id: "conversation-1",
        message_id: "message-1",
        envelope_id: "envelope-1",
        source_revision: 1,
        protected_payload_b64: "Y2lwaGVydGV4dA==",
        rendition_type: "ORIGINAL",
        expires_at: "2026-10-05T00:00:00.000Z",
        created_at: "2026-10-04T00:00:00.000Z",
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const rows = await repository.withTransaction((tx) =>
    repository.listInboxEvents(tx, {
      tenantId: "tenant-1",
      deviceId: "device-1",
      inboxEpoch: 4,
      afterOffset: 8,
      limit: 100,
    }),
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenantId, "tenant-1");
  const sql = connection.queries[1];
  assert.match(sql.text, /die\.tenant_id = \$1/);
  assert.match(sql.text, /die\.device_id = \$2/);
  assert.deepEqual(sql.params, [
    "tenant-1",
    "device-1",
    4,
    8,
    100,
  ]);
});

test("sync cursor separates replay position from ACK payload-purge watermark", () => {
  assert.deepEqual(
    evaluateSyncCursor(
      { inboxEpoch: 4, nextOffset: 31, lastAckedOffset: 20 },
      { inboxEpoch: 3, afterOffset: 20 },
    ),
    {
      kind: "RESET_EPOCH",
      currentEpoch: 4,
    },
  );

  assert.deepEqual(
    evaluateSyncCursor(
      { inboxEpoch: 4, nextOffset: 31, lastAckedOffset: 20 },
      { inboxEpoch: 4, afterOffset: 19 },
    ),
    {
      kind: "CONTINUE",
      afterOffset: 19,
    },
  );

  assert.deepEqual(
    evaluateSyncCursor(
      { inboxEpoch: 4, nextOffset: 31, lastAckedOffset: 20 },
      { inboxEpoch: 4, afterOffset: 20 },
    ),
    {
      kind: "CONTINUE",
      afterOffset: 20,
    },
  );

  assert.deepEqual(
    evaluateSyncCursor(
      { inboxEpoch: 4, nextOffset: 31, lastAckedOffset: 20 },
      { inboxEpoch: 4, afterOffset: 31 },
    ),
    {
      kind: "RESET_AHEAD",
      maximumIssuedOffset: 30,
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


test("message mutation lock is author device and tenant scoped", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        conversation_id: "conversation-1",
        message_seq: 7,
        current_revision: 2,
        status: "ACTIVE",
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const result = await repository.withTransaction((tx) =>
    repository.lockMessageForAuthorMutation(
      tx,
      actor(),
      "message-1",
    ),
  );

  assert.deepEqual(result, {
    conversationId: "conversation-1",
    messageSeq: 7,
    currentRevision: 2,
    status: "ACTIVE",
  });

  const query = connection.queries[1];
  assert.match(query.text, /mm\.author_user_id = \$3/);
  assert.match(query.text, /d\.device_id = \$4/);
  assert.match(query.text, /FOR UPDATE OF mm/);
  assert.deepEqual(query.params, [
    "tenant-1",
    "message-1",
    "user-1",
    "device-1",
  ]);
});

test("mutation allocates only conversation op_seq under active actor membership", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        op_seq: 12,
        membership_epoch: 5,
        erasure_epoch: 6,
        policy_version: 7,
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const opSeq = await repository.withTransaction((tx) =>
    repository.allocateOperationSequence(
      tx,
      actor(),
      "conversation-1",
    ),
  );

  assert.deepEqual(opSeq, {
    opSeq: 12,
    membershipEpoch: 5,
    erasureEpoch: 6,
    policyVersion: 7,
  });
  const query = connection.queries[1];
  assert.match(query.text, /next_op_seq = c\.next_op_seq \+ 1/);
  assert.match(query.text, /c\.membership_epoch/);
  assert.match(query.text, /c\.erasure_epoch/);
  assert.match(query.text, /c\.policy_version/);
  assert.doesNotMatch(query.text, /next_message_seq/);
  assert.match(query.text, /actor_device\.status = 'ACTIVE'/);
  assert.deepEqual(query.params, [
    "tenant-1",
    "conversation-1",
    "user-1",
    "device-1",
  ]);
});

test("message revision pointer update is fenced by expected revision", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  await repository.withTransaction((tx) =>
    repository.updateMessageRevisionPointer(tx, {
      tenantId: "tenant-1",
      messageId: "message-1",
      expectedRevision: 2,
      newRevision: 3,
      status: "DELETED",
      deletedAt: "2026-10-04T10:00:00.000Z",
    }),
  );

  const query = connection.queries[1];
  assert.match(query.text, /current_revision = \$4/);
  assert.match(query.text, /current_revision = \$3/);
  assert.deepEqual(query.params, [
    "tenant-1",
    "message-1",
    2,
    3,
    "DELETED",
    "2026-10-04T10:00:00.000Z",
  ]);
});

test("message mutation revokes pending envelopes and purges protected payload", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 3 },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const count = await repository.withTransaction((tx) =>
    repository.revokePendingMessageEnvelopes(tx, {
      tenantId: "tenant-1",
      messageId: "message-1",
      throughRevision: 2,
    }),
  );

  assert.equal(count, 3);
  const query = connection.queries[1];
  assert.match(query.text, /status = 'REVOKED'/);
  assert.match(query.text, /protected_payload = decode\('', 'hex'\)/);
  assert.match(query.text, /source_revision <= \$3/);
});

test("message mutation supersedes available or leased translation jobs", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 2 },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const count = await repository.withTransaction((tx) =>
    repository.supersedeTranslationJobs(tx, {
      tenantId: "tenant-1",
      messageId: "message-1",
      throughRevision: 2,
      now: "2026-10-04T10:00:00.000Z",
    }),
  );

  assert.equal(count, 2);
  const query = connection.queries[1];
  assert.match(query.text, /status = 'SUPERSEDED'/);
  assert.match(
    query.text,
    /job_type IN \('translation\.request','translation\.execute'\)/,
  );
  assert.match(query.text, /status IN \('AVAILABLE','LEASED'\)/);
  assert.match(query.text, /payload_ref->>'message_id' = \$2/);
  assert.match(query.text, /payload_ref->>'source_revision'/);
  assert.deepEqual(query.params, [
    "tenant-1",
    "message-1",
    2,
    "2026-10-04T10:00:00.000Z",
  ]);
});


test("content-free conversation events include active devices without public delivery material", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [
        { user_id: "user-a", device_id: "device-a2" },
        { user_id: "user-b", device_id: "device-b-no-key" },
      ],
      rowCount: 2,
    },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const devices = await repository.withTransaction((tx) =>
    repository.listConversationEventDevices(
      tx,
      actor(),
      "conversation-1",
    ),
  );

  assert.deepEqual(devices, [
    { userId: "user-a", deviceId: "device-a2" },
    { userId: "user-b", deviceId: "device-b-no-key" },
  ]);

  const sql = connection.queries[1];
  assert.match(sql.text, /JOIN devices d/);
  assert.match(sql.text, /d\.status = 'ACTIVE'/);
  assert.match(sql.text, /d\.device_id <> \$3/);
  assert.doesNotMatch(sql.text, /public_material_ref/);
  assert.deepEqual(sql.params, [
    "tenant-1",
    "conversation-1",
    "device-1",
  ]);
});


test("outbox lease uses SKIP LOCKED and fences every lease attempt", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        job_id: "job-1",
        tenant_id: "tenant-1",
        job_type: "translation.request",
        business_key: "message-1:1",
        payload_ref: {
          message_id: "message-1",
          source_revision: 1,
        },
        priority: 10,
        fencing_token: 4,
        attempt_count: 2,
        lease_until: "2026-10-04T10:00:30.000Z",
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresOutboxRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const lease = await repository.withTransaction((tx) =>
    repository.leaseNextJob(tx, {
      jobType: "translation.request",
      now: "2026-10-04T10:00:00.000Z",
      leaseUntil: "2026-10-04T10:00:30.000Z",
    }),
  );

  assert.deepEqual(lease, {
    jobId: "job-1",
    tenantId: "tenant-1",
    jobType: "translation.request",
    businessKey: "message-1:1",
    payloadRef: {
      message_id: "message-1",
      source_revision: 1,
    },
    priority: 10,
    fencingToken: 4,
    attemptCount: 2,
    leaseUntil: "2026-10-04T10:00:30.000Z",
  });

  const sql = connection.queries[1];
  assert.match(sql.text, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql.text, /status = 'AVAILABLE'/);
  assert.match(sql.text, /status = 'LEASED'/);
  assert.match(sql.text, /lease_until <= \$2/);
  assert.match(sql.text, /fencing_token = j\.fencing_token \+ 1/);
  assert.match(sql.text, /attempt_count = j\.attempt_count \+ 1/);
});

test("outbox completion is accepted only for a live matching fencing token", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresOutboxRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const completed = await repository.withTransaction((tx) =>
    repository.completeJob(tx, {
      tenantId: "tenant-1",
      jobId: "job-1",
      fencingToken: 7,
      now: "2026-10-04T10:00:10.000Z",
    }),
  );

  assert.equal(completed, true);
  const sql = connection.queries[1];
  assert.match(sql.text, /status = 'LEASED'/);
  assert.match(sql.text, /fencing_token = \$3/);
  assert.match(sql.text, /lease_until > \$4/);
  assert.match(sql.text, /status = 'DONE'/);
});

test("outbox retry and dead-letter transitions are lease fenced", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresOutboxRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const result = await repository.withTransaction(async (tx) => ({
    retry: await repository.retryJob(tx, {
      tenantId: "tenant-1",
      jobId: "job-1",
      fencingToken: 9,
      now: "2026-10-04T10:00:10.000Z",
      availableAt: "2026-10-04T10:01:00.000Z",
    }),
    dead: await repository.deadLetterJob(tx, {
      tenantId: "tenant-1",
      jobId: "job-2",
      fencingToken: 5,
      now: "2026-10-04T10:00:10.000Z",
    }),
  }));

  assert.deepEqual(result, {
    retry: true,
    dead: true,
  });

  assert.match(connection.queries[1].text, /status = 'AVAILABLE'/);
  assert.match(connection.queries[1].text, /fencing_token = \$3/);
  assert.match(connection.queries[1].text, /lease_until > \$4/);
  assert.match(connection.queries[2].text, /status = 'DEAD'/);
  assert.match(connection.queries[2].text, /fencing_token = \$3/);
  assert.match(connection.queries[2].text, /lease_until > \$4/);
});

test("superseding translation work invalidates any in-flight fencing token", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 2 },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const count = await repository.withTransaction((tx) =>
    repository.supersedeTranslationJobs(tx, {
      tenantId: "tenant-1",
      messageId: "message-1",
      throughRevision: 2,
      now: "2026-10-04T10:00:00.000Z",
    }),
  );

  assert.equal(count, 2);
  const sql = connection.queries[1];
  assert.match(sql.text, /status = 'SUPERSEDED'/);
  assert.match(sql.text, /fencing_token = fencing_token \+ 1/);
  assert.match(sql.text, /lease_until = NULL/);
});


test("message mutation supersedes pending translation executions", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 2 },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  const count = await repository.withTransaction((tx) =>
    repository.supersedeTranslationExecutions(tx, {
      tenantId: "tenant-1",
      messageId: "message-1",
      throughRevision: 2,
      now: "2026-10-04T12:30:00.000Z",
    }),
  );

  assert.equal(count, 2);
  const query = connection.queries[1];
  assert.match(query.text, /UPDATE translation_executions/);
  assert.match(query.text, /status = 'SUPERSEDED'/);
  assert.match(query.text, /source_revision <= \$3/);
  assert.match(query.text, /status IN \('PENDING','SOURCE_REQUIRED'\)/);
  assert.deepEqual(query.params, [
    "tenant-1",
    "message-1",
    2,
    "2026-10-04T12:30:00.000Z",
  ]);
});


test("translated delivery envelope persists ciphertext with TRANSLATION rendition and execution reference", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresMessagingRepository(
    new SqlTransactionManager(new SingleConnectionPool(connection)),
  );

  await repository.withTransaction((tx) =>
    repository.insertTranslationDeliveryEnvelope(tx, {
      tenantId: "tenant-1",
      envelopeId: "envelope-tr-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      sourceRevision: 2,
      translationId: "translation-1",
      recipientUserId: "user-b",
      recipientDeviceId: "device-b1",
      credentialVersion: 4,
      protectedPayload: "YWJj",
      createdAt: "2026-10-04T12:00:00.000Z",
      expiresAt: "2026-10-11T12:00:00.000Z",
    }),
  );

  const query = connection.queries[1];
  assert.match(query.text, /'TRANSLATION'/);
  assert.match(query.text, /translation_id/);
  assert.match(query.text, /decode\(\$10,'base64'\)/);
  assert.doesNotMatch(
    query.text,
    /translated_text|source_text|prompt_text/,
  );
  assert.deepEqual(query.params, [
    "tenant-1",
    "envelope-tr-1",
    "conversation-1",
    "message-1",
    2,
    "translation-1",
    "user-b",
    "device-b1",
    4,
    "YWJj",
    "2026-10-04T12:00:00.000Z",
    "2026-10-11T12:00:00.000Z",
  ]);
});

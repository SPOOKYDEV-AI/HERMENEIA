import test from "node:test";
import assert from "node:assert/strict";

import {
  SqlTransactionManager,
} from "../.build/packages/persistence/src/index.js";
import {
  PostgresTranslationRepository,
} from "../.build/packages/persistence-postgres/src/translation.js";

class ScriptedConnection {
  constructor(responses = []) {
    this.responses = [...responses];
    this.queries = [];
  }

  async query(text, params = []) {
    this.queries.push({ text, params: [...params] });
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    return this.responses.shift() ?? { rows: [], rowCount: 0 };
  }

  release() {}
}

class Pool {
  constructor(connection) {
    this.connection = connection;
  }

  async connect() {
    return this.connection;
  }
}

function row(overrides = {}) {
  return {
    tenant_id: "tenant-1",
    translation_id: "translation-1",
    conversation_id: "conversation-1",
    source_message_id: "message-1",
    source_revision: 1,
    recipient_user_id: "user-b",
    target_language_tag: "es-CO",
    target_profile_version: 1,
    context_snapshot_id: null,
    strategy_version: "t0-v1",
    status: "PENDING",
    next_attempt_at: null,
    created_at: "2026-10-04T11:00:00.000Z",
    ready_at: null,
    superseded_at: null,
    ...overrides,
  };
}

function key() {
  return {
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    sourceMessageId: "message-1",
    sourceRevision: 1,
    recipientUserId: "user-b",
    targetLanguageTag: "es-CO",
    targetProfileVersion: 1,
    contextSnapshotId: null,
    strategyVersion: "t0-v1",
  };
}

test("translation logical lookup is null-safe and fully parameterized", async () => {
  const connection = new ScriptedConnection([
    { rows: [row()], rowCount: 1 },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  const result = await repository.withTransaction((tx) =>
    repository.findTranslationExecution(tx, key()),
  );

  assert.equal(result.translationId, "translation-1");
  const sql = connection.queries[1];
  assert.match(
    sql.text,
    /context_snapshot_id IS NOT DISTINCT FROM \$8::uuid/,
  );
  assert.deepEqual(sql.params, [
    "tenant-1",
    "conversation-1",
    "message-1",
    1,
    "user-b",
    "es-CO",
    1,
    null,
    "t0-v1",
  ]);
});

test("translation creation uses database uniqueness as concurrency arbiter", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 0 },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  const result = await repository.withTransaction((tx) =>
    repository.insertTranslationExecution(tx, {
      ...key(),
      translationId: "translation-proposed",
      status: "PENDING",
      nextAttemptAt: null,
      createdAt: "2026-10-04T11:00:00.000Z",
      readyAt: null,
      supersededAt: null,
    }),
  );

  assert.equal(result, undefined);
  const sql = connection.queries[1];
  assert.match(sql.text, /ON CONFLICT DO NOTHING/);
  assert.doesNotMatch(sql.text, /source_text|translated_text|prompt_text/);
});

test("translation execution lock serializes provider attempt numbering", async () => {
  const connection = new ScriptedConnection([
    { rows: [row()], rowCount: 1 },
    { rows: [{ attempt_no: 3 }], rowCount: 1 },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  const result = await repository.withTransaction(async (tx) => ({
    execution: await repository.lockTranslationExecution(
      tx,
      "tenant-1",
      "translation-1",
    ),
    attemptNo: await repository.nextProviderAttemptNumber(
      tx,
      "tenant-1",
      "translation-1",
    ),
  }));

  assert.equal(result.attemptNo, 3);
  assert.match(connection.queries[1].text, /FOR UPDATE/);
  assert.match(connection.queries[2].text, /MAX\(attempt_no\)/);
});

test("provider attempt insert contains metadata only and no provider body", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  await repository.withTransaction((tx) =>
    repository.insertProviderExecution(tx, {
      tenantId: "tenant-1",
      attemptId: "attempt-1",
      translationId: "translation-1",
      attemptNo: 1,
      providerId: "provider-a",
      modelId: "model-a",
      providerRegion: "eu-west",
      status: "STARTED",
      inputTokens: null,
      outputTokens: null,
      billedCostMicrounits: null,
      latencyMs: null,
      errorClass: null,
      startedAt: "2026-10-04T11:00:00.000Z",
      completedAt: null,
    }),
  );

  const sql = connection.queries[1];
  assert.match(sql.text, /INSERT INTO provider_executions/);
  assert.doesNotMatch(
    sql.text,
    /prompt|source_text|translated_text|response_body/,
  );
});

test("provider attempt completion is fenced by STARTED state", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  const completed = await repository.withTransaction((tx) =>
    repository.completeProviderExecution(tx, {
      tenantId: "tenant-1",
      attemptId: "attempt-1",
      status: "SUCCEEDED",
      inputTokens: 12,
      outputTokens: 8,
      billedCostMicrounits: 50,
      latencyMs: 240,
      errorClass: null,
      completedAt: "2026-10-04T11:00:00.240Z",
    }),
  );

  assert.equal(completed, true);
  const sql = connection.queries[1];
  assert.match(sql.text, /status = 'STARTED'/);
  assert.match(sql.text, /completed_at = \$9/);
});

test("SOURCE_REQUIRED transition only applies to PENDING execution", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  const updated = await repository.withTransaction((tx) =>
    repository.markSourceRequired(tx, {
      tenantId: "tenant-1",
      translationId: "translation-1",
    }),
  );

  assert.equal(updated, true);
  const sql = connection.queries[1];
  assert.match(sql.text, /status = 'SOURCE_REQUIRED'/);
  assert.match(sql.text, /status = 'PENDING'/);
});


test("fanout plan resolves locale override and membership version without source text", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        conversation_id: "conversation-1",
        declared_source_language: "fr-FR",
        source_hash: "hmac-sha256:k1:" + "a".repeat(64),
      }],
      rowCount: 1,
    },
    {
      rows: [{
        user_id: "user-b",
        target_language_tag: "es-CO",
        membership_version: 4,
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  const plan = await repository.withTransaction((tx) =>
    repository.loadFanoutPlan(tx, {
      tenantId: "tenant-1",
      sourceMessageId: "message-1",
      sourceRevision: 2,
    }),
  );

  assert.deepEqual(plan, {
    conversationId: "conversation-1",
    sourceLanguageTag: "fr-FR",
    sourceHash: "hmac-sha256:k1:" + "a".repeat(64),
    targets: [{
      recipientUserId: "user-b",
      targetLanguageTag: "es-CO",
      targetProfileVersion: 4,
    }],
  });

  assert.match(connection.queries[1].text, /mm\.current_revision = \$3/);
  assert.match(connection.queries[1].text, /mr\.source_hash/);
  assert.match(connection.queries[1].text, /mr\.source_hash IS NOT NULL/);
  assert.match(connection.queries[2].text, /target_locale_override/);
  assert.match(connection.queries[2].text, /membership_version/);
  assert.doesNotMatch(
    connection.queries[2].text,
    /source_text|translated_text|prompt_text/,
  );
});

test("publish lock verifies source, target profile, erasure, conversation policy and tenant policy frontiers", async () => {
  const connection = new ScriptedConnection([
    { rows: [row()], rowCount: 1 },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  const execution = await repository.withTransaction((tx) =>
    repository.lockCurrentTranslationForPublish(
      tx,
      "tenant-1",
      "translation-1",
    ),
  );

  assert.equal(execution.translationId, "translation-1");
  const sql = connection.queries[1];
  assert.match(sql.text, /mm\.current_revision = te\.source_revision/);
  assert.match(sql.text, /cm\.membership_version = te\.target_profile_version/);
  assert.match(sql.text, /target_locale_override/);
  assert.match(sql.text, /JOIN conversations c/);
  assert.match(sql.text, /c\.status = 'ACTIVE'/);
  assert.match(sql.text, /te\.context_snapshot_id IS NULL/);
  assert.match(sql.text, /FROM context_snapshots cs/);
  assert.match(
    sql.text,
    /cs\.erasure_epoch = c\.erasure_epoch/,
  );
  assert.match(
    sql.text,
    /cs\.policy_version = c\.policy_version/,
  );
  assert.match(
    sql.text,
    /cs\.tenant_policy_version = t\.policy_version/,
  );
  assert.match(sql.text, /JOIN tenants t/);
  assert.match(sql.text, /FOR UPDATE OF te, mm, cm, c, t/);
});

test("translation publish device query locks active devices with public material", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        device_id: "device-b1",
        credential_version: 7,
        public_material_ref: "pub:b1",
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  const devices = await repository.withTransaction((tx) =>
    repository.listRecipientDevicesForPublish(tx, {
      tenantId: "tenant-1",
      recipientUserId: "user-b",
      sourceMessageId: "message-1",
      sourceRevision: 2,
    }),
  );

  assert.deepEqual(devices, [{
    deviceId: "device-b1",
    credentialVersion: 7,
    publicMaterialRef: "pub:b1",
  }]);
  const sql = connection.queries[1];
  assert.match(sql.text, /FROM devices d/);
  assert.match(sql.text, /tenant_memberships tm/);
  assert.match(sql.text, /EXISTS \(/);
  assert.match(sql.text, /FROM delivery_envelopes de/);
  assert.match(sql.text, /de\.recipient_user_id = \$2/);
  assert.match(sql.text, /de\.recipient_device_id = d\.device_id/);
  assert.match(sql.text, /de\.message_id = \$3/);
  assert.match(sql.text, /de\.source_revision = \$4/);
  assert.match(sql.text, /de\.rendition_type = 'ORIGINAL'/);
  assert.match(sql.text, /d\.status = 'ACTIVE'/);
  assert.match(sql.text, /length\(d\.public_material_ref\) > 0/);
  assert.match(sql.text, /FOR SHARE OF d/);
  assert.doesNotMatch(sql.text, /SELECT DISTINCT/);
  assert.deepEqual(sql.params, [
    "tenant-1",
    "user-b",
    "message-1",
    2,
  ]);
});

test("translation retry and terminal transitions are fenced by PENDING state", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  await repository.withTransaction(async (tx) => {
    assert.equal(
      await repository.scheduleRetry(tx, {
        tenantId: "tenant-1",
        translationId: "translation-1",
        nextAttemptAt: "2026-10-04T12:01:00.000Z",
      }),
      true,
    );
    assert.equal(
      await repository.markReady(tx, {
        tenantId: "tenant-1",
        translationId: "translation-1",
        readyAt: "2026-10-04T12:02:00.000Z",
      }),
      true,
    );
    assert.equal(
      await repository.markFailed(tx, {
        tenantId: "tenant-1",
        translationId: "translation-2",
      }),
      true,
    );
    assert.equal(
      await repository.markSuperseded(tx, {
        tenantId: "tenant-1",
        translationId: "translation-3",
        supersededAt: "2026-10-04T12:03:00.000Z",
      }),
      true,
    );
  });

  assert.match(connection.queries[1].text, /next_attempt_at = \$3/);
  assert.match(connection.queries[1].text, /status = 'PENDING'/);
  assert.match(connection.queries[2].text, /status = 'READY'/);
  assert.match(connection.queries[3].text, /status = 'FAILED'/);
  assert.match(connection.queries[4].text, /status = 'SUPERSEDED'/);
});


test("translation control device query only returns active devices historically exposed to the exact ORIGINAL revision", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [
        { device_id: "device-b1" },
        { device_id: "device-b2" },
      ],
      rowCount: 2,
    },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  const devices = await repository.withTransaction((tx) =>
    repository.listRecipientControlDevices(tx, {
      tenantId: "tenant-1",
      recipientUserId: "user-b",
      sourceMessageId: "message-1",
      sourceRevision: 2,
    }),
  );

  assert.deepEqual(devices, ["device-b1", "device-b2"]);
  const sql = connection.queries[1];
  assert.match(sql.text, /FROM delivery_envelopes de/);
  assert.match(sql.text, /de\.recipient_user_id = \$2/);
  assert.match(sql.text, /de\.message_id = \$3/);
  assert.match(sql.text, /de\.source_revision = \$4/);
  assert.match(sql.text, /de\.rendition_type = 'ORIGINAL'/);
  assert.match(sql.text, /tm\.status = 'ACTIVE'/);
  assert.match(sql.text, /d\.status = 'ACTIVE'/);
  assert.doesNotMatch(sql.text, /public_material_ref/);
  assert.deepEqual(sql.params, [
    "tenant-1",
    "user-b",
    "message-1",
    2,
  ]);
});


test("translation recovery lock is actor-scoped and returns blocked target state explicitly", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        ...row({ status: "SOURCE_REQUIRED" }),
        expected_source_hash: "hmac-sha256:k1:" + "a".repeat(64),
        message_current_revision: 1,
        message_status: "ACTIVE",
      }],
      rowCount: 1,
    },
    {
      rows: [{
        status: "BLOCKED",
        membership_version: 3,
        target_language_tag: "es-CO",
      }],
      rowCount: 1,
    },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  const recovery = await repository.withTransaction((tx) =>
    repository.lockTranslationForRecovery(
      tx,
      {
        tenantId: "tenant-1",
        userId: "user-a",
        deviceId: "device-a1",
      },
      "translation-1",
    ),
  );

  assert.equal(recovery.targetMembershipStatus, "BLOCKED");
  assert.equal(recovery.currentTargetProfileVersion, 3);
  assert.equal(recovery.currentTargetLanguageTag, "es-CO");
  assert.equal(
    recovery.expectedSourceHash,
    "hmac-sha256:k1:" + "a".repeat(64),
  );

  const executionSql = connection.queries[1];
  assert.match(executionSql.text, /actor_cm\.user_id = \$3/);
  assert.match(executionSql.text, /actor_device\.device_id = \$4/);
  assert.match(executionSql.text, /actor_device\.status = 'ACTIVE'/);
  assert.match(executionSql.text, /mm\.author_user_id = \$3/);
  assert.match(executionSql.text, /mm\.author_device_id = \$4/);
  assert.match(executionSql.text, /EXISTS \(/);
  assert.match(executionSql.text, /FROM delivery_envelopes source_de/);
  assert.match(executionSql.text, /source_de\.recipient_user_id = \$3/);
  assert.match(executionSql.text, /source_de\.recipient_device_id = \$4/);
  assert.match(executionSql.text, /source_de\.rendition_type = 'ORIGINAL'/);
  assert.match(executionSql.text, /FOR UPDATE OF te, mm/);
  assert.match(executionSql.text, /FOR SHARE OF actor_cm, actor_tm, actor_device/);
  assert.deepEqual(executionSql.params, [
    "tenant-1",
    "translation-1",
    "user-a",
    "device-a1",
  ]);
});

test("translation recovery resumes SOURCE_REQUIRED and FAILED only from their exact states", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);
  const repository = new PostgresTranslationRepository(
    new SqlTransactionManager(new Pool(connection)),
  );

  await repository.withTransaction(async (tx) => {
    assert.equal(
      await repository.resumeSourceRequired(tx, {
        tenantId: "tenant-1",
        translationId: "translation-1",
      }),
      true,
    );
    assert.equal(
      await repository.resumeFailed(tx, {
        tenantId: "tenant-1",
        translationId: "translation-2",
      }),
      true,
    );
  });

  assert.match(connection.queries[1].text, /status = 'SOURCE_REQUIRED'/);
  assert.match(connection.queries[1].text, /SET status = 'PENDING'/);
  assert.match(connection.queries[2].text, /status = 'FAILED'/);
  assert.match(connection.queries[2].text, /SET status = 'PENDING'/);
});

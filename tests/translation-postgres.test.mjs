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
    /context_snapshot_id IS NOT DISTINCT FROM $8::uuid/,
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
  assert.match(connection.queries[2].text, /MAX(attempt_no)/);
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
  assert.match(sql.text, /completed_at = $9/);
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

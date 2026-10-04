import test from "node:test";
import assert from "node:assert/strict";

import {
  TranslationExecutionService,
} from "../.build/packages/translation-service/src/index.js";

function clone(value) {
  return structuredClone(value);
}

class FakeTranslationStore {
  constructor() {
    this.execution = null;
    this.attempts = [];
    this.raceWinner = null;
  }

  async withTransaction(work) {
    return work({ id: "tx" });
  }

  async findTranslationExecution(_tx, key) {
    const current = this.execution ?? this.raceWinner;
    if (!current) return undefined;

    const matches =
      current.tenantId === key.tenantId &&
      current.conversationId === key.conversationId &&
      current.sourceMessageId === key.sourceMessageId &&
      current.sourceRevision === key.sourceRevision &&
      current.recipientUserId === key.recipientUserId &&
      current.targetLanguageTag === key.targetLanguageTag &&
      current.targetProfileVersion === key.targetProfileVersion &&
      current.contextSnapshotId === key.contextSnapshotId &&
      current.strategyVersion === key.strategyVersion;

    return matches ? clone(current) : undefined;
  }

  async insertTranslationExecution(_tx, input) {
    if (this.raceWinner) return undefined;
    if (this.execution) return undefined;
    this.execution = clone(input);
    return clone(input);
  }

  async lockTranslationExecution(_tx, tenantId, translationId) {
    if (
      !this.execution ||
      this.execution.tenantId !== tenantId ||
      this.execution.translationId !== translationId
    ) {
      return undefined;
    }
    return clone(this.execution);
  }

  async markSourceRequired(_tx, input) {
    if (
      !this.execution ||
      this.execution.tenantId !== input.tenantId ||
      this.execution.translationId !== input.translationId ||
      this.execution.status !== "PENDING"
    ) {
      return false;
    }
    this.execution.status = "SOURCE_REQUIRED";
    this.execution.nextAttemptAt = null;
    return true;
  }

  async nextProviderAttemptNumber() {
    return this.attempts.length + 1;
  }

  async insertProviderExecution(_tx, input) {
    this.attempts.push(clone(input));
  }

  async completeProviderExecution(_tx, input) {
    const attempt = this.attempts.find(
      (candidate) =>
        candidate.tenantId === input.tenantId &&
        candidate.attemptId === input.attemptId,
    );
    if (!attempt || attempt.status !== "STARTED") {
      return false;
    }

    attempt.status = input.status;
    attempt.inputTokens = input.inputTokens ?? null;
    attempt.outputTokens = input.outputTokens ?? null;
    attempt.billedCostMicrounits =
      input.billedCostMicrounits ?? null;
    attempt.latencyMs = input.latencyMs ?? null;
    attempt.errorClass = input.errorClass ?? null;
    attempt.completedAt = input.completedAt;
    return true;
  }
}

function ids() {
  let n = 0;
  return {
    next(prefix) {
      n += 1;
      return `${prefix}-${n}`;
    },
  };
}

function service(store, now = "2026-10-04T11:00:00.000Z") {
  return new TranslationExecutionService(
    store,
    ids(),
    {
      now() {
        return now;
      },
    },
  );
}

function key(overrides = {}) {
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
    ...overrides,
  };
}

test("ensurePending creates one logical execution and reuses it", async () => {
  const store = new FakeTranslationStore();
  const translations = service(store);

  const first = await translations.ensurePending(key());
  const second = await translations.ensurePending(key());

  assert.deepEqual(second, first);
  assert.equal(first.status, "PENDING");
  assert.equal(first.translationId, "trn-1");
  assert.equal(first.createdAt, "2026-10-04T11:00:00.000Z");
});

test("ensurePending recovers the concurrent unique-index winner", async () => {
  const store = new FakeTranslationStore();
  store.raceWinner = {
    ...key(),
    translationId: "translation-winner",
    status: "PENDING",
    nextAttemptAt: null,
    createdAt: "2026-10-04T10:59:59.000Z",
    readyAt: null,
    supersededAt: null,
  };

  const result = await service(store).ensurePending(key());

  assert.equal(result.translationId, "translation-winner");
});

test("requireSource is idempotent and only moves PENDING execution", async () => {
  const store = new FakeTranslationStore();
  const translations = service(store);
  const execution = await translations.ensurePending(key());

  assert.equal(
    await translations.requireSource(
      execution.tenantId,
      execution.translationId,
    ),
    "SOURCE_REQUIRED",
  );
  assert.equal(store.execution.status, "SOURCE_REQUIRED");

  assert.equal(
    await translations.requireSource(
      execution.tenantId,
      execution.translationId,
    ),
    "UNCHANGED",
  );
});

test("provider attempts are numbered and only start while execution is PENDING", async () => {
  const store = new FakeTranslationStore();
  const translations = service(store);
  const execution = await translations.ensurePending(key());

  const attempt = await translations.startProviderAttempt({
    tenantId: execution.tenantId,
    translationId: execution.translationId,
    providerId: "provider-a",
    modelId: "model-a",
    providerRegion: "eu-west",
  });

  assert.equal(attempt.attemptNo, 1);
  assert.equal(attempt.status, "STARTED");
  assert.equal(attempt.attemptId, "pat-2");

  await translations.requireSource(
    execution.tenantId,
    execution.translationId,
  );

  assert.equal(
    await translations.startProviderAttempt({
      tenantId: execution.tenantId,
      translationId: execution.translationId,
      providerId: "provider-a",
      modelId: "model-a",
    }),
    undefined,
  );
});

test("provider completion is audit-only and cannot be replayed", async () => {
  const store = new FakeTranslationStore();
  const translations = service(store);
  const execution = await translations.ensurePending(key());
  const attempt = await translations.startProviderAttempt({
    tenantId: execution.tenantId,
    translationId: execution.translationId,
    providerId: "provider-a",
    modelId: "model-a",
  });

  const completed = await translations.completeProviderAttempt({
    tenantId: execution.tenantId,
    attemptId: attempt.attemptId,
    status: "SUCCEEDED",
    inputTokens: 12,
    outputTokens: 8,
    billedCostMicrounits: 50,
    latencyMs: 240,
  });

  assert.equal(completed, "COMPLETED");
  assert.equal(store.attempts[0].status, "SUCCEEDED");
  assert.equal(store.execution.status, "PENDING");

  assert.equal(
    await translations.completeProviderAttempt({
      tenantId: execution.tenantId,
      attemptId: attempt.attemptId,
      status: "SUCCEEDED",
    }),
    "STALE_ATTEMPT",
  );
});

test("invalid logical keys and negative provider metrics fail closed", async () => {
  const store = new FakeTranslationStore();
  const translations = service(store);

  await assert.rejects(
    () =>
      translations.ensurePending(
        key({ sourceRevision: 0 }),
      ),
    /sourceRevision/,
  );

  await assert.rejects(
    () =>
      translations.completeProviderAttempt({
        tenantId: "tenant-1",
        attemptId: "attempt-1",
        status: "FAILED",
        latencyMs: -1,
      }),
    /latencyMs/,
  );
});

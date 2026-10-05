import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { DomainError } from "../.build/packages/domain/src/index.js";
import {
  InMemoryTransientSourceStore,
} from "../.build/packages/transient-source/src/index.js";
import {
  TranslationExecutionService,
  TranslationRecoveryService,
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
      current.preferredRegister === key.preferredRegister &&
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
    preferredRegister: null,
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


const recoveryActor = {
  tenantId: "tenant-1",
  userId: "user-a",
  deviceId: "device-a1",
};

const exactSource = {
  text: "Bonjour source exacte",
  language_hint: "fr-FR",
};

function recoveryFingerprinter() {
  function fingerprint(source) {
    const canonical = JSON.stringify({
      text: source.text,
      language_hint: source.language_hint ?? null,
    });
    return `test-sha256:${createHash("sha256")
      .update(canonical)
      .digest("hex")}`;
  }

  return {
    fingerprint,
    matches(source, storedFingerprint) {
      return fingerprint(source) === storedFingerprint;
    },
  };
}

function recoveryExecution(status = "SOURCE_REQUIRED", overrides = {}) {
  return {
    tenantId: "tenant-1",
    translationId: "translation-1",
    conversationId: "conversation-1",
    sourceMessageId: "message-1",
    sourceRevision: 1,
    recipientUserId: "user-b",
    targetLanguageTag: "es-CO",
    targetProfileVersion: 3,
    preferredRegister: null,
    contextSnapshotId: null,
    strategyVersion: "t0-v1",
    status,
    nextAttemptAt: null,
    createdAt: "2026-10-04T12:00:00.000Z",
    readyAt:
      status === "READY"
        ? "2026-10-04T12:00:30.000Z"
        : null,
    supersededAt:
      status === "SUPERSEDED"
        ? "2026-10-04T12:00:20.000Z"
        : null,
    ...overrides,
  };
}

function recoveryRecord(overrides = {}) {
  const fingerprinter = recoveryFingerprinter();
  return {
    execution: recoveryExecution(),
    expectedSourceHash: fingerprinter.fingerprint(exactSource),
    messageCurrentRevision: 1,
    messageStatus: "ACTIVE",
    targetMembershipStatus: "ACTIVE",
    currentTargetProfileVersion: 3,
    currentTargetLanguageTag: "es-CO",
    ...overrides,
  };
}

class FakeRecoveryStore {
  constructor({
    recovery = recoveryRecord(),
    allowedActor = recoveryActor,
    jobState = "REACTIVATED",
    failAt = null,
    failCommit = false,
  } = {}) {
    this.recovery = clone(recovery);
    this.allowedActor = clone(allowedActor);
    this.jobState = jobState;
    this.failAt = failAt;
    this.failCommit = failCommit;
    this.receipts = new Map();
    this.calls = [];
  }

  snapshot() {
    return {
      recovery: clone(this.recovery),
      receipts: new Map(
        [...this.receipts.entries()].map(([key, value]) => [
          key,
          clone(value),
        ]),
      ),
      jobState: this.jobState,
      calls: clone(this.calls),
    };
  }

  restore(snapshot) {
    this.recovery = snapshot.recovery;
    this.receipts = snapshot.receipts;
    this.jobState = snapshot.jobState;
    this.calls = snapshot.calls;
  }

  maybeFail(name) {
    if (this.failAt === name) {
      throw new Error(`forced recovery failure at ${name}`);
    }
  }

  async withTransaction(work) {
    const snapshot = this.snapshot();
    try {
      const result = await work({ id: "tx" });
      if (this.failCommit) {
        this.restore(snapshot);
        throw new Error("forced recovery commit failure");
      }
      return result;
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  async claimCommand(_tx, input) {
    this.maybeFail("claimCommand");
    const key = `${input.actor.tenantId}:${input.commandId}`;
    const existing = this.receipts.get(key);
    if (existing) {
      return {
        claimed: false,
        existing: clone(existing),
      };
    }

    this.receipts.set(key, {
      actorUserId: input.actor.userId,
      actorDeviceId: input.actor.deviceId,
      commandType: input.commandType,
      commandFingerprint: input.commandFingerprint,
      status: "IN_PROGRESS",
      result: {},
    });
    return { claimed: true };
  }

  async markCommandSucceeded(_tx, input) {
    this.maybeFail("markCommandSucceeded");
    const key = `${input.tenantId}:${input.commandId}`;
    const receipt = this.receipts.get(key);
    if (
      !receipt ||
      receipt.actorUserId !== input.actorUserId ||
      receipt.actorDeviceId !== input.actorDeviceId ||
      receipt.commandType !== input.commandType ||
      receipt.commandFingerprint !== input.commandFingerprint ||
      receipt.status !== "IN_PROGRESS"
    ) {
      throw new Error("recovery command receipt mismatch");
    }

    receipt.status = "SUCCEEDED";
    receipt.result = clone(input.result);
  }

  async lockTranslationForRecovery(_tx, actor, translationId) {
    this.maybeFail("lockTranslationForRecovery");
    this.calls.push("lockTranslationForRecovery");

    if (
      actor.tenantId !== this.allowedActor.tenantId ||
      actor.userId !== this.allowedActor.userId ||
      actor.deviceId !== this.allowedActor.deviceId ||
      translationId !== this.recovery.execution.translationId
    ) {
      return undefined;
    }

    return clone(this.recovery);
  }

  async resumeSourceRequired(_tx, input) {
    this.maybeFail("resumeSourceRequired");
    this.calls.push("resumeSourceRequired");
    if (
      this.recovery.execution.tenantId !== input.tenantId ||
      this.recovery.execution.translationId !== input.translationId ||
      this.recovery.execution.status !== "SOURCE_REQUIRED"
    ) {
      return false;
    }

    this.recovery.execution.status = "PENDING";
    this.recovery.execution.nextAttemptAt = null;
    return true;
  }

  async resumeFailed(_tx, input) {
    this.maybeFail("resumeFailed");
    this.calls.push("resumeFailed");
    if (
      this.recovery.execution.tenantId !== input.tenantId ||
      this.recovery.execution.translationId !== input.translationId ||
      this.recovery.execution.status !== "FAILED"
    ) {
      return false;
    }

    this.recovery.execution.status = "PENDING";
    this.recovery.execution.nextAttemptAt = null;
    return true;
  }

  async markSuperseded(_tx, input) {
    this.maybeFail("markSuperseded");
    this.calls.push("markSuperseded");
    if (
      this.recovery.execution.tenantId !== input.tenantId ||
      this.recovery.execution.translationId !== input.translationId
    ) {
      return false;
    }

    this.recovery.execution.status = "SUPERSEDED";
    this.recovery.execution.nextAttemptAt = null;
    this.recovery.execution.readyAt = null;
    this.recovery.execution.supersededAt = input.supersededAt;
    return true;
  }

  async reactivateTranslationExecuteJob(_tx, input) {
    this.maybeFail("reactivateTranslationExecuteJob");
    this.calls.push("reactivateTranslationExecuteJob");

    if (
      this.recovery.execution.tenantId !== input.tenantId ||
      this.recovery.execution.translationId !== input.translationId
    ) {
      return "NOT_FOUND";
    }

    const current = this.jobState;
    if (current === "REACTIVATED") {
      this.jobState = "ACTIVE";
    }
    return current;
  }
}

function recoveryFixture({
  storeOptions = {},
  transientOptions = {},
  now = "2026-10-04T12:05:00.000Z",
} = {}) {
  const store = new FakeRecoveryStore(storeOptions);
  const transientSources = new InMemoryTransientSourceStore({
    clock: {
      now() {
        return now;
      },
    },
    maxEntries: transientOptions.maxEntries ?? 10,
    maxApproxBytes:
      transientOptions.maxApproxBytes ?? 1024 * 1024,
  });
  const fingerprinter = recoveryFingerprinter();
  const recovery = new TranslationRecoveryService({
    store,
    transientSources,
    fingerprinter,
    clock: {
      now() {
        return now;
      },
    },
    transientSourceTtlSeconds: 300,
  });

  return {
    store,
    transientSources,
    fingerprinter,
    recovery,
  };
}

function sourceResupplyCommand(overrides = {}) {
  const fingerprinter = recoveryFingerprinter();
  return {
    protocol_version: 1,
    command_id: "source-command-1",
    translation_id: "translation-1",
    message_id: "message-1",
    source_revision: 1,
    source_ref: fingerprinter.fingerprint(exactSource),
    source: clone(exactSource),
    ...overrides,
  };
}

test("source re-supply validates exact revision, resumes execution and reactivates job", async () => {
  const f = recoveryFixture();

  const result = await f.recovery.resupplySource(
    recoveryActor,
    sourceResupplyCommand(),
  );

  assert.deepEqual(result, {
    protocol_version: 1,
    translation_id: "translation-1",
    status: "PENDING",
  });
  assert.equal(f.store.recovery.execution.status, "PENDING");
  assert.equal(f.store.jobState, "ACTIVE");

  const buffered = f.transientSources.get({
    tenantId: "tenant-1",
    messageId: "message-1",
    sourceRevision: 1,
  });
  assert.ok(buffered);
  assert.equal(buffered.source.text, exactSource.text);
  assert.equal(
    buffered.sourceHash,
    f.fingerprinter.fingerprint(exactSource),
  );

  const receipt = f.store.receipts.get(
    "tenant-1:source-command-1",
  );
  assert.equal(receipt.status, "SUCCEEDED");
  assert.deepEqual(receipt.result, result);
});

test("source re-supply rejects a wrong source_ref or wrong source body without durable mutation", async () => {
  for (const command of [
    sourceResupplyCommand({
      source_ref: "test-sha256:" + "0".repeat(64),
    }),
    sourceResupplyCommand({
      source: {
        text: "mauvaise source",
        language_hint: "fr-FR",
      },
    }),
  ]) {
    const f = recoveryFixture();

    await assert.rejects(
      () =>
        f.recovery.resupplySource(
          recoveryActor,
          command,
        ),
      (error) =>
        error instanceof DomainError &&
        error.code === "SOURCE_REVISION_MISMATCH",
    );

    assert.equal(
      f.store.recovery.execution.status,
      "SOURCE_REQUIRED",
    );
    assert.equal(f.store.receipts.size, 0);
    assert.equal(f.transientSources.size, 0);
  }
});

test("source re-supply rejects a foreign actor before source admission", async () => {
  const f = recoveryFixture();

  await assert.rejects(
    () =>
      f.recovery.resupplySource(
        {
          tenantId: "tenant-1",
          userId: "user-foreign",
          deviceId: "device-foreign",
        },
        sourceResupplyCommand(),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "NOT_AUTHORIZED",
  );

  assert.equal(f.store.receipts.size, 0);
  assert.equal(f.transientSources.size, 0);
  assert.equal(
    f.store.recovery.execution.status,
    "SOURCE_REQUIRED",
  );
});

test("source re-supply buffer pressure rolls back the durable command and execution status", async () => {
  const f = recoveryFixture({
    transientOptions: {
      maxEntries: 1,
      maxApproxBytes: 1,
    },
  });

  await assert.rejects(
    () =>
      f.recovery.resupplySource(
        recoveryActor,
        sourceResupplyCommand(),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "SOURCE_BUFFER_UNAVAILABLE",
  );

  assert.equal(
    f.store.recovery.execution.status,
    "SOURCE_REQUIRED",
  );
  assert.equal(f.store.receipts.size, 0);
  assert.equal(f.transientSources.size, 0);
});

test("source re-supply commit failure removes newly admitted plaintext", async () => {
  const f = recoveryFixture({
    storeOptions: {
      failCommit: true,
    },
  });

  await assert.rejects(
    () =>
      f.recovery.resupplySource(
        recoveryActor,
        sourceResupplyCommand(),
      ),
    /forced recovery commit failure/,
  );

  assert.equal(f.transientSources.size, 0);
  assert.equal(f.store.receipts.size, 0);
  assert.equal(
    f.store.recovery.execution.status,
    "SOURCE_REQUIRED",
  );
});

test("source recovery supersedes stale message or blocked target before admitting plaintext", async () => {
  for (const record of [
    recoveryRecord({
      messageCurrentRevision: 2,
    }),
    recoveryRecord({
      targetMembershipStatus: "BLOCKED",
    }),
    recoveryRecord({
      currentTargetProfileVersion: 4,
    }),
    recoveryRecord({
      currentTargetLanguageTag: "es-ES",
    }),
  ]) {
    const f = recoveryFixture({
      storeOptions: { recovery: record },
    });

    const result = await f.recovery.resupplySource(
      recoveryActor,
      sourceResupplyCommand(),
    );

    assert.equal(result.status, "SUPERSEDED");
    assert.equal(
      f.store.recovery.execution.status,
      "SUPERSEDED",
    );
    assert.equal(f.transientSources.size, 0);
    assert.equal(
      f.store.calls.includes("markSuperseded"),
      true,
    );
  }
});

test("translation retry resumes FAILED execution and reactivates its execute job", async () => {
  const f = recoveryFixture({
    storeOptions: {
      recovery: recoveryRecord({
        execution: recoveryExecution("FAILED"),
      }),
    },
  });

  const result = await f.recovery.retryTranslation(
    recoveryActor,
    "translation-1",
  );

  assert.deepEqual(result, {
    protocol_version: 1,
    translation_id: "translation-1",
    status: "PENDING",
  });
  assert.equal(f.store.recovery.execution.status, "PENDING");
  assert.equal(f.store.jobState, "ACTIVE");
});

test("translation retry fails closed for SOURCE_REQUIRED and EXPIRED states", async () => {
  const required = recoveryFixture();
  await assert.rejects(
    () =>
      required.recovery.retryTranslation(
        recoveryActor,
        "translation-1",
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "SOURCE_REQUIRED",
  );

  const expired = recoveryFixture({
    storeOptions: {
      recovery: recoveryRecord({
        execution: recoveryExecution("EXPIRED"),
      }),
    },
  });
  await assert.rejects(
    () =>
      expired.recovery.retryTranslation(
        recoveryActor,
        "translation-1",
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "SOURCE_EXPIRED",
  );
});

test("translation retry returns READY or SUPERSEDED without resurrecting work", async () => {
  for (const status of ["READY", "SUPERSEDED"]) {
    const f = recoveryFixture({
      storeOptions: {
        recovery: recoveryRecord({
          execution: recoveryExecution(status),
        }),
      },
    });

    const result = await f.recovery.retryTranslation(
      recoveryActor,
      "translation-1",
    );

    assert.equal(result.status, status);
    assert.equal(
      f.store.calls.includes("reactivateTranslationExecuteJob"),
      false,
    );
  }
});


test("successful source re-supply cannot be replayed with altered plaintext under the same command_id", async () => {
  const f = recoveryFixture();
  const command = sourceResupplyCommand();

  const first = await f.recovery.resupplySource(
    recoveryActor,
    command,
  );
  assert.equal(first.status, "PENDING");

  await assert.rejects(
    () =>
      f.recovery.resupplySource(
        recoveryActor,
        {
          ...command,
          source: {
            text: "plaintext altered after successful receipt",
            language_hint: "fr-FR",
          },
        },
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "SOURCE_REVISION_MISMATCH",
  );

  assert.equal(f.store.receipts.size, 1);
  assert.equal(f.store.recovery.execution.status, "PENDING");
});

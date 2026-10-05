import test from "node:test";
import assert from "node:assert/strict";

import {
  PersistentOutboxService,
} from "../.build/packages/outbox-service/src/index.js";
import {
  InMemoryTransientSourceStore,
} from "../.build/packages/transient-source/src/index.js";
import {
  TranslationExecutionService,
} from "../.build/packages/translation-service/src/index.js";
import {
  TranslationWorkerService,
} from "../.build/packages/translation-worker/src/index.js";

function clone(value) {
  return structuredClone(value);
}

class FakeWorkerStore {
  constructor() {
    this.state = {
      jobs: [],
      executions: new Map(),
      attempts: [],
      envelopes: [],
      events: [],
      controlDeviceQueries: [],
      inboxOffsets: new Map(),
    };
    this.fanoutPlan = {
      conversationId: "conversation-1",
      sourceLanguageTag: "fr-FR",
      sourceHash: "source-hash-1",
      targets: [{
        recipientUserId: "user-b",
        targetLanguageTag: "es-CO",
        targetProfileVersion: 3,
      }],
    };
    this.current = true;
    this.devices = [{
      deviceId: "device-b1",
      credentialVersion: 4,
      publicMaterialRef: "pub:b1",
    }];
    this.controlDevices = ["device-b1"];
    this.publishDevices = clone(this.devices);
    this.forceCompleteStale = false;
  }

  async withTransaction(work) {
    const snapshot = clone(this.state);
    try {
      return await work({ id: "tx" });
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  seedRootJob(overrides = {}) {
    this.state.jobs.push({
      jobId: "job-root",
      tenantId: "tenant-1",
      jobType: "translation.request",
      businessKey: "message-1:1",
      payloadRef: {
        message_id: "message-1",
        source_revision: 1,
        source_hash: "source-hash-1",
      },
      priority: 10,
      status: "AVAILABLE",
      availableAt: "2026-10-04T12:00:00.000Z",
      leaseUntil: null,
      fencingToken: 0,
      attemptCount: 0,
      completedAt: null,
      ...overrides,
    });
  }

  async leaseNextJob(_tx, input) {
    const job = this.state.jobs.find((candidate) => {
      if (candidate.jobType !== input.jobType) return false;
      return (
        (
          candidate.status === "AVAILABLE" &&
          Date.parse(candidate.availableAt) <= Date.parse(input.now)
        ) ||
        (
          candidate.status === "LEASED" &&
          candidate.leaseUntil &&
          Date.parse(candidate.leaseUntil) <= Date.parse(input.now)
        )
      );
    });
    if (!job) return undefined;

    job.status = "LEASED";
    job.leaseUntil = input.leaseUntil;
    job.fencingToken += 1;
    job.attemptCount += 1;
    job.completedAt = null;

    return {
      jobId: job.jobId,
      tenantId: job.tenantId,
      jobType: job.jobType,
      businessKey: job.businessKey,
      payloadRef: clone(job.payloadRef),
      priority: job.priority,
      fencingToken: job.fencingToken,
      attemptCount: job.attemptCount,
      leaseUntil: job.leaseUntil,
    };
  }

  currentLeaseMatches(input) {
    const job = this.state.jobs.find(
      (candidate) =>
        candidate.tenantId === input.tenantId &&
        candidate.jobId === input.jobId,
    );
    return Boolean(
      job &&
      job.status === "LEASED" &&
      job.fencingToken === input.fencingToken &&
      job.leaseUntil &&
      Date.parse(job.leaseUntil) > Date.parse(input.now),
    );
  }

  async completeJob(_tx, input) {
    if (this.forceCompleteStale) return false;
    if (!this.currentLeaseMatches(input)) return false;
    const job = this.state.jobs.find(
      (candidate) => candidate.jobId === input.jobId,
    );
    job.status = "DONE";
    job.leaseUntil = null;
    job.completedAt = input.now;
    return true;
  }

  async retryJob(_tx, input) {
    if (!this.currentLeaseMatches(input)) return false;
    const job = this.state.jobs.find(
      (candidate) => candidate.jobId === input.jobId,
    );
    job.status = "AVAILABLE";
    job.availableAt = input.availableAt;
    job.leaseUntil = null;
    job.completedAt = null;
    return true;
  }

  async deadLetterJob(_tx, input) {
    if (!this.currentLeaseMatches(input)) return false;
    const job = this.state.jobs.find(
      (candidate) => candidate.jobId === input.jobId,
    );
    job.status = "DEAD";
    job.leaseUntil = null;
    job.completedAt = input.now;
    return true;
  }

  async loadFanoutPlan() {
    return this.current && this.fanoutPlan
      ? clone(this.fanoutPlan)
      : undefined;
  }

  async insertOutboxJob(_tx, input) {
    const exists = this.state.jobs.some(
      (job) =>
        job.tenantId === input.tenantId &&
        job.jobType === input.jobType &&
        job.businessKey === input.businessKey,
    );
    if (exists) return;

    this.state.jobs.push({
      ...clone(input),
      status: "AVAILABLE",
      availableAt: input.availableAt,
      leaseUntil: null,
      fencingToken: 0,
      attemptCount: 0,
      completedAt: null,
    });
  }

  logicalKey(key) {
    return [
      key.tenantId,
      key.sourceMessageId,
      key.sourceRevision,
      key.recipientUserId,
      key.targetLanguageTag,
      key.targetProfileVersion,
      key.contextSnapshotId ?? "",
      key.strategyVersion,
    ].join("|");
  }

  async findTranslationExecution(_tx, key) {
    const id = this.logicalKey(key);
    const execution = this.state.executions.get(id);
    return execution ? clone(execution) : undefined;
  }

  async insertTranslationExecution(_tx, input) {
    const id = this.logicalKey(input);
    if (this.state.executions.has(id)) return undefined;
    this.state.executions.set(id, clone(input));
    return clone(input);
  }

  findExecutionById(tenantId, translationId) {
    for (const execution of this.state.executions.values()) {
      if (
        execution.tenantId === tenantId &&
        execution.translationId === translationId
      ) {
        return execution;
      }
    }
    return undefined;
  }

  async lockTranslationExecution(_tx, tenantId, translationId) {
    const execution = this.findExecutionById(
      tenantId,
      translationId,
    );
    return execution ? clone(execution) : undefined;
  }

  async lockCurrentTranslationForPublish(
    _tx,
    tenantId,
    translationId,
  ) {
    if (!this.current) return undefined;
    const execution = this.findExecutionById(
      tenantId,
      translationId,
    );
    return execution?.status === "PENDING"
      ? clone(execution)
      : undefined;
  }

  async listRecipientControlDevices(_tx, input) {
    this.state.controlDeviceQueries.push(clone(input));
    return this.current
      ? clone(this.controlDevices)
      : [];
  }

  async listRecipientDevicesForPublish() {
    return this.current ? clone(this.publishDevices) : [];
  }

  async markSourceRequired(_tx, input) {
    const execution = this.findExecutionById(
      input.tenantId,
      input.translationId,
    );
    if (!execution || execution.status !== "PENDING") {
      return false;
    }
    execution.status = "SOURCE_REQUIRED";
    execution.nextAttemptAt = null;
    return true;
  }

  async scheduleRetry(_tx, input) {
    const execution = this.findExecutionById(
      input.tenantId,
      input.translationId,
    );
    if (!execution || execution.status !== "PENDING") {
      return false;
    }
    execution.nextAttemptAt = input.nextAttemptAt;
    return true;
  }

  async markFailed(_tx, input) {
    const execution = this.findExecutionById(
      input.tenantId,
      input.translationId,
    );
    if (!execution || execution.status !== "PENDING") {
      return false;
    }
    execution.status = "FAILED";
    execution.nextAttemptAt = null;
    return true;
  }

  async markReady(_tx, input) {
    const execution = this.findExecutionById(
      input.tenantId,
      input.translationId,
    );
    if (!execution || execution.status !== "PENDING") {
      return false;
    }
    execution.status = "READY";
    execution.nextAttemptAt = null;
    execution.readyAt = input.readyAt;
    return true;
  }

  async markSuperseded(_tx, input) {
    const execution = this.findExecutionById(
      input.tenantId,
      input.translationId,
    );
    if (
      !execution ||
      !["PENDING", "SOURCE_REQUIRED"].includes(execution.status)
    ) {
      return false;
    }
    execution.status = "SUPERSEDED";
    execution.nextAttemptAt = null;
    execution.supersededAt = input.supersededAt;
    return true;
  }

  async nextProviderAttemptNumber(_tx, tenantId, translationId) {
    return (
      this.state.attempts.filter(
        (attempt) =>
          attempt.tenantId === tenantId &&
          attempt.translationId === translationId,
      ).length + 1
    );
  }

  async insertProviderExecution(_tx, input) {
    this.state.attempts.push(clone(input));
  }

  async completeProviderExecution(_tx, input) {
    const attempt = this.state.attempts.find(
      (candidate) =>
        candidate.tenantId === input.tenantId &&
        candidate.attemptId === input.attemptId,
    );
    if (!attempt || attempt.status !== "STARTED") return false;
    Object.assign(attempt, {
      status: input.status,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      billedCostMicrounits:
        input.billedCostMicrounits ?? null,
      latencyMs: input.latencyMs ?? null,
      errorClass: input.errorClass ?? null,
      completedAt: input.completedAt,
    });
    return true;
  }

  async insertTranslationDeliveryEnvelope(_tx, input) {
    this.state.envelopes.push({
      ...clone(input),
      renditionType: "TRANSLATION",
      status: "PENDING",
    });
  }

  async allocateDeviceInboxOffset(_tx, _tenantId, deviceId) {
    const next = this.state.inboxOffsets.get(deviceId) ?? 1;
    this.state.inboxOffsets.set(deviceId, next + 1);
    return { inboxEpoch: 1, offset: next };
  }

  async insertInboxEvent(_tx, input) {
    this.state.events.push(clone(input));
  }
}

function clock(initial = "2026-10-04T12:00:00.000Z") {
  let now = initial;
  return {
    now() {
      return now;
    },
    set(value) {
      now = value;
    },
  };
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

function fixture({
  providerResult = {
    ok: true,
    text: "Hola mundo",
    inputTokens: 5,
    outputTokens: 3,
    latencyMs: 120,
  },
  maxProviderAttempts = 3,
  onProviderTranslate = null,
  contextBridge = undefined,
} = {}) {
  const store = new FakeWorkerStore();
  store.seedRootJob();
  const time = clock();
  const idFactory = ids();

  const outbox = new PersistentOutboxService(
    store,
    time,
    { leaseSeconds: 30 },
  );
  const executions = new TranslationExecutionService(
    store,
    idFactory,
    time,
  );
  const transientSources = new InMemoryTransientSourceStore({
    clock: time,
    maxEntries: 100,
    maxApproxBytes: 1024 * 1024,
  });

  let providerCalls = 0;
  const providerInputs = [];
  const provider = {
    providerId: "provider-a",
    modelId: "model-a",
    providerRegion: "eu-west",
    async translate(input) {
      providerCalls += 1;
      providerInputs.push(clone(input));
      assert.ok(input.requestId);
      assert.equal(input.targetLanguageTag, "es-CO");
      if (typeof onProviderTranslate === "function") {
        await onProviderTranslate({ store, input });
      }
      return clone(providerResult);
    },
  };

  const worker = new TranslationWorkerService({
    store,
    outbox,
    executions,
    transientSources,
    provider,
    envelopeProtector: {
      protect(input) {
        return Buffer.from(
          `TRANSLATED:${input.recipientDeviceId}:${input.translatedText}`,
          "utf8",
        ).toString("base64");
      },
    },
    contextBridge,
    ids: idFactory,
    clock: time,
    strategyVersion: "t0-v1",
    envelopeTtlSeconds: 3600,
    maxProviderAttempts,
    retryBaseSeconds: 5,
  });

  return {
    store,
    time,
    outbox,
    executions,
    transientSources,
    providerCalls() {
      return providerCalls;
    },
    providerInputs,
    worker,
  };
}

async function fanoutOne(f) {
  assert.equal(await f.worker.runFanoutOnce(), "FANOUT_DONE");
  const child = f.store.state.jobs.find(
    (job) => job.jobType === "translation.execute",
  );
  assert.ok(child);
  return child;
}

function currentExecution(f) {
  return [...f.store.state.executions.values()][0];
}

test("context-aware fanout binds snapshot and provider receives resolved transient context", async () => {
  const bridgeCalls = [];
  const f = fixture({
    contextBridge: {
      async prepare(input) {
        bridgeCalls.push({ type: "prepare", input: clone(input) });
        return {
          contextSnapshotId: "context-snapshot-1",
          strategyVersion: "adaptive-context-v1",
        };
      },
      async resolve(input) {
        bridgeCalls.push({ type: "resolve", input: clone(input) });
        return {
          status: "READY",
          selected: [{
            candidateId: "recent-1",
            candidateType: "IMMEDIATE_MESSAGE",
            content: "Previous private context",
            selectionReason: "IMMEDIATE_CONTEXT",
          }],
        };
      },
    },
  });

  await fanoutOne(f);
  const execution = currentExecution(f);
  assert.equal(execution.contextSnapshotId, "context-snapshot-1");
  assert.equal(execution.strategyVersion, "adaptive-context-v1");

  f.transientSources.put({
    tenantId: "tenant-1",
    messageId: "message-1",
    sourceRevision: 1,
    sourceHash: "source-hash-1",
    source: { text: "Bonjour" },
    createdAt: f.time.now(),
    expiresAt: "2026-10-04T12:05:00.000Z",
  });

  assert.equal(
    await f.worker.runExecuteOnce(),
    "EXECUTION_DONE",
  );

  assert.equal(f.providerCalls(), 1);
  assert.equal(
    f.providerInputs[0].contextSnapshotId,
    "context-snapshot-1",
  );
  assert.deepEqual(f.providerInputs[0].contextItems, [{
    candidateId: "recent-1",
    candidateType: "IMMEDIATE_MESSAGE",
    content: "Previous private context",
    selectionReason: "IMMEDIATE_CONTEXT",
  }]);
  assert.deepEqual(
    bridgeCalls.map((call) => call.type),
    ["prepare", "resolve"],
  );
});

test("expired contextual payload supersedes T2 execution and replans T0 without provider call", async () => {
  const f = fixture({
    contextBridge: {
      async prepare() {
        return {
          contextSnapshotId: "context-snapshot-lost",
          strategyVersion: "adaptive-context-v1",
        };
      },
      async resolve() {
        return {
          status: "PAYLOAD_UNAVAILABLE",
        };
      },
    },
  });

  const originalChild = await fanoutOne(f);
  const originalExecution = currentExecution(f);

  f.transientSources.put({
    tenantId: "tenant-1",
    messageId: "message-1",
    sourceRevision: 1,
    sourceHash: "source-hash-1",
    source: { text: "Bonjour" },
    createdAt: f.time.now(),
    expiresAt: "2026-10-04T12:05:00.000Z",
  });

  assert.equal(
    await f.worker.runExecuteOnce(),
    "CONTEXT_FALLBACK",
  );

  assert.equal(f.providerCalls(), 0);
  assert.equal(originalExecution.status, "SUPERSEDED");
  assert.equal(originalChild.status, "DONE");

  const executions = [...f.store.state.executions.values()];
  assert.equal(executions.length, 2);
  const fallback = executions.find(
    (item) => item.translationId !== originalExecution.translationId,
  );
  assert.ok(fallback);
  assert.equal(fallback.contextSnapshotId, null);
  assert.equal(fallback.strategyVersion, "t0-v1");
  assert.equal(fallback.status, "PENDING");

  const fallbackJob = f.store.state.jobs.find(
    (job) =>
      job.jobType === "translation.execute" &&
      job.businessKey === fallback.translationId,
  );
  assert.ok(fallbackJob);
  assert.equal(fallbackJob.status, "AVAILABLE");
});

test("fanout creates one child execution per target and skips exact same-language target", async () => {
  const f = fixture();
  f.store.fanoutPlan.targets.push({
    recipientUserId: "user-c",
    targetLanguageTag: "fr-FR",
    targetProfileVersion: 1,
  });
  f.store.fanoutPlan.targets.push({
    recipientUserId: "user-d",
    targetLanguageTag: "en-US",
    targetProfileVersion: 2,
  });

  assert.equal(await f.worker.runFanoutOnce(), "FANOUT_DONE");

  const executions = [...f.store.state.executions.values()];
  assert.equal(executions.length, 2);
  assert.deepEqual(
    executions.map((item) => item.targetLanguageTag).sort(),
    ["en-US", "es-CO"],
  );

  const children = f.store.state.jobs.filter(
    (job) => job.jobType === "translation.execute",
  );
  assert.equal(children.length, 2);
  assert.equal(
    JSON.stringify(children).includes("Bonjour"),
    false,
  );
  assert.equal(f.store.state.jobs[0].status, "DONE");
});

test("stale root source completes without creating translation work", async () => {
  const f = fixture();
  f.store.current = false;

  assert.equal(
    await f.worker.runFanoutOnce(),
    "SUPERSEDED",
  );
  assert.equal(f.store.state.executions.size, 0);
  assert.equal(
    f.store.state.jobs.filter(
      (job) => job.jobType === "translation.execute",
    ).length,
    0,
  );
});

test("missing transient source marks execution SOURCE_REQUIRED without provider call", async () => {
  const f = fixture();
  const child = await fanoutOne(f);

  assert.equal(
    await f.worker.runExecuteOnce(),
    "SOURCE_REQUIRED",
  );
  assert.equal(currentExecution(f).status, "SOURCE_REQUIRED");
  assert.equal(child.status, "DONE");
  assert.equal(f.providerCalls(), 0);
  assert.deepEqual(f.store.state.controlDeviceQueries, [{
    tenantId: "tenant-1",
    recipientUserId: "user-b",
    sourceMessageId: "message-1",
    sourceRevision: 1,
  }]);

  const controlEvents = f.store.state.events.filter(
    (event) => event.eventType === "translation.source_required",
  );
  assert.equal(controlEvents.length, 1);
  assert.deepEqual(controlEvents[0], {
    deviceId: "device-b1",
    inboxEpoch: 1,
    offset: 1,
    eventId: "evt-3",
    eventType: "translation.source_required",
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    envelopeId: null,
    sourceRevision: 1,
    translationId: currentExecution(f).translationId,
    sourceRef: "source-hash-1",
    createdAt: "2026-10-04T12:00:00.000Z",
  });
});

test("source becoming stale while handling missing plaintext supersedes instead of requesting re-supply", async () => {
  const f = fixture();
  const child = await fanoutOne(f);
  f.store.current = false;

  assert.equal(
    await f.worker.runExecuteOnce(),
    "SUPERSEDED",
  );
  assert.equal(currentExecution(f).status, "SUPERSEDED");
  assert.equal(child.status, "DONE");
  assert.equal(
    f.store.state.events.some(
      (event) => event.eventType === "translation.source_required",
    ),
    false,
  );
  assert.equal(f.providerCalls(), 0);
});

test("successful provider result publishes encrypted translation and marks execution READY", async () => {
  const f = fixture();
  const child = await fanoutOne(f);
  const execution = currentExecution(f);

  f.transientSources.put({
    tenantId: "tenant-1",
    messageId: "message-1",
    sourceRevision: 1,
    sourceHash: "source-hash-1",
    source: {
      text: "Bonjour monde",
      language_hint: "fr-FR",
    },
    createdAt: f.time.now(),
    expiresAt: "2026-10-04T12:05:00.000Z",
  });

  assert.equal(
    await f.worker.runExecuteOnce(),
    "EXECUTION_DONE",
  );

  assert.equal(execution.status, "READY");
  assert.equal(child.status, "DONE");
  assert.equal(f.providerCalls(), 1);
  assert.equal(f.store.state.attempts[0].status, "SUCCEEDED");
  assert.equal(f.store.state.envelopes.length, 1);
  assert.equal(
    f.store.state.envelopes[0].renditionType,
    "TRANSLATION",
  );
  assert.equal(
    f.store.state.envelopes[0].protectedPayload.includes("Hola mundo"),
    false,
  );
  assert.equal(f.store.state.events.length, 1);
  assert.equal(
    f.store.state.events[0].eventType,
    "message.available",
  );
});

test("provider attempt cancelled by a concurrent message mutation stops before publish", async () => {
  const f = fixture({
    onProviderTranslate({ store }) {
      const attempt = store.state.attempts[0];
      attempt.status = "CANCELLED_LOGICALLY";
      attempt.completedAt = "2026-10-04T12:00:00.000Z";

      const execution = [...store.state.executions.values()][0];
      execution.status = "SUPERSEDED";
      execution.supersededAt = "2026-10-04T12:00:00.000Z";

      const child = store.state.jobs.find(
        (job) => job.jobType === "translation.execute",
      );
      child.status = "SUPERSEDED";
      child.leaseUntil = null;
      child.completedAt = "2026-10-04T12:00:00.000Z";
      child.fencingToken += 1;
    },
  });
  await fanoutOne(f);
  f.transientSources.put({
    tenantId: "tenant-1",
    messageId: "message-1",
    sourceRevision: 1,
    sourceHash: "source-hash-1",
    source: { text: "Bonjour" },
    createdAt: f.time.now(),
    expiresAt: "2026-10-04T12:05:00.000Z",
  });

  assert.equal(
    await f.worker.runExecuteOnce(),
    "SUPERSEDED",
  );
  assert.equal(f.providerCalls(), 1);
  assert.equal(
    f.store.state.attempts[0].status,
    "CANCELLED_LOGICALLY",
  );
  assert.equal(
    [...f.store.state.executions.values()][0].status,
    "SUPERSEDED",
  );
  assert.equal(f.store.state.envelopes.length, 0);
  assert.equal(
    f.store.state.events.some(
      (event) => event.eventType === "message.available",
    ),
    false,
  );
});

test("stale profile/source preflight supersedes execution without calling provider", async () => {
  const f = fixture();
  await fanoutOne(f);
  f.transientSources.put({
    tenantId: "tenant-1",
    messageId: "message-1",
    sourceRevision: 1,
    sourceHash: "source-hash-1",
    source: { text: "Bonjour" },
    createdAt: f.time.now(),
    expiresAt: "2026-10-04T12:05:00.000Z",
  });
  f.store.current = false;

  assert.equal(
    await f.worker.runExecuteOnce(),
    "SUPERSEDED",
  );
  assert.equal(currentExecution(f).status, "SUPERSEDED");
  assert.equal(f.providerCalls(), 0);
  assert.equal(f.store.state.envelopes.length, 0);
});

test("recipient with no active device is retried before provider cost is incurred", async () => {
  const f = fixture();
  const child = await fanoutOne(f);
  f.transientSources.put({
    tenantId: "tenant-1",
    messageId: "message-1",
    sourceRevision: 1,
    sourceHash: "source-hash-1",
    source: { text: "Bonjour" },
    createdAt: f.time.now(),
    expiresAt: "2026-10-04T12:05:00.000Z",
  });
  f.store.publishDevices = [];

  assert.equal(
    await f.worker.runExecuteOnce(),
    "RETRY_SCHEDULED",
  );
  assert.equal(f.providerCalls(), 0);
  assert.equal(child.status, "AVAILABLE");
  assert.equal(
    currentExecution(f).nextAttemptAt,
    "2026-10-04T12:00:05.000Z",
  );
});

test("provider Retry-After extends durable retry delay", async () => {
  const f = fixture({
    providerResult: {
      ok: false,
      status: "RATE_LIMITED",
      retryable: true,
      errorClass: "OPENAI_SLOW_DOWN",
      retryAfterSeconds: 30,
    },
  });
  const child = await fanoutOne(f);
  f.transientSources.put({
    tenantId: "tenant-1",
    messageId: "message-1",
    sourceRevision: 1,
    sourceHash: "source-hash-1",
    source: { text: "Bonjour" },
    createdAt: f.time.now(),
    expiresAt: "2026-10-04T12:05:00.000Z",
  });

  assert.equal(
    await f.worker.runExecuteOnce(),
    "RETRY_SCHEDULED",
  );
  assert.equal(child.status, "AVAILABLE");
  assert.equal(
    child.availableAt,
    "2026-10-04T12:00:30.000Z",
  );
  assert.equal(
    currentExecution(f).nextAttemptAt,
    "2026-10-04T12:00:30.000Z",
  );
});

test("retryable provider failure requeues child with exponential backoff", async () => {
  const f = fixture({
    providerResult: {
      ok: false,
      status: "RATE_LIMITED",
      retryable: true,
      errorClass: "RATE_LIMIT",
    },
  });
  const child = await fanoutOne(f);
  f.transientSources.put({
    tenantId: "tenant-1",
    messageId: "message-1",
    sourceRevision: 1,
    sourceHash: "source-hash-1",
    source: { text: "Bonjour" },
    createdAt: f.time.now(),
    expiresAt: "2026-10-04T12:05:00.000Z",
  });

  assert.equal(
    await f.worker.runExecuteOnce(),
    "RETRY_SCHEDULED",
  );
  assert.equal(child.status, "AVAILABLE");
  assert.equal(child.availableAt, "2026-10-04T12:00:05.000Z");
  assert.equal(currentExecution(f).status, "PENDING");
  assert.equal(f.store.state.attempts[0].status, "RATE_LIMITED");
});

test("terminal provider failure dead-letters child and marks execution FAILED", async () => {
  const f = fixture({
    providerResult: {
      ok: false,
      status: "FAILED",
      retryable: false,
      errorClass: "INVALID_REQUEST",
    },
  });
  const child = await fanoutOne(f);
  f.transientSources.put({
    tenantId: "tenant-1",
    messageId: "message-1",
    sourceRevision: 1,
    sourceHash: "source-hash-1",
    source: { text: "Bonjour" },
    createdAt: f.time.now(),
    expiresAt: "2026-10-04T12:05:00.000Z",
  });

  assert.equal(await f.worker.runExecuteOnce(), "FAILED");
  assert.equal(child.status, "DEAD");
  assert.equal(currentExecution(f).status, "FAILED");
});

test("stale lease at final commit rolls back translation envelopes and READY state", async () => {
  const f = fixture();
  const child = await fanoutOne(f);
  f.transientSources.put({
    tenantId: "tenant-1",
    messageId: "message-1",
    sourceRevision: 1,
    sourceHash: "source-hash-1",
    source: { text: "Bonjour" },
    createdAt: f.time.now(),
    expiresAt: "2026-10-04T12:05:00.000Z",
  });
  f.store.forceCompleteStale = true;

  assert.equal(
    await f.worker.runExecuteOnce(),
    "STALE_LEASE",
  );
  assert.equal(currentExecution(f).status, "PENDING");
  assert.equal(f.store.state.envelopes.length, 0);
  assert.equal(f.store.state.events.length, 0);
  assert.equal(child.status, "LEASED");
  assert.equal(f.store.state.attempts[0].status, "SUCCEEDED");
});


test("source-required control does not backfill old message metadata to a newly added device", async () => {
  const f = fixture();
  await fanoutOne(f);

  f.store.devices.push({
    deviceId: "device-b-new",
    credentialVersion: 1,
    publicMaterialRef: "pub:b-new",
  });

  assert.equal(
    await f.worker.runExecuteOnce(),
    "SOURCE_REQUIRED",
  );

  const controlEvents = f.store.state.events.filter(
    (event) => event.eventType === "translation.source_required",
  );
  assert.deepEqual(
    controlEvents.map((event) => event.deviceId),
    ["device-b1"],
  );
  assert.equal(
    controlEvents.some(
      (event) => event.deviceId === "device-b-new",
    ),
    false,
  );
});


test("fanout normalizes a stale outbox source hash from the authoritative message revision", async () => {
  const f = fixture();
  f.store.state.jobs[0].payloadRef.source_hash =
    "stale-or-corrupted-outbox-hash";
  f.store.fanoutPlan.sourceHash = "source-hash-authoritative";

  assert.equal(
    await f.worker.runFanoutOnce(),
    "FANOUT_DONE",
  );

  const child = f.store.state.jobs.find(
    (job) => job.jobType === "translation.execute",
  );
  assert.ok(child);
  assert.equal(
    child.payloadRef.source_hash,
    "source-hash-authoritative",
  );
  assert.notEqual(
    child.payloadRef.source_hash,
    f.store.state.jobs[0].payloadRef.source_hash,
  );
});


test("translation publish never backfills an old message to a newly added device", async () => {
  const f = fixture();
  await fanoutOne(f);

  f.transientSources.put({
    tenantId: "tenant-1",
    messageId: "message-1",
    sourceRevision: 1,
    sourceHash: "source-hash-1",
    source: {
      text: "Bonjour monde",
      language_hint: "fr-FR",
    },
    createdAt: "2026-10-04T12:00:00.000Z",
    expiresAt: "2026-10-04T12:05:00.000Z",
  });

  f.store.devices.push({
    deviceId: "device-b-new",
    credentialVersion: 1,
    publicMaterialRef: "pub:b-new",
  });

  assert.equal(
    await f.worker.runExecuteOnce(),
    "EXECUTION_DONE",
  );

  const translationEnvelopes =
    f.store.state.envelopes.filter(
      (envelope) => envelope.renditionType === "TRANSLATION",
    );

  assert.equal(
    translationEnvelopes.some(
      (envelope) =>
        envelope.recipientDeviceId === "device-b-new",
    ),
    false,
  );
  assert.equal(
    translationEnvelopes.some(
      (envelope) =>
        envelope.recipientDeviceId === "device-b1",
    ),
    true,
  );
});

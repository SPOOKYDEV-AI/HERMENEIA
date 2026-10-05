import test from "node:test";
import assert from "node:assert/strict";

import {
  createInitialContextState,
  registerContextOperation,
} from "../.build/packages/context-state/src/index.js";
import {
  ContextStateWorkerService,
} from "../.build/packages/context-state-worker/src/index.js";
import {
  PersistentOutboxService,
} from "../.build/packages/outbox-service/src/index.js";

function clone(value) {
  return structuredClone(value);
}

class FakeContextWorkerStore {
  constructor(state, jobs) {
    this.state = clone(state);
    this.jobs = clone(jobs);
    this.forceStaleComplete = false;
  }

  async withTransaction(work) {
    const beforeState = clone(this.state);
    const beforeJobs = clone(this.jobs);
    try {
      return await work({ id: "tx" });
    } catch (error) {
      this.state = beforeState;
      this.jobs = beforeJobs;
      throw error;
    }
  }

  async loadState(_tx, input) {
    if (
      this.state.tenantId !== input.tenantId ||
      this.state.conversationId !== input.conversationId
    ) {
      return undefined;
    }
    return clone(this.state);
  }

  async updateState(_tx, input) {
    if (
      this.state.stateVersion !==
      input.expectedStateVersion
    ) {
      return false;
    }
    this.state = clone(input.state);
    return true;
  }

  async leaseNextJob(_tx, input) {
    const now = Date.parse(input.now);
    const job = this.jobs.find(
      (candidate) =>
        candidate.jobType === input.jobType &&
        candidate.status === "AVAILABLE" &&
        Date.parse(candidate.availableAt) <= now,
    );
    if (!job) return undefined;

    job.status = "LEASED";
    job.fencingToken += 1;
    job.attemptCount += 1;
    job.leaseUntil = input.leaseUntil;
    return clone({
      jobId: job.jobId,
      tenantId: job.tenantId,
      jobType: job.jobType,
      businessKey: job.businessKey,
      payloadRef: job.payloadRef,
      priority: job.priority,
      fencingToken: job.fencingToken,
      attemptCount: job.attemptCount,
      leaseUntil: job.leaseUntil,
    });
  }

  async completeJob(_tx, input) {
    if (this.forceStaleComplete) return false;
    const job = this.jobs.find(
      (candidate) =>
        candidate.tenantId === input.tenantId &&
        candidate.jobId === input.jobId &&
        candidate.status === "LEASED" &&
        candidate.fencingToken ===
          input.fencingToken,
    );
    if (!job) return false;
    job.status = "DONE";
    job.completedAt = input.now;
    job.leaseUntil = null;
    return true;
  }

  async retryJob(_tx, input) {
    const job = this.jobs.find(
      (candidate) =>
        candidate.tenantId === input.tenantId &&
        candidate.jobId === input.jobId &&
        candidate.status === "LEASED" &&
        candidate.fencingToken ===
          input.fencingToken,
    );
    if (!job) return false;
    job.status = "AVAILABLE";
    job.availableAt = input.availableAt;
    job.leaseUntil = null;
    return true;
  }

  async deadLetterJob(_tx, input) {
    const job = this.jobs.find(
      (candidate) =>
        candidate.tenantId === input.tenantId &&
        candidate.jobId === input.jobId &&
        candidate.status === "LEASED" &&
        candidate.fencingToken ===
          input.fencingToken,
    );
    if (!job) return false;
    job.status = "DEAD";
    job.completedAt = input.now;
    job.leaseUntil = null;
    return true;
  }
}

function stateWithOperations(opSeqs) {
  let state = createInitialContextState({
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    membershipEpoch: 0,
    erasureEpoch: 0,
    policyVersion: 1,
    strategyVersion: "context-state-v1",
    now: "2026-10-05T09:00:00.000Z",
  });

  for (const opSeq of opSeqs) {
    state = registerContextOperation(state, {
      opSeq,
      operationId: `op-${opSeq}`,
      kind: "MESSAGE_CREATED",
      messageId: `message-${opSeq}`,
      sourceRevision: 1,
      registeredAt:
        `2026-10-05T09:00:0${opSeq}.000Z`,
    });
  }

  return state;
}

function job(opSeq, overrides = {}) {
  return {
    jobId: `job-${opSeq}`,
    tenantId: "tenant-1",
    jobType: "context.reduce",
    businessKey: `conversation-1:${opSeq}`,
    payloadRef: {
      conversation_id: "conversation-1",
      operation_id: `op-${opSeq}`,
      op_seq: opSeq,
    },
    priority: 20,
    status: "AVAILABLE",
    fencingToken: 0,
    attemptCount: 0,
    availableAt: "2026-10-05T09:00:00.000Z",
    leaseUntil: null,
    completedAt: null,
    ...overrides,
  };
}

function fixture(state, jobs) {
  let now = "2026-10-05T09:01:00.000Z";
  const clock = {
    now() {
      return now;
    },
  };
  const store = new FakeContextWorkerStore(
    state,
    jobs,
  );
  const outbox = new PersistentOutboxService(
    store,
    clock,
    { leaseSeconds: 30 },
  );
  const worker = new ContextStateWorkerService({
    store,
    outbox,
    clock,
    retryBaseSeconds: 1,
    maxAttempts: 4,
  });

  return {
    worker,
    store,
    setNow(value) {
      now = value;
    },
  };
}

test("context reducer advances the durable operation prefix and completes the fenced job atomically", async () => {
  const { worker, store } = fixture(
    stateWithOperations([1]),
    [job(1)],
  );

  assert.equal(await worker.runOnce(), "REDUCED");
  assert.equal(store.state.processedPrefixOpSeq, 1);
  assert.deepEqual(store.state.pendingOperations, []);
  assert.equal(store.jobs[0].status, "DONE");
});

test("out-of-order context job is retried until its causal predecessor closes the gap", async () => {
  const { worker, store, setNow } = fixture(
    stateWithOperations([1, 2]),
    [job(2), job(1)],
  );

  assert.equal(
    await worker.runOnce(),
    "RETRY_SCHEDULED",
  );
  assert.equal(store.state.processedPrefixOpSeq, 0);
  assert.equal(store.jobs[0].status, "AVAILABLE");
  assert.equal(store.jobs[1].status, "AVAILABLE");

  assert.equal(await worker.runOnce(), "REDUCED");
  assert.equal(store.state.processedPrefixOpSeq, 1);

  setNow("2026-10-05T09:01:02.000Z");
  assert.equal(await worker.runOnce(), "REDUCED");
  assert.equal(store.state.processedPrefixOpSeq, 2);
  assert.deepEqual(store.state.pendingOperations, []);
});

test("already reduced context job completes idempotently without mutating state version", async () => {
  const state = stateWithOperations([1]);
  const first = fixture(state, [job(1)]);
  assert.equal(await first.worker.runOnce(), "REDUCED");

  const version = first.store.state.stateVersion;
  first.store.jobs.push(job(1, { jobId: "job-replay" }));

  assert.equal(
    await first.worker.runOnce(),
    "ALREADY_REDUCED",
  );
  assert.equal(first.store.state.stateVersion, version);
  assert.equal(
    first.store.jobs.find(
      (candidate) => candidate.jobId === "job-replay",
    ).status,
    "DONE",
  );
});

test("stale outbox completion rolls back the ContextState prefix update", async () => {
  const { worker, store } = fixture(
    stateWithOperations([1]),
    [job(1)],
  );
  store.forceStaleComplete = true;
  const before = clone(store.state);

  assert.equal(
    await worker.runOnce(),
    "STALE_LEASE",
  );
  assert.deepEqual(store.state, before);
});

test("malformed context.reduce payload is dead-lettered without touching state", async () => {
  const malformed = job(1);
  malformed.payloadRef = {
    conversation_id: "conversation-1",
    operation_id: "",
    op_seq: 1,
  };
  const { worker, store } = fixture(
    stateWithOperations([1]),
    [malformed],
  );
  const before = clone(store.state);

  assert.equal(await worker.runOnce(), "DEAD");
  assert.deepEqual(store.state, before);
  assert.equal(store.jobs[0].status, "DEAD");
});

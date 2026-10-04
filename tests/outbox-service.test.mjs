import test from "node:test";
import assert from "node:assert/strict";

import {
  PersistentOutboxService,
} from "../.build/packages/outbox-service/src/index.js";

function clone(value) {
  return structuredClone(value);
}

class FakeOutboxStore {
  constructor(job = {}) {
    this.job = {
      jobId: "job-1",
      tenantId: "tenant-1",
      jobType: "translation.request",
      businessKey: "message-1:1",
      payloadRef: {
        message_id: "message-1",
        source_revision: 1,
      },
      priority: 10,
      status: "AVAILABLE",
      availableAt: "2026-10-04T10:00:00.000Z",
      leaseUntil: null,
      fencingToken: 0,
      attemptCount: 0,
      completedAt: null,
      ...job,
    };
  }

  async withTransaction(work) {
    return work({ id: "tx" });
  }

  async leaseNextJob(_tx, input) {
    if (this.job.jobType !== input.jobType) return undefined;

    const eligible =
      (
        this.job.status === "AVAILABLE" &&
        Date.parse(this.job.availableAt) <= Date.parse(input.now)
      ) ||
      (
        this.job.status === "LEASED" &&
        this.job.leaseUntil &&
        Date.parse(this.job.leaseUntil) <= Date.parse(input.now)
      );

    if (!eligible) return undefined;

    this.job.status = "LEASED";
    this.job.leaseUntil = input.leaseUntil;
    this.job.fencingToken += 1;
    this.job.attemptCount += 1;
    this.job.completedAt = null;

    return {
      jobId: this.job.jobId,
      tenantId: this.job.tenantId,
      jobType: this.job.jobType,
      businessKey: this.job.businessKey,
      payloadRef: clone(this.job.payloadRef),
      priority: this.job.priority,
      fencingToken: this.job.fencingToken,
      attemptCount: this.job.attemptCount,
      leaseUntil: this.job.leaseUntil,
    };
  }

  async completeJob(_tx, input) {
    if (!this.currentLeaseMatches(input)) return false;
    this.job.status = "DONE";
    this.job.leaseUntil = null;
    this.job.completedAt = input.now;
    return true;
  }

  async retryJob(_tx, input) {
    if (!this.currentLeaseMatches(input)) return false;
    this.job.status = "AVAILABLE";
    this.job.availableAt = input.availableAt;
    this.job.leaseUntil = null;
    this.job.completedAt = null;
    return true;
  }

  async deadLetterJob(_tx, input) {
    if (!this.currentLeaseMatches(input)) return false;
    this.job.status = "DEAD";
    this.job.leaseUntil = null;
    this.job.completedAt = input.now;
    return true;
  }

  supersede(now) {
    this.job.status = "SUPERSEDED";
    this.job.completedAt = now;
    this.job.leaseUntil = null;
    this.job.fencingToken += 1;
  }

  currentLeaseMatches(input) {
    return (
      this.job.tenantId === input.tenantId &&
      this.job.jobId === input.jobId &&
      this.job.status === "LEASED" &&
      this.job.fencingToken === input.fencingToken &&
      this.job.leaseUntil &&
      Date.parse(this.job.leaseUntil) > Date.parse(input.now)
    );
  }
}

function clock(initial = "2026-10-04T10:00:00.000Z") {
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

test("outbox lease increments fencing token and attempt count", async () => {
  const store = new FakeOutboxStore();
  const time = clock();
  const service = new PersistentOutboxService(
    store,
    time,
    { leaseSeconds: 30 },
  );

  const lease = await service.leaseNext("translation.request");

  assert.equal(lease.fencingToken, 1);
  assert.equal(lease.attemptCount, 1);
  assert.equal(lease.leaseUntil, "2026-10-04T10:00:30.000Z");
  assert.equal(store.job.status, "LEASED");
});

test("expired lease can be reclaimed and invalidates the old fencing token", async () => {
  const store = new FakeOutboxStore();
  const time = clock();
  const service = new PersistentOutboxService(
    store,
    time,
    { leaseSeconds: 30 },
  );

  const first = await service.leaseNext("translation.request");
  time.set("2026-10-04T10:00:31.000Z");
  const second = await service.leaseNext("translation.request");

  assert.equal(second.fencingToken, 2);
  assert.equal(second.attemptCount, 2);
  assert.equal(
    await service.complete(first),
    "STALE_LEASE",
  );
  assert.equal(
    await service.complete(second),
    "COMPLETED",
  );
});

test("superseded leased work cannot commit a stale completion", async () => {
  const store = new FakeOutboxStore();
  const time = clock();
  const service = new PersistentOutboxService(
    store,
    time,
    { leaseSeconds: 60 },
  );

  const lease = await service.leaseNext("translation.request");
  store.supersede("2026-10-04T10:00:05.000Z");

  assert.equal(
    await service.complete(lease),
    "STALE_LEASE",
  );
  assert.equal(store.job.status, "SUPERSEDED");
});

test("retry requeues only the current live lease", async () => {
  const store = new FakeOutboxStore();
  const time = clock();
  const service = new PersistentOutboxService(
    store,
    time,
    { leaseSeconds: 30 },
  );

  const lease = await service.leaseNext("translation.request");
  assert.equal(
    await service.retry(
      lease,
      "2026-10-04T10:01:00.000Z",
    ),
    "REQUEUED",
  );
  assert.equal(store.job.status, "AVAILABLE");
  assert.equal(store.job.availableAt, "2026-10-04T10:01:00.000Z");

  assert.equal(
    await service.complete(lease),
    "STALE_LEASE",
  );
});

test("dead-letter transition is fenced by the active lease", async () => {
  const store = new FakeOutboxStore();
  const time = clock();
  const service = new PersistentOutboxService(
    store,
    time,
    { leaseSeconds: 30 },
  );

  const lease = await service.leaseNext("translation.request");
  assert.equal(await service.deadLetter(lease), "DEAD");
  assert.equal(store.job.status, "DEAD");
  assert.equal(
    await service.deadLetter(lease),
    "STALE_LEASE",
  );
});

test("invalid lease duration and timestamps fail closed", async () => {
  const store = new FakeOutboxStore();
  const badClock = clock("not-a-date");

  assert.throws(
    () =>
      new PersistentOutboxService(
        store,
        badClock,
        { leaseSeconds: 0 },
      ),
    /leaseSeconds/,
  );

  const service = new PersistentOutboxService(
    store,
    badClock,
  );
  await assert.rejects(
    () => service.leaseNext("translation.request"),
    /invalid timestamp/,
  );
});

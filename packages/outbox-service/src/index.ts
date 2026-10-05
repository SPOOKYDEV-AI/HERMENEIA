import type { UUID } from "../../domain/src/index.js";

export interface OutboxJobLease {
  jobId: UUID;
  tenantId: UUID;
  jobType: string;
  businessKey: string;
  payloadRef: Record<string, unknown>;
  priority: number;
  fencingToken: number;
  attemptCount: number;
  leaseUntil: string;
}

export interface PersistentOutboxStore<Tx> {
  withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

  leaseNextJob(
    tx: Tx,
    input: {
      jobType: string;
      now: string;
      leaseUntil: string;
    },
  ): Promise<OutboxJobLease | undefined>;

  completeJob(
    tx: Tx,
    input: {
      tenantId: UUID;
      jobId: UUID;
      fencingToken: number;
      now: string;
    },
  ): Promise<boolean>;

  retryJob(
    tx: Tx,
    input: {
      tenantId: UUID;
      jobId: UUID;
      fencingToken: number;
      now: string;
      availableAt: string;
    },
  ): Promise<boolean>;

  deadLetterJob(
    tx: Tx,
    input: {
      tenantId: UUID;
      jobId: UUID;
      fencingToken: number;
      now: string;
    },
  ): Promise<boolean>;
}

export interface PersistentOutboxClock {
  now(): string;
}

export class PersistentOutboxService<Tx> {
  private readonly leaseSeconds: number;

  constructor(
    private readonly store: PersistentOutboxStore<Tx>,
    private readonly clock: PersistentOutboxClock,
    options: { leaseSeconds?: number } = {},
  ) {
    this.leaseSeconds = options.leaseSeconds ?? 30;
    if (
      !Number.isInteger(this.leaseSeconds) ||
      this.leaseSeconds < 1 ||
      this.leaseSeconds > 15 * 60
    ) {
      throw new TypeError(
        "leaseSeconds must be an integer between 1 and 900",
      );
    }
  }

  async leaseNext(jobType: string): Promise<OutboxJobLease | undefined> {
    if (typeof jobType !== "string" || !jobType) {
      throw new TypeError("jobType is required");
    }

    const now = this.clock.now();
    assertTimestamp(now, "Clock");
    const leaseUntil = addSeconds(now, this.leaseSeconds);

    return this.store.withTransaction((tx) =>
      this.store.leaseNextJob(tx, {
        jobType,
        now,
        leaseUntil,
      }),
    );
  }

  async complete(
    lease: Pick<
      OutboxJobLease,
      "tenantId" | "jobId" | "fencingToken"
    >,
  ): Promise<"COMPLETED" | "STALE_LEASE"> {
    const now = this.clock.now();
    assertTimestamp(now, "Clock");

    const completed = await this.store.withTransaction((tx) =>
      this.store.completeJob(tx, {
        tenantId: lease.tenantId,
        jobId: lease.jobId,
        fencingToken: lease.fencingToken,
        now,
      }),
    );

    return completed ? "COMPLETED" : "STALE_LEASE";
  }

  async retry(
    lease: Pick<
      OutboxJobLease,
      "tenantId" | "jobId" | "fencingToken"
    >,
    availableAt: string,
  ): Promise<"REQUEUED" | "STALE_LEASE"> {
    assertTimestamp(availableAt, "availableAt");
    const now = this.clock.now();
    assertTimestamp(now, "Clock");

    const requeued = await this.store.withTransaction((tx) =>
      this.store.retryJob(tx, {
        tenantId: lease.tenantId,
        jobId: lease.jobId,
        fencingToken: lease.fencingToken,
        now,
        availableAt,
      }),
    );

    return requeued ? "REQUEUED" : "STALE_LEASE";
  }

  async deadLetter(
    lease: Pick<
      OutboxJobLease,
      "tenantId" | "jobId" | "fencingToken"
    >,
  ): Promise<"DEAD" | "STALE_LEASE"> {
    const now = this.clock.now();
    assertTimestamp(now, "Clock");

    const dead = await this.store.withTransaction((tx) =>
      this.store.deadLetterJob(tx, {
        tenantId: lease.tenantId,
        jobId: lease.jobId,
        fencingToken: lease.fencingToken,
        now,
      }),
    );

    return dead ? "DEAD" : "STALE_LEASE";
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} returned an invalid timestamp`);
  }
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1000).toISOString();
}

import type { UUID } from "../../domain/src/index.js";
import {
  ContextEngine,
  type BuildContextInput,
  type ContextBuildResult,
  type ContextSnapshot,
  type ContextStrategy,
  type SelectedContextItem,
} from "../../context-engine/src/index.js";

export interface ContextPreparationClock {
  now(): string;
}

export interface ContextPreparationIds {
  next(prefix: string): UUID;
}

export interface ContextSnapshotStore<Tx> {
  withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

  insertContextSnapshot(
    tx: Tx,
    tenantId: UUID,
    snapshot: ContextSnapshot,
  ): Promise<boolean>;

  getContextSnapshot(
    tx: Tx,
    tenantId: UUID,
    snapshotId: UUID,
  ): Promise<ContextSnapshot | undefined>;
}

export interface ContextPayloadRecord {
  tenantId: UUID;
  snapshotId: UUID;
  selected: SelectedContextItem[];
  createdAt: string;
  expiresAt: string;
}

export interface ContextPayloadStore {
  put(
    record: ContextPayloadRecord,
  ): boolean | Promise<boolean>;

  get(input: {
    tenantId: UUID;
    snapshotId: UUID;
  }): ContextPayloadRecord | undefined | Promise<ContextPayloadRecord | undefined>;

  remove(input: {
    tenantId: UUID;
    snapshotId: UUID;
  }): void | Promise<void>;
}

export interface PrepareContextInput
  extends Omit<BuildContextInput, "snapshotId" | "now"> {
  tenantId: UUID;
}

export type ContextDegradedReason =
  | "CONTEXT_PAYLOAD_UNAVAILABLE";

export interface ContextPreparationResult
  extends ContextBuildResult {
  requestedStrategy: ContextStrategy;
  effectiveStrategy: ContextStrategy;
  degradedReason: ContextDegradedReason | null;
}

export type ContextResolutionResult =
  | {
      status: "READY";
      snapshot: ContextSnapshot;
      selected: SelectedContextItem[];
    }
  | {
      status: "MISSING_SNAPSHOT";
    }
  | {
      status: "PAYLOAD_UNAVAILABLE";
      snapshot: ContextSnapshot;
    }
  | {
      status: "PAYLOAD_INTEGRITY_MISMATCH";
      snapshot: ContextSnapshot;
    };

export interface ContextPreparationDependencies<Tx> {
  engine: ContextEngine;
  store: ContextSnapshotStore<Tx>;
  payloads: ContextPayloadStore;
  ids: ContextPreparationIds;
  clock: ContextPreparationClock;
  payloadTtlSeconds?: number;
}

export class ContextPreparationService<Tx> {
  private readonly payloadTtlSeconds: number;

  constructor(
    private readonly deps: ContextPreparationDependencies<Tx>,
  ) {
    this.payloadTtlSeconds =
      deps.payloadTtlSeconds ?? 5 * 60;

    if (
      !Number.isInteger(this.payloadTtlSeconds) ||
      this.payloadTtlSeconds < 1
    ) {
      throw new TypeError(
        "payloadTtlSeconds must be a positive integer",
      );
    }
  }

  async prepare(
    input: PrepareContextInput,
  ): Promise<ContextPreparationResult> {
    if (!input.tenantId) {
      throw new TypeError("tenantId is required");
    }

    const now = this.deps.clock.now();
    if (!Number.isFinite(Date.parse(now))) {
      throw new TypeError(
        "Context preparation clock returned an invalid timestamp",
      );
    }

    const snapshotId = this.deps.ids.next("ctx");
    if (!snapshotId) {
      throw new Error(
        "Context snapshot id factory returned an empty id",
      );
    }

    const requestedStrategy = input.strategy;
    let built = this.deps.engine.build({
      ...input,
      snapshotId,
      now,
    });

    let payloadAdmitted = false;
    let degradedReason: ContextDegradedReason | null =
      null;

    if (built.selected.length > 0) {
      payloadAdmitted = await this.bestEffortPutPayload({
        tenantId: input.tenantId,
        snapshotId,
        selected: built.selected,
        createdAt: now,
        expiresAt: addSeconds(
          now,
          this.payloadTtlSeconds,
        ),
      });

      if (!payloadAdmitted) {
        degradedReason =
          "CONTEXT_PAYLOAD_UNAVAILABLE";

        built = this.deps.engine.build({
          ...input,
          strategy: "T0",
          snapshotId,
          now,
        });
      }
    }

    try {
      const inserted =
        await this.deps.store.withTransaction((tx) =>
          this.deps.store.insertContextSnapshot(
            tx,
            input.tenantId,
            built.snapshot,
          ),
        );

      if (!inserted) {
        throw new Error(
          "Context snapshot identifier already exists",
        );
      }
    } catch (error) {
      if (payloadAdmitted) {
        try {
          await this.deps.payloads.remove({
            tenantId: input.tenantId,
            snapshotId,
          });
        } catch {
          // TTL remains the privacy fallback if cleanup fails.
        }
      }
      throw error;
    }

    return {
      ...built,
      requestedStrategy,
      effectiveStrategy: built.snapshot.strategy,
      degradedReason,
    };
  }

  async resolveForProvider(input: {
    tenantId: UUID;
    snapshotId: UUID;
  }): Promise<ContextResolutionResult> {
    const snapshot =
      await this.deps.store.withTransaction((tx) =>
        this.deps.store.getContextSnapshot(
          tx,
          input.tenantId,
          input.snapshotId,
        ),
      );

    if (!snapshot) {
      return {
        status: "MISSING_SNAPSHOT",
      };
    }

    if (snapshot.selectedCandidateIds.length === 0) {
      return {
        status: "READY",
        snapshot,
        selected: [],
      };
    }

    let payload: ContextPayloadRecord | undefined;
    try {
      payload = await this.deps.payloads.get(input);
    } catch {
      payload = undefined;
    }

    if (!payload) {
      return {
        status: "PAYLOAD_UNAVAILABLE",
        snapshot,
      };
    }

    const payloadIds = payload.selected.map(
      (item) => item.candidateId,
    );
    const payloadTokens = payload.selected.reduce(
      (sum, item) => sum + item.tokenEstimate,
      0,
    );

    if (
      !sameOrderedStrings(
        payloadIds,
        snapshot.selectedCandidateIds,
      ) ||
      payloadTokens !== snapshot.tokenEstimate
    ) {
      return {
        status: "PAYLOAD_INTEGRITY_MISMATCH",
        snapshot,
      };
    }

    return {
      status: "READY",
      snapshot,
      selected: payload.selected.map((item) => ({
        ...item,
      })),
    };
  }

  private async bestEffortPutPayload(
    record: ContextPayloadRecord,
  ): Promise<boolean> {
    try {
      return Boolean(
        await this.deps.payloads.put(record),
      );
    } catch {
      return false;
    }
  }
}

export interface InMemoryContextPayloadStoreOptions {
  clock: ContextPreparationClock;
  maxEntries?: number;
  maxTotalChars?: number;
}

export class InMemoryContextPayloadStore
  implements ContextPayloadStore {
  private readonly records =
    new Map<string, ContextPayloadRecord>();
  private readonly maxEntries: number;
  private readonly maxTotalChars: number;
  private totalChars = 0;

  constructor(
    private readonly options: InMemoryContextPayloadStoreOptions,
  ) {
    this.maxEntries = options.maxEntries ?? 1_000;
    this.maxTotalChars =
      options.maxTotalChars ?? 5_000_000;

    if (
      !Number.isInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      !Number.isInteger(this.maxTotalChars) ||
      this.maxTotalChars < 1
    ) {
      throw new TypeError(
        "Context payload limits must be positive integers",
      );
    }
  }

  put(record: ContextPayloadRecord): boolean {
    this.purgeExpired();

    if (
      !record.tenantId ||
      !record.snapshotId ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      !Number.isFinite(Date.parse(record.expiresAt)) ||
      Date.parse(record.expiresAt) <=
        Date.parse(record.createdAt)
    ) {
      throw new TypeError(
        "Invalid context payload record",
      );
    }

    const key = this.key(
      record.tenantId,
      record.snapshotId,
    );

    if (this.records.has(key)) {
      return false;
    }

    const chars = payloadChars(record.selected);
    if (
      this.records.size + 1 > this.maxEntries ||
      this.totalChars + chars > this.maxTotalChars
    ) {
      return false;
    }

    this.records.set(
      key,
      clonePayload(record),
    );
    this.totalChars += chars;
    return true;
  }

  get(input: {
    tenantId: UUID;
    snapshotId: UUID;
  }): ContextPayloadRecord | undefined {
    this.purgeExpired();
    const record = this.records.get(
      this.key(input.tenantId, input.snapshotId),
    );
    return record
      ? clonePayload(record)
      : undefined;
  }

  remove(input: {
    tenantId: UUID;
    snapshotId: UUID;
  }): void {
    const key = this.key(
      input.tenantId,
      input.snapshotId,
    );
    const existing = this.records.get(key);
    if (!existing) return;

    this.totalChars -=
      payloadChars(existing.selected);
    this.records.delete(key);
  }

  stats(): {
    entries: number;
    totalChars: number;
  } {
    this.purgeExpired();
    return {
      entries: this.records.size,
      totalChars: this.totalChars,
    };
  }

  private purgeExpired(): void {
    const now = Date.parse(this.options.clock.now());
    if (!Number.isFinite(now)) {
      throw new TypeError(
        "Context payload clock returned an invalid timestamp",
      );
    }

    for (const [key, record] of this.records) {
      if (Date.parse(record.expiresAt) <= now) {
        this.totalChars -=
          payloadChars(record.selected);
        this.records.delete(key);
      }
    }
  }

  private key(
    tenantId: UUID,
    snapshotId: UUID,
  ): string {
    return `${tenantId}:${snapshotId}`;
  }
}

function payloadChars(
  selected: SelectedContextItem[],
): number {
  return selected.reduce(
    (sum, item) => sum + item.content.length,
    0,
  );
}

function clonePayload(
  record: ContextPayloadRecord,
): ContextPayloadRecord {
  return {
    ...record,
    selected: record.selected.map((item) => ({
      ...item,
    })),
  };
}

function addSeconds(
  timestamp: string,
  seconds: number,
): string {
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) {
    throw new TypeError("Invalid timestamp");
  }
  return new Date(
    millis + seconds * 1_000,
  ).toISOString();
}


function sameOrderedStrings(
  left: string[],
  right: string[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) => value === right[index],
    )
  );
}

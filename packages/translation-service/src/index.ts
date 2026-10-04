import type { UUID } from "../../domain/src/index.js";

export type TranslationExecutionStatus =
  | "PENDING"
  | "READY"
  | "FAILED"
  | "SOURCE_REQUIRED"
  | "EXPIRED"
  | "SUPERSEDED";

export type ProviderExecutionStatus =
  | "STARTED"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "RATE_LIMITED"
  | "CANCELLED_LOGICALLY";

export interface TranslationLogicalKey {
  tenantId: UUID;
  conversationId: UUID;
  sourceMessageId: UUID;
  sourceRevision: number;
  recipientUserId: UUID;
  targetLanguageTag: string;
  targetProfileVersion: number;
  contextSnapshotId: UUID | null;
  strategyVersion: string;
}

export interface TranslationExecutionRecord
  extends TranslationLogicalKey {
  translationId: UUID;
  status: TranslationExecutionStatus;
  nextAttemptAt: string | null;
  createdAt: string;
  readyAt: string | null;
  supersededAt: string | null;
}

export interface ProviderExecutionRecord {
  tenantId: UUID;
  attemptId: UUID;
  translationId: UUID;
  attemptNo: number;
  providerId: string;
  modelId: string;
  providerRegion: string | null;
  status: ProviderExecutionStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  billedCostMicrounits: number | null;
  latencyMs: number | null;
  errorClass: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface TranslationExecutionStore<Tx> {
  withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

  findTranslationExecution(
    tx: Tx,
    key: TranslationLogicalKey,
  ): Promise<TranslationExecutionRecord | undefined>;

  insertTranslationExecution(
    tx: Tx,
    input: TranslationExecutionRecord,
  ): Promise<TranslationExecutionRecord | undefined>;

  lockTranslationExecution(
    tx: Tx,
    tenantId: UUID,
    translationId: UUID,
  ): Promise<TranslationExecutionRecord | undefined>;

  markSourceRequired(
    tx: Tx,
    input: {
      tenantId: UUID;
      translationId: UUID;
    },
  ): Promise<boolean>;

  nextProviderAttemptNumber(
    tx: Tx,
    tenantId: UUID,
    translationId: UUID,
  ): Promise<number>;

  insertProviderExecution(
    tx: Tx,
    input: ProviderExecutionRecord,
  ): Promise<void>;

  completeProviderExecution(
    tx: Tx,
    input: {
      tenantId: UUID;
      attemptId: UUID;
      status: Exclude<ProviderExecutionStatus, "STARTED">;
      inputTokens?: number | null;
      outputTokens?: number | null;
      billedCostMicrounits?: number | null;
      latencyMs?: number | null;
      errorClass?: string | null;
      completedAt: string;
    },
  ): Promise<boolean>;
}

export interface TranslationExecutionIdFactory {
  next(prefix: string): UUID;
}

export interface TranslationExecutionClock {
  now(): string;
}

export class TranslationExecutionService<Tx> {
  constructor(
    private readonly store: TranslationExecutionStore<Tx>,
    private readonly ids: TranslationExecutionIdFactory,
    private readonly clock: TranslationExecutionClock,
  ) {}

  async ensurePending(
    key: TranslationLogicalKey,
  ): Promise<TranslationExecutionRecord> {
    validateLogicalKey(key);
    const now = this.clock.now();
    assertTimestamp(now, "Clock");

    return this.store.withTransaction(async (tx) => {
      const existing = await this.store.findTranslationExecution(
        tx,
        key,
      );
      if (existing) return existing;

      const proposed: TranslationExecutionRecord = {
        ...key,
        translationId: this.ids.next("trn"),
        status: "PENDING",
        nextAttemptAt: null,
        createdAt: now,
        readyAt: null,
        supersededAt: null,
      };

      const inserted =
        await this.store.insertTranslationExecution(tx, proposed);
      if (inserted) return inserted;

      const raced = await this.store.findTranslationExecution(
        tx,
        key,
      );
      if (!raced) {
        throw new Error(
          "Invariant violation: translation execution conflict without visible winner",
        );
      }
      return raced;
    });
  }

  async requireSource(
    tenantId: UUID,
    translationId: UUID,
  ): Promise<"SOURCE_REQUIRED" | "UNCHANGED" | "NOT_FOUND"> {
    return this.store.withTransaction(async (tx) => {
      const execution =
        await this.store.lockTranslationExecution(
          tx,
          tenantId,
          translationId,
        );
      if (!execution) return "NOT_FOUND";
      if (execution.status === "SOURCE_REQUIRED") {
        return "UNCHANGED";
      }
      if (execution.status !== "PENDING") {
        return "UNCHANGED";
      }

      const updated = await this.store.markSourceRequired(tx, {
        tenantId,
        translationId,
      });
      if (!updated) {
        throw new Error(
          "Invariant violation: locked translation execution was not updated",
        );
      }
      return "SOURCE_REQUIRED";
    });
  }

  async startProviderAttempt(input: {
    tenantId: UUID;
    translationId: UUID;
    providerId: string;
    modelId: string;
    providerRegion?: string | null;
  }): Promise<ProviderExecutionRecord | undefined> {
    if (!input.providerId || !input.modelId) {
      throw new TypeError("providerId and modelId are required");
    }
    const now = this.clock.now();
    assertTimestamp(now, "Clock");

    return this.store.withTransaction(async (tx) => {
      const execution =
        await this.store.lockTranslationExecution(
          tx,
          input.tenantId,
          input.translationId,
        );
      if (!execution || execution.status !== "PENDING") {
        return undefined;
      }

      const attemptNo =
        await this.store.nextProviderAttemptNumber(
          tx,
          input.tenantId,
          input.translationId,
        );

      const attempt: ProviderExecutionRecord = {
        tenantId: input.tenantId,
        attemptId: this.ids.next("pat"),
        translationId: input.translationId,
        attemptNo,
        providerId: input.providerId,
        modelId: input.modelId,
        providerRegion: input.providerRegion ?? null,
        status: "STARTED",
        inputTokens: null,
        outputTokens: null,
        billedCostMicrounits: null,
        latencyMs: null,
        errorClass: null,
        startedAt: now,
        completedAt: null,
      };

      await this.store.insertProviderExecution(tx, attempt);
      return attempt;
    });
  }

  async completeProviderAttempt(input: {
    tenantId: UUID;
    attemptId: UUID;
    status: Exclude<ProviderExecutionStatus, "STARTED">;
    inputTokens?: number | null;
    outputTokens?: number | null;
    billedCostMicrounits?: number | null;
    latencyMs?: number | null;
    errorClass?: string | null;
  }): Promise<"COMPLETED" | "STALE_ATTEMPT"> {
    if (input.status === "STARTED") {
      throw new TypeError("Provider attempt completion must be terminal");
    }
    validateOptionalCounter(input.inputTokens, "inputTokens");
    validateOptionalCounter(input.outputTokens, "outputTokens");
    validateOptionalCounter(
      input.billedCostMicrounits,
      "billedCostMicrounits",
    );
    validateOptionalCounter(input.latencyMs, "latencyMs");

    const now = this.clock.now();
    assertTimestamp(now, "Clock");

    const completed = await this.store.withTransaction((tx) =>
      this.store.completeProviderExecution(tx, {
        ...input,
        completedAt: now,
      }),
    );

    return completed ? "COMPLETED" : "STALE_ATTEMPT";
  }
}

function validateLogicalKey(key: TranslationLogicalKey): void {
  if (
    !key.tenantId ||
    !key.conversationId ||
    !key.sourceMessageId ||
    !key.recipientUserId ||
    !key.targetLanguageTag ||
    !key.strategyVersion
  ) {
    throw new TypeError("Translation logical key is incomplete");
  }
  if (!Number.isInteger(key.sourceRevision) || key.sourceRevision < 1) {
    throw new TypeError("sourceRevision must be a positive integer");
  }
  if (
    !Number.isInteger(key.targetProfileVersion) ||
    key.targetProfileVersion < 1
  ) {
    throw new TypeError(
      "targetProfileVersion must be a positive integer",
    );
  }
}

function validateOptionalCounter(
  value: number | null | undefined,
  name: string,
): void {
  if (
    value !== undefined &&
    value !== null &&
    (!Number.isInteger(value) || value < 0)
  ) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} returned an invalid timestamp`);
  }
}

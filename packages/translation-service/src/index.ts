import {
  DomainError,
  type ActorContext,
  type UUID,
} from "../../domain/src/index.js";
import type {
  SourceContent,
  SourceResupplyCommand,
  TranslationRecoveryResult,
} from "../../protocol/src/index.js";
import type {
  TransientSourceKey,
  TransientSourceStore,
} from "../../transient-source/src/index.js";

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

export interface TranslationFanoutTarget {
  recipientUserId: UUID;
  targetLanguageTag: string;
  targetProfileVersion: number;
}

export interface TranslationFanoutPlan {
  conversationId: UUID;
  sourceLanguageTag: string | null;
  targets: TranslationFanoutTarget[];
}

export interface TranslationRecipientDevice {
  deviceId: UUID;
  credentialVersion: number;
  publicMaterialRef: string;
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


export interface TranslationRecoveryRecord {
  execution: TranslationExecutionRecord;
  expectedSourceHash: string;
  messageCurrentRevision: number;
  messageStatus: "ACTIVE" | "DELETED";
  targetMembershipStatus: "ACTIVE" | "LEFT" | "REMOVED" | null;
  currentTargetProfileVersion: number | null;
  currentTargetLanguageTag: string | null;
}

export interface TranslationRecoveryCommandReceipt {
  actorUserId: UUID;
  actorDeviceId: UUID;
  commandType: string;
  commandFingerprint: string | null;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result: Record<string, unknown>;
}

export type TranslationRecoveryCommandClaim =
  | { claimed: true }
  | { claimed: false; existing: TranslationRecoveryCommandReceipt };

export type TranslationJobReactivation =
  | "REACTIVATED"
  | "ACTIVE"
  | "SUPERSEDED"
  | "NOT_FOUND";

export interface TranslationRecoveryStore<Tx> {
  withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

  claimCommand(
    tx: Tx,
    input: {
      actor: ActorContext;
      commandId: UUID;
      commandType: string;
      commandFingerprint: string;
      now: string;
    },
  ): Promise<TranslationRecoveryCommandClaim>;

  markCommandSucceeded(
    tx: Tx,
    input: {
      tenantId: UUID;
      commandId: UUID;
      actorUserId: UUID;
      actorDeviceId: UUID;
      commandType: string;
      commandFingerprint: string;
      result: Record<string, unknown>;
      now: string;
    },
  ): Promise<void>;

  lockTranslationForRecovery(
    tx: Tx,
    actor: ActorContext,
    translationId: UUID,
  ): Promise<TranslationRecoveryRecord | undefined>;

  resumeSourceRequired(
    tx: Tx,
    input: {
      tenantId: UUID;
      translationId: UUID;
    },
  ): Promise<boolean>;

  resumeFailed(
    tx: Tx,
    input: {
      tenantId: UUID;
      translationId: UUID;
    },
  ): Promise<boolean>;

  markSuperseded(
    tx: Tx,
    input: {
      tenantId: UUID;
      translationId: UUID;
      supersededAt: string;
    },
  ): Promise<boolean>;

  reactivateTranslationExecuteJob(
    tx: Tx,
    input: {
      tenantId: UUID;
      translationId: UUID;
      availableAt: string;
    },
  ): Promise<TranslationJobReactivation>;
}

export interface TranslationRecoveryFingerprinter {
  fingerprint(source: SourceContent): string;
  matches(source: SourceContent, storedFingerprint: string): boolean;
}

export interface TranslationRecoveryDependencies<Tx> {
  store: TranslationRecoveryStore<Tx>;
  transientSources: TransientSourceStore;
  fingerprinter: TranslationRecoveryFingerprinter;
  clock: TranslationExecutionClock;
  transientSourceTtlSeconds?: number;
}

interface SourceResupplyFingerprintV1 {
  v: 1;
  type: "translation.source_resupply";
  translation_id: UUID;
  message_id: UUID;
  source_revision: number;
  source_ref: string;
}

export class TranslationRecoveryService<Tx> {
  private readonly transientSourceTtlSeconds: number;

  constructor(private readonly deps: TranslationRecoveryDependencies<Tx>) {
    this.transientSourceTtlSeconds =
      deps.transientSourceTtlSeconds ?? 5 * 60;
    if (
      !Number.isInteger(this.transientSourceTtlSeconds) ||
      this.transientSourceTtlSeconds < 1
    ) {
      throw new TypeError(
        "transientSourceTtlSeconds must be a positive integer",
      );
    }
  }

  async resupplySource(
    actor: ActorContext,
    command: SourceResupplyCommand,
  ): Promise<TranslationRecoveryResult> {
    if (
      command.protocol_version !== 1 ||
      !command.command_id ||
      !command.translation_id ||
      !command.message_id ||
      !Number.isInteger(command.source_revision) ||
      command.source_revision < 1 ||
      typeof command.source_ref !== "string" ||
      command.source_ref.length < 16 ||
      !command.source?.text
    ) {
      throw new DomainError(
        "INVALID_COMMAND",
        "Invalid source re-supply command",
      );
    }

    const now = this.deps.clock.now();
    assertTimestamp(now, "Clock");

    const commandFingerprint = JSON.stringify({
      v: 1,
      type: "translation.source_resupply",
      translation_id: command.translation_id,
      message_id: command.message_id,
      source_revision: command.source_revision,
      source_ref: command.source_ref,
    } satisfies SourceResupplyFingerprintV1);

    let insertedTransient = false;
    const transientKey: TransientSourceKey = {
      tenantId: actor.tenantId,
      messageId: command.message_id,
      sourceRevision: command.source_revision,
    };

    try {
      const result = await this.deps.store.withTransaction(async (tx) => {
        const claim = await this.deps.store.claimCommand(tx, {
          actor,
          commandId: command.command_id,
          commandType: "translation.source_resupply",
          commandFingerprint,
          now,
        });

        if (!claim.claimed) {
          const existing = claim.existing;
          if (
            existing.actorUserId !== actor.userId ||
            existing.actorDeviceId !== actor.deviceId
          ) {
            throw new DomainError(
              "NOT_AUTHORIZED",
              "Command identifier is not available to actor",
            );
          }
          if (
            existing.commandType !== "translation.source_resupply" ||
            existing.commandFingerprint !== commandFingerprint
          ) {
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "command_id was already used for a different operation",
            );
          }
          if (existing.status !== "SUCCEEDED") {
            throw new Error(
              "Persistent source re-supply receipt is not terminal",
            );
          }
          return recoveryResultFromCommand(existing.result);
        }

        const recovery =
          await this.deps.store.lockTranslationForRecovery(
            tx,
            actor,
            command.translation_id,
          );
        if (!recovery) {
          throw new DomainError(
            "NOT_AUTHORIZED",
            "Translation is not available to actor",
          );
        }

        if (!isRecoveryCurrent(recovery)) {
          await this.bestEffortSupersede(tx, recovery.execution, now);
          return this.completeSourceCommand(
            tx,
            actor,
            command,
            commandFingerprint,
            now,
            "SUPERSEDED",
          );
        }

        if (
          recovery.execution.sourceMessageId !== command.message_id ||
          recovery.execution.sourceRevision !== command.source_revision ||
          recovery.expectedSourceHash !== command.source_ref ||
          !this.deps.fingerprinter.matches(
            command.source,
            recovery.expectedSourceHash,
          )
        ) {
          throw new DomainError(
            "SOURCE_REVISION_MISMATCH",
            "Re-supplied source does not match the requested revision",
          );
        }

        if (recovery.execution.status === "EXPIRED") {
          throw new DomainError(
            "SOURCE_EXPIRED",
            "Translation source recovery window has expired",
          );
        }
        if (recovery.execution.status === "SUPERSEDED") {
          return this.completeSourceCommand(
            tx,
            actor,
            command,
            commandFingerprint,
            now,
            "SUPERSEDED",
          );
        }
        if (recovery.execution.status === "READY") {
          return this.completeSourceCommand(
            tx,
            actor,
            command,
            commandFingerprint,
            now,
            "READY",
          );
        }
        if (recovery.execution.status === "FAILED") {
          return this.completeSourceCommand(
            tx,
            actor,
            command,
            commandFingerprint,
            now,
            "FAILED",
          );
        }
        if (
          recovery.execution.status !== "PENDING" &&
          recovery.execution.status !== "SOURCE_REQUIRED"
        ) {
          throw new Error(
            "Invariant violation: unsupported translation recovery status",
          );
        }

        const existingSource =
          await this.deps.transientSources.get(transientKey);

        if (existingSource) {
          if (
            existingSource.sourceHash !== recovery.expectedSourceHash ||
            !this.deps.fingerprinter.matches(
              existingSource.source,
              recovery.expectedSourceHash,
            )
          ) {
            throw new Error(
              "Invariant violation: transient source key contains mismatched content",
            );
          }
        } else {
          const admitted = await this.deps.transientSources.put({
            ...transientKey,
            sourceHash: recovery.expectedSourceHash,
            source: structuredClone(command.source),
            createdAt: now,
            expiresAt: addSeconds(
              now,
              this.transientSourceTtlSeconds,
            ),
          });
          if (!admitted) {
            throw new DomainError(
              "SOURCE_BUFFER_UNAVAILABLE",
              "Transient source buffer cannot admit the supplied revision",
            );
          }
          insertedTransient = true;
        }

        if (recovery.execution.status === "SOURCE_REQUIRED") {
          const resumed = await this.deps.store.resumeSourceRequired(
            tx,
            {
              tenantId: actor.tenantId,
              translationId: command.translation_id,
            },
          );
          if (!resumed) {
            throw new Error(
              "Invariant violation: SOURCE_REQUIRED translation was not resumed",
            );
          }
        }

        const jobState =
          await this.deps.store.reactivateTranslationExecuteJob(
            tx,
            {
              tenantId: actor.tenantId,
              translationId: command.translation_id,
              availableAt: now,
            },
          );
        if (
          jobState === "NOT_FOUND" ||
          jobState === "SUPERSEDED"
        ) {
          throw new Error(
            "Invariant violation: translation execute job cannot be reactivated",
          );
        }

        return this.completeSourceCommand(
          tx,
          actor,
          command,
          commandFingerprint,
          now,
          "PENDING",
        );
      });

      return result;
    } catch (error) {
      if (insertedTransient) {
        try {
          await this.deps.transientSources.remove(transientKey);
        } catch {
          // TTL remains the fallback; never mask the durable failure.
        }
      }
      throw error;
    }
  }

  async retryTranslation(
    actor: ActorContext,
    translationId: UUID,
  ): Promise<TranslationRecoveryResult> {
    if (!translationId) {
      throw new DomainError(
        "INVALID_COMMAND",
        "translation_id is required",
      );
    }

    const now = this.deps.clock.now();
    assertTimestamp(now, "Clock");

    return this.deps.store.withTransaction(async (tx) => {
      const recovery =
        await this.deps.store.lockTranslationForRecovery(
          tx,
          actor,
          translationId,
        );
      if (!recovery) {
        throw new DomainError(
          "NOT_AUTHORIZED",
          "Translation is not available to actor",
        );
      }

      if (!isRecoveryCurrent(recovery)) {
        await this.bestEffortSupersede(tx, recovery.execution, now);
        return {
          protocol_version: 1,
          translation_id: translationId,
          status: "SUPERSEDED",
        };
      }

      switch (recovery.execution.status) {
        case "READY":
          return {
            protocol_version: 1,
            translation_id: translationId,
            status: "READY",
          };
        case "SUPERSEDED":
          return {
            protocol_version: 1,
            translation_id: translationId,
            status: "SUPERSEDED",
          };
        case "EXPIRED":
          throw new DomainError(
            "SOURCE_EXPIRED",
            "Translation recovery window has expired",
          );
        case "SOURCE_REQUIRED":
          throw new DomainError(
            "SOURCE_REQUIRED",
            "Exact source re-supply is required before retry",
          );
        case "FAILED": {
          const resumed = await this.deps.store.resumeFailed(tx, {
            tenantId: actor.tenantId,
            translationId,
          });
          if (!resumed) {
            throw new Error(
              "Invariant violation: FAILED translation was not resumed",
            );
          }
          break;
        }
        case "PENDING":
          break;
        default:
          throw new Error(
            "Invariant violation: unsupported translation retry status",
          );
      }

      const jobState =
        await this.deps.store.reactivateTranslationExecuteJob(
          tx,
          {
            tenantId: actor.tenantId,
            translationId,
            availableAt: now,
          },
        );

      if (jobState === "NOT_FOUND") {
        throw new Error(
          "Invariant violation: translation execute job is missing",
        );
      }
      if (jobState === "SUPERSEDED") {
        await this.bestEffortSupersede(tx, recovery.execution, now);
        return {
          protocol_version: 1,
          translation_id: translationId,
          status: "SUPERSEDED",
        };
      }

      return {
        protocol_version: 1,
        translation_id: translationId,
        status: "PENDING",
      };
    });
  }

  private async completeSourceCommand(
    tx: Tx,
    actor: ActorContext,
    command: SourceResupplyCommand,
    commandFingerprint: string,
    now: string,
    status: TranslationRecoveryResult["status"],
  ): Promise<TranslationRecoveryResult> {
    const result: TranslationRecoveryResult = {
      protocol_version: 1,
      translation_id: command.translation_id,
      status,
    };

    await this.deps.store.markCommandSucceeded(tx, {
      tenantId: actor.tenantId,
      commandId: command.command_id,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      commandType: "translation.source_resupply",
      commandFingerprint,
      result: result as unknown as Record<string, unknown>,
      now,
    });

    return result;
  }

  private async bestEffortSupersede(
    tx: Tx,
    execution: TranslationExecutionRecord,
    now: string,
  ): Promise<void> {
    if (execution.status !== "SUPERSEDED") {
      await this.deps.store.markSuperseded(tx, {
        tenantId: execution.tenantId,
        translationId: execution.translationId,
        supersededAt: now,
      });
    }
  }
}

function recoveryResultFromCommand(
  result: Record<string, unknown>,
): TranslationRecoveryResult {
  if (
    result.protocol_version !== 1 ||
    typeof result.translation_id !== "string" ||
    ![
      "PENDING",
      "SOURCE_REQUIRED",
      "READY",
      "FAILED",
      "SUPERSEDED",
    ].includes(String(result.status))
  ) {
    throw new Error(
      "Invariant violation: invalid translation recovery command result",
    );
  }

  return {
    protocol_version: 1,
    translation_id: result.translation_id,
    status:
      result.status as TranslationRecoveryResult["status"],
  };
}

function isRecoveryCurrent(
  recovery: TranslationRecoveryRecord,
): boolean {
  const execution = recovery.execution;
  return (
    recovery.messageStatus === "ACTIVE" &&
    recovery.messageCurrentRevision === execution.sourceRevision &&
    recovery.targetMembershipStatus === "ACTIVE" &&
    recovery.currentTargetProfileVersion ===
      execution.targetProfileVersion &&
    normalizeLanguageTag(recovery.currentTargetLanguageTag) ===
      normalizeLanguageTag(execution.targetLanguageTag)
  );
}

function normalizeLanguageTag(
  value: string | null,
): string | null {
  return value ? value.trim().toLowerCase() : null;
}

function addSeconds(timestamp: string, seconds: number): string {
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) {
    throw new TypeError("Invalid timestamp");
  }
  return new Date(millis + seconds * 1000).toISOString();
}

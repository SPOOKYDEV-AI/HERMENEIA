import type { UUID } from "../../domain/src/index.js";
import type {
  OutboxJobLease,
  PersistentOutboxService,
} from "../../outbox-service/src/index.js";
import type {
  TransientSourceStore,
} from "../../transient-source/src/index.js";
import type {
  TranslationExecutionRecord,
  TranslationExecutionService,
  TranslationFanoutPlan,
  TranslationRecipientDevice,
} from "../../translation-service/src/index.js";

export interface TranslationWorkerClock {
  now(): string;
}

export interface TranslationWorkerIds {
  next(prefix: string): UUID;
}

export interface TranslationWorkerProviderSuccess {
  ok: true;
  text: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  billedCostMicrounits?: number | null;
  latencyMs?: number | null;
}

export interface TranslationWorkerProviderFailure {
  ok: false;
  status: "FAILED" | "TIMED_OUT" | "RATE_LIMITED";
  retryable: boolean;
  errorClass?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  billedCostMicrounits?: number | null;
  latencyMs?: number | null;
}

export type TranslationWorkerProviderResult =
  | TranslationWorkerProviderSuccess
  | TranslationWorkerProviderFailure;

export interface TranslationWorkerProvider {
  providerId: string;
  modelId: string;
  providerRegion?: string | null;

  translate(input: {
    source: {
      text: string;
      language_hint?: string;
    };
    targetLanguageTag: string;
    targetProfileVersion: number;
    strategyVersion: string;
    contextSnapshotId: UUID | null;
  }): Promise<TranslationWorkerProviderResult>;
}

export interface TranslationEnvelopeProtector {
  protect(input: {
    tenantId: UUID;
    conversationId: UUID;
    messageId: UUID;
    sourceRevision: number;
    translationId: UUID;
    recipientUserId: UUID;
    recipientDeviceId: UUID;
    recipientCredentialVersion: number;
    recipientPublicMaterialRef: string;
    translatedText: string;
    targetLanguageTag: string;
  }): string | Promise<string>;
}

export interface TranslationWorkerStore<Tx> {
  withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

  loadFanoutPlan(
    tx: Tx,
    input: {
      tenantId: UUID;
      sourceMessageId: UUID;
      sourceRevision: number;
    },
  ): Promise<TranslationFanoutPlan | undefined>;

  insertOutboxJob(
    tx: Tx,
    input: {
      jobId: UUID;
      tenantId: UUID;
      jobType: string;
      businessKey: string;
      payloadRef: Record<string, unknown>;
      priority: number;
      availableAt: string;
    },
  ): Promise<void>;

  lockTranslationExecution(
    tx: Tx,
    tenantId: UUID,
    translationId: UUID,
  ): Promise<TranslationExecutionRecord | undefined>;

  lockCurrentTranslationForPublish(
    tx: Tx,
    tenantId: UUID,
    translationId: UUID,
  ): Promise<TranslationExecutionRecord | undefined>;

  listRecipientControlDevices(
    tx: Tx,
    input: {
      tenantId: UUID;
      recipientUserId: UUID;
    },
  ): Promise<UUID[]>;

  listRecipientDevicesForPublish(
    tx: Tx,
    input: {
      tenantId: UUID;
      recipientUserId: UUID;
    },
  ): Promise<TranslationRecipientDevice[]>;

  markSourceRequired(
    tx: Tx,
    input: {
      tenantId: UUID;
      translationId: UUID;
    },
  ): Promise<boolean>;

  scheduleRetry(
    tx: Tx,
    input: {
      tenantId: UUID;
      translationId: UUID;
      nextAttemptAt: string;
    },
  ): Promise<boolean>;

  markFailed(
    tx: Tx,
    input: {
      tenantId: UUID;
      translationId: UUID;
    },
  ): Promise<boolean>;

  markReady(
    tx: Tx,
    input: {
      tenantId: UUID;
      translationId: UUID;
      readyAt: string;
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

  insertTranslationDeliveryEnvelope(
    tx: Tx,
    input: {
      tenantId: UUID;
      envelopeId: UUID;
      conversationId: UUID;
      messageId: UUID;
      sourceRevision: number;
      translationId: UUID;
      recipientUserId: UUID;
      recipientDeviceId: UUID;
      credentialVersion: number;
      protectedPayload: string;
      createdAt: string;
      expiresAt: string;
    },
  ): Promise<void>;

  allocateDeviceInboxOffset(
    tx: Tx,
    tenantId: UUID,
    deviceId: UUID,
  ): Promise<{ inboxEpoch: number; offset: number }>;

  insertInboxEvent(
    tx: Tx,
    input: {
      deviceId: UUID;
      inboxEpoch: number;
      offset: number;
      eventId: UUID;
      eventType:
        | "message.available"
        | "message.edited"
        | "message.deleted"
        | "translation.source_required";
      tenantId: UUID;
      conversationId: UUID;
      messageId: UUID;
      envelopeId?: UUID | null;
      sourceRevision: number;
      translationId?: UUID | null;
      sourceRef?: string | null;
      createdAt: string;
    },
  ): Promise<void>;

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

export interface TranslationWorkerDependencies<Tx> {
  store: TranslationWorkerStore<Tx>;
  outbox: PersistentOutboxService<Tx>;
  executions: TranslationExecutionService<Tx>;
  transientSources: TransientSourceStore;
  provider: TranslationWorkerProvider;
  envelopeProtector: TranslationEnvelopeProtector;
  ids: TranslationWorkerIds;
  clock: TranslationWorkerClock;
  strategyVersion?: string;
  envelopeTtlSeconds?: number;
  maxProviderAttempts?: number;
  retryBaseSeconds?: number;
}

export type TranslationWorkerResult =
  | "NO_WORK"
  | "FANOUT_DONE"
  | "EXECUTION_DONE"
  | "SOURCE_REQUIRED"
  | "RETRY_SCHEDULED"
  | "FAILED"
  | "STALE_LEASE"
  | "SUPERSEDED";

class StaleLeaseError extends Error {}

export class TranslationWorkerService<Tx> {
  private readonly strategyVersion: string;
  private readonly envelopeTtlSeconds: number;
  private readonly maxProviderAttempts: number;
  private readonly retryBaseSeconds: number;

  constructor(private readonly deps: TranslationWorkerDependencies<Tx>) {
    this.strategyVersion = deps.strategyVersion ?? "t0-v1";
    this.envelopeTtlSeconds =
      deps.envelopeTtlSeconds ?? 7 * 24 * 60 * 60;
    this.maxProviderAttempts = deps.maxProviderAttempts ?? 3;
    this.retryBaseSeconds = deps.retryBaseSeconds ?? 5;

    if (!this.strategyVersion) {
      throw new TypeError("strategyVersion is required");
    }
    if (
      !Number.isInteger(this.maxProviderAttempts) ||
      this.maxProviderAttempts < 1 ||
      this.maxProviderAttempts > 20
    ) {
      throw new TypeError(
        "maxProviderAttempts must be an integer between 1 and 20",
      );
    }
    if (
      !Number.isInteger(this.retryBaseSeconds) ||
      this.retryBaseSeconds < 1 ||
      this.retryBaseSeconds > 3600
    ) {
      throw new TypeError(
        "retryBaseSeconds must be an integer between 1 and 3600",
      );
    }
  }

  async runFanoutOnce(): Promise<TranslationWorkerResult> {
    const lease = await this.deps.outbox.leaseNext(
      "translation.request",
    );
    if (!lease) return "NO_WORK";

    try {
      const payload = parseRootPayload(lease);
      const plan = await this.deps.store.withTransaction((tx) =>
        this.deps.store.loadFanoutPlan(tx, {
          tenantId: lease.tenantId,
          sourceMessageId: payload.messageId,
          sourceRevision: payload.sourceRevision,
        }),
      );

      if (!plan) {
        return await this.completeLease(lease)
          ? "SUPERSEDED"
          : "STALE_LEASE";
      }

      for (const target of plan.targets) {
        if (
          sameLanguageTag(
            plan.sourceLanguageTag,
            target.targetLanguageTag,
          )
        ) {
          continue;
        }

        const execution = await this.deps.executions.ensurePending({
          tenantId: lease.tenantId,
          conversationId: plan.conversationId,
          sourceMessageId: payload.messageId,
          sourceRevision: payload.sourceRevision,
          recipientUserId: target.recipientUserId,
          targetLanguageTag: target.targetLanguageTag,
          targetProfileVersion: target.targetProfileVersion,
          contextSnapshotId: null,
          strategyVersion: this.strategyVersion,
        });

        if (execution.status !== "PENDING") {
          continue;
        }

        await this.deps.store.withTransaction(async (tx) => {
          const current =
            await this.deps.store.lockCurrentTranslationForPublish(
              tx,
              execution.tenantId,
              execution.translationId,
            );

          if (!current) {
            await this.deps.store.markSuperseded(tx, {
              tenantId: execution.tenantId,
              translationId: execution.translationId,
              supersededAt: this.deps.clock.now(),
            });
            return;
          }

          await this.deps.store.insertOutboxJob(tx, {
            jobId: this.deps.ids.next("job"),
            tenantId: execution.tenantId,
            jobType: "translation.execute",
            businessKey: execution.translationId,
            payloadRef: {
              translation_id: execution.translationId,
              message_id: execution.sourceMessageId,
              source_revision: execution.sourceRevision,
              source_hash: payload.sourceHash,
            },
            priority: 10,
            availableAt: this.deps.clock.now(),
          });
        });
      }

      return await this.completeLease(lease)
        ? "FANOUT_DONE"
        : "STALE_LEASE";
    } catch {
      return this.retryOrDeadLetter(lease);
    }
  }

  async runExecuteOnce(): Promise<TranslationWorkerResult> {
    const lease = await this.deps.outbox.leaseNext(
      "translation.execute",
    );
    if (!lease) return "NO_WORK";

    let payload: ExecutePayload;
    try {
      payload = parseExecutePayload(lease);
    } catch {
      return this.deadLetter(lease);
    }

    const execution = await this.deps.store.withTransaction((tx) =>
      this.deps.store.lockTranslationExecution(
        tx,
        lease.tenantId,
        payload.translationId,
      ),
    );

    if (!execution || execution.status !== "PENDING") {
      return await this.completeLease(lease)
        ? "SUPERSEDED"
        : "STALE_LEASE";
    }

    const source = await this.deps.transientSources.get({
      tenantId: lease.tenantId,
      messageId: payload.messageId,
      sourceRevision: payload.sourceRevision,
    });

    if (
      !source ||
      source.sourceHash !== payload.sourceHash
    ) {
      return this.markSourceRequiredAndComplete(
        lease,
        execution,
        payload,
      );
    }

    const preflight = await this.deps.store.withTransaction(
      async (tx) => {
        const current =
          await this.deps.store.lockCurrentTranslationForPublish(
            tx,
            execution.tenantId,
            execution.translationId,
          );
        if (!current) {
          return { current: false, hasDevices: false };
        }

        const devices =
          await this.deps.store.listRecipientDevicesForPublish(
            tx,
            {
              tenantId: execution.tenantId,
              recipientUserId: execution.recipientUserId,
            },
          );

        return {
          current: true,
          hasDevices: devices.length > 0,
        };
      },
    );

    if (!preflight.current) {
      return this.supersedeAndComplete(
        lease,
        execution,
      );
    }

    if (!preflight.hasDevices) {
      return this.scheduleExecutionRetry(
        lease,
        execution,
      );
    }

    const attempt =
      await this.deps.executions.startProviderAttempt({
        tenantId: execution.tenantId,
        translationId: execution.translationId,
        providerId: this.deps.provider.providerId,
        modelId: this.deps.provider.modelId,
        providerRegion:
          this.deps.provider.providerRegion ?? null,
      });

    if (!attempt) {
      return await this.completeLease(lease)
        ? "SUPERSEDED"
        : "STALE_LEASE";
    }

    let providerResult: TranslationWorkerProviderResult;
    try {
      providerResult = await this.deps.provider.translate({
        source: source.source,
        targetLanguageTag: execution.targetLanguageTag,
        targetProfileVersion: execution.targetProfileVersion,
        strategyVersion: execution.strategyVersion,
        contextSnapshotId: execution.contextSnapshotId,
      });
    } catch (error) {
      providerResult = {
        ok: false,
        status: "FAILED",
        retryable: true,
        errorClass:
          error instanceof Error
            ? error.name || "ProviderError"
            : "ProviderError",
      };
    }

    if (!providerResult.ok) {
      const completion =
        await this.deps.executions.completeProviderAttempt({
          tenantId: execution.tenantId,
          attemptId: attempt.attemptId,
          status: providerResult.status,
          inputTokens: providerResult.inputTokens ?? null,
          outputTokens: providerResult.outputTokens ?? null,
          billedCostMicrounits:
            providerResult.billedCostMicrounits ?? null,
          latencyMs: providerResult.latencyMs ?? null,
          errorClass: providerResult.errorClass ?? null,
        });
      if (completion === "STALE_ATTEMPT") {
        return "SUPERSEDED";
      }

      if (
        providerResult.retryable &&
        lease.attemptCount < this.maxProviderAttempts
      ) {
        return this.scheduleExecutionRetry(
          lease,
          execution,
        );
      }
      return this.failExecution(lease, execution);
    }

    if (!providerResult.text) {
      const completion =
        await this.deps.executions.completeProviderAttempt({
          tenantId: execution.tenantId,
          attemptId: attempt.attemptId,
          status: "FAILED",
          errorClass: "EMPTY_TRANSLATION",
        });
      if (completion === "STALE_ATTEMPT") {
        return "SUPERSEDED";
      }
      return this.failExecution(lease, execution);
    }

    const completion =
      await this.deps.executions.completeProviderAttempt({
        tenantId: execution.tenantId,
        attemptId: attempt.attemptId,
        status: "SUCCEEDED",
        inputTokens: providerResult.inputTokens ?? null,
        outputTokens: providerResult.outputTokens ?? null,
        billedCostMicrounits:
          providerResult.billedCostMicrounits ?? null,
        latencyMs: providerResult.latencyMs ?? null,
        errorClass: null,
      });
    if (completion === "STALE_ATTEMPT") {
      return "SUPERSEDED";
    }

    try {
      const published = await this.publishTranslation(
        lease,
        execution,
        providerResult.text,
      );
      return published;
    } catch (error) {
      if (error instanceof StaleLeaseError) {
        return "STALE_LEASE";
      }
      return this.scheduleExecutionRetry(
        lease,
        execution,
      );
    }
  }

  private async publishTranslation(
    lease: OutboxJobLease,
    execution: TranslationExecutionRecord,
    translatedText: string,
  ): Promise<TranslationWorkerResult> {
    return this.deps.store.withTransaction<TranslationWorkerResult>(async (tx) => {
      const current =
        await this.deps.store.lockCurrentTranslationForPublish(
          tx,
          execution.tenantId,
          execution.translationId,
        );

      const now = this.deps.clock.now();

      if (!current) {
        await this.deps.store.markSuperseded(tx, {
          tenantId: execution.tenantId,
          translationId: execution.translationId,
          supersededAt: now,
        });

        const completed = await this.deps.store.completeJob(tx, {
          tenantId: lease.tenantId,
          jobId: lease.jobId,
          fencingToken: lease.fencingToken,
          now,
        });
        if (!completed) throw new StaleLeaseError();
        return "SUPERSEDED";
      }

      const devices =
        await this.deps.store.listRecipientDevicesForPublish(
          tx,
          {
            tenantId: execution.tenantId,
            recipientUserId: execution.recipientUserId,
          },
        );

      if (devices.length === 0) {
        const nextAttemptAt = this.nextRetryAt(
          lease.attemptCount,
          now,
        );
        const scheduled = await this.deps.store.scheduleRetry(
          tx,
          {
            tenantId: execution.tenantId,
            translationId: execution.translationId,
            nextAttemptAt,
          },
        );
        if (!scheduled) throw new StaleLeaseError();

        const requeued = await this.deps.store.retryJob(tx, {
          tenantId: lease.tenantId,
          jobId: lease.jobId,
          fencingToken: lease.fencingToken,
          now,
          availableAt: nextAttemptAt,
        });
        if (!requeued) throw new StaleLeaseError();
        return "RETRY_SCHEDULED";
      }

      const expiresAt = addSeconds(
        now,
        this.envelopeTtlSeconds,
      );

      for (const device of devices) {
        const envelopeId = this.deps.ids.next("env");
        const protectedPayload =
          await this.deps.envelopeProtector.protect({
            tenantId: execution.tenantId,
            conversationId: execution.conversationId,
            messageId: execution.sourceMessageId,
            sourceRevision: execution.sourceRevision,
            translationId: execution.translationId,
            recipientUserId: execution.recipientUserId,
            recipientDeviceId: device.deviceId,
            recipientCredentialVersion:
              device.credentialVersion,
            recipientPublicMaterialRef:
              device.publicMaterialRef,
            translatedText,
            targetLanguageTag: execution.targetLanguageTag,
          });
        if (!protectedPayload) {
          throw new Error(
            "Translation envelope protector returned an empty payload",
          );
        }

        await this.deps.store.insertTranslationDeliveryEnvelope(
          tx,
          {
            tenantId: execution.tenantId,
            envelopeId,
            conversationId: execution.conversationId,
            messageId: execution.sourceMessageId,
            sourceRevision: execution.sourceRevision,
            translationId: execution.translationId,
            recipientUserId: execution.recipientUserId,
            recipientDeviceId: device.deviceId,
            credentialVersion: device.credentialVersion,
            protectedPayload,
            createdAt: now,
            expiresAt,
          },
        );

        const inbox =
          await this.deps.store.allocateDeviceInboxOffset(
            tx,
            execution.tenantId,
            device.deviceId,
          );

        await this.deps.store.insertInboxEvent(tx, {
          deviceId: device.deviceId,
          inboxEpoch: inbox.inboxEpoch,
          offset: inbox.offset,
          eventId: this.deps.ids.next("evt"),
          eventType: "message.available",
          tenantId: execution.tenantId,
          conversationId: execution.conversationId,
          messageId: execution.sourceMessageId,
          envelopeId,
          sourceRevision: execution.sourceRevision,
          createdAt: now,
        });
      }

      const ready = await this.deps.store.markReady(tx, {
        tenantId: execution.tenantId,
        translationId: execution.translationId,
        readyAt: now,
      });
      if (!ready) throw new StaleLeaseError();

      const completed = await this.deps.store.completeJob(tx, {
        tenantId: lease.tenantId,
        jobId: lease.jobId,
        fencingToken: lease.fencingToken,
        now,
      });
      if (!completed) throw new StaleLeaseError();

      return "EXECUTION_DONE";
    });
  }

  private async supersedeAndComplete(
    lease: OutboxJobLease,
    execution: TranslationExecutionRecord,
  ): Promise<TranslationWorkerResult> {
    try {
      return await this.deps.store.withTransaction<TranslationWorkerResult>(async (tx) => {
        const now = this.deps.clock.now();
        await this.deps.store.markSuperseded(tx, {
          tenantId: execution.tenantId,
          translationId: execution.translationId,
          supersededAt: now,
        });

        const completed = await this.deps.store.completeJob(tx, {
          tenantId: lease.tenantId,
          jobId: lease.jobId,
          fencingToken: lease.fencingToken,
          now,
        });
        if (!completed) throw new StaleLeaseError();

        return "SUPERSEDED";
      });
    } catch (error) {
      return error instanceof StaleLeaseError
        ? "STALE_LEASE"
        : "FAILED";
    }
  }

  private async markSourceRequiredAndComplete(
    lease: OutboxJobLease,
    execution: TranslationExecutionRecord,
    payload: ExecutePayload,
  ): Promise<TranslationWorkerResult> {
    try {
      return await this.deps.store.withTransaction<TranslationWorkerResult>(async (tx) => {
        const current =
          await this.deps.store.lockCurrentTranslationForPublish(
            tx,
            execution.tenantId,
            execution.translationId,
          );

        const now = this.deps.clock.now();

        if (!current) {
          await this.deps.store.markSuperseded(tx, {
            tenantId: execution.tenantId,
            translationId: execution.translationId,
            supersededAt: now,
          });

          const completed = await this.deps.store.completeJob(tx, {
            tenantId: lease.tenantId,
            jobId: lease.jobId,
            fencingToken: lease.fencingToken,
            now,
          });
          if (!completed) throw new StaleLeaseError();
          return "SUPERSEDED";
        }

        const marked =
          await this.deps.store.markSourceRequired(tx, {
            tenantId: execution.tenantId,
            translationId: execution.translationId,
          });
        if (!marked) throw new StaleLeaseError();

        const devices =
          await this.deps.store.listRecipientControlDevices(
            tx,
            {
              tenantId: execution.tenantId,
              recipientUserId: execution.recipientUserId,
            },
          );

        for (const deviceId of devices) {
          const inbox =
            await this.deps.store.allocateDeviceInboxOffset(
              tx,
              execution.tenantId,
              deviceId,
            );

          await this.deps.store.insertInboxEvent(tx, {
            deviceId,
            inboxEpoch: inbox.inboxEpoch,
            offset: inbox.offset,
            eventId: this.deps.ids.next("evt"),
            eventType: "translation.source_required",
            tenantId: execution.tenantId,
            conversationId: execution.conversationId,
            messageId: execution.sourceMessageId,
            envelopeId: null,
            sourceRevision: execution.sourceRevision,
            translationId: execution.translationId,
            sourceRef: payload.sourceHash,
            createdAt: now,
          });
        }

        const completed = await this.deps.store.completeJob(tx, {
          tenantId: lease.tenantId,
          jobId: lease.jobId,
          fencingToken: lease.fencingToken,
          now,
        });
        if (!completed) throw new StaleLeaseError();

        return "SOURCE_REQUIRED";
      });
    } catch (error) {
      return error instanceof StaleLeaseError
        ? "STALE_LEASE"
        : "FAILED";
    }
  }

  private async scheduleExecutionRetry(
    lease: OutboxJobLease,
    execution: TranslationExecutionRecord,
  ): Promise<TranslationWorkerResult> {
    try {
      return await this.deps.store.withTransaction<TranslationWorkerResult>(async (tx) => {
        const now = this.deps.clock.now();
        const nextAttemptAt = this.nextRetryAt(
          lease.attemptCount,
          now,
        );

        const scheduled = await this.deps.store.scheduleRetry(
          tx,
          {
            tenantId: execution.tenantId,
            translationId: execution.translationId,
            nextAttemptAt,
          },
        );
        if (!scheduled) throw new StaleLeaseError();

        const requeued = await this.deps.store.retryJob(tx, {
          tenantId: lease.tenantId,
          jobId: lease.jobId,
          fencingToken: lease.fencingToken,
          now,
          availableAt: nextAttemptAt,
        });
        if (!requeued) throw new StaleLeaseError();

        return "RETRY_SCHEDULED";
      });
    } catch (error) {
      return error instanceof StaleLeaseError
        ? "STALE_LEASE"
        : "FAILED";
    }
  }

  private async failExecution(
    lease: OutboxJobLease,
    execution: TranslationExecutionRecord,
  ): Promise<TranslationWorkerResult> {
    try {
      return await this.deps.store.withTransaction<TranslationWorkerResult>(async (tx) => {
        const failed = await this.deps.store.markFailed(tx, {
          tenantId: execution.tenantId,
          translationId: execution.translationId,
        });
        if (!failed) throw new StaleLeaseError();

        const now = this.deps.clock.now();
        const dead = await this.deps.store.deadLetterJob(tx, {
          tenantId: lease.tenantId,
          jobId: lease.jobId,
          fencingToken: lease.fencingToken,
          now,
        });
        if (!dead) throw new StaleLeaseError();

        return "FAILED";
      });
    } catch (error) {
      return error instanceof StaleLeaseError
        ? "STALE_LEASE"
        : "FAILED";
    }
  }

  private async completeLease(
    lease: OutboxJobLease,
  ): Promise<boolean> {
    return (await this.deps.outbox.complete(lease)) === "COMPLETED";
  }

  private async deadLetter(
    lease: OutboxJobLease,
  ): Promise<TranslationWorkerResult> {
    return (await this.deps.outbox.deadLetter(lease)) === "DEAD"
      ? "FAILED"
      : "STALE_LEASE";
  }

  private async retryOrDeadLetter(
    lease: OutboxJobLease,
  ): Promise<TranslationWorkerResult> {
    if (lease.attemptCount >= this.maxProviderAttempts) {
      return this.deadLetter(lease);
    }

    const availableAt = this.nextRetryAt(
      lease.attemptCount,
      this.deps.clock.now(),
    );
    return (await this.deps.outbox.retry(
      lease,
      availableAt,
    )) === "REQUEUED"
      ? "RETRY_SCHEDULED"
      : "STALE_LEASE";
  }

  private nextRetryAt(
    attemptCount: number,
    now: string,
  ): string {
    const multiplier = Math.min(
      2 ** Math.max(0, attemptCount - 1),
      64,
    );
    return addSeconds(
      now,
      this.retryBaseSeconds * multiplier,
    );
  }
}

interface RootPayload {
  messageId: UUID;
  sourceRevision: number;
  sourceHash: string;
}

interface ExecutePayload extends RootPayload {
  translationId: UUID;
}

function parseRootPayload(lease: OutboxJobLease): RootPayload {
  const messageId = lease.payloadRef.message_id;
  const sourceRevision = lease.payloadRef.source_revision;
  const sourceHash = lease.payloadRef.source_hash;

  if (
    typeof messageId !== "string" ||
    !Number.isInteger(sourceRevision) ||
    Number(sourceRevision) < 1 ||
    typeof sourceHash !== "string" ||
    !sourceHash
  ) {
    throw new TypeError(
      "Invalid translation.request payload_ref",
    );
  }

  return {
    messageId,
    sourceRevision: Number(sourceRevision),
    sourceHash,
  };
}

function parseExecutePayload(
  lease: OutboxJobLease,
): ExecutePayload {
  const root = parseRootPayload(lease);
  const translationId = lease.payloadRef.translation_id;
  if (typeof translationId !== "string") {
    throw new TypeError(
      "Invalid translation.execute payload_ref",
    );
  }
  return {
    ...root,
    translationId,
  };
}

function sameLanguageTag(
  source: string | null,
  target: string,
): boolean {
  return Boolean(
    source &&
    source.trim().toLowerCase() ===
      target.trim().toLowerCase(),
  );
}

function addSeconds(timestamp: string, seconds: number): string {
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) {
    throw new TypeError("Invalid timestamp");
  }
  return new Date(millis + seconds * 1000).toISOString();
}

import type { UUID } from "../../domain/src/index.js";
import type {
  OutboxJobLease,
  PersistentOutboxService,
} from "../../outbox-service/src/index.js";
import {
  applyContextDerivation,
  deriveTemporalEpisodePatch,
  type ContextOperationRef,
  type ContextStatePatch,
  type ConversationContextState,
} from "../../context-state/src/index.js";

export interface ContextStateWorkerClock {
  now(): string;
}

export interface ContextStateWorkerStore<Tx> {
  withTransaction<T>(
    work: (tx: Tx) => Promise<T>,
  ): Promise<T>;

  loadState(
    tx: Tx,
    input: {
      tenantId: UUID;
      conversationId: UUID;
      forUpdate?: boolean;
    },
  ): Promise<ConversationContextState | undefined>;

  updateState(
    tx: Tx,
    input: {
      expectedStateVersion: number;
      state: ConversationContextState;
    },
  ): Promise<boolean>;

  isTranslationFanoutPending(
    tx: Tx,
    input: {
      tenantId: UUID;
      messageId: UUID;
      sourceRevision: number;
    },
  ): Promise<boolean>;

  completeJob(
    tx: Tx,
    input: {
      tenantId: UUID;
      jobId: UUID;
      fencingToken: number;
      now: string;
    },
  ): Promise<boolean>;
}

export interface ContextStateEpisodeDeriver<Tx> {
  derive(
    tx: Tx,
    input: {
      tenantId: UUID;
      state: ConversationContextState;
      operation: ContextOperationRef;
    },
  ): Promise<ContextStatePatch | undefined>;
}

export interface ContextStateWorkerDependencies<Tx> {
  store: ContextStateWorkerStore<Tx>;
  outbox: PersistentOutboxService<Tx>;
  clock: ContextStateWorkerClock;
  episodeDeriver?: ContextStateEpisodeDeriver<Tx>;
  retryBaseSeconds?: number;
  maxAttempts?: number;
}

export type ContextStateWorkerResult =
  | "NO_WORK"
  | "REDUCED"
  | "ALREADY_REDUCED"
  | "RETRY_SCHEDULED"
  | "DEAD"
  | "STALE_LEASE";

class StaleLeaseError extends Error {}
class RetryableContextStateError extends Error {}

export class ContextStateWorkerService<Tx> {
  private readonly retryBaseSeconds: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly deps: ContextStateWorkerDependencies<Tx>,
  ) {
    this.retryBaseSeconds = deps.retryBaseSeconds ?? 1;
    this.maxAttempts = deps.maxAttempts ?? 20;

    if (
      !Number.isInteger(this.retryBaseSeconds) ||
      this.retryBaseSeconds < 1 ||
      this.retryBaseSeconds > 300
    ) {
      throw new TypeError(
        "retryBaseSeconds must be an integer between 1 and 300",
      );
    }
    if (
      !Number.isInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 100
    ) {
      throw new TypeError(
        "maxAttempts must be an integer between 1 and 100",
      );
    }
  }

  async runOnce(): Promise<ContextStateWorkerResult> {
    const lease =
      await this.deps.outbox.leaseNext("context.reduce");
    if (!lease) return "NO_WORK";

    let payload: ContextReducePayload;
    try {
      payload = parsePayload(lease);
    } catch {
      return this.deadLetter(lease);
    }

    try {
      return await this.deps.store.withTransaction<
        ContextStateWorkerResult
      >(async (tx) => {
        const state = await this.deps.store.loadState(tx, {
          tenantId: lease.tenantId,
          conversationId: payload.conversationId,
          forUpdate: true,
        });

        if (!state) {
          throw new RetryableContextStateError(
            "ConversationState is not available yet",
          );
        }

        if (state.processedPrefixOpSeq >= payload.opSeq) {
          await this.completeOrThrow(tx, lease);
          return "ALREADY_REDUCED";
        }

        const operation = state.pendingOperations.find(
          (candidate) =>
            candidate.opSeq === payload.opSeq &&
            candidate.operationId === payload.operationId,
        );

        if (!operation) {
          throw new RetryableContextStateError(
            "Context operation is not registered in durable state",
          );
        }

        if (
          payload.opSeq !==
          state.processedPrefixOpSeq + 1
        ) {
          throw new RetryableContextStateError(
            "Context operation is waiting for its causal predecessor",
          );
        }

        if (
          operation.kind !== "MESSAGE_DELETED" &&
          operation.messageId &&
          operation.sourceRevision !== undefined
        ) {
          const fanoutPending =
            await this.deps.store.isTranslationFanoutPending(
              tx,
              {
                tenantId: lease.tenantId,
                messageId: operation.messageId,
                sourceRevision: operation.sourceRevision,
              },
            );
          if (fanoutPending) {
            throw new RetryableContextStateError(
              "Context operation is waiting for translation fanout",
            );
          }
        }

        let episodePatch =
          deriveTemporalEpisodePatch(
            state,
            operation,
          );

        if (
          this.deps.episodeDeriver &&
          operation.kind === "MESSAGE_CREATED" &&
          operation.messageId &&
          operation.sourceRevision !== undefined
        ) {
          try {
            const semanticPatch =
              await this.deps.episodeDeriver.derive(
                tx,
                {
                  tenantId: lease.tenantId,
                  state: structuredClone(state),
                  operation:
                    structuredClone(operation),
                },
              );
            if (semanticPatch) {
              episodePatch = semanticPatch;
            }
          } catch {
            // Semantic enrichment is strictly optional. Any missing transient
            // source, bounded-history failure or heuristic error preserves
            // the already-computed temporal V1 decision.
          }
        }

        const next = applyContextDerivation(state, {
          conversationId: state.conversationId,
          operationId: operation.operationId,
          opSeq: operation.opSeq,
          baseStateVersion: state.stateVersion,
          membershipEpoch: state.membershipEpoch,
          erasureEpoch: state.erasureEpoch,
          policyVersion: state.policyVersion,
          strategyVersion: state.strategyVersion,
          outcome: "PROCESSED",
          ...(episodePatch
            ? { patch: episodePatch }
            : {}),
          completedAt: this.now(),
        });

        const updated = await this.deps.store.updateState(
          tx,
          {
            expectedStateVersion: state.stateVersion,
            state: next,
          },
        );
        if (!updated) {
          throw new StaleLeaseError(
            "ConversationState changed under row lock",
          );
        }

        await this.completeOrThrow(tx, lease);
        return "REDUCED";
      });
    } catch (error) {
      if (error instanceof StaleLeaseError) {
        return "STALE_LEASE";
      }
      return this.retryOrDeadLetter(lease);
    }
  }

  private async completeOrThrow(
    tx: Tx,
    lease: OutboxJobLease,
  ): Promise<void> {
    const completed = await this.deps.store.completeJob(
      tx,
      {
        tenantId: lease.tenantId,
        jobId: lease.jobId,
        fencingToken: lease.fencingToken,
        now: this.now(),
      },
    );
    if (!completed) {
      throw new StaleLeaseError(
        "Context reduce outbox lease is stale",
      );
    }
  }

  private async retryOrDeadLetter(
    lease: OutboxJobLease,
  ): Promise<ContextStateWorkerResult> {
    if (lease.attemptCount >= this.maxAttempts) {
      return this.deadLetter(lease);
    }

    const availableAt = addSeconds(
      this.now(),
      Math.min(
        this.retryBaseSeconds *
          2 ** Math.max(0, lease.attemptCount - 1),
        60,
      ),
    );

    return (
      (await this.deps.outbox.retry(
        lease,
        availableAt,
      )) === "REQUEUED"
        ? "RETRY_SCHEDULED"
        : "STALE_LEASE"
    );
  }

  private async deadLetter(
    lease: OutboxJobLease,
  ): Promise<ContextStateWorkerResult> {
    return (
      (await this.deps.outbox.deadLetter(lease)) === "DEAD"
        ? "DEAD"
        : "STALE_LEASE"
    );
  }

  private now(): string {
    const value = this.deps.clock.now();
    if (!Number.isFinite(Date.parse(value))) {
      throw new TypeError(
        "ContextState worker clock returned an invalid timestamp",
      );
    }
    return value;
  }
}

interface ContextReducePayload {
  conversationId: UUID;
  operationId: UUID;
  opSeq: number;
}

function parsePayload(
  lease: OutboxJobLease,
): ContextReducePayload {
  const conversationId =
    lease.payloadRef.conversation_id;
  const operationId = lease.payloadRef.operation_id;
  const opSeq = lease.payloadRef.op_seq;

  if (
    typeof conversationId !== "string" ||
    !conversationId ||
    typeof operationId !== "string" ||
    !operationId ||
    !Number.isInteger(opSeq) ||
    Number(opSeq) < 1
  ) {
    throw new TypeError(
      "Invalid context.reduce payload_ref",
    );
  }

  return {
    conversationId,
    operationId,
    opSeq: Number(opSeq),
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

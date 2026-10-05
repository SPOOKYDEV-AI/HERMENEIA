import type {
  PersistentOutboxService,
} from "../../outbox-service/src/index.js";
import type {
  SqlExecutor,
} from "../../persistence/src/index.js";
import type {
  PostgresOutboxRepository,
} from "../../persistence-postgres/src/index.js";
import type {
  PostgresConversationContextStateRepository,
} from "../../persistence-postgres/src/context-state.js";
import {
  ContextStateWorkerService,
  type ContextStateWorkerClock,
  type ContextStateEpisodeDeriver,
} from "../../context-state-worker/src/index.js";
import {
  deriveSemanticEpisodeContinuity,
  type EpisodeSemanticEvidence,
} from "../../context-episode-heuristic/src/index.js";
import type {
  TransientSourceStore,
} from "../../transient-source/src/index.js";

export interface PostgresContextStateWorkerDependencies {
  stateRepository: PostgresConversationContextStateRepository;
  outboxRepository: PostgresOutboxRepository;
  outboxService: PersistentOutboxService<SqlExecutor>;
  clock: ContextStateWorkerClock;
  transientSources?: TransientSourceStore;
  retryBaseSeconds?: number;
  maxAttempts?: number;
}

export function createPostgresContextStateWorker(
  deps: PostgresContextStateWorkerDependencies,
): ContextStateWorkerService<SqlExecutor> {
  const store = {
    withTransaction: <T>(
      work: (tx: SqlExecutor) => Promise<T>,
    ) => deps.stateRepository.withTransaction(work),

    loadState: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresConversationContextStateRepository["loadState"]
      >[1],
    ) => deps.stateRepository.loadState(tx, input),

    updateState: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresConversationContextStateRepository["updateState"]
      >[1],
    ) => deps.stateRepository.updateState(tx, input),

    isTranslationFanoutPending: (
      tx: SqlExecutor,
      input: {
        tenantId: string;
        messageId: string;
        sourceRevision: number;
      },
    ) =>
      deps.outboxRepository.isJobPending(tx, {
        tenantId: input.tenantId,
        jobType: "translation.request",
        businessKey:
          `${input.messageId}:${input.sourceRevision}`,
      }),

    loadEpisodeSourceRefs: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresConversationContextStateRepository["loadEpisodeSourceRefs"]
      >[1],
    ) => deps.stateRepository.loadEpisodeSourceRefs(tx, input),

    completeJob: (
      tx: SqlExecutor,
      input: Parameters<
        PostgresOutboxRepository["completeJob"]
      >[1],
    ) => deps.outboxRepository.completeJob(tx, input),
  };

  const episodeDeriver:
    ContextStateEpisodeDeriver<SqlExecutor> | undefined =
    deps.transientSources
      ? {
          async derive(tx, input) {
            const active =
              input.state.activeEpisode;
            const operation = input.operation;
            if (
              operation.kind !== "MESSAGE_CREATED" ||
              !operation.messageId ||
              operation.sourceRevision === undefined ||
              !active ||
              active.startOperationSequence === undefined ||
              active.lastOperationSequence === undefined ||
              !active.startedAt ||
              !active.lastActivityAt
            ) {
              return undefined;
            }

            const current =
              await deps.transientSources!.get({
                tenantId: input.tenantId,
                messageId: operation.messageId,
                sourceRevision:
                  operation.sourceRevision,
              });
            if (!current) return undefined;

            const refs =
              await store.loadEpisodeSourceRefs(
                tx,
                {
                  tenantId: input.tenantId,
                  conversationId:
                    input.state.conversationId,
                  startOperationSequence:
                    active.startOperationSequence,
                  throughOperationSequence:
                    active.lastOperationSequence,
                  limit: 8,
                },
              );

            const priorSources:
              EpisodeSemanticEvidence[] = [];
            for (const ref of refs) {
              const prior =
                await deps.transientSources!.get({
                  tenantId: input.tenantId,
                  messageId: ref.messageId,
                  sourceRevision:
                    ref.sourceRevision,
                });
              if (!prior) continue;
              priorSources.push({
                text: prior.source.text,
                languageTag:
                  prior.source.language_hint ?? null,
                createdAt: prior.createdAt,
              });
            }

            if (priorSources.length === 0) {
              return undefined;
            }

            const decision =
              deriveSemanticEpisodeContinuity({
                current: {
                  text: current.source.text,
                  languageTag:
                    current.source.language_hint ?? null,
                  createdAt:
                    operation.registeredAt,
                },
                priorSources,
                previousLastActivityAt:
                  active.lastActivityAt,
              });

            if (decision.decision === "UNCERTAIN") {
              return undefined;
            }

            if (
              decision.decision ===
              "START_NEW"
            ) {
              return {
                activeEpisode: {
                  episodeId:
                    operation.operationId,
                  episodeVersion: 1,
                  continuityConfidence:
                    decision.confidence,
                  startOperationSequence:
                    operation.opSeq,
                  lastOperationSequence:
                    operation.opSeq,
                  startedAt:
                    operation.registeredAt,
                  lastActivityAt:
                    operation.registeredAt,
                },
              };
            }

            return {
              activeEpisode: {
                episodeId: active.episodeId,
                episodeVersion:
                  active.episodeVersion + 1,
                continuityConfidence:
                  decision.confidence,
                startOperationSequence:
                  active.startOperationSequence,
                lastOperationSequence:
                  operation.opSeq,
                startedAt: active.startedAt,
                lastActivityAt:
                  operation.registeredAt,
              },
            };
          },
        }
      : undefined;

  return new ContextStateWorkerService<SqlExecutor>({
    store,
    outbox: deps.outboxService,
    clock: deps.clock,
    episodeDeriver,
    retryBaseSeconds: deps.retryBaseSeconds,
    maxAttempts: deps.maxAttempts,
  });
}

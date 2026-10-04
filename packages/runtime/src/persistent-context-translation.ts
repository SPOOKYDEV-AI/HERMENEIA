import type { UUID } from "../../domain/src/index.js";
import type { SqlExecutor } from "../../persistence/src/index.js";
import type {
  PostgresContextPlanningRepository,
  PostgresContextSnapshotRepository,
} from "../../persistence-postgres/src/context.js";
import {
  ContextEngine,
} from "../../context-engine/src/index.js";
import {
  ContextPreparationService,
  InMemoryContextPayloadStore,
} from "../../context-service/src/index.js";
import {
  TranslationContextService,
} from "../../context-translation/src/index.js";
import {
  TranslationContextPlanner,
  type ConversationContextStateSource,
  type TranslationContextPlannerConfig,
} from "../../context-planner/src/index.js";
import type {
  TransientSourceStore,
} from "../../transient-source/src/index.js";
import {
  createTranslationWorkerContextBridge,
} from "./context-translation-worker.js";

export interface PersistentContextTranslationClock {
  now(): string;
}

export interface PersistentContextTranslationIds {
  next(prefix: string): UUID;
}

export interface PersistentContextTranslationDependencies {
  snapshotRepository: PostgresContextSnapshotRepository;
  planningRepository: PostgresContextPlanningRepository;
  transientSources: TransientSourceStore;
  ids: PersistentContextTranslationIds;
  clock: PersistentContextTranslationClock;
  stateSource?: ConversationContextStateSource;
  plannerConfig?: Partial<TranslationContextPlannerConfig> & {
    budget?: Partial<
      TranslationContextPlannerConfig["budget"]
    >;
  };
  payloadTtlSeconds?: number;
  payloadMaxEntries?: number;
  payloadMaxTotalChars?: number;
}

export function createPostgresTranslationContextRuntime(
  deps: PersistentContextTranslationDependencies,
) {
  const payloads = new InMemoryContextPayloadStore({
    clock: deps.clock,
    maxEntries: deps.payloadMaxEntries,
    maxTotalChars: deps.payloadMaxTotalChars,
  });

  const preparation =
    new ContextPreparationService<SqlExecutor>({
      engine: new ContextEngine(),
      store: deps.snapshotRepository,
      payloads,
      ids: deps.ids,
      clock: deps.clock,
      payloadTtlSeconds: deps.payloadTtlSeconds,
    });

  const planner = new TranslationContextPlanner({
    metadata: {
      load(input, recentMessageLimit) {
        return deps.planningRepository.withTransaction(
          (tx) =>
            deps.planningRepository.loadPlanningFrame(
              tx,
              {
                tenantId: input.tenantId,
                conversationId: input.conversationId,
                sourceMessageId: input.sourceMessageId,
                sourceRevision: input.sourceRevision,
                recipientUserId: input.recipientUserId,
              },
              recentMessageLimit,
            ),
        );
      },
    },
    transientSources: deps.transientSources,
    stateSource: deps.stateSource,
    config: deps.plannerConfig,
  });

  const contextService =
    new TranslationContextService<SqlExecutor>(
      preparation,
      planner,
    );

  return {
    contextService,
    contextBridge:
      createTranslationWorkerContextBridge(
        contextService,
      ),
    payloads,
    planner,
  };
}

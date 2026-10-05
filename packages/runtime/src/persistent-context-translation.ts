import type { UUID } from "../../domain/src/index.js";
import type { SqlExecutor } from "../../persistence/src/index.js";
import type {
  PostgresContextPlanningRepository,
  PostgresContextSnapshotRepository,
} from "../../persistence-postgres/src/context.js";
import type {
  PostgresConversationContextStateRepository,
} from "../../persistence-postgres/src/context-state.js";
import type {
  PostgresContextClaimRepository,
} from "../../persistence-postgres/src/context-claims.js";
import {
  materializeReferencedClaimCandidates,
} from "../../context-claim-candidates/src/index.js";
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
  type DerivedContextCandidateSource,
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
  stateRepository?: PostgresConversationContextStateRepository;
  derivedCandidates?: DerivedContextCandidateSource;
  claimRepository?: PostgresContextClaimRepository;
  plannerConfig?: Omit<
    Partial<TranslationContextPlannerConfig>,
    "budget"
  > & {
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

  const stateSource: ConversationContextStateSource | undefined =
    deps.stateSource ??
    (deps.stateRepository
      ? {
          load(input) {
            return deps.stateRepository!.withTransaction(
              (tx) =>
                deps.stateRepository!.loadEngineState(tx, {
                  tenantId: input.tenantId,
                  conversationId: input.conversationId,
                }),
            );
          },
        }
      : undefined);

  const derivedCandidates: DerivedContextCandidateSource | undefined =
    deps.derivedCandidates ??
    (deps.claimRepository
      ? {
          async load(input, state, frame) {
            const referencedClaimIds = [
              ...(state.correctionClaimRefs ?? []),
              ...(state.terminologyClaimRefs ?? []),
              ...(state.lexicalClaimRefs ?? []),
            ].filter(
              (value, index, values) =>
                values.indexOf(value) === index,
            );

            const asOf = frame.currentMessageAcceptedAt;
            if (!Number.isFinite(Date.parse(asOf))) {
              throw new TypeError(
                "Current message acceptance timestamp is invalid",
              );
            }

            const {
              claims,
              materializedClaimIds,
            } =
              await deps.claimRepository!.withTransaction(
                async (tx) => {
                  const referencedClaims =
                    referencedClaimIds.length === 0
                      ? []
                      : await deps.claimRepository!.loadReferencedClaims(
                          tx,
                          {
                            tenantId: input.tenantId,
                            conversationId:
                              input.conversationId,
                            claimIds:
                              referencedClaimIds,
                            asOf,
                          },
                        );

                  const tenantPolicyClaims =
                    await deps.claimRepository!.loadTenantPolicyClaims(
                      tx,
                      {
                        tenantId: input.tenantId,
                        asOf,
                      },
                    );

                  const materializedClaimIds = [
                    ...new Set([
                      ...referencedClaimIds,
                      ...tenantPolicyClaims.map(
                        (claim) => claim.claimId,
                      ),
                    ]),
                  ];

                  return {
                    claims: [
                      ...referencedClaims,
                      ...tenantPolicyClaims,
                    ],
                    materializedClaimIds,
                  };
                },
              );

            if (materializedClaimIds.length === 0) {
              return [];
            }

            return materializeReferencedClaimCandidates({
              claims,
              referencedClaimIds: materializedClaimIds,
              conversationId: input.conversationId,
              currentSourceAuthorUserId:
                frame.currentSourceAuthorUserId,
              currentSourceLanguageTag:
                frame.currentSourceLanguageTag,
              targetLanguageTag: input.targetLanguageTag,
              state,
              now: asOf,
            });
          },
        }
      : undefined);

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
    stateSource,
    derivedCandidates,
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

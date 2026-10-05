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
  ACTIVE_EPISODE_CONTINUITY_GAP_MS,
} from "../../context-state/src/index.js";
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
    (deps.claimRepository || stateSource
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
            } = deps.claimRepository
              ? await deps.claimRepository.withTransaction(
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
              )
              : {
                  claims: [],
                  materializedClaimIds: [],
                };

            const claimCandidates =
              materializedClaimIds.length === 0
                ? []
                : materializeReferencedClaimCandidates({
                    claims,
                    referencedClaimIds:
                      materializedClaimIds,
                    conversationId:
                      input.conversationId,
                    currentSourceAuthorUserId:
                      frame.currentSourceAuthorUserId,
                    currentSourceLanguageTag:
                      frame.currentSourceLanguageTag,
                    targetLanguageTag:
                      input.targetLanguageTag,
                    state,
                    now: asOf,
                  });

            const profile =
              state.styleProfiles?.find(
                (candidate) =>
                  candidate.speakerUserId ===
                  frame.currentSourceAuthorUserId,
              );

            const styleCandidates =
              profile &&
              Date.parse(profile.updatedAt) <
                Date.parse(asOf) &&
              (
                !profile.expiresAt ||
                Date.parse(profile.expiresAt) >
                  Date.parse(asOf)
              )
                ? [{
                    candidateId:
                      `style:${profile.sourceRepairEventId}`,
                    candidateType:
                      "STYLE_PROFILE" as const,
                    content: JSON.stringify({
                      kind:
                        "trusted_conversation_style",
                      preferred_register:
                        profile.preferredRegister,
                    }),
                    causalThroughOperationSequence:
                      state.processedPrefixOperationSequence,
                    sourceRevisionRefs: [],
                    claimRefs: [],
                    semanticScore: 1,
                    temporalScore: 1,
                    confidence:
                      profile.confidence,
                    importance: 1,
                    explicitReference: false,
                    activeEpisode: false,
                    privacyScope:
                      "STYLE" as const,
                    erasureEpoch:
                      state.erasureEpoch,
                    validUntil:
                      profile.expiresAt ?? null,
                    correctionTrigger: null,
                  }]
                : [];

            const episodeCandidates = [];
            const episodeStart =
              state.activeEpisodeStartOperationSequence;
            const episodeLast =
              state.activeEpisodeLastOperationSequence;
            const episodeStartedAt =
              state.activeEpisodeStartedAt;
            const episodeLastActivityAt =
              state.activeEpisodeLastActivityAt;
            const episodeConfidence =
              state.activeEpisodeContinuityConfidence;

            if (
              state.activeEpisodeId &&
              state.activeEpisodeVersion &&
              episodeStart !== undefined &&
              episodeStart !== null &&
              episodeLast !== undefined &&
              episodeLast !== null &&
              episodeStartedAt &&
              episodeLastActivityAt &&
              episodeConfidence !== undefined &&
              episodeConfidence !== null &&
              episodeLast <
                frame.currentOperationSequence &&
              Date.parse(episodeLastActivityAt) <
                Date.parse(asOf) &&
              Date.parse(asOf) -
                Date.parse(episodeLastActivityAt) <=
                ACTIVE_EPISODE_CONTINUITY_GAP_MS
            ) {
              const tailRefs = frame.recentMessages
                .slice(3)
                .filter(
                  (ref) =>
                    ref.operationSequence >=
                      episodeStart &&
                    ref.operationSequence <=
                      episodeLast,
                );

              const episodeMessages = [];
              let episodeChars = 0;

              for (const ref of tailRefs) {
                if (episodeMessages.length >= 3) {
                  break;
                }

                let source;
                try {
                  source =
                    await deps.transientSources.get({
                      tenantId: input.tenantId,
                      messageId: ref.messageId,
                      sourceRevision:
                        ref.sourceRevision,
                    });
                } catch {
                  source = undefined;
                }

                const text =
                  source?.source?.text;
                if (
                  typeof text !== "string" ||
                  !text ||
                  text.length > 768 ||
                  episodeChars + text.length >
                    3_000
                ) {
                  continue;
                }

                episodeChars += text.length;
                episodeMessages.push({
                  ref,
                  text,
                });
              }

              if (episodeMessages.length > 0) {
                episodeMessages.reverse();
                const content = JSON.stringify({
                  kind:
                    "trusted_active_episode_tail",
                  episode_version:
                    state.activeEpisodeVersion,
                  continuity_confidence:
                    episodeConfidence,
                  messages: episodeMessages.map(
                    (message) => ({
                      source_text: message.text,
                    }),
                  ),
                });

                episodeCandidates.push({
                  candidateId:
                    `episode:${state.activeEpisodeId}:${state.activeEpisodeVersion}`,
                  candidateType:
                    "ACTIVE_EPISODE" as const,
                  content,
                  causalThroughOperationSequence:
                    episodeLast,
                  sourceRevisionRefs:
                    episodeMessages.map(
                      (message) =>
                        `${message.ref.messageId}:${message.ref.sourceRevision}`,
                    ),
                  claimRefs: [],
                  semanticScore: 0,
                  temporalScore: 1,
                  confidence:
                    episodeConfidence,
                  importance: 0.6,
                  explicitReference: false,
                  activeEpisode: true,
                  tokenEstimate: Math.max(
                    1,
                    Math.ceil(
                      content.length / 4,
                    ),
                  ),
                  privacyScope:
                    "EPISODE" as const,
                  erasureEpoch:
                    state.erasureEpoch,
                  validUntil: null,
                  correctionTrigger: null,
                });
              }
            }

            return [
              ...claimCandidates,
              ...styleCandidates,
              ...episodeCandidates,
            ];
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

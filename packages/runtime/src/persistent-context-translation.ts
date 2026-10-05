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
  type ContextCandidate,
  type ConversationContextState,
} from "../../context-engine/src/index.js";
import {
  parseEpisodeSourceRef,
} from "../../context-episode-heuristic/src/index.js";
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
    deps.derivedCandidates ?? {
      async load(input, state, frame) {
        const asOf = frame.currentMessageAcceptedAt;
        if (!Number.isFinite(Date.parse(asOf))) {
          throw new TypeError(
            "Current message acceptance timestamp is invalid",
          );
        }

        const episodeCandidates =
          await materializeActiveEpisodeCandidates(
            deps.transientSources,
            input.tenantId,
            state,
            frame,
          );

        if (!deps.claimRepository) {
          return episodeCandidates;
        }

        const referencedClaimIds = [
          ...(state.correctionClaimRefs ?? []),
          ...(state.terminologyClaimRefs ?? []),
          ...(state.lexicalClaimRefs ?? []),
        ].filter(
          (value, index, values) =>
            values.indexOf(value) === index,
        );

        const {
          claims,
          materializedClaimIds,
        } =
          await deps.claimRepository.withTransaction(
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

        return [
          ...episodeCandidates,
          ...claimCandidates,
        ];
      },
    };

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


export async function materializeActiveEpisodeCandidates(
  transientSources: TransientSourceStore,
  tenantId: UUID,
  state: ConversationContextState,
  frame: {
    recentMessages: Array<{
      messageId: UUID;
      sourceRevision: number;
    }>;
  },
): Promise<ContextCandidate[]> {
  if (
    !state.activeEpisodeId ||
    !state.activeEpisodeVersion ||
    !state.activeEpisodeSourceRevisionRefs?.length
  ) {
    return [];
  }

  const immediateRefs = new Set(
    frame.recentMessages.map(
      (ref) =>
        `${ref.messageId}:${ref.sourceRevision}`,
    ),
  );

  const episodeRefs =
    state.activeEpisodeSourceRevisionRefs
      .filter((ref) => !immediateRefs.has(ref))
      .slice(-4);

  const candidates: ContextCandidate[] = [];
  for (const [index, ref] of episodeRefs.entries()) {
    const parsed = parseEpisodeSourceRef(ref);
    if (!parsed) continue;

    const source = await transientSources.get({
      tenantId,
      messageId: parsed.messageId,
      sourceRevision: parsed.sourceRevision,
    });
    if (!source) continue;

    const recency =
      episodeRefs.length <= 1
        ? 1
        : (index + 1) / episodeRefs.length;

    candidates.push({
      candidateId:
        `episode:${state.activeEpisodeId}:${state.activeEpisodeVersion}:${ref}`,
      candidateType: "ACTIVE_EPISODE",
      content: source.source.text,
      causalThroughOperationSequence:
        state.processedPrefixOperationSequence,
      sourceRevisionRefs: [ref],
      claimRefs: [],
      semanticScore: 0,
      temporalScore: Math.max(0.4, recency),
      confidence:
        state.activeEpisodeContinuityConfidence ?? 0.5,
      importance: 0.4,
      explicitReference: false,
      activeEpisode: true,
      privacyScope: "TRANSIENT",
      erasureEpoch: state.erasureEpoch,
      validUntil: source.expiresAt,
      correctionTrigger: null,
    });
  }

  return candidates;
}

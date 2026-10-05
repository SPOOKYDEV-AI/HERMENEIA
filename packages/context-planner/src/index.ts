import type { UUID } from "../../domain/src/index.js";
import type {
  ContextBudget,
  ContextCandidate,
  ConversationContextState,
} from "../../context-engine/src/index.js";
import type {
  TranslationContextCandidateSet,
  TranslationContextCandidateSource,
  TranslationContextRequest,
} from "../../context-translation/src/index.js";
import type {
  TransientSourceStore,
} from "../../transient-source/src/index.js";

export interface RecentContextMessageRef {
  messageId: UUID;
  sourceRevision: number;
  messageSequence: number;
  operationSequence: number;
  acceptedAt: string;
}

export interface ContextPlanningFrame {
  currentMessageSequence: number;
  currentOperationSequence: number;
  erasureEpoch: number;
  recentMessages: RecentContextMessageRef[];
}

export interface ContextPlanningMetadataSource {
  load(
    input: TranslationContextRequest,
    recentMessageLimit: number,
  ): Promise<ContextPlanningFrame>;
}

export interface ConversationContextStateSource {
  load(
    input: TranslationContextRequest,
  ): Promise<ConversationContextState | null>;
}

export interface TranslationContextPlannerConfig {
  recentMessageLimit: number;
  budget: Omit<ContextBudget, "currentMessageTokens">;
  fallbackCurrentMessageTokens: number;
  maxCurrentMessageTokens: number;
}

const DEFAULT_CONFIG: TranslationContextPlannerConfig = {
  recentMessageLimit: 6,
  budget: {
    totalTokens: 2_048,
    systemReserveTokens: 192,
    safetyReserveTokens: 128,
    immediateReserveTokens: 512,
    activeEpisodeReserveTokens: 384,
    memoryReserveTokens: 384,
  },
  fallbackCurrentMessageTokens: 128,
  maxCurrentMessageTokens: 768,
};

export interface TranslationContextPlannerDependencies {
  metadata: ContextPlanningMetadataSource;
  transientSources: TransientSourceStore;
  stateSource?: ConversationContextStateSource;
  config?: Omit<
    Partial<TranslationContextPlannerConfig>,
    "budget"
  > & {
    budget?: Partial<
      Omit<ContextBudget, "currentMessageTokens">
    >;
  };
}

export class TranslationContextPlanner
  implements TranslationContextCandidateSource {
  private readonly config: TranslationContextPlannerConfig;

  constructor(
    private readonly deps: TranslationContextPlannerDependencies,
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...(deps.config ?? {}),
      budget: {
        ...DEFAULT_CONFIG.budget,
        ...(deps.config?.budget ?? {}),
      },
    };
    validateConfig(this.config);
  }

  async load(
    input: TranslationContextRequest,
  ): Promise<TranslationContextCandidateSet> {
    const [frame, loadedState, currentSource] = await Promise.all([
      this.deps.metadata.load(
        input,
        this.config.recentMessageLimit,
      ),
      this.deps.stateSource
        ? this.deps.stateSource.load(input)
        : Promise.resolve(null),
      this.safeGetSource({
        tenantId: input.tenantId,
        messageId: input.sourceMessageId,
        sourceRevision: input.sourceRevision,
      }),
    ]);

    const state =
      loadedState &&
      loadedState.conversationId === input.conversationId &&
      loadedState.erasureEpoch === frame.erasureEpoch
        ? loadedState
        : null;

    const resolved = await Promise.all(
      frame.recentMessages.map(async (ref) => {
        const source = await this.safeGetSource({
          tenantId: input.tenantId,
          messageId: ref.messageId,
          sourceRevision: ref.sourceRevision,
        });
        return source
          ? toImmediateCandidate(
              ref,
              source.source.text,
              frame.currentMessageSequence,
              frame.erasureEpoch,
            )
          : null;
      }),
    );

    const candidates = resolved.filter(
      (value): value is ContextCandidate => value !== null,
    );

    const currentMessageTokens = Math.min(
      this.config.maxCurrentMessageTokens,
      currentSource
        ? estimateTokens(currentSource.source.text)
        : this.config.fallbackCurrentMessageTokens,
    );

    // A compatible ConversationState is necessary for T2, but not
    // sufficient. Until a state/recovery/correction adapter materialises at
    // least one derived candidate, selecting T2 would only relabel the same
    // recent-message window and overstate adaptive-context behaviour.
    const hasDerivedCandidate = candidates.some(
      (candidate) =>
        candidate.candidateType !== "IMMEDIATE_MESSAGE",
    );

    const strategy =
      state !== null && hasDerivedCandidate
        ? "T2_ADAPTIVE_V1"
        : candidates.length > 0
          ? "T1"
          : "T0";

    return {
      currentMessageSequence: frame.currentMessageSequence,
      currentOperationSequence: frame.currentOperationSequence,
      erasureEpoch: frame.erasureEpoch,
      strategy,
      state,
      candidates,
      budget: {
        ...this.config.budget,
        currentMessageTokens,
      },
    };
  }

  private async safeGetSource(input: {
    tenantId: UUID;
    messageId: UUID;
    sourceRevision: number;
  }) {
    try {
      return await this.deps.transientSources.get(input);
    } catch {
      return undefined;
    }
  }
}

function toImmediateCandidate(
  ref: RecentContextMessageRef,
  content: string,
  currentMessageSequence: number,
  erasureEpoch: number,
): ContextCandidate {
  const distance = Math.max(
    1,
    currentMessageSequence - ref.messageSequence,
  );

  return {
    candidateId:
      `message:${ref.messageId}:${ref.sourceRevision}`,
    candidateType: "IMMEDIATE_MESSAGE",
    content,
    sourceMessageSequence: ref.messageSequence,
    causalThroughOperationSequence: ref.operationSequence,
    sourceRevisionRefs: [
      `${ref.messageId}:${ref.sourceRevision}`,
    ],
    claimRefs: [],
    // V1 does not fabricate semantic similarity before an embedding/reranker
    // explicitly produces one.
    semanticScore: 0,
    temporalScore: 1 / distance,
    confidence: 1,
    // Neutral bounded prior for an exact recent source revision.
    importance: 0.3,
    explicitReference: false,
    activeEpisode: false,
    tokenEstimate: estimateTokens(content),
    privacyScope: "TRANSIENT",
    erasureEpoch,
    validUntil: null,
    correctionTrigger: null,
  };
}

function estimateTokens(text: string): number {
  return Math.max(
    1,
    Math.ceil(text.trim().length / 4),
  );
}

function validateConfig(
  config: TranslationContextPlannerConfig,
): void {
  for (const [name, value] of Object.entries({
    recentMessageLimit: config.recentMessageLimit,
    fallbackCurrentMessageTokens:
      config.fallbackCurrentMessageTokens,
    maxCurrentMessageTokens:
      config.maxCurrentMessageTokens,
    ...config.budget,
  })) {
    if (
      !Number.isInteger(value) ||
      Number(value) < 1
    ) {
      throw new TypeError(
        `Context planner config ${name} must be a positive integer`,
      );
    }
  }

  const fixed =
    config.budget.systemReserveTokens +
    config.budget.safetyReserveTokens +
    Math.min(
      config.fallbackCurrentMessageTokens,
      config.maxCurrentMessageTokens,
    );

  if (fixed > config.budget.totalTokens) {
    throw new TypeError(
      "Context planner fixed token reserves exceed totalTokens",
    );
  }
}

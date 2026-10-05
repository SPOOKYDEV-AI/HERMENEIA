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
  currentMessageAcceptedAt: string;
  currentSourceAuthorUserId: UUID;
  currentSourceLanguageTag: string | null;
  erasureEpoch: number;
  policyVersion: number;
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

export interface DerivedContextCandidateSource {
  load(
    input: TranslationContextRequest,
    state: ConversationContextState,
    frame: ContextPlanningFrame,
  ): Promise<ContextCandidate[]>;
}

export interface ControlPlaneContextCandidateSource {
  load(
    input: TranslationContextRequest,
    frame: ContextPlanningFrame,
  ): Promise<ContextCandidate[]>;
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
  derivedCandidates?: DerivedContextCandidateSource;
  controlPlaneCandidates?: ControlPlaneContextCandidateSource;
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

    if (
      !Number.isFinite(
        Date.parse(frame.currentMessageAcceptedAt),
      )
    ) {
      throw new TypeError(
        "currentMessageAcceptedAt must be a valid timestamp",
      );
    }

    const state = stateForCurrentOperation(
      loadedState,
      input.conversationId,
      frame,
    );

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

    const immediateCandidates = resolved.filter(
      (value): value is ContextCandidate => value !== null,
    );

    const stateDerivedCandidates =
      state && this.deps.derivedCandidates
        ? await this.safeLoadDerivedCandidates(
            input,
            state,
            frame,
          )
        : [];

    const controlPlaneCandidates =
      this.deps.controlPlaneCandidates
        ? await this.safeLoadControlPlaneCandidates(
            input,
            frame,
          )
        : [];

    const derivedCandidates = [
      ...stateDerivedCandidates,
      ...controlPlaneCandidates,
    ];

    const candidates = [
      ...immediateCandidates,
      ...derivedCandidates,
    ];

    const currentMessageTokens = Math.min(
      this.config.maxCurrentMessageTokens,
      currentSource
        ? estimateTokens(currentSource.source.text)
        : this.config.fallbackCurrentMessageTokens,
    );

    // T2 requires material derived/control-plane evidence, but a
    // ConversationState is not required for independently authoritative
    // tenant policy/glossary evidence. State-derived adapters still run only
    // with a compatible causal state.
    const strategy =
      derivedCandidates.length > 0
        ? "T2_ADAPTIVE_V1"
        : immediateCandidates.length > 0
          ? "T1"
          : "T0";

    return {
      currentMessageSequence: frame.currentMessageSequence,
      currentOperationSequence: frame.currentOperationSequence,
      erasureEpoch: frame.erasureEpoch,
      policyVersion: frame.policyVersion,
      strategy,
      state,
      candidates,
      budget: {
        ...this.config.budget,
        currentMessageTokens,
      },
    };
  }

  private async safeLoadDerivedCandidates(
    input: TranslationContextRequest,
    state: ConversationContextState,
    frame: ContextPlanningFrame,
  ): Promise<ContextCandidate[]> {
    try {
      const candidates =
        await this.deps.derivedCandidates!.load(
          input,
          structuredClone(state),
          structuredClone(frame),
        );
      return Array.isArray(candidates)
        ? candidates.map((candidate) =>
            structuredClone(candidate),
          )
        : [];
    } catch {
      // Adaptive enrichment is optional to the critical path. A failed
      // adapter degrades to exact transient T1/T0 context rather than
      // blocking translation or fabricating derived evidence.
      return [];
    }
  }

  private async safeLoadControlPlaneCandidates(
    input: TranslationContextRequest,
    frame: ContextPlanningFrame,
  ): Promise<ContextCandidate[]> {
    try {
      const candidates =
        await this.deps.controlPlaneCandidates!.load(
          input,
          structuredClone(frame),
        );
      return Array.isArray(candidates)
        ? candidates.map((candidate) =>
            structuredClone(candidate),
          )
        : [];
    } catch {
      // Control-plane enrichment is optional to the critical path. If the
      // complete bounded policy view cannot be established, translation
      // degrades to state-derived/T1/T0 context rather than applying a
      // partial or fabricated policy set.
      return [];
    }
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

function stateForCurrentOperation(
  loadedState: ConversationContextState | null,
  conversationId: UUID,
  frame: ContextPlanningFrame,
): ConversationContextState | null {
  if (
    !loadedState ||
    loadedState.conversationId !== conversationId ||
    loadedState.erasureEpoch !== frame.erasureEpoch ||
    loadedState.policyVersion !== frame.policyVersion
  ) {
    return null;
  }

  // Once durable derived state has processed the current operation (or a
  // later one), we cannot project it backwards safely: episode/style/etc.
  // may already contain evidence from the message being translated.
  if (
    loadedState.processedPrefixOperationSequence >=
    frame.currentOperationSequence
  ) {
    return null;
  }

  // Pending operations at/after the current operation are not historical
  // freshness gaps for this translation. In particular, the current message
  // is normally registered before its translation fanout and must not make
  // context preparation reject an otherwise causal state.
  return {
    ...structuredClone(loadedState),
    processingGapOperationSequences:
      loadedState.processingGapOperationSequences.filter(
        (sequence) =>
          sequence >
            loadedState.processedPrefixOperationSequence &&
          sequence < frame.currentOperationSequence,
      ),
  };
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

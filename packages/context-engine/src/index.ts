import type { UUID } from "../../domain/src/index.js";

export type ContextStrategy =
  | "T0"
  | "T1"
  | "T2_ADAPTIVE_V1";

export type ContextRecoveryMode =
  | "FAST"
  | "PARTIAL"
  | "DEGRADED";

export type ContextCandidateType =
  | "IMMEDIATE_MESSAGE"
  | "ACTIVE_EPISODE"
  | "RECOVERY_CHECKPOINT"
  | "CORRECTION_MEMORY"
  | "APPROVED_POLICY"
  | "STYLE_PROFILE";

export type ContextPrivacyScope =
  | "TRANSIENT"
  | "CHECKPOINT"
  | "CORRECTION"
  | "POLICY"
  | "STYLE"
  | "EPISODE";

export type CorrectionTrigger =
  | "EXPLICIT_UI"
  | "EXPLICIT_REPAIR"
  | "TENANT_POLICY";

export interface ConversationContextState {
  conversationId: UUID;
  contextVersion: number;
  processedPrefixOperationSequence: number;
  processingGapOperationSequences: number[];
  erasureEpoch: number;
  policyVersion: number;
  activeEpisodeId: UUID | null;
  activeEpisodeVersion: number | null;
  activeEpisodeContinuityConfidence?: number | null;
  activeEpisodeStartOperationSequence?: number | null;
  activeEpisodeLastOperationSequence?: number | null;
  activeEpisodeStartedAt?: string | null;
  activeEpisodeLastActivityAt?: string | null;
  terminologyClaimRefs?: UUID[];
  lexicalClaimRefs?: UUID[];
  correctionClaimRefs?: UUID[];
  styleProfiles?: Array<{
    speakerUserId: UUID;
    preferredRegister:
      | "NEUTRAL"
      | "FORMAL"
      | "INFORMAL";
    sourceRepairEventId: UUID;
    confidence: number;
    updatedAt: string;
    expiresAt?: string;
  }>;
  updatedAt: string;
}

export interface ContextCandidate {
  candidateId: string;
  candidateType: ContextCandidateType;

  /**
   * Transient context content supplied to the translation layer.
   * It is intentionally excluded from ContextSnapshot.
   */
  content: string;

  sourceMessageSequence?: number | null;

  /**
   * Highest conversation sequence whose evidence contributed to this
   * candidate. Required for derived conversational state that has no single
   * sourceMessageSequence. It prevents a checkpoint/episode computed in the future
   * from leaking into an earlier translation.
   */
  causalThroughOperationSequence?: number | null;

  sourceRevisionRefs?: string[];
  claimRefs?: string[];

  semanticScore: number;
  temporalScore: number;
  confidence: number;
  importance: number;

  explicitReference?: boolean;
  activeEpisode?: boolean;

  tokenEstimate?: number;
  privacyScope: ContextPrivacyScope;
  erasureEpoch: number;
  validUntil?: string | null;

  /**
   * Required only for durable correction memory. A model inference by itself
   * is never an admissible durable correction.
   */
  correctionTrigger?: CorrectionTrigger | null;
}

export interface ContextBudget {
  totalTokens: number;
  systemReserveTokens: number;
  currentMessageTokens: number;
  safetyReserveTokens: number;

  /**
   * Soft bands. Unused budget may flow to later bands.
   */
  immediateReserveTokens: number;
  activeEpisodeReserveTokens: number;
  memoryReserveTokens: number;
}

export interface ContextEngineConfig {
  strategyVersion: string;
  t1WindowSize: number;
  minAdaptiveUtility: number;
  weights: {
    semantic: number;
    temporal: number;
    confidence: number;
    importance: number;
    explicitReferenceBonus: number;
    activeEpisodeBonus: number;
    tokenPenalty: number;
  };
}

export interface BuildContextInput {
  snapshotId: UUID;
  conversationId: UUID;
  messageId: UUID;
  sourceRevision: number;
  recipientUserId: UUID;
  targetLanguageTag: string;
  targetProfileVersion: number;
  /** Message ordering axis used to exclude future messages. */
  currentMessageSequence: number;
  /** Operation ordering axis used for causal state freshness. */
  currentOperationSequence: number;
  /**
   * Authoritative conversation erasure epoch. This value exists even when
   * the derived ConversationContextState cache is absent.
   */
  erasureEpoch: number;
  policyVersion: number;
  tenantPolicyVersion: number;
  now: string;
  strategy: ContextStrategy;
  state: ConversationContextState | null;
  candidates: ContextCandidate[];
  budget: ContextBudget;
}

export interface SelectedContextItem {
  candidateId: string;
  candidateType: ContextCandidateType;
  content: string;
  tokenEstimate: number;
  utility: number;
  selectionReason:
    | "T1_RECENT_WINDOW"
    | "FRESHNESS_RECONCILIATION"
    | "EXPLICIT_REFERENCE"
    | "IMMEDIATE_CONTEXT"
    | "ACTIVE_EPISODE"
    | "CORRECTION_OR_POLICY"
    | "STYLE_PROFILE"
    | "RECOVERY_CHECKPOINT"
    | "ADAPTIVE_UTILITY";
}

export interface ContextSnapshot {
  snapshotId: UUID;
  conversationId: UUID;
  messageId: UUID;
  sourceRevision: number;
  recipientUserId: UUID;
  targetLanguageTag: string;
  targetProfileVersion: number;
  strategy: ContextStrategy;
  strategyVersion: string;
  contextStateVersion: number | null;
  activeEpisodeId: UUID | null;
  selectedCandidateIds: string[];
  selectedSourceRevisionRefs: string[];
  selectedClaimRefs: string[];
  processedPrefixOperationSequence: number;
  processingGapOperationSequences: number[];
  erasureEpoch: number;
  policyVersion: number;
  tenantPolicyVersion: number;
  tokenEstimate: number;
  recoveryMode: ContextRecoveryMode;
  createdAt: string;
}

export interface ContextMetrics {
  candidatesTotal: number;
  candidatesEligible: number;
  candidatesSelected: number;
  contextTokensEstimated: number;
  contextFreshnessOperationGap: number;
  recoveryMode: ContextRecoveryMode;
}

export interface ContextBuildResult {
  selected: SelectedContextItem[];
  snapshot: ContextSnapshot;
  metrics: ContextMetrics;
}

const DEFAULT_CONFIG: ContextEngineConfig = {
  strategyVersion: "adaptive-context-v1",
  t1WindowSize: 3,
  minAdaptiveUtility: 0.25,
  weights: {
    semantic: 0.32,
    temporal: 0.2,
    confidence: 0.18,
    importance: 0.15,
    explicitReferenceBonus: 0.2,
    activeEpisodeBonus: 0.12,
    tokenPenalty: 0.02,
  },
};

interface ScoredCandidate {
  candidate: ContextCandidate;
  tokenEstimate: number;
  utility: number;
}

export class ContextEngine {
  private readonly config: ContextEngineConfig;

  constructor(config: Partial<ContextEngineConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      weights: {
        ...DEFAULT_CONFIG.weights,
        ...(config.weights ?? {}),
      },
    };

    assertConfig(this.config);
  }

  build(input: BuildContextInput): ContextBuildResult {
    validateInput(input);

    const erasureEpoch = input.erasureEpoch;
    const processedPrefixOperationSequence =
      input.state?.processedPrefixOperationSequence ?? 0;
    const processingGapOperationSequences =
      normaliseGaps(
        input.state?.processingGapOperationSequences ?? [],
        processedPrefixOperationSequence,
        input.currentOperationSequence,
      );
    const recoveryMode = deriveRecoveryMode(
      input.state,
      processingGapOperationSequences,
    );

    const eligible = input.candidates.filter((candidate) =>
      isEligible(candidate, input, erasureEpoch),
    );

    const selected =
      input.strategy === "T0"
        ? []
        : input.strategy === "T1"
          ? this.selectT1(eligible, input)
          : this.selectT2(
              eligible,
              input,
              processedPrefixOperationSequence,
              processingGapOperationSequences,
            );

    const tokenEstimate = selected.reduce(
      (sum, item) => sum + item.tokenEstimate,
      0,
    );

    const snapshot: ContextSnapshot = {
      snapshotId: input.snapshotId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      sourceRevision: input.sourceRevision,
      recipientUserId: input.recipientUserId,
      targetLanguageTag: input.targetLanguageTag,
      targetProfileVersion: input.targetProfileVersion,
      strategy: input.strategy,
      strategyVersion: this.config.strategyVersion,
      contextStateVersion:
        input.state?.contextVersion ?? null,
      activeEpisodeId:
        input.state?.activeEpisodeId ?? null,
      selectedCandidateIds: selected.map(
        (item) => item.candidateId,
      ),
      selectedSourceRevisionRefs: unique(
        selected.flatMap((item) => {
          const candidate = eligible.find(
            (value) =>
              value.candidateId === item.candidateId,
          );
          return candidate?.sourceRevisionRefs ?? [];
        }),
      ),
      selectedClaimRefs: unique(
        selected.flatMap((item) => {
          const candidate = eligible.find(
            (value) =>
              value.candidateId === item.candidateId,
          );
          return candidate?.claimRefs ?? [];
        }),
      ),
      processedPrefixOperationSequence,
      processingGapOperationSequences,
      erasureEpoch,
      policyVersion: input.policyVersion,
      tenantPolicyVersion: input.tenantPolicyVersion,
      tokenEstimate,
      recoveryMode,
      createdAt: input.now,
    };

    const metrics: ContextMetrics = {
      candidatesTotal: input.candidates.length,
      candidatesEligible: eligible.length,
      candidatesSelected: selected.length,
      contextTokensEstimated: tokenEstimate,
      contextFreshnessOperationGap: Math.max(
        0,
        input.currentOperationSequence -
          1 -
          processedPrefixOperationSequence,
      ),
      recoveryMode,
    };

    return {
      selected,
      snapshot,
      metrics,
    };
  }

  private selectT1(
    candidates: ContextCandidate[],
    input: BuildContextInput,
  ): SelectedContextItem[] {
    const availableTokens = contextTokenBudget(input.budget);
    const recent = candidates
      .filter(
        (candidate) =>
          candidate.candidateType ===
            "IMMEDIATE_MESSAGE" &&
          candidate.sourceMessageSequence !== undefined &&
          candidate.sourceMessageSequence !== null,
      )
      .sort(
        (left, right) =>
          Number(right.sourceMessageSequence) -
            Number(left.sourceMessageSequence) ||
          left.candidateId.localeCompare(
            right.candidateId,
          ),
      )
      .slice(0, this.config.t1WindowSize)
      .sort(
        (left, right) =>
          Number(left.sourceMessageSequence) -
            Number(right.sourceMessageSequence) ||
          left.candidateId.localeCompare(
            right.candidateId,
          ),
      );

    const selected: SelectedContextItem[] = [];
    let used = 0;

    for (const candidate of recent) {
      const tokenEstimate =
        estimateCandidateTokens(candidate);
      if (used + tokenEstimate > availableTokens) {
        continue;
      }
      selected.push({
        candidateId: candidate.candidateId,
        candidateType: candidate.candidateType,
        content: candidate.content,
        tokenEstimate,
        utility: 1,
        selectionReason: "T1_RECENT_WINDOW",
      });
      used += tokenEstimate;
    }

    return selected;
  }

  private selectT2(
    candidates: ContextCandidate[],
    input: BuildContextInput,
    processedPrefixOperationSequence: number,
    processingGapOperationSequences: number[],
  ): SelectedContextItem[] {
    const availableTokens = contextTokenBudget(input.budget);
    if (availableTokens <= 0) return [];

    const scored = candidates.map((candidate) =>
      this.score(candidate),
    );

    const selected: SelectedContextItem[] = [];
    const selectedIds = new Set<string>();
    let usedTokens = 0;
    const softBandUsed = {
      immediate: 0,
      episode: 0,
      memory: 0,
    };

    const selectFrom = (
      pool: ScoredCandidate[],
      reason:
        | "FRESHNESS_RECONCILIATION"
        | "EXPLICIT_REFERENCE"
        | "IMMEDIATE_CONTEXT"
        | "ACTIVE_EPISODE"
        | "CORRECTION_OR_POLICY"
        | "STYLE_PROFILE"
        | "RECOVERY_CHECKPOINT"
        | "ADAPTIVE_UTILITY",
      softBand:
        | "immediate"
        | "episode"
        | "memory"
        | null,
      softBandLimit: number | null,
      bypassUtility = false,
    ) => {
      for (const entry of sortScored(pool)) {
        if (
          selectedIds.has(entry.candidate.candidateId)
        ) {
          continue;
        }
        if (
          !bypassUtility &&
          entry.utility < this.config.minAdaptiveUtility
        ) {
          continue;
        }
        if (
          softBand !== null &&
          softBandLimit !== null &&
          softBandUsed[softBand] +
            entry.tokenEstimate >
            softBandLimit
        ) {
          continue;
        }
        if (
          usedTokens + entry.tokenEstimate >
          availableTokens
        ) {
          continue;
        }

        selected.push({
          candidateId: entry.candidate.candidateId,
          candidateType: entry.candidate.candidateType,
          content: entry.candidate.content,
          tokenEstimate: entry.tokenEstimate,
          utility: entry.utility,
          selectionReason: reason,
        });
        selectedIds.add(entry.candidate.candidateId);
        usedTokens += entry.tokenEstimate;
        if (softBand !== null) {
          softBandUsed[softBand] +=
            entry.tokenEstimate;
        }
      }
    };

    const gapSet = new Set(processingGapOperationSequences);
    const freshness = scored.filter(({ candidate }) =>
      candidate.candidateType ===
        "IMMEDIATE_MESSAGE" &&
      candidate.sourceMessageSequence !== undefined &&
      candidate.sourceMessageSequence !== null &&
      Number(candidate.sourceMessageSequence) <
        input.currentMessageSequence &&
      candidate.causalThroughOperationSequence !== undefined &&
      candidate.causalThroughOperationSequence !== null &&
      Number(candidate.causalThroughOperationSequence) <
        input.currentOperationSequence &&
      (Number(candidate.causalThroughOperationSequence) >
        processedPrefixOperationSequence ||
        gapSet.has(
          Number(candidate.causalThroughOperationSequence),
        )),
    );

    selectFrom(
      freshness,
      "FRESHNESS_RECONCILIATION",
      null,
      null,
      true,
    );

    selectFrom(
      scored.filter(
        ({ candidate }) =>
          candidate.explicitReference === true,
      ),
      "EXPLICIT_REFERENCE",
      null,
      null,
      true,
    );

    const immediateWindow = scored
      .filter(
        ({ candidate }) =>
          candidate.candidateType ===
            "IMMEDIATE_MESSAGE" &&
          candidate.sourceMessageSequence !== undefined &&
          candidate.sourceMessageSequence !== null,
      )
      .sort(
        (left, right) =>
          Number(
            right.candidate.sourceMessageSequence,
          ) -
            Number(
              left.candidate.sourceMessageSequence,
            ) ||
          left.candidate.candidateId.localeCompare(
            right.candidate.candidateId,
          ),
      )
      .slice(0, this.config.t1WindowSize);

    selectFrom(
      immediateWindow,
      "IMMEDIATE_CONTEXT",
      "immediate",
      input.budget.immediateReserveTokens,
    );

    selectFrom(
      scored.filter(
        ({ candidate }) =>
          candidate.candidateType ===
            "ACTIVE_EPISODE" ||
          candidate.activeEpisode === true,
      ),
      "ACTIVE_EPISODE",
      "episode",
      input.budget.activeEpisodeReserveTokens,
    );

    selectFrom(
      scored.filter(
        ({ candidate }) =>
          candidate.candidateType ===
          "STYLE_PROFILE",
      ),
      "STYLE_PROFILE",
      "memory",
      input.budget.memoryReserveTokens,
    );

    selectFrom(
      scored.filter(
        ({ candidate }) =>
          candidate.candidateType ===
            "CORRECTION_MEMORY" ||
          candidate.candidateType ===
            "APPROVED_POLICY",
      ),
      "CORRECTION_OR_POLICY",
      "memory",
      input.budget.memoryReserveTokens,
    );

    selectFrom(
      scored.filter(
        ({ candidate }) =>
          candidate.candidateType ===
          "RECOVERY_CHECKPOINT",
      ),
      "RECOVERY_CHECKPOINT",
      "memory",
      input.budget.memoryReserveTokens,
    );

    const immediateWindowIds = new Set(
      immediateWindow.map(
        ({ candidate }) =>
          candidate.candidateId,
      ),
    );

    selectFrom(
      scored.filter(
        ({ candidate }) =>
          candidate.candidateType !==
            "IMMEDIATE_MESSAGE" ||
          immediateWindowIds.has(
            candidate.candidateId,
          ),
      ),
      "ADAPTIVE_UTILITY",
      null,
      null,
    );

    return reorderPayload(selected, candidates);
  }

  private score(
    candidate: ContextCandidate,
  ): ScoredCandidate {
    const tokenEstimate =
      estimateCandidateTokens(candidate);
    const normalisedTokenCost = Math.min(
      1,
      tokenEstimate / 256,
    );

    const utility =
      this.config.weights.semantic *
        candidate.semanticScore +
      this.config.weights.temporal *
        candidate.temporalScore +
      this.config.weights.confidence *
        candidate.confidence +
      this.config.weights.importance *
        candidate.importance +
      (candidate.explicitReference
        ? this.config.weights
            .explicitReferenceBonus
        : 0) +
      (candidate.activeEpisode
        ? this.config.weights.activeEpisodeBonus
        : 0) -
      this.config.weights.tokenPenalty *
        normalisedTokenCost;

    return {
      candidate,
      tokenEstimate,
      utility,
    };
  }
}

function validateInput(input: BuildContextInput): void {
  if (
    !input.snapshotId ||
    !input.conversationId ||
    !input.messageId ||
    !input.recipientUserId ||
    !input.targetLanguageTag.trim()
  ) {
    throw new TypeError(
      "snapshotId, conversationId, messageId, recipientUserId and targetLanguageTag are required",
    );
  }

  if (
    !Number.isInteger(input.sourceRevision) ||
    input.sourceRevision < 1
  ) {
    throw new TypeError(
      "sourceRevision must be a positive integer",
    );
  }

  if (
    !Number.isInteger(input.targetProfileVersion) ||
    input.targetProfileVersion < 1
  ) {
    throw new TypeError(
      "targetProfileVersion must be a positive integer",
    );
  }
  if (
    !Number.isInteger(input.currentMessageSequence) ||
    input.currentMessageSequence < 1
  ) {
    throw new TypeError(
      "currentMessageSequence must be a positive integer",
    );
  }
  if (
    !Number.isInteger(input.currentOperationSequence) ||
    input.currentOperationSequence < 1
  ) {
    throw new TypeError(
      "currentOperationSequence must be a positive integer",
    );
  }
  if (
    !Number.isInteger(input.erasureEpoch) ||
    input.erasureEpoch < 0
  ) {
    throw new TypeError(
      "erasureEpoch must be a non-negative integer",
    );
  }
  if (
    !Number.isInteger(input.policyVersion) ||
    input.policyVersion < 1
  ) {
    throw new TypeError(
      "policyVersion must be a positive integer",
    );
  }
  if (
    !Number.isInteger(input.tenantPolicyVersion) ||
    input.tenantPolicyVersion < 1
  ) {
    throw new TypeError(
      "tenantPolicyVersion must be a positive integer",
    );
  }
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new TypeError("now must be a valid timestamp");
  }

  validateBudget(input.budget);

  if (
    input.state &&
    input.state.conversationId !==
      input.conversationId
  ) {
    throw new TypeError(
      "ContextState belongs to another conversation",
    );
  }

  if (input.state) {
    if (
      !Number.isInteger(
        input.state.processedPrefixOperationSequence,
      ) ||
      input.state.processedPrefixOperationSequence < 0 ||
      input.state.processedPrefixOperationSequence >=
        input.currentOperationSequence
    ) {
      throw new TypeError(
        "processedPrefixOperationSequence must precede currentOperationSequence",
      );
    }
    if (
      !Number.isInteger(input.state.contextVersion) ||
      input.state.contextVersion < 1
    ) {
      throw new TypeError(
        "contextVersion must be a positive integer",
      );
    }
    if (
      !Number.isInteger(input.state.erasureEpoch) ||
      input.state.erasureEpoch < 0
    ) {
      throw new TypeError(
        "ContextState erasureEpoch must be a non-negative integer",
      );
    }
    if (
      input.state.erasureEpoch !== input.erasureEpoch
    ) {
      throw new TypeError(
        "ContextState erasureEpoch does not match authoritative erasureEpoch",
      );
    }

    if (
      !Number.isInteger(input.state.policyVersion) ||
      input.state.policyVersion < 1
    ) {
      throw new TypeError(
        "ContextState policyVersion must be a positive integer",
      );
    }
    if (
      input.state.policyVersion !== input.policyVersion
    ) {
      throw new TypeError(
        "ContextState policyVersion does not match authoritative policyVersion",
      );
    }

    for (const gap of input.state.processingGapOperationSequences) {
      if (
        !Number.isInteger(gap) ||
        gap <= input.state.processedPrefixOperationSequence ||
        gap >= input.currentOperationSequence
      ) {
        throw new TypeError(
          "processingGapOperationSequences must be strictly after the processed prefix and before currentOperationSequence",
        );
      }
    }
  }

  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate.candidateId || ids.has(candidate.candidateId)) {
      throw new TypeError(
        "candidateId values must be non-empty and unique",
      );
    }
    ids.add(candidate.candidateId);

    if (!candidate.content) {
      throw new TypeError(
        "Context candidate content is required",
      );
    }

    for (const [name, value] of [
      ["semanticScore", candidate.semanticScore],
      ["temporalScore", candidate.temporalScore],
      ["confidence", candidate.confidence],
      ["importance", candidate.importance],
    ] as const) {
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1
      ) {
        throw new TypeError(
          `${name} must be in [0,1]`,
        );
      }
    }

    if (
      candidate.sourceMessageSequence !== undefined &&
      candidate.sourceMessageSequence !== null &&
      (!Number.isInteger(candidate.sourceMessageSequence) ||
        candidate.sourceMessageSequence < 1)
    ) {
      throw new TypeError(
        "candidate sourceMessageSequence must be a positive integer when present",
      );
    }

    if (
      candidate.causalThroughOperationSequence !== undefined &&
      candidate.causalThroughOperationSequence !== null &&
      (!Number.isInteger(candidate.causalThroughOperationSequence) ||
        candidate.causalThroughOperationSequence < 0)
    ) {
      throw new TypeError(
        "candidate causalThroughOperationSequence must be a non-negative integer when present",
      );
    }

    if (
      candidate.candidateType === "ACTIVE_EPISODE" ||
      candidate.candidateType === "RECOVERY_CHECKPOINT"
    ) {
      if (
        candidate.causalThroughOperationSequence === undefined ||
        candidate.causalThroughOperationSequence === null
      ) {
        throw new TypeError(
          "Derived episode/checkpoint candidates require causalThroughOperationSequence",
        );
      }
    }

    if (
      candidate.candidateType === "CORRECTION_MEMORY" &&
      (candidate.causalThroughOperationSequence === undefined ||
        candidate.causalThroughOperationSequence === null)
    ) {
      throw new TypeError(
        "Correction memory requires causalThroughOperationSequence",
      );
    }

    if (
      candidate.validUntil &&
      !Number.isFinite(Date.parse(candidate.validUntil))
    ) {
      throw new TypeError(
        "candidate validUntil must be a valid timestamp",
      );
    }

    if (
      !Number.isInteger(candidate.erasureEpoch) ||
      candidate.erasureEpoch < 0
    ) {
      throw new TypeError(
        "candidate erasureEpoch must be a non-negative integer",
      );
    }

    if (
      candidate.candidateType ===
        "CORRECTION_MEMORY" &&
      !candidate.correctionTrigger
    ) {
      throw new TypeError(
        "Durable correction memory requires an explicit correction trigger",
      );
    }
  }
}

function validateBudget(budget: ContextBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(
        `${name} must be a non-negative integer`,
      );
    }
  }

  if (budget.totalTokens < 1) {
    throw new TypeError(
      "totalTokens must be positive",
    );
  }

  const fixed =
    budget.systemReserveTokens +
    budget.currentMessageTokens +
    budget.safetyReserveTokens;

  if (fixed > budget.totalTokens) {
    throw new TypeError(
      "Fixed context reserves exceed totalTokens",
    );
  }
}

function assertConfig(config: ContextEngineConfig): void {
  if (!config.strategyVersion) {
    throw new TypeError(
      "strategyVersion is required",
    );
  }
  if (
    !Number.isInteger(config.t1WindowSize) ||
    config.t1WindowSize < 0
  ) {
    throw new TypeError(
      "t1WindowSize must be a non-negative integer",
    );
  }
  if (
    !Number.isFinite(config.minAdaptiveUtility)
  ) {
    throw new TypeError(
      "minAdaptiveUtility must be finite",
    );
  }

  for (const [name, value] of Object.entries(
    config.weights,
  )) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(
        `Context weight ${name} must be a non-negative finite number`,
      );
    }
  }
}

function deriveRecoveryMode(
  state: ConversationContextState | null,
  processingGapOperationSequences: number[],
): ContextRecoveryMode {
  if (!state) return "DEGRADED";
  return processingGapOperationSequences.length > 0
    ? "PARTIAL"
    : "FAST";
}

function isEligible(
  candidate: ContextCandidate,
  input: BuildContextInput,
  erasureEpoch: number,
): boolean {
  if (candidate.erasureEpoch !== erasureEpoch) {
    return false;
  }

  if (
    candidate.validUntil &&
    Date.parse(candidate.validUntil) <=
      Date.parse(input.now)
  ) {
    return false;
  }

  if (
    candidate.sourceMessageSequence !== undefined &&
    candidate.sourceMessageSequence !== null &&
    candidate.sourceMessageSequence >= input.currentMessageSequence
  ) {
    return false;
  }

  if (
    candidate.causalThroughOperationSequence !== undefined &&
    candidate.causalThroughOperationSequence !== null &&
    candidate.causalThroughOperationSequence >= input.currentOperationSequence
  ) {
    return false;
  }

  if (
    candidate.candidateType ===
      "CORRECTION_MEMORY" &&
    !candidate.correctionTrigger
  ) {
    return false;
  }

  return true;
}

function contextTokenBudget(
  budget: ContextBudget,
): number {
  return Math.max(
    0,
    budget.totalTokens -
      budget.systemReserveTokens -
      budget.currentMessageTokens -
      budget.safetyReserveTokens,
  );
}

function estimateCandidateTokens(
  candidate: ContextCandidate,
): number {
  if (
    candidate.tokenEstimate !== undefined &&
    Number.isInteger(candidate.tokenEstimate) &&
    candidate.tokenEstimate > 0
  ) {
    return candidate.tokenEstimate;
  }

  return Math.max(
    1,
    Math.ceil(candidate.content.length / 4),
  );
}

function sortScored(
  values: ScoredCandidate[],
): ScoredCandidate[] {
  return [...values].sort(
    (left, right) =>
      right.utility - left.utility ||
      right.candidate.importance -
        left.candidate.importance ||
      Number(
        right.candidate.sourceMessageSequence ?? -1,
      ) -
        Number(
          left.candidate.sourceMessageSequence ?? -1,
        ) ||
      left.candidate.candidateId.localeCompare(
        right.candidate.candidateId,
      ),
  );
}

function reorderPayload(
  selected: SelectedContextItem[],
  candidates: ContextCandidate[],
): SelectedContextItem[] {
  const byId = new Map(
    candidates.map((candidate) => [
      candidate.candidateId,
      candidate,
    ]),
  );

  return [...selected].sort((left, right) => {
    const leftCandidate = byId.get(left.candidateId);
    const rightCandidate = byId.get(right.candidateId);

    const leftSequence =
      leftCandidate?.sourceMessageSequence;
    const rightSequence =
      rightCandidate?.sourceMessageSequence;

    if (
      leftSequence !== undefined &&
      leftSequence !== null &&
      rightSequence !== undefined &&
      rightSequence !== null
    ) {
      return (
        leftSequence - rightSequence ||
        left.candidateId.localeCompare(
          right.candidateId,
        )
      );
    }

    if (
      leftSequence !== undefined &&
      leftSequence !== null
    ) {
      return -1;
    }
    if (
      rightSequence !== undefined &&
      rightSequence !== null
    ) {
      return 1;
    }

    return left.candidateId.localeCompare(
      right.candidateId,
    );
  });
}

function normaliseGaps(
  gaps: number[],
  processedPrefixOperationSequence: number,
  currentOperationSequence: number,
): number[] {
  return unique(
    gaps.filter(
      (value) =>
        Number.isInteger(value) &&
        value > processedPrefixOperationSequence &&
        value < currentOperationSequence,
    ),
  ).sort((left, right) => left - right);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

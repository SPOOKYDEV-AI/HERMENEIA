import type { UUID } from "../../domain/src/index.js";
import type {
  ContextBudget,
  ContextCandidate,
  ContextStrategy,
  ConversationContextState,
} from "../../context-engine/src/index.js";
import {
  ContextPreparationService,
  type ContextDegradedReason,
  type ContextResolutionResult,
} from "../../context-service/src/index.js";

export interface TranslationContextRequest {
  tenantId: UUID;
  conversationId: UUID;
  sourceMessageId: UUID;
  sourceRevision: number;
  recipientUserId: UUID;
  targetLanguageTag: string;
  targetProfileVersion: number;
}

export interface TranslationContextCandidateSet {
  currentMessageSequence: number;
  currentOperationSequence: number;
  erasureEpoch: number;
  policyVersion: number;
  tenantPolicyVersion: number;
  strategy: ContextStrategy;
  state: ConversationContextState | null;
  candidates: ContextCandidate[];
  budget: ContextBudget;
}

export interface TranslationContextCandidateSource {
  load(
    input: TranslationContextRequest,
  ): Promise<TranslationContextCandidateSet>;
}

export interface PreparedTranslationContext {
  contextSnapshotId: UUID;
  strategyVersion: string;
  requestedStrategy: ContextStrategy;
  effectiveStrategy: ContextStrategy;
  degradedReason: ContextDegradedReason | null;
}

export class TranslationContextService<Tx> {
  constructor(
    private readonly preparation: ContextPreparationService<Tx>,
    private readonly candidates: TranslationContextCandidateSource,
  ) {}

  async prepareForTranslation(
    input: TranslationContextRequest,
  ): Promise<PreparedTranslationContext> {
    validateRequest(input);

    const loaded = await this.candidates.load(input);

    const prepared = await this.preparation.prepare({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.sourceMessageId,
      sourceRevision: input.sourceRevision,
      recipientUserId: input.recipientUserId,
      targetLanguageTag: input.targetLanguageTag,
      targetProfileVersion: input.targetProfileVersion,
      currentMessageSequence: loaded.currentMessageSequence,
      currentOperationSequence: loaded.currentOperationSequence,
      erasureEpoch: loaded.erasureEpoch,
      policyVersion: loaded.policyVersion,
      tenantPolicyVersion: loaded.tenantPolicyVersion,
      strategy: loaded.strategy,
      state: loaded.state,
      candidates: loaded.candidates,
      budget: loaded.budget,
    });

    return {
      contextSnapshotId: prepared.snapshot.snapshotId,
      strategyVersion: prepared.snapshot.strategyVersion,
      requestedStrategy: prepared.requestedStrategy,
      effectiveStrategy: prepared.effectiveStrategy,
      degradedReason: prepared.degradedReason,
    };
  }

  resolveForTranslation(input: {
    tenantId: UUID;
    contextSnapshotId: UUID;
  }): Promise<ContextResolutionResult> {
    if (
      !input.tenantId ||
      !input.contextSnapshotId
    ) {
      throw new TypeError(
        "tenantId and contextSnapshotId are required",
      );
    }

    return this.preparation.resolveForProvider({
      tenantId: input.tenantId,
      snapshotId: input.contextSnapshotId,
    });
  }
}

function validateRequest(
  input: TranslationContextRequest,
): void {
  if (
    !input.tenantId ||
    !input.conversationId ||
    !input.sourceMessageId ||
    !input.recipientUserId ||
    !input.targetLanguageTag
  ) {
    throw new TypeError(
      "Translation context request identifiers are required",
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
}

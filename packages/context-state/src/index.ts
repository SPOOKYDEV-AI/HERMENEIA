import type { UUID } from "../../domain/src/index.js";

export type ContextOperationKind =
  | "MESSAGE_CREATED"
  | "MESSAGE_EDITED"
  | "MESSAGE_DELETED"
  | "CORRECTION_CONFIRMED"
  | "MEMBERSHIP_CHANGED"
  | "POLICY_CHANGED";

export type ContextOperationStatus =
  | "PENDING"
  | "PROCESSED"
  | "SOURCE_REQUIRED";

export interface ContextOperationRef {
  opSeq: number;
  operationId: UUID;
  kind: ContextOperationKind;
  messageId?: UUID;
  sourceRevision?: number;
  status: ContextOperationStatus;
  registeredAt: string;
}

export interface ActiveEpisodeState {
  episodeId: UUID;
  episodeVersion: number;
  continuityConfidence: number;
}

export interface ConversationStyleState {
  formality?: "LOW" | "MEDIUM" | "HIGH";
  warmth?: "LOW" | "MEDIUM" | "HIGH";
  directness?: "LOW" | "MEDIUM" | "HIGH";
  brevity?: "LOW" | "MEDIUM" | "HIGH";
  technicality?: "LOW" | "MEDIUM" | "HIGH";
  confidence?: number;
  expiresAt?: string;
}

export interface PragmaticStateCoarse {
  stance?:
    | "NEUTRAL"
    | "WARM"
    | "PLAYFUL"
    | "FORMAL"
    | "TENSE"
    | "APOLOGETIC"
    | "URGENT";
  speechAct?:
    | "STATEMENT"
    | "QUESTION"
    | "REQUEST"
    | "PROMISE"
    | "CORRECTION"
    | "ACKNOWLEDGEMENT";
  confidence?: number;
  expiresAt?: string;
}

export interface ConversationContextState {
  tenantId: UUID;
  conversationId: UUID;
  stateVersion: number;
  causalFloorOpSeq: number;
  processedPrefixOpSeq: number;
  pendingOperations: ContextOperationRef[];
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
  strategyVersion: string;
  stateSchemaVersion: 1;
  recoveryMode: "FULL" | "DEGRADED_BASELINE";
  status: "ACTIVE" | "DEGRADED";
  activeEpisode?: ActiveEpisodeState;
  terminologyClaimRefs: UUID[];
  lexicalClaimRefs: UUID[];
  correctionClaimRefs: UUID[];
  entityHandles: string[];
  unresolvedReferenceHandles: string[];
  styleState: ConversationStyleState;
  pragmaticState: PragmaticStateCoarse;
  updatedAt: string;
}

export interface ContextStatePatch {
  activeEpisode?: ActiveEpisodeState | null;
  terminologyClaimRefs?: UUID[];
  lexicalClaimRefs?: UUID[];
  correctionClaimRefs?: UUID[];
  entityHandles?: string[];
  unresolvedReferenceHandles?: string[];
  styleState?: ConversationStyleState;
  pragmaticState?: PragmaticStateCoarse;
  removeClaimRefs?: UUID[];
  clearActiveEpisode?: boolean;
}

export interface ContextDerivationResult {
  conversationId: UUID;
  operationId: UUID;
  opSeq: number;
  baseStateVersion: number;
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
  strategyVersion: string;
  outcome: "PROCESSED" | "SOURCE_REQUIRED";
  patch?: ContextStatePatch;
  completedAt: string;
}

export class ContextStateConflictError extends Error {
  constructor(
    public readonly code:
      | "STALE_STATE_VERSION"
      | "EPOCH_MISMATCH"
      | "UNKNOWN_OPERATION"
      | "OPERATION_CONFLICT"
      | "CAUSAL_GAP"
      | "INVALID_STATE",
    message: string,
  ) {
    super(message);
    this.name = "ContextStateConflictError";
  }
}

export function createInitialContextState(input: {
  tenantId: UUID;
  conversationId: UUID;
  causalFloorOpSeq?: number;
  processedPrefixOpSeq?: number;
  recoveryMode?: "FULL" | "DEGRADED_BASELINE";
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
  strategyVersion: string;
  now: string;
}): ConversationContextState {
  const causalFloorOpSeq = input.causalFloorOpSeq ?? 0;
  const processedPrefixOpSeq =
    input.processedPrefixOpSeq ?? causalFloorOpSeq;
  requireSafeInteger(causalFloorOpSeq, "causalFloorOpSeq", 0);
  requireSafeInteger(processedPrefixOpSeq, "processedPrefixOpSeq", 0);
  if (processedPrefixOpSeq < causalFloorOpSeq) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      "processedPrefixOpSeq cannot be behind causalFloorOpSeq",
    );
  }
  requireSafeInteger(input.membershipEpoch, "membershipEpoch", 1);
  requireSafeInteger(input.erasureEpoch, "erasureEpoch", 1);
  requireSafeInteger(input.policyVersion, "policyVersion", 1);
  requireOpaqueIdentifier(input.tenantId, "tenantId");
  requireOpaqueIdentifier(input.conversationId, "conversationId");
  requireStrategyVersion(input.strategyVersion);
  requireTimestamp(input.now, "now");

  return {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    stateVersion: 1,
    causalFloorOpSeq,
    processedPrefixOpSeq,
    pendingOperations: [],
    membershipEpoch: input.membershipEpoch,
    erasureEpoch: input.erasureEpoch,
    policyVersion: input.policyVersion,
    strategyVersion: input.strategyVersion,
    stateSchemaVersion: 1,
    recoveryMode: input.recoveryMode ?? "FULL",
    status:
      (input.recoveryMode ?? "FULL") === "FULL"
        ? "ACTIVE"
        : "DEGRADED",
    terminologyClaimRefs: [],
    lexicalClaimRefs: [],
    correctionClaimRefs: [],
    entityHandles: [],
    unresolvedReferenceHandles: [],
    styleState: {},
    pragmaticState: {},
    updatedAt: input.now,
  };
}

export function createDegradedContextStateFromFloor(input: {
  tenantId: UUID;
  conversationId: UUID;
  causalFloorOpSeq: number;
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
  strategyVersion: string;
  now: string;
}): ConversationContextState {
  return createInitialContextState({
    ...input,
    processedPrefixOpSeq: input.causalFloorOpSeq,
    recoveryMode: "DEGRADED_BASELINE",
  });
}

export function registerContextOperation(
  state: ConversationContextState,
  operation: Omit<ContextOperationRef, "status">,
): ConversationContextState {
  validateState(state);
  validateOperation(operation);

  if (operation.opSeq <= state.processedPrefixOpSeq) {
    return structuredClone(state);
  }

  const bySequence = state.pendingOperations.find(
    (candidate) => candidate.opSeq === operation.opSeq,
  );
  if (bySequence) {
    if (
      bySequence.operationId === operation.operationId &&
      bySequence.kind === operation.kind &&
      bySequence.messageId === operation.messageId &&
      bySequence.sourceRevision === operation.sourceRevision
    ) {
      return structuredClone(state);
    }
    throw new ContextStateConflictError(
      "OPERATION_CONFLICT",
      "Another context operation already owns this op_seq",
    );
  }

  if (state.pendingOperations.length >= 512) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      "Pending context operation budget exceeded",
    );
  }

  const next = structuredClone(state);
  next.pendingOperations.push({
    ...operation,
    status: "PENDING",
  });
  next.pendingOperations.sort((left, right) => left.opSeq - right.opSeq);
  next.stateVersion += 1;
  next.updatedAt = operation.registeredAt;
  validateState(next);
  return next;
}

export function applyContextDerivation(
  state: ConversationContextState,
  result: ContextDerivationResult,
): ConversationContextState {
  validateState(state);
  validateDerivationResult(result);

  if (result.conversationId !== state.conversationId) {
    throw new ContextStateConflictError(
      "UNKNOWN_OPERATION",
      "Derivation belongs to another conversation",
    );
  }
  if (result.baseStateVersion !== state.stateVersion) {
    throw new ContextStateConflictError(
      "STALE_STATE_VERSION",
      "Context derivation was computed from a stale state version",
    );
  }
  if (
    result.membershipEpoch !== state.membershipEpoch ||
    result.erasureEpoch !== state.erasureEpoch ||
    result.policyVersion !== state.policyVersion
  ) {
    throw new ContextStateConflictError(
      "EPOCH_MISMATCH",
      "Context derivation epochs do not match current state",
    );
  }
  if (result.strategyVersion !== state.strategyVersion) {
    throw new ContextStateConflictError(
      "STALE_STATE_VERSION",
      "Context derivation strategy version does not match current state",
    );
  }

  const index = state.pendingOperations.findIndex(
    (operation) =>
      operation.opSeq === result.opSeq &&
      operation.operationId === result.operationId,
  );
  if (index < 0) {
    throw new ContextStateConflictError(
      "UNKNOWN_OPERATION",
      "Context derivation operation is not registered",
    );
  }

  if (result.opSeq !== state.processedPrefixOpSeq + 1) {
    throw new ContextStateConflictError(
      "CAUSAL_GAP",
      "Context operation cannot publish before its causal predecessor",
    );
  }

  const next = structuredClone(state);
  const pending = next.pendingOperations[index];

  if (result.outcome === "SOURCE_REQUIRED") {
    pending.status = "SOURCE_REQUIRED";
    next.status = "DEGRADED";
  } else {
    pending.status = "PROCESSED";
    if (result.patch) {
      applySafePatch(next, result.patch);
    }
  }

  advanceContiguousPrefix(next);
  next.status =
    next.recoveryMode === "DEGRADED_BASELINE" ||
    next.pendingOperations.some(
      (operation) => operation.status === "SOURCE_REQUIRED",
    )
      ? "DEGRADED"
      : "ACTIVE";
  next.stateVersion += 1;
  next.updatedAt = result.completedAt;
  validateState(next);
  return next;
}

export function processingGapRefs(
  state: ConversationContextState,
): ContextOperationRef[] {
  validateState(state);
  return state.pendingOperations
    .filter((operation) => operation.status !== "PROCESSED")
    .map((operation) => structuredClone(operation));
}

function advanceContiguousPrefix(state: ConversationContextState): void {
  while (true) {
    const nextSequence = state.processedPrefixOpSeq + 1;
    const index = state.pendingOperations.findIndex(
      (operation) => operation.opSeq === nextSequence,
    );
    if (index < 0) return;

    const operation = state.pendingOperations[index];
    if (operation.status !== "PROCESSED") return;

    state.processedPrefixOpSeq = operation.opSeq;
    state.pendingOperations.splice(index, 1);
  }
}

function applySafePatch(
  state: ConversationContextState,
  patch: ContextStatePatch,
): void {
  if (patch.activeEpisode !== undefined) {
    state.activeEpisode =
      patch.activeEpisode === null
        ? undefined
        : validateEpisode(patch.activeEpisode);
  }
  if (patch.clearActiveEpisode) {
    state.activeEpisode = undefined;
  }

  if (patch.terminologyClaimRefs) {
    state.terminologyClaimRefs = validateRefSet(
      patch.terminologyClaimRefs,
      "terminologyClaimRefs",
      128,
    );
  }
  if (patch.lexicalClaimRefs) {
    state.lexicalClaimRefs = validateRefSet(
      patch.lexicalClaimRefs,
      "lexicalClaimRefs",
      128,
    );
  }
  if (patch.correctionClaimRefs) {
    state.correctionClaimRefs = validateRefSet(
      patch.correctionClaimRefs,
      "correctionClaimRefs",
      128,
    );
  }
  if (patch.entityHandles) {
    state.entityHandles = validateHandleSet(
      patch.entityHandles,
      "entityHandles",
      128,
    );
  }
  if (patch.unresolvedReferenceHandles) {
    state.unresolvedReferenceHandles = validateHandleSet(
      patch.unresolvedReferenceHandles,
      "unresolvedReferenceHandles",
      64,
    );
  }
  if (patch.styleState) {
    state.styleState = validateStyleState(patch.styleState);
  }
  if (patch.pragmaticState) {
    state.pragmaticState = validatePragmaticState(
      patch.pragmaticState,
    );
  }

  if (patch.removeClaimRefs?.length) {
    const removals = new Set(
      validateRefSet(
        patch.removeClaimRefs,
        "removeClaimRefs",
        256,
      ),
    );
    state.terminologyClaimRefs = state.terminologyClaimRefs.filter(
      (ref) => !removals.has(ref),
    );
    state.lexicalClaimRefs = state.lexicalClaimRefs.filter(
      (ref) => !removals.has(ref),
    );
    state.correctionClaimRefs = state.correctionClaimRefs.filter(
      (ref) => !removals.has(ref),
    );
  }
}

export type TranslationRepairKind =
  | "PROBLEM_REPORT"
  | "EXPLICIT_CORRECTION"
  | "MEANING_CORRECTION"
  | "TONE_CORRECTION"
  | "TERMINOLOGY_CORRECTION";

export type CorrectionTrigger =
  | "EXPLICIT_UI_CORRECTION"
  | "EXPLICIT_TEXTUAL_CORRECTION"
  | "APPROVED_GLOSSARY_CHANGE"
  | "TENANT_POLICY_CHANGE";

export interface RepairSignal {
  repairEventId: UUID;
  tenantId: UUID;
  conversationId: UUID;
  actorUserId: UUID;
  kind: TranslationRepairKind;
  trigger?: CorrectionTrigger;
  targetMessageId?: UUID;
  targetSourceRevision?: number;
  conceptType?:
    | "MEANING"
    | "TERMINOLOGY"
    | "TONE"
    | "LOCALE_PREFERENCE";
  surfaceForm?: string;
  correctedMeaning?: string;
  scopeKind?: "CONVERSATION" | "TENANT";
  sensitivityClass?: "NORMAL" | "RESTRICTED";
  createdAt: string;
}

export type DurableCorrectionDecision =
  | {
      action: "MARK_SUSPECT";
      durableClaim: null;
    }
  | {
      action: "NEEDS_CONFIRMATION";
      durableClaim: null;
    }
  | {
      action: "CREATE_CORRECTION";
      durableClaim: {
        retentionClass: "CORRECTIVE_DURABLE";
        modality: "CORRECTION";
        authorityClass: "CONFIRMED_CORRECTION";
        trigger: CorrectionTrigger;
        scopeKind: "CONVERSATION" | "TENANT";
        scopeConversationId: UUID | null;
        conversationId: UUID;
        repairEventId: UUID;
        actorUserId: UUID;
        targetMessageId?: UUID;
        targetSourceRevision?: number;
        conceptType:
          | "MEANING"
          | "TERMINOLOGY"
          | "TONE"
          | "LOCALE_PREFERENCE";
        surfaceForm?: string;
        correctedMeaning: string;
        confidence: 1;
        createdAt: string;
      };
    };

export function decideDurableCorrection(
  signal: RepairSignal,
): DurableCorrectionDecision {
  validateRepairSignal(signal);

  if (signal.kind === "PROBLEM_REPORT") {
    return {
      action: "MARK_SUSPECT",
      durableClaim: null,
    };
  }

  if (
    signal.sensitivityClass === "RESTRICTED" &&
    signal.trigger !== "EXPLICIT_UI_CORRECTION"
  ) {
    return {
      action: "NEEDS_CONFIRMATION",
      durableClaim: null,
    };
  }

  if (
    !signal.trigger ||
    !signal.conceptType ||
    !signal.correctedMeaning ||
    !signal.scopeKind
  ) {
    return {
      action: "NEEDS_CONFIRMATION",
      durableClaim: null,
    };
  }

  if (
    signal.scopeKind === "TENANT" &&
    signal.trigger !== "APPROVED_GLOSSARY_CHANGE" &&
    signal.trigger !== "TENANT_POLICY_CHANGE"
  ) {
    return {
      action: "NEEDS_CONFIRMATION",
      durableClaim: null,
    };
  }

  if (
    signal.trigger === "EXPLICIT_TEXTUAL_CORRECTION" &&
    signal.scopeKind !== "CONVERSATION"
  ) {
    return {
      action: "NEEDS_CONFIRMATION",
      durableClaim: null,
    };
  }

  const correctedMeaning = requireBoundedSemanticValue(
    signal.correctedMeaning,
    "correctedMeaning",
    512,
  );
  const surfaceForm = signal.surfaceForm
    ? requireBoundedSemanticValue(
        signal.surfaceForm,
        "surfaceForm",
        128,
      )
    : undefined;

  return {
    action: "CREATE_CORRECTION",
    durableClaim: {
      retentionClass: "CORRECTIVE_DURABLE",
      modality: "CORRECTION",
      authorityClass: "CONFIRMED_CORRECTION",
      trigger: signal.trigger,
      scopeKind: signal.scopeKind,
      scopeConversationId:
        signal.scopeKind === "CONVERSATION"
          ? signal.conversationId
          : null,
      conversationId: signal.conversationId,
      repairEventId: signal.repairEventId,
      actorUserId: signal.actorUserId,
      ...(signal.targetMessageId
        ? { targetMessageId: signal.targetMessageId }
        : {}),
      ...(signal.targetSourceRevision
        ? { targetSourceRevision: signal.targetSourceRevision }
        : {}),
      conceptType: signal.conceptType,
      ...(surfaceForm ? { surfaceForm } : {}),
      correctedMeaning,
      confidence: 1,
      createdAt: signal.createdAt,
    },
  };
}

function validateState(state: ConversationContextState): void {
  requireOpaqueIdentifier(state.tenantId, "tenantId");
  requireOpaqueIdentifier(state.conversationId, "conversationId");
  requireSafeInteger(state.stateVersion, "stateVersion", 1);
  requireSafeInteger(
    state.causalFloorOpSeq,
    "causalFloorOpSeq",
    0,
  );
  requireSafeInteger(
    state.processedPrefixOpSeq,
    "processedPrefixOpSeq",
    0,
  );
  if (state.processedPrefixOpSeq < state.causalFloorOpSeq) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      "processed prefix cannot be behind causal floor",
    );
  }
  if (
    state.recoveryMode !== "FULL" &&
    state.recoveryMode !== "DEGRADED_BASELINE"
  ) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      "Unknown context recovery mode",
    );
  }
  requireSafeInteger(state.membershipEpoch, "membershipEpoch", 1);
  requireSafeInteger(state.erasureEpoch, "erasureEpoch", 1);
  requireSafeInteger(state.policyVersion, "policyVersion", 1);
  requireStrategyVersion(state.strategyVersion);
  requireTimestamp(state.updatedAt, "updatedAt");

  if (state.pendingOperations.length > 512) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      "Pending context operation budget exceeded",
    );
  }

  let lastSequence = state.processedPrefixOpSeq;
  for (const operation of state.pendingOperations) {
    validateOperation(operation);
    if (operation.opSeq <= state.processedPrefixOpSeq) {
      throw new ContextStateConflictError(
        "INVALID_STATE",
        "Pending operation is behind processed prefix",
      );
    }
    if (operation.opSeq <= lastSequence) {
      throw new ContextStateConflictError(
        "INVALID_STATE",
        "Pending operations are not strictly ordered",
      );
    }
    lastSequence = operation.opSeq;
  }

  validateRefSet(
    state.terminologyClaimRefs,
    "terminologyClaimRefs",
    128,
  );
  validateRefSet(state.lexicalClaimRefs, "lexicalClaimRefs", 128);
  validateRefSet(
    state.correctionClaimRefs,
    "correctionClaimRefs",
    128,
  );
  validateHandleSet(state.entityHandles, "entityHandles", 128);
  validateHandleSet(
    state.unresolvedReferenceHandles,
    "unresolvedReferenceHandles",
    64,
  );
  validateStyleState(state.styleState);
  validatePragmaticState(state.pragmaticState);
  if (state.activeEpisode) {
    validateEpisode(state.activeEpisode);
  }
}

function validateOperation(
  operation: Omit<ContextOperationRef, "status"> | ContextOperationRef,
): void {
  requireSafeInteger(operation.opSeq, "opSeq", 1);
  requireOpaqueIdentifier(operation.operationId, "operationId");
  requireTimestamp(operation.registeredAt, "registeredAt");
  if (operation.messageId) {
    requireOpaqueIdentifier(operation.messageId, "messageId");
  }
  if (operation.sourceRevision !== undefined) {
    requireSafeInteger(
      operation.sourceRevision,
      "sourceRevision",
      1,
    );
  }
}

function validateDerivationResult(
  result: ContextDerivationResult,
): void {
  requireOpaqueIdentifier(result.conversationId, "conversationId");
  requireOpaqueIdentifier(result.operationId, "operationId");
  requireSafeInteger(result.opSeq, "opSeq", 1);
  requireSafeInteger(
    result.baseStateVersion,
    "baseStateVersion",
    1,
  );
  requireSafeInteger(result.membershipEpoch, "membershipEpoch", 1);
  requireSafeInteger(result.erasureEpoch, "erasureEpoch", 1);
  requireSafeInteger(result.policyVersion, "policyVersion", 1);
  requireStrategyVersion(result.strategyVersion);
  requireTimestamp(result.completedAt, "completedAt");
}

function validateEpisode(
  episode: ActiveEpisodeState,
): ActiveEpisodeState {
  requireOpaqueIdentifier(episode.episodeId, "episodeId");
  requireSafeInteger(
    episode.episodeVersion,
    "episodeVersion",
    1,
  );
  requireProbability(
    episode.continuityConfidence,
    "continuityConfidence",
  );
  return structuredClone(episode);
}

function validateStyleState(
  style: ConversationStyleState,
): ConversationStyleState {
  if (style.confidence !== undefined) {
    requireProbability(style.confidence, "style.confidence");
  }
  if (style.expiresAt) {
    requireTimestamp(style.expiresAt, "style.expiresAt");
  }
  return structuredClone(style);
}

function validatePragmaticState(
  pragmatic: PragmaticStateCoarse,
): PragmaticStateCoarse {
  if (pragmatic.confidence !== undefined) {
    requireProbability(
      pragmatic.confidence,
      "pragmatic.confidence",
    );
  }
  if (pragmatic.expiresAt) {
    requireTimestamp(pragmatic.expiresAt, "pragmatic.expiresAt");
  }
  return structuredClone(pragmatic);
}

function validateRefSet(
  values: UUID[],
  label: string,
  max: number,
): UUID[] {
  if (!Array.isArray(values) || values.length > max) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      `${label} exceeds its bounded size`,
    );
  }
  const unique = [...new Set(values)];
  if (unique.length !== values.length) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      `${label} contains duplicate refs`,
    );
  }
  for (const value of values) {
    requireOpaqueIdentifier(value, label);
  }
  return [...values];
}

function validateHandleSet(
  values: string[],
  label: string,
  max: number,
): string[] {
  if (!Array.isArray(values) || values.length > max) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      `${label} exceeds its bounded size`,
    );
  }
  const unique = [...new Set(values)];
  if (unique.length !== values.length) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      `${label} contains duplicate handles`,
    );
  }
  for (const value of values) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9:_./-]{1,160}$/.test(value)
    ) {
      throw new ContextStateConflictError(
        "INVALID_STATE",
        `${label} must contain opaque handles only`,
      );
    }
  }
  return [...values];
}

function validateRepairSignal(signal: RepairSignal): void {
  requireOpaqueIdentifier(signal.repairEventId, "repairEventId");
  requireOpaqueIdentifier(signal.tenantId, "tenantId");
  requireOpaqueIdentifier(signal.conversationId, "conversationId");
  requireOpaqueIdentifier(signal.actorUserId, "actorUserId");
  requireTimestamp(signal.createdAt, "createdAt");
  if (signal.targetMessageId) {
    requireOpaqueIdentifier(signal.targetMessageId, "targetMessageId");
  }
  if (signal.targetSourceRevision !== undefined) {
    requireSafeInteger(
      signal.targetSourceRevision,
      "targetSourceRevision",
      1,
    );
  }
}

function requireOpaqueIdentifier(
  value: string,
  label: string,
): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9:_./-]{1,160}$/.test(value)
  ) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      `${label} must be an opaque identifier`,
    );
  }
}

function requireStrategyVersion(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:-]{1,80}$/.test(value)
  ) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      "strategyVersion must be a bounded opaque identifier",
    );
  }
}

function requireBoundedSemanticValue(
  value: string,
  label: string,
  maxLength: number,
): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > maxLength ||
    /[\r\n\u0000]/.test(trimmed)
  ) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      `${label} is invalid or exceeds its semantic memory budget`,
    );
  }
  return trimmed;
}

function requireSafeInteger(
  value: number,
  label: string,
  minimum: number,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      `${label} must be an integer >= ${minimum}`,
    );
  }
}

function requireProbability(
  value: number,
  label: string,
): void {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      `${label} must be in [0,1]`,
    );
  }
}

function requireTimestamp(
  value: string,
  label: string,
): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new ContextStateConflictError(
      "INVALID_STATE",
      `${label} must be an ISO-compatible timestamp`,
    );
  }
}

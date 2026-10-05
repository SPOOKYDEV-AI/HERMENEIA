import type { UUID } from "../../domain/src/index.js";
import {
  cloneValidatedContextState,
  createInitialContextState,
  type ActiveEpisodeState,
  type ConversationContextState,
} from "../../context-state/src/index.js";

export interface SanitisedRecoveryPayloadV1 {
  schemaVersion: 1;
  activeEpisode?: ActiveEpisodeState;
  terminologyClaimRefs: UUID[];
  lexicalClaimRefs: UUID[];
  correctionClaimRefs: UUID[];
}

export interface RecoveryCheckpointV1 {
  tenantId: UUID;
  conversationId: UUID;
  checkpointVersion: number;
  schemaVersion: 1;
  contextStrategyVersion: string;
  baseContextStateVersion: number;
  processedPrefixOpSeq: number;
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
  tenantPolicyVersion: number;
  payload: SanitisedRecoveryPayloadV1;
  status:
    | "ACTIVE"
    | "SUPERSEDED"
    | "INVALIDATED"
    | "CORRUPT";
  createdAt: string;
  expiresAt: string;
}

export function buildSanitisedRecoverySeed(
  state: ConversationContextState,
): {
  baseContextStateVersion: number;
  processedPrefixOpSeq: number;
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
  contextStrategyVersion: string;
  payload: SanitisedRecoveryPayloadV1;
} | null {
  const value = cloneValidatedContextState(state);

  if (
    value.status !== "ACTIVE" ||
    value.recoveryMode !== "FULL" ||
    value.pendingOperations.length !== 0
  ) {
    return null;
  }

  return {
    baseContextStateVersion: value.stateVersion,
    processedPrefixOpSeq:
      value.processedPrefixOpSeq,
    membershipEpoch: value.membershipEpoch,
    erasureEpoch: value.erasureEpoch,
    policyVersion: value.policyVersion,
    contextStrategyVersion:
      value.strategyVersion,
    payload: {
      schemaVersion: 1,
      ...(value.activeEpisode
        ? {
            activeEpisode:
              structuredClone(
                value.activeEpisode,
              ),
          }
        : {}),
      terminologyClaimRefs: [
        ...value.terminologyClaimRefs,
      ],
      lexicalClaimRefs: [
        ...value.lexicalClaimRefs,
      ],
      correctionClaimRefs: [
        ...value.correctionClaimRefs,
      ],
    },
  };
}

export function restoreContextStateFromCheckpoint(
  checkpoint: RecoveryCheckpointV1,
  input: {
    tenantId: UUID;
    conversationId: UUID;
    requiredProcessedPrefixOpSeq: number;
    strategyVersion: string;
    now: string;
  },
): ConversationContextState | null {
  if (
    !Number.isFinite(Date.parse(input.now)) ||
    checkpoint.status !== "ACTIVE" ||
    checkpoint.schemaVersion !== 1 ||
    checkpoint.payload.schemaVersion !== 1 ||
    checkpoint.tenantId !== input.tenantId ||
    checkpoint.conversationId !==
      input.conversationId ||
    checkpoint.processedPrefixOpSeq !==
      input.requiredProcessedPrefixOpSeq ||
    checkpoint.contextStrategyVersion !==
      input.strategyVersion ||
    Date.parse(checkpoint.expiresAt) <=
      Date.parse(input.now) ||
    !Number.isSafeInteger(
      checkpoint.baseContextStateVersion,
    ) ||
    checkpoint.baseContextStateVersion < 1 ||
    !Number.isSafeInteger(
      checkpoint.processedPrefixOpSeq,
    ) ||
    checkpoint.processedPrefixOpSeq < 0 ||
    !Number.isSafeInteger(
      checkpoint.tenantPolicyVersion,
    ) ||
    checkpoint.tenantPolicyVersion < 1
  ) {
    return null;
  }

  try {
    const state = createInitialContextState({
      tenantId: input.tenantId,
      conversationId:
        input.conversationId,
      causalFloorOpSeq:
        checkpoint.processedPrefixOpSeq,
      processedPrefixOpSeq:
        checkpoint.processedPrefixOpSeq,
      membershipEpoch:
        checkpoint.membershipEpoch,
      erasureEpoch:
        checkpoint.erasureEpoch,
      policyVersion:
        checkpoint.policyVersion,
      strategyVersion:
        checkpoint.contextStrategyVersion,
      now: input.now,
    });

    state.stateVersion =
      checkpoint.baseContextStateVersion;
    state.activeEpisode =
      checkpoint.payload.activeEpisode
        ? structuredClone(
            checkpoint.payload.activeEpisode,
          )
        : undefined;
    state.terminologyClaimRefs = [
      ...checkpoint.payload
        .terminologyClaimRefs,
    ];
    state.lexicalClaimRefs = [
      ...checkpoint.payload.lexicalClaimRefs,
    ];
    state.correctionClaimRefs = [
      ...checkpoint.payload
        .correctionClaimRefs,
    ];

    // Deliberately not restored:
    // - styleState: conversation style is working/personal projection only;
    // - pragmaticState/entity handles: weak derived hypotheses;
    // - pending operations: a checkpoint is captured only at a clean prefix.
    state.styleState = {};
    state.pragmaticState = {};
    state.entityHandles = [];
    state.unresolvedReferenceHandles = [];
    state.pendingOperations = [];
    state.recoveryMode = "FULL";
    state.status = "ACTIVE";
    state.updatedAt = input.now;

    return cloneValidatedContextState(state);
  } catch {
    return null;
  }
}

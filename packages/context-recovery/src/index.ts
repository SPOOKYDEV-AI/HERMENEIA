import type { UUID } from "../../domain/src/index.js";
import {
  cloneValidatedContextState,
  createInitialContextState,
  type ActiveEpisodeState,
  type ContextOperationRef,
  type ConversationContextState,
  type ConversationStyleState,
} from "../../context-state/src/index.js";

export interface SanitisedRecoveryPayloadV1 {
  schemaVersion: 1;
  activeEpisode?: ActiveEpisodeState;
  terminologyClaimRefs: UUID[];
  lexicalClaimRefs: UUID[];
  correctionClaimRefs: UUID[];
  entityHandles: string[];
  unresolvedReferenceHandles: string[];
  styleState: ConversationStyleState;
}

export interface RecoveryCheckpointV1 {
  tenantId: UUID;
  conversationId: UUID;
  checkpointVersion: number;
  schemaVersion: 1;
  contextStrategyVersion: string;
  baseContextStateVersion: number;
  processedPrefixOpSeq: number;
  processingGapManifest: ContextOperationRef[];
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
  payload: SanitisedRecoveryPayloadV1;
  status:
    | "CANDIDATE"
    | "ACTIVE"
    | "SUPERSEDED"
    | "INVALIDATED"
    | "CORRUPT";
  createdAt: string;
  expiresAt: string;
}

export interface RecoveryAuthorityFrontier {
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
  strategyVersion: string;
}

export function buildSanitisedRecoveryPayload(
  state: ConversationContextState,
): {
  processedPrefixOpSeq: number;
  processingGapManifest: ContextOperationRef[];
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
  contextStrategyVersion: string;
  baseContextStateVersion: number;
  payload: SanitisedRecoveryPayloadV1;
} {
  const value = cloneValidatedContextState(state);

  return {
    processedPrefixOpSeq:
      value.processedPrefixOpSeq,
    processingGapManifest:
      structuredClone(
        value.pendingOperations,
      ),
    membershipEpoch:
      value.membershipEpoch,
    erasureEpoch:
      value.erasureEpoch,
    policyVersion:
      value.policyVersion,
    contextStrategyVersion:
      value.strategyVersion,
    baseContextStateVersion:
      value.stateVersion,
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
      entityHandles: [
        ...value.entityHandles,
      ],
      unresolvedReferenceHandles: [
        ...value.unresolvedReferenceHandles,
      ],
      styleState:
        structuredClone(
          value.styleState,
        ),
    },
  };
}

export function restoreContextStateFromCheckpoint(
  checkpoint: RecoveryCheckpointV1,
  input: {
    tenantId: UUID;
    conversationId: UUID;
    authority: RecoveryAuthorityFrontier;
    now: string;
  },
): ConversationContextState | null {
  if (
    checkpoint.status !== "ACTIVE" ||
    checkpoint.schemaVersion !== 1 ||
    checkpoint.payload.schemaVersion !== 1 ||
    checkpoint.tenantId !== input.tenantId ||
    checkpoint.conversationId !==
      input.conversationId ||
    checkpoint.contextStrategyVersion !==
      input.authority.strategyVersion ||
    checkpoint.membershipEpoch !==
      input.authority.membershipEpoch ||
    checkpoint.erasureEpoch !==
      input.authority.erasureEpoch ||
    checkpoint.policyVersion !==
      input.authority.policyVersion ||
    Date.parse(checkpoint.expiresAt) <=
      Date.parse(input.now)
  ) {
    return null;
  }

  if (
    !Number.isSafeInteger(
      checkpoint.baseContextStateVersion,
    ) ||
    checkpoint.baseContextStateVersion < 1 ||
    !Number.isSafeInteger(
      checkpoint.processedPrefixOpSeq,
    ) ||
    checkpoint.processedPrefixOpSeq < 0
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
    state.pendingOperations =
      structuredClone(
        checkpoint.processingGapManifest,
      );
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
    state.entityHandles = [
      ...checkpoint.payload.entityHandles,
    ];
    state.unresolvedReferenceHandles = [
      ...checkpoint.payload
        .unresolvedReferenceHandles,
    ];
    state.styleState =
      structuredClone(
        checkpoint.payload.styleState,
      );
    state.pragmaticState = {};
    state.recoveryMode = "FULL";
    state.status =
      state.pendingOperations.some(
        (operation) =>
          operation.status ===
            "SOURCE_REQUIRED",
      )
        ? "DEGRADED"
        : "ACTIVE";
    state.updatedAt = input.now;

    return cloneValidatedContextState(
      state,
    );
  } catch {
    return null;
  }
}

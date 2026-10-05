import type {
  ActorContext,
  UUID,
} from "../../domain/src/index.js";
import type {
  PersistentCommandClaimResult,
} from "../../messaging-service/src/index.js";
import type {
  ConversationContextState,
} from "../../context-state/src/index.js";

export interface CorrectionAuthority {
  tenantRole: "MEMBER" | "ADMIN" | "OWNER";
  conversationRole: "MEMBER" | "MODERATOR";
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
  nextOperationSequence: number;
}

export interface ContextCorrectionTransactions<Tx> {
  withTransaction<T>(
    work: (tx: Tx) => Promise<T>,
  ): Promise<T>;
}

export interface ContextCorrectionCommandStore<Tx> {
  claimCommand(
    tx: Tx,
    input: {
      actor: ActorContext;
      commandId: UUID;
      commandType: string;
      commandFingerprint: string;
      now: string;
    },
  ): Promise<PersistentCommandClaimResult>;

  markCommandSucceeded(
    tx: Tx,
    input: {
      tenantId: UUID;
      commandId: UUID;
      actorUserId: UUID;
      actorDeviceId: UUID;
      commandType: string;
      commandFingerprint: string;
      result: Record<string, unknown>;
      now: string;
    },
  ): Promise<void>;
}

export interface ContextCorrectionStore<Tx> {
  loadAuthority(
    tx: Tx,
    input: {
      actor: ActorContext;
      conversationId: UUID;
    },
  ): Promise<CorrectionAuthority | undefined>;

  messageRevisionExists(
    tx: Tx,
    input: {
      tenantId: UUID;
      conversationId: UUID;
      messageId: UUID;
      sourceRevision: number;
    },
  ): Promise<boolean>;

  loadVisibleTranslationTarget(
    tx: Tx,
    input: {
      actor: ActorContext;
      conversationId: UUID;
      translationId: UUID;
    },
  ): Promise<{
    messageId: UUID;
    sourceRevision: number;
  } | undefined>;

  insertRepairEvent(
    tx: Tx,
    input: {
      tenantId: UUID;
      repairEventId: UUID;
      conversationId: UUID;
      actorUserId: UUID;
      targetTranslationId: UUID | null;
      targetMessageId: UUID | null;
      targetSourceRevision: number | null;
      kind:
        | "MEANING_CORRECTION"
        | "TONE_CORRECTION"
        | "TERMINOLOGY_CORRECTION";
      status:
        | "RECORDED"
        | "NEEDS_CONFIRMATION"
        | "APPLIED";
      structuredPayload: Record<string, unknown>;
      commandId: UUID;
      createdAt: string;
    },
  ): Promise<void>;

  insertConfirmedClaim(
    tx: Tx,
    input: {
      tenantId: UUID;
      claimId: UUID;
      conversationId: UUID;
      messageId: UUID | null;
      claimType: "MEANING" | "TERMINOLOGY";
      propositionRef: Record<string, unknown>;
      scopeKind: "CONVERSATION" | "TENANT";
      scopeConversationId: UUID | null;
      createdAt: string;
    },
  ): Promise<void>;

  insertRepairProvenance(
    tx: Tx,
    input: {
      tenantId: UUID;
      provenanceEdgeId: UUID;
      claimId: UUID;
      repairEventId: UUID;
      strategyVersion: string;
      createdAt: string;
    },
  ): Promise<void>;
}

export interface ContextCorrectionStateStore<Tx> {
  loadState(
    tx: Tx,
    input: {
      tenantId: UUID;
      conversationId: UUID;
      forUpdate?: boolean;
    },
  ): Promise<ConversationContextState | undefined>;

  insertState(
    tx: Tx,
    state: ConversationContextState,
  ): Promise<boolean>;

  updateState(
    tx: Tx,
    input: {
      expectedStateVersion: number;
      state: ConversationContextState;
    },
  ): Promise<boolean>;
}

export interface ContextCorrectionIds {
  next(prefix: string): UUID;
}

export interface ContextCorrectionClock {
  now(): string;
}

export interface ContextCorrectionDependencies<Tx> {
  transactions: ContextCorrectionTransactions<Tx>;
  commands: ContextCorrectionCommandStore<Tx>;
  corrections: ContextCorrectionStore<Tx>;
  state: ContextCorrectionStateStore<Tx>;
  ids: ContextCorrectionIds;
  clock: ContextCorrectionClock;
  strategyVersion?: string;
}

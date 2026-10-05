import type {
  ActorContext,
  UUID,
} from "../../domain/src/index.js";
import { DomainError } from "../../domain/src/index.js";
import type {
  CorrectionCommand,
  CorrectionResult,
  CorrectionScope,
} from "../../protocol/src/index.js";
import type {
  PersistentCommandClaimResult,
} from "../../messaging-service/src/index.js";
import {
  parseSupportedClaimProposition,
  storedClaimProposition,
} from "../../context-claim-candidates/src/index.js";
import {
  createDegradedContextStateFromFloor,
  createInitialContextState,
  linkConfirmedCorrectionClaim,
  rebaseContextStateAuthority,
  type ConversationContextState,
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

interface NormalisedCorrection {
  payload: Record<string, unknown>;
  canBecomeClaim: boolean;
}

export class ContextCorrectionService<Tx> {
  private readonly strategyVersion: string;

  constructor(
    private readonly deps: ContextCorrectionDependencies<Tx>,
  ) {
    this.strategyVersion =
      deps.strategyVersion ?? "context-state-v1";
    if (!this.strategyVersion) {
      throw new TypeError(
        "Correction strategyVersion is required",
      );
    }
  }

  async createCorrection(
    actor: ActorContext,
    command: CorrectionCommand,
  ): Promise<CorrectionResult> {
    validateCommand(command);
    const normalised = normaliseCorrection(command);
    const now = this.deps.clock.now();
    if (!Number.isFinite(Date.parse(now))) {
      throw new TypeError(
        "Correction clock returned an invalid timestamp",
      );
    }

    const commandFingerprint = JSON.stringify({
      v: 1,
      type: "context.correction",
      conversation_id: command.conversation_id,
      target_message_id:
        command.target_message_id ?? null,
      target_source_revision:
        command.target_source_revision ?? null,
      target_translation_id:
        command.target_translation_id ?? null,
      kind: command.kind,
      requested_scope: command.requested_scope,
      payload: normalised.payload,
    });

    return this.deps.transactions.withTransaction(
      async (tx) => {
        const commandClaim =
          await this.deps.commands.claimCommand(tx, {
            actor,
            commandId: command.command_id,
            commandType: "context.correction",
            commandFingerprint,
            now,
          });

        if (!commandClaim.claimed) {
          return replayExisting(
            commandClaim.existing,
            actor,
            commandFingerprint,
          );
        }

        const authority =
          await this.deps.corrections.loadAuthority(
            tx,
            {
              actor,
              conversationId:
                command.conversation_id,
            },
          );
        if (!authority) {
          throw new DomainError(
            "NOT_AUTHORIZED",
            "Conversation is not available to actor",
          );
        }

        const target = await this.resolveTarget(
          tx,
          actor,
          command,
        );

        const promotion = promotionDecision(
          command,
          authority,
          normalised.canBecomeClaim,
        );

        const repairEventId =
          this.deps.ids.next("repair");
        const claimId = promotion.apply
          ? this.deps.ids.next("claim")
          : null;

        await this.deps.corrections.insertRepairEvent(
          tx,
          {
            tenantId: actor.tenantId,
            repairEventId,
            conversationId:
              command.conversation_id,
            actorUserId: actor.userId,
            targetTranslationId:
              command.target_translation_id ?? null,
            targetMessageId: target.messageId,
            targetSourceRevision:
              target.sourceRevision,
            kind: repairKind(command.kind),
            status: promotion.status,
            structuredPayload:
              normalised.payload,
            commandId: command.command_id,
            createdAt: now,
          },
        );

        if (claimId) {
          await this.deps.corrections.insertConfirmedClaim(
            tx,
            {
              tenantId: actor.tenantId,
              claimId,
              conversationId:
                command.conversation_id,
              messageId: target.messageId,
              claimType:
                command.kind === "MEANING"
                  ? "MEANING"
                  : "TERMINOLOGY",
              propositionRef:
                normalised.payload,
              scopeKind: promotion.scope!,
              scopeConversationId:
                promotion.scope === "CONVERSATION"
                  ? command.conversation_id
                  : null,
              createdAt: now,
            },
          );

          await this.deps.corrections.insertRepairProvenance(
            tx,
            {
              tenantId: actor.tenantId,
              provenanceEdgeId:
                this.deps.ids.next("provenance"),
              claimId,
              repairEventId,
              strategyVersion:
                this.strategyVersion,
              createdAt: now,
            },
          );

          await this.linkClaimIntoState(
            tx,
            actor,
            command.conversation_id,
            authority,
            claimId,
            now,
          );
        }

        const result: CorrectionResult = {
          protocol_version: 1,
          repair_event_id: repairEventId,
          status: promotion.status,
          requested_scope:
            command.requested_scope,
          applied_scope: promotion.scope,
          claim_id: claimId,
          claim_version: claimId ? 1 : null,
        };

        await this.deps.commands.markCommandSucceeded(
          tx,
          {
            tenantId: actor.tenantId,
            commandId: command.command_id,
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
            commandType: "context.correction",
            commandFingerprint,
            result:
              result as unknown as Record<string, unknown>,
            now,
          },
        );

        return result;
      },
    );
  }

  private async resolveTarget(
    tx: Tx,
    actor: ActorContext,
    command: CorrectionCommand,
  ): Promise<{
    messageId: UUID | null;
    sourceRevision: number | null;
  }> {
    let messageId =
      command.target_message_id ?? null;
    let sourceRevision =
      command.target_source_revision ?? null;

    if (messageId) {
      const exists =
        await this.deps.corrections.messageRevisionExists(
          tx,
          {
            tenantId: actor.tenantId,
            conversationId:
              command.conversation_id,
            messageId,
            sourceRevision: sourceRevision!,
          },
        );
      if (!exists) {
        throw new DomainError(
          "NOT_AUTHORIZED",
          "Correction target is not available to actor",
        );
      }
    }

    if (command.target_translation_id) {
      const translation =
        await this.deps.corrections.loadVisibleTranslationTarget(
          tx,
          {
            actor,
            conversationId:
              command.conversation_id,
            translationId:
              command.target_translation_id,
          },
        );
      if (!translation) {
        throw new DomainError(
          "NOT_AUTHORIZED",
          "Translation target is not available to actor",
        );
      }

      if (
        messageId &&
        (
          messageId !== translation.messageId ||
          sourceRevision !==
            translation.sourceRevision
        )
      ) {
        throw new DomainError(
          "INVALID_COMMAND",
          "Correction targets do not refer to the same source revision",
        );
      }

      messageId = translation.messageId;
      sourceRevision =
        translation.sourceRevision;
    }

    return { messageId, sourceRevision };
  }

  private async linkClaimIntoState(
    tx: Tx,
    actor: ActorContext,
    conversationId: UUID,
    authority: CorrectionAuthority,
    claimId: UUID,
    now: string,
  ): Promise<void> {
    const existing = await this.deps.state.loadState(
      tx,
      {
        tenantId: actor.tenantId,
        conversationId,
        forUpdate: true,
      },
    );

    if (!existing) {
      let created =
        authority.nextOperationSequence <= 1
          ? createInitialContextState({
              tenantId: actor.tenantId,
              conversationId,
              membershipEpoch:
                authority.membershipEpoch,
              erasureEpoch:
                authority.erasureEpoch,
              policyVersion:
                authority.policyVersion,
              strategyVersion:
                this.strategyVersion,
              now,
            })
          : createDegradedContextStateFromFloor({
              tenantId: actor.tenantId,
              conversationId,
              causalFloorOpSeq:
                authority.nextOperationSequence - 1,
              membershipEpoch:
                authority.membershipEpoch,
              erasureEpoch:
                authority.erasureEpoch,
              policyVersion:
                authority.policyVersion,
              strategyVersion:
                this.strategyVersion,
              now,
            });
      created = linkConfirmedCorrectionClaim(
        created,
        { claimId, now },
      );

      const inserted =
        await this.deps.state.insertState(
          tx,
          created,
        );
      if (!inserted) {
        throw new Error(
          "ConversationState appeared concurrently during correction",
        );
      }
      return;
    }

    const expectedStateVersion =
      existing.stateVersion;
    let next = rebaseContextStateAuthority(
      existing,
      {
        membershipEpoch:
          authority.membershipEpoch,
        erasureEpoch: authority.erasureEpoch,
        policyVersion: authority.policyVersion,
        now,
      },
    );
    next = linkConfirmedCorrectionClaim(
      next,
      { claimId, now },
    );

    if (
      next.stateVersion ===
      expectedStateVersion
    ) {
      return;
    }

    const updated =
      await this.deps.state.updateState(
        tx,
        {
          expectedStateVersion,
          state: next,
        },
      );
    if (!updated) {
      throw new Error(
        "ConversationState changed despite correction row lock",
      );
    }
  }
}

function validateCommand(
  command: CorrectionCommand,
): void {
  if (
    command.protocol_version !== 1 ||
    !isUuid(command.command_id) ||
    !isUuid(command.conversation_id)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Invalid correction command identity",
    );
  }

  if (
    !["MEANING", "TONE", "TERMINOLOGY"].includes(
      command.kind,
    ) ||
    !["MESSAGE", "CONVERSATION", "TENANT"].includes(
      command.requested_scope,
    )
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Invalid correction kind or scope",
    );
  }

  const hasMessage =
    command.target_message_id !== undefined &&
    command.target_message_id !== null;
  const hasRevision =
    command.target_source_revision !== undefined &&
    command.target_source_revision !== null;

  if (hasMessage !== hasRevision) {
    throw new DomainError(
      "INVALID_COMMAND",
      "target_message_id and target_source_revision must be provided together",
    );
  }
  if (
    hasMessage &&
    (
      !isUuid(command.target_message_id!) ||
      !Number.isInteger(
        command.target_source_revision,
      ) ||
      Number(command.target_source_revision) < 1
    )
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Invalid target message revision",
    );
  }
  if (
    command.target_translation_id !== undefined &&
    command.target_translation_id !== null &&
    !isUuid(command.target_translation_id)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Invalid target_translation_id",
    );
  }
  if (
    command.requested_scope === "MESSAGE" &&
    !hasMessage &&
    !command.target_translation_id
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "MESSAGE correction requires a message or translation target",
    );
  }

  if (
    !command.payload ||
    typeof command.payload !== "object" ||
    Array.isArray(command.payload)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Correction payload must be an object",
    );
  }
}

function normaliseCorrection(
  command: CorrectionCommand,
): NormalisedCorrection {
  if (command.kind === "TONE") {
    const preferred =
      command.payload.preferred_register;
    if (
      command.payload.schema_version !== 1 ||
      command.payload.kind !== "TONE" ||
      !["NEUTRAL", "FORMAL", "INFORMAL"].includes(
        String(preferred),
      )
    ) {
      throw new DomainError(
        "INVALID_COMMAND",
        "TONE correction requires schema_version=1, kind=TONE and a supported preferred_register",
      );
    }

    return {
      payload: {
        schema_version: 1,
        kind: "TONE",
        preferred_register: preferred,
      },
      canBecomeClaim: false,
    };
  }

  const proposition =
    parseSupportedClaimProposition(
      command.payload,
    );
  if (!proposition) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Correction payload is not a supported structured proposition",
    );
  }
  if (
    command.kind === "MEANING" &&
    proposition.kind !== "TERM_MEANING"
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "MEANING correction requires TERM_MEANING payload",
    );
  }

  return {
    payload:
      storedClaimProposition(proposition),
    canBecomeClaim: true,
  };
}

function promotionDecision(
  command: CorrectionCommand,
  authority: CorrectionAuthority,
  canBecomeClaim: boolean,
): {
  apply: boolean;
  status:
    | "RECORDED"
    | "NEEDS_CONFIRMATION"
    | "APPLIED";
  scope: "CONVERSATION" | "TENANT" | null;
} {
  if (
    command.requested_scope === "MESSAGE"
  ) {
    return {
      apply: false,
      status: "RECORDED",
      scope: null,
    };
  }

  if (!canBecomeClaim) {
    return {
      apply: false,
      status: "NEEDS_CONFIRMATION",
      scope: null,
    };
  }

  if (
    command.requested_scope === "TENANT"
  ) {
    // V1 only injects claims explicitly referenced by a conversation's
    // ConversationState. Until tenant-wide policy/glossary distribution is
    // implemented, claiming that a tenant correction is APPLIED would be
    // semantically false even for an ADMIN/OWNER.
    return {
      apply: false,
      status: "NEEDS_CONFIRMATION",
      scope: null,
    };
  }

  const elevated =
    authority.conversationRole === "MODERATOR" ||
    authority.tenantRole === "ADMIN" ||
    authority.tenantRole === "OWNER";

  return elevated
    ? {
        apply: true,
        status: "APPLIED",
        scope: "CONVERSATION",
      }
    : {
        apply: false,
        status: "NEEDS_CONFIRMATION",
        scope: null,
      };
}

function repairKind(
  kind: CorrectionCommand["kind"],
):
  | "MEANING_CORRECTION"
  | "TONE_CORRECTION"
  | "TERMINOLOGY_CORRECTION" {
  if (kind === "MEANING") {
    return "MEANING_CORRECTION";
  }
  if (kind === "TONE") {
    return "TONE_CORRECTION";
  }
  return "TERMINOLOGY_CORRECTION";
}

function replayExisting(
  existing: {
    actorUserId: UUID;
    actorDeviceId: UUID;
    commandType: string;
    commandFingerprint: string | null;
    status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
    result: Record<string, unknown>;
  },
  actor: ActorContext,
  commandFingerprint: string,
): CorrectionResult {
  if (
    existing.actorUserId !== actor.userId ||
    existing.actorDeviceId !== actor.deviceId
  ) {
    throw new DomainError(
      "NOT_AUTHORIZED",
      "Command identifier is not available to actor",
    );
  }
  if (
    existing.commandType !== "context.correction" ||
    existing.commandFingerprint !==
      commandFingerprint
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "command_id was already used for a different operation",
    );
  }
  if (existing.status !== "SUCCEEDED") {
    throw new Error(
      "Persistent correction command receipt is not terminal",
    );
  }

  return correctionResultFromRecord(
    existing.result,
  );
}

function correctionResultFromRecord(
  value: Record<string, unknown>,
): CorrectionResult {
  const status = value.status;
  const requestedScope =
    value.requested_scope;
  const appliedScope = value.applied_scope;

  if (
    value.protocol_version !== 1 ||
    !isUuid(value.repair_event_id) ||
    !["RECORDED", "NEEDS_CONFIRMATION", "APPLIED"].includes(
      String(status),
    ) ||
    !["MESSAGE", "CONVERSATION", "TENANT"].includes(
      String(requestedScope),
    ) ||
    !(
      appliedScope === null ||
      appliedScope === "CONVERSATION" ||
      appliedScope === "TENANT"
    ) ||
    !(
      value.claim_id === null ||
      isUuid(value.claim_id)
    ) ||
    !(
      value.claim_version === null ||
      (
        Number.isInteger(value.claim_version) &&
        Number(value.claim_version) >= 1
      )
    )
  ) {
    throw new Error(
      "Stored correction result is malformed",
    );
  }

  return {
    protocol_version: 1,
    repair_event_id:
      value.repair_event_id as UUID,
    status:
      status as CorrectionResult["status"],
    requested_scope:
      requestedScope as CorrectionScope,
    applied_scope:
      appliedScope as CorrectionResult["applied_scope"],
    claim_id:
      value.claim_id as UUID | null,
    claim_version:
      value.claim_version as number | null,
  };
}

function isUuid(value: unknown): value is UUID {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

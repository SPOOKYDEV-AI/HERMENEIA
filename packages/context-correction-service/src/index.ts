import {
  DomainError,
  type ActorContext,
  type UUID,
} from "../../domain/src/index.js";
import type {
  CorrectionCommand,
  CorrectionResult,
  CorrectionRevocationCommand,
  CorrectionRevocationResult,
  CorrectionReviewCommand,
  CorrectionReviewResult,
} from "../../protocol/src/index.js";
import {
  createDegradedContextStateFromFloor,
  createInitialContextState,
  replaceConfirmedCorrectionClaim,
  rebaseContextStateAuthority,
  unlinkConfirmedCorrectionClaim,
} from "../../context-state/src/index.js";
import type {
  CorrectionAuthority,
  ContextCorrectionDependencies,
} from "./contracts.js";
import {
  correctionRepairKind,
  decideCorrectionPromotion,
  normaliseCorrection,
  validateCorrectionCommand,
  isUuid,
} from "./policy.js";
import {
  replayCorrectionCommand,
  replayCorrectionRevocationCommand,
  replayCorrectionReviewCommand,
} from "./replay.js";

export type {
  CorrectionAuthority,
  ContextCorrectionClock,
  ContextCorrectionCommandStore,
  ContextCorrectionDependencies,
  ContextCorrectionIds,
  ContextCorrectionStateStore,
  ContextCorrectionStore,
  ContextCorrectionTransactions,
} from "./contracts.js";

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
    validateCorrectionCommand(command);
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
          return replayCorrectionCommand(
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
        const promotion =
          decideCorrectionPromotion(
            command,
            authority,
            normalised.canBecomeClaim,
            actor.userId,
            target.authorUserId,
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
            kind: correctionRepairKind(
              command.kind,
            ),
            status: promotion.status,
            structuredPayload:
              normalised.payload,
            commandId: command.command_id,
            createdAt: now,
          },
        );

        if (claimId) {
          await this.persistPromotedClaim(
            tx,
            actor,
            command,
            authority,
            target.messageId,
            promotion.subjectUserId,
            claimId,
            repairEventId,
            normalised.payload,
            promotion.scope!,
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

  async reviewCorrection(
    actor: ActorContext,
    command: CorrectionReviewCommand,
  ): Promise<CorrectionReviewResult> {
    if (
      command.protocol_version !== 1 ||
      !isUuid(command.command_id) ||
      !isUuid(command.conversation_id) ||
      !isUuid(command.repair_event_id) ||
      !["APPROVE", "REJECT"].includes(
        command.decision,
      )
    ) {
      throw new DomainError(
        "INVALID_COMMAND",
        "Invalid correction review command",
      );
    }

    const now = this.deps.clock.now();
    if (!Number.isFinite(Date.parse(now))) {
      throw new TypeError(
        "Correction review clock returned an invalid timestamp",
      );
    }

    const commandFingerprint = JSON.stringify({
      v: 1,
      type: "context.correction.review",
      conversation_id: command.conversation_id,
      repair_event_id: command.repair_event_id,
      decision: command.decision,
    });

    return this.deps.transactions.withTransaction(
      async (tx) => {
        const commandClaim =
          await this.deps.commands.claimCommand(tx, {
            actor,
            commandId: command.command_id,
            commandType:
              "context.correction.review",
            commandFingerprint,
            now,
          });

        if (!commandClaim.claimed) {
          return replayCorrectionReviewCommand(
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

        const elevated =
          authority.conversationRole ===
            "MODERATOR" ||
          authority.tenantRole === "ADMIN" ||
          authority.tenantRole === "OWNER";
        if (!elevated) {
          throw new DomainError(
            "NOT_AUTHORIZED",
            "Pending correction review requires elevated conversation authority",
          );
        }

        const repair =
          await this.deps.corrections.loadReviewableRepairEvent(
            tx,
            {
              tenantId: actor.tenantId,
              conversationId:
                command.conversation_id,
              repairEventId:
                command.repair_event_id,
            },
          );
        if (!repair) {
          throw new DomainError(
            "NOT_AUTHORIZED",
            "Repair event is not available for review",
          );
        }

        let proposed:
          | {
              command: CorrectionCommand;
              payload: Record<string, unknown>;
            }
          | undefined;

        if (command.decision === "APPROVE") {
          proposed = reviewableCorrectionProposal(
            command.conversation_id,
            repair,
          );
        }

        const reviewEventId =
          this.deps.ids.next("repair");

        await this.deps.corrections.insertRepairEvent(
          tx,
          {
            tenantId: actor.tenantId,
            repairEventId: reviewEventId,
            conversationId:
              command.conversation_id,
            actorUserId: actor.userId,
            targetTranslationId: null,
            targetMessageId:
              repair.targetMessageId,
            targetSourceRevision:
              repair.targetSourceRevision,
            kind: "EXPLICIT_CORRECTION",
            status: "APPLIED",
            structuredPayload: {
              schema_version: 1,
              action:
                command.decision === "APPROVE"
                  ? "APPROVE_PENDING_CORRECTION"
                  : "REJECT_PENDING_REPAIR",
              source_repair_event_id:
                repair.repairEventId,
              proposal_actor_user_id:
                repair.actorUserId,
            },
            commandId: command.command_id,
            createdAt: now,
          },
        );

        const terminalStatus =
          command.decision === "APPROVE"
            ? "APPLIED"
            : "REJECTED";

        const transitioned =
          await this.deps.corrections.updateRepairReviewStatus(
            tx,
            {
              tenantId: actor.tenantId,
              repairEventId:
                repair.repairEventId,
              status: terminalStatus,
            },
          );
        if (!transitioned) {
          throw new Error(
            "Pending repair changed despite review row lock",
          );
        }

        let claimId: UUID | null = null;
        if (proposed) {
          claimId =
            this.deps.ids.next("claim");
          await this.persistPromotedClaim(
            tx,
            actor,
            proposed.command,
            authority,
            repair.targetMessageId,
            null,
            claimId,
            reviewEventId,
            proposed.payload,
            "CONVERSATION",
            now,
          );
        }

        const result: CorrectionReviewResult = {
          protocol_version: 1,
          repair_event_id:
            repair.repairEventId,
          review_event_id: reviewEventId,
          status: terminalStatus,
          claim_id: claimId,
          claim_version:
            claimId ? 1 : null,
        };

        await this.deps.commands.markCommandSucceeded(
          tx,
          {
            tenantId: actor.tenantId,
            commandId: command.command_id,
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
            commandType:
              "context.correction.review",
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

  async revokeCorrection(
    actor: ActorContext,
    command: CorrectionRevocationCommand,
  ): Promise<CorrectionRevocationResult> {
    if (
      command.protocol_version !== 1 ||
      !isUuid(command.command_id) ||
      !isUuid(command.conversation_id) ||
      !isUuid(command.claim_id)
    ) {
      throw new DomainError(
        "INVALID_COMMAND",
        "Invalid correction revocation identity",
      );
    }

    const now = this.deps.clock.now();
    if (!Number.isFinite(Date.parse(now))) {
      throw new TypeError(
        "Correction revocation clock returned an invalid timestamp",
      );
    }

    const commandFingerprint = JSON.stringify({
      v: 1,
      type: "context.correction.revoke",
      conversation_id: command.conversation_id,
      claim_id: command.claim_id,
    });

    return this.deps.transactions.withTransaction(
      async (tx) => {
        const commandClaim =
          await this.deps.commands.claimCommand(tx, {
            actor,
            commandId: command.command_id,
            commandType:
              "context.correction.revoke",
            commandFingerprint,
            now,
          });

        if (!commandClaim.claimed) {
          return replayCorrectionRevocationCommand(
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

        const claim =
          await this.deps.corrections.loadRevocableCorrectionClaim(
            tx,
            {
              tenantId: actor.tenantId,
              conversationId:
                command.conversation_id,
              claimId: command.claim_id,
            },
          );

        if (!claim) {
          throw new DomainError(
            "NOT_AUTHORIZED",
            "Correction claim is not available for revocation",
          );
        }

        const actorCanRevoke =
          claim.subjectUserId !== null
            ? claim.subjectUserId === actor.userId
            : (
                authority.conversationRole ===
                  "MODERATOR" ||
                authority.tenantRole === "ADMIN" ||
                authority.tenantRole === "OWNER"
              );

        if (!actorCanRevoke) {
          throw new DomainError(
            "NOT_AUTHORIZED",
            "Correction claim is not available for revocation",
          );
        }

        const repairEventId =
          this.deps.ids.next("repair");

        await this.deps.corrections.insertRepairEvent(
          tx,
          {
            tenantId: actor.tenantId,
            repairEventId,
            conversationId:
              command.conversation_id,
            actorUserId: actor.userId,
            targetTranslationId: null,
            targetMessageId: null,
            targetSourceRevision: null,
            kind: "EXPLICIT_CORRECTION",
            status: "APPLIED",
            structuredPayload: {
              schema_version: 1,
              action: "REVOKE_CORRECTION",
              claim_id: claim.claimId,
              claim_version:
                claim.claimVersion,
            },
            commandId: command.command_id,
            createdAt: now,
          },
        );

        const revoked =
          await this.deps.corrections.revokeCorrectionClaim(
            tx,
            {
              tenantId: actor.tenantId,
              claimId: claim.claimId,
              claimVersion:
                claim.claimVersion,
              revokedAt: now,
            },
          );
        if (!revoked) {
          throw new Error(
            "Correction claim changed despite revocation row lock",
          );
        }

        await this.deps.corrections.insertClaimInvalidationProvenance(
          tx,
          {
            tenantId: actor.tenantId,
            provenanceEdgeId:
              this.deps.ids.next("provenance"),
            claimId: claim.claimId,
            claimVersion:
              claim.claimVersion,
            repairEventId,
            strategyVersion:
              this.strategyVersion,
            createdAt: now,
          },
        );

        await this.unlinkClaimFromState(
          tx,
          actor,
          command.conversation_id,
          authority,
          claim.claimId,
          now,
        );

        const result: CorrectionRevocationResult = {
          protocol_version: 1,
          repair_event_id: repairEventId,
          claim_id: claim.claimId,
          claim_version:
            claim.claimVersion,
          status: "REVOKED",
        };

        await this.deps.commands.markCommandSucceeded(
          tx,
          {
            tenantId: actor.tenantId,
            commandId: command.command_id,
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
            commandType:
              "context.correction.revoke",
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

  private async persistPromotedClaim(
    tx: Tx,
    actor: ActorContext,
    command: CorrectionCommand,
    authority: CorrectionAuthority,
    targetMessageId: UUID | null,
    subjectUserId: UUID | null,
    claimId: UUID,
    repairEventId: UUID,
    propositionRef: Record<string, unknown>,
    scope: "CONVERSATION" | "TENANT",
    now: string,
  ): Promise<void> {
    const superseded =
      await this.deps.corrections.invalidateSupersededCorrectionClaims(
        tx,
        {
          tenantId: actor.tenantId,
          conversationId:
            command.conversation_id,
          subjectUserId,
          propositionRef,
          invalidatedAt: now,
        },
      );

    await this.deps.corrections.insertConfirmedClaim(
      tx,
      {
        tenantId: actor.tenantId,
        claimId,
        conversationId:
          command.conversation_id,
        messageId: targetMessageId,
        subjectUserId,
        claimType:
          command.kind === "MEANING"
            ? "MEANING"
            : "TERMINOLOGY",
        propositionRef,
        scopeKind: scope,
        scopeConversationId:
          scope === "CONVERSATION"
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

    for (const previous of superseded) {
      await this.deps.corrections.insertClaimOverrideProvenance(
        tx,
        {
          tenantId: actor.tenantId,
          provenanceEdgeId:
            this.deps.ids.next("provenance"),
          overriddenClaimId:
            previous.claimId,
          overriddenClaimVersion:
            previous.claimVersion,
          replacementClaimId: claimId,
          replacementClaimVersion: 1,
          strategyVersion:
            this.strategyVersion,
          createdAt: now,
        },
      );
    }

    await this.linkClaimIntoState(
      tx,
      actor,
      command.conversation_id,
      authority,
      claimId,
      superseded.map(
        (claim) => claim.claimId,
      ),
      now,
    );
  }

  private async resolveTarget(
    tx: Tx,
    actor: ActorContext,
    command: CorrectionCommand,
  ): Promise<{
    messageId: UUID | null;
    sourceRevision: number | null;
    authorUserId: UUID | null;
  }> {
    let messageId =
      command.target_message_id ?? null;
    let sourceRevision =
      command.target_source_revision ?? null;
    let authorUserId: UUID | null = null;

    if (messageId) {
      const target =
        await this.deps.corrections.loadMessageRevisionTarget(
          tx,
          {
            tenantId: actor.tenantId,
            conversationId:
              command.conversation_id,
            messageId,
            sourceRevision: sourceRevision!,
          },
        );
      if (!target) {
        throw new DomainError(
          "NOT_AUTHORIZED",
          "Correction target is not available to actor",
        );
      }
      authorUserId = target.authorUserId;
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
      authorUserId =
        translation.authorUserId;
    }

    return {
      messageId,
      sourceRevision,
      authorUserId,
    };
  }

  private async unlinkClaimFromState(
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
    if (!existing) return;

    const expectedStateVersion =
      existing.stateVersion;
    let next = rebaseContextStateAuthority(
      existing,
      {
        membershipEpoch:
          authority.membershipEpoch,
        erasureEpoch:
          authority.erasureEpoch,
        policyVersion:
          authority.policyVersion,
        now,
      },
    );
    next = unlinkConfirmedCorrectionClaim(
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
        "ConversationState changed despite correction revocation row lock",
      );
    }
  }

  private async linkClaimIntoState(
    tx: Tx,
    actor: ActorContext,
    conversationId: UUID,
    authority: CorrectionAuthority,
    claimId: UUID,
    removeClaimIds: UUID[],
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

      created = replaceConfirmedCorrectionClaim(
        created,
        {
          claimId,
          removeClaimIds,
          now,
        },
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
    next = replaceConfirmedCorrectionClaim(
      next,
      {
        claimId,
        removeClaimIds,
        now,
      },
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


function reviewableCorrectionProposal(
  conversationId: UUID,
  repair: {
    repairEventId: UUID;
    actorUserId: UUID;
    targetMessageId: UUID | null;
    targetSourceRevision: number | null;
    kind:
      | "PROBLEM_REPORT"
      | "MEANING_CORRECTION"
      | "TONE_CORRECTION"
      | "TERMINOLOGY_CORRECTION";
    structuredPayload: Record<string, unknown>;
    originalCommandId: UUID;
    commandType: string;
    commandFingerprint: string | null;
  },
): {
  command: CorrectionCommand;
  payload: Record<string, unknown>;
} {
  if (
    repair.commandType !== "context.correction" ||
    !repair.commandFingerprint
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Pending feedback cannot be approved as semantic correction memory",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      repair.commandFingerprint,
    );
  } catch {
    throw new DomainError(
      "INVALID_COMMAND",
      "Pending correction fingerprint is malformed",
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Pending correction fingerprint is malformed",
    );
  }

  const value =
    parsed as Record<string, unknown>;
  if (
    value.v !== 1 ||
    value.type !== "context.correction" ||
    value.conversation_id !==
      conversationId ||
    value.requested_scope !==
      "CONVERSATION" ||
    !["MEANING", "TERMINOLOGY"].includes(
      String(value.kind),
    ) ||
    !value.payload ||
    typeof value.payload !== "object" ||
    Array.isArray(value.payload)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Pending correction is not approvable in V1",
    );
  }

  const original: CorrectionCommand = {
    protocol_version: 1,
    command_id:
      repair.originalCommandId,
    conversation_id: conversationId,
    kind:
      value.kind as CorrectionCommand["kind"],
    requested_scope: "CONVERSATION",
    payload:
      structuredClone(
        value.payload as Record<string, unknown>,
      ),
    ...(repair.targetMessageId &&
    repair.targetSourceRevision !== null
      ? {
          target_message_id:
            repair.targetMessageId,
          target_source_revision:
            repair.targetSourceRevision,
        }
      : {}),
  };

  const normalised =
    normaliseCorrection(original);
  if (
    !normalised.canBecomeClaim ||
    canonicalJson(normalised.payload) !==
      canonicalJson(repair.structuredPayload)
  ) {
    throw new DomainError(
      "INVALID_COMMAND",
      "Pending correction proposal does not match its durable repair event",
    );
  }

  return {
    command: original,
    payload: normalised.payload,
  };
}

function canonicalJson(
  value: unknown,
): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => canonicalJson(item))
      .join(",")}]`;
  }
  if (
    value &&
    typeof value === "object"
  ) {
    const record =
      value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            record[key],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

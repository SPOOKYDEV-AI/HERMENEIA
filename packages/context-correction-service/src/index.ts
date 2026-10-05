import {
  DomainError,
  type ActorContext,
  type UUID,
} from "../../domain/src/index.js";
import type {
  CorrectionCommand,
  CorrectionResult,
} from "../../protocol/src/index.js";
import {
  createDegradedContextStateFromFloor,
  createInitialContextState,
  replaceConfirmedCorrectionClaim,
  rebaseContextStateAuthority,
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
} from "./policy.js";
import {
  replayCorrectionCommand,
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

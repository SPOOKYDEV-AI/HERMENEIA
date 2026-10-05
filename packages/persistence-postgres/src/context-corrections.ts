import type {
  ActorContext,
  UUID,
} from "../../domain/src/index.js";
import type {
  SqlExecutor,
  SqlTransactionManager,
} from "../../persistence/src/index.js";

export interface CorrectionAuthority {
  tenantRole: "MEMBER" | "ADMIN" | "OWNER";
  conversationRole: "MEMBER" | "MODERATOR";
  membershipEpoch: number;
  erasureEpoch: number;
  policyVersion: number;
}

export class PostgresContextCorrectionRepository {
  constructor(
    private readonly transactions: SqlTransactionManager,
  ) {}

  withTransaction<T>(
    work: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return this.transactions.withTransaction(work);
  }

  async loadAuthority(
    tx: SqlExecutor,
    input: {
      actor: ActorContext;
      conversationId: UUID;
    },
  ): Promise<CorrectionAuthority | undefined> {
    const result = await tx.query<{
      tenant_role: CorrectionAuthority["tenantRole"];
      conversation_role: CorrectionAuthority["conversationRole"];
      membership_epoch: number;
      erasure_epoch: number;
      policy_version: number;
    }>(
      `SELECT tm.role AS tenant_role,
              cm.role AS conversation_role,
              c.membership_epoch,
              c.erasure_epoch,
              c.policy_version
         FROM conversations c
         JOIN conversation_members cm
           ON cm.tenant_id = c.tenant_id
          AND cm.conversation_id = c.conversation_id
          AND cm.user_id = $3
          AND cm.status = 'ACTIVE'
         JOIN tenant_memberships tm
           ON tm.tenant_id = c.tenant_id
          AND tm.user_id = cm.user_id
          AND tm.status = 'ACTIVE'
         JOIN devices d
           ON d.device_id = $4
          AND d.user_id = cm.user_id
          AND d.status = 'ACTIVE'
        WHERE c.tenant_id = $1
          AND c.conversation_id = $2
          AND c.status = 'ACTIVE'`,
      [
        input.actor.tenantId,
        input.conversationId,
        input.actor.userId,
        input.actor.deviceId,
      ],
    );

    const row = result.rows[0];
    return row
      ? {
          tenantRole: row.tenant_role,
          conversationRole: row.conversation_role,
          membershipEpoch: Number(row.membership_epoch),
          erasureEpoch: Number(row.erasure_epoch),
          policyVersion: Number(row.policy_version),
        }
      : undefined;
  }

  async messageRevisionExists(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      conversationId: UUID;
      messageId: UUID;
      sourceRevision: number;
    },
  ): Promise<boolean> {
    const result = await tx.query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1
           FROM message_revisions mr
          WHERE mr.tenant_id = $1
            AND mr.conversation_id = $2
            AND mr.message_id = $3
            AND mr.revision = $4
       ) AS present`,
      [
        input.tenantId,
        input.conversationId,
        input.messageId,
        input.sourceRevision,
      ],
    );
    return result.rows[0]?.present === true;
  }

  async loadVisibleTranslationTarget(
    tx: SqlExecutor,
    input: {
      actor: ActorContext;
      conversationId: UUID;
      translationId: UUID;
    },
  ): Promise<{
    messageId: UUID;
    sourceRevision: number;
  } | undefined> {
    const result = await tx.query<{
      source_message_id: UUID;
      source_revision: number;
    }>(
      `SELECT te.source_message_id,
              te.source_revision
         FROM translation_executions te
        WHERE te.tenant_id = $1
          AND te.conversation_id = $2
          AND te.translation_id = $3
          AND te.recipient_user_id = $4`,
      [
        input.actor.tenantId,
        input.conversationId,
        input.translationId,
        input.actor.userId,
      ],
    );
    const row = result.rows[0];
    return row
      ? {
          messageId: row.source_message_id,
          sourceRevision: Number(row.source_revision),
        }
      : undefined;
  }

  async insertRepairEvent(
    tx: SqlExecutor,
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
  ): Promise<void> {
    const result = await tx.query(
      `INSERT INTO translation_repair_events(
         tenant_id,
         repair_event_id,
         conversation_id,
         actor_user_id,
         target_translation_id,
         target_message_id,
         target_source_revision,
         kind,
         status,
         structured_payload,
         command_id,
         created_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12
       )`,
      [
        input.tenantId,
        input.repairEventId,
        input.conversationId,
        input.actorUserId,
        input.targetTranslationId,
        input.targetMessageId,
        input.targetSourceRevision,
        input.kind,
        input.status,
        JSON.stringify(input.structuredPayload),
        input.commandId,
        input.createdAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Correction repair event was not inserted");
    }
  }

  async insertConfirmedClaim(
    tx: SqlExecutor,
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
  ): Promise<void> {
    const result = await tx.query(
      `INSERT INTO context_claims(
         tenant_id,
         claim_id,
         claim_version,
         conversation_id,
         message_id,
         subject_user_id,
         claim_type,
         proposition_ref,
         modality,
         authority_class,
         retention_class,
         sensitivity_class,
         confidence,
         scope_kind,
         scope_conversation_id,
         trigger_kind,
         valid_from,
         valid_until,
         status,
         created_at
       ) VALUES (
         $1,$2,1,$3,$4,NULL,$5,$6::jsonb,
         'CORRECTION','CONFIRMED_CORRECTION',
         'CORRECTIVE_DURABLE','NORMAL',1,
         $7,$8,'EXPLICIT_UI_CORRECTION',
         $9,NULL,'ACTIVE',$9
       )`,
      [
        input.tenantId,
        input.claimId,
        input.conversationId,
        input.messageId,
        input.claimType,
        JSON.stringify(input.propositionRef),
        input.scopeKind,
        input.scopeConversationId,
        input.createdAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Confirmed correction claim was not inserted");
    }
  }

  async insertRepairProvenance(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      provenanceEdgeId: UUID;
      claimId: UUID;
      repairEventId: UUID;
      strategyVersion: string;
      createdAt: string;
    },
  ): Promise<void> {
    const result = await tx.query(
      `INSERT INTO provenance_edges(
         tenant_id,
         provenance_edge_id,
         derived_claim_id,
         derived_claim_version,
         relation,
         source_repair_event_id,
         strategy_version,
         created_at
       ) VALUES (
         $1,$2,$3,1,'CORRECTED_BY',$4,$5,$6
       )`,
      [
        input.tenantId,
        input.provenanceEdgeId,
        input.claimId,
        input.repairEventId,
        input.strategyVersion,
        input.createdAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Correction provenance edge was not inserted");
    }
  }
}

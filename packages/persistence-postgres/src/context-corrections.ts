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
  nextOperationSequence: number;
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
      next_op_seq: number;
    }>(
      `SELECT tm.role AS tenant_role,
              cm.role AS conversation_role,
              c.membership_epoch,
              c.erasure_epoch,
              c.policy_version,
              c.next_op_seq
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
          nextOperationSequence: Number(row.next_op_seq),
        }
      : undefined;
  }

  async loadMessageRevisionTarget(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      conversationId: UUID;
      messageId: UUID;
      sourceRevision: number;
    },
  ): Promise<{
    messageId: UUID;
    sourceRevision: number;
    authorUserId: UUID;
  } | undefined> {
    const result = await tx.query<{
      message_id: UUID;
      revision: number;
      author_user_id: UUID;
    }>(
      `SELECT mr.message_id,
              mr.revision,
              mm.author_user_id
         FROM message_revisions mr
         JOIN message_metadata mm
           ON mm.tenant_id = mr.tenant_id
          AND mm.conversation_id = mr.conversation_id
          AND mm.message_id = mr.message_id
        WHERE mr.tenant_id = $1
          AND mr.conversation_id = $2
          AND mr.message_id = $3
          AND mr.revision = $4`,
      [
        input.tenantId,
        input.conversationId,
        input.messageId,
        input.sourceRevision,
      ],
    );
    const row = result.rows[0];
    return row
      ? {
          messageId: row.message_id,
          sourceRevision: Number(row.revision),
          authorUserId: row.author_user_id,
        }
      : undefined;
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
    authorUserId: UUID;
  } | undefined> {
    const result = await tx.query<{
      source_message_id: UUID;
      source_revision: number;
      author_user_id: UUID;
    }>(
      `SELECT te.source_message_id,
              te.source_revision,
              mm.author_user_id
         FROM translation_executions te
         JOIN message_metadata mm
           ON mm.tenant_id = te.tenant_id
          AND mm.conversation_id = te.conversation_id
          AND mm.message_id = te.source_message_id
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
          authorUserId: row.author_user_id,
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
        | "EXPLICIT_CORRECTION"
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

  async loadRevocableCorrectionClaim(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      conversationId: UUID;
      claimId: UUID;
    },
  ): Promise<{
    claimId: UUID;
    claimVersion: number;
    subjectUserId: UUID | null;
  } | undefined> {
    const result = await tx.query<{
      claim_id: UUID;
      claim_version: number;
      subject_user_id: UUID | null;
    }>(
      `SELECT claim_id,
              claim_version,
              subject_user_id
         FROM context_claims
        WHERE tenant_id = $1
          AND conversation_id = $2
          AND claim_id = $3
          AND scope_kind = 'CONVERSATION'
          AND scope_conversation_id = $2
          AND status = 'ACTIVE'
          AND authority_class = 'CONFIRMED_CORRECTION'
          AND retention_class = 'CORRECTIVE_DURABLE'
          AND modality = 'CORRECTION'
        ORDER BY claim_version DESC
        LIMIT 1
        FOR UPDATE`,
      [
        input.tenantId,
        input.conversationId,
        input.claimId,
      ],
    );

    const row = result.rows[0];
    return row
      ? {
          claimId: row.claim_id,
          claimVersion: Number(row.claim_version),
          subjectUserId: row.subject_user_id,
        }
      : undefined;
  }

  async revokeCorrectionClaim(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      claimId: UUID;
      claimVersion: number;
      revokedAt: string;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE context_claims
          SET status = 'REVOKED',
              valid_until = CASE
                WHEN valid_from IS NULL OR valid_from < $4
                  THEN $4
                ELSE valid_from + interval '1 microsecond'
              END
        WHERE tenant_id = $1
          AND claim_id = $2
          AND claim_version = $3
          AND status = 'ACTIVE'
          AND authority_class = 'CONFIRMED_CORRECTION'
          AND retention_class = 'CORRECTIVE_DURABLE'
          AND modality = 'CORRECTION'`,
      [
        input.tenantId,
        input.claimId,
        input.claimVersion,
        input.revokedAt,
      ],
    );
    return result.rowCount === 1;
  }

  async invalidateSupersededCorrectionClaims(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      conversationId: UUID;
      subjectUserId: UUID | null;
      propositionRef: Record<string, unknown>;
      invalidatedAt: string;
    },
  ): Promise<Array<{
    claimId: UUID;
    claimVersion: number;
  }>> {
    const result = await tx.query<{
      claim_id: UUID;
      claim_version: number;
    }>(
      `UPDATE context_claims
          SET status = 'INVALIDATED',
              valid_until = CASE
                WHEN valid_from IS NULL OR valid_from < $5
                  THEN $5
                ELSE valid_from + interval '1 microsecond'
              END
        WHERE tenant_id = $1
          AND conversation_id = $2
          AND scope_kind = 'CONVERSATION'
          AND scope_conversation_id = $2
          AND subject_user_id IS NOT DISTINCT FROM $3
          AND status = 'ACTIVE'
          AND authority_class = 'CONFIRMED_CORRECTION'
          AND retention_class = 'CORRECTIVE_DURABLE'
          AND modality = 'CORRECTION'
          AND (
            (
              ($4::jsonb ->> 'kind') = 'TERM_MEANING'
              AND proposition_ref ->> 'kind' = 'TERM_MEANING'
              AND proposition_ref ->> 'surface_form' =
                  ($4::jsonb ->> 'surface_form')
              AND COALESCE(
                    proposition_ref ->> 'source_language_tag',
                    ''
                  ) =
                  COALESCE(
                    $4::jsonb ->> 'source_language_tag',
                    ''
                  )
              AND COALESCE(
                    proposition_ref ->> 'target_language_tag',
                    ''
                  ) =
                  COALESCE(
                    $4::jsonb ->> 'target_language_tag',
                    ''
                  )
            )
            OR
            (
              ($4::jsonb ->> 'kind') = 'PREFERRED_RENDERING'
              AND proposition_ref ->> 'kind' = 'PREFERRED_RENDERING'
              AND proposition_ref ->> 'source_form' =
                  ($4::jsonb ->> 'source_form')
              AND COALESCE(
                    proposition_ref ->> 'source_language_tag',
                    ''
                  ) =
                  COALESCE(
                    $4::jsonb ->> 'source_language_tag',
                    ''
                  )
              AND COALESCE(
                    proposition_ref ->> 'target_language_tag',
                    ''
                  ) =
                  COALESCE(
                    $4::jsonb ->> 'target_language_tag',
                    ''
                  )
            )
          )
      RETURNING claim_id, claim_version`,
      [
        input.tenantId,
        input.conversationId,
        input.subjectUserId,
        JSON.stringify(input.propositionRef),
        input.invalidatedAt,
      ],
    );

    return result.rows.map((row) => ({
      claimId: row.claim_id,
      claimVersion: Number(row.claim_version),
    }));
  }

  async insertConfirmedClaim(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      claimId: UUID;
      conversationId: UUID;
      messageId: UUID | null;
      subjectUserId: UUID | null;
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
         $1,$2,1,$3,$4,$5,$6,$7::jsonb,
         'CORRECTION','CONFIRMED_CORRECTION',
         'CORRECTIVE_DURABLE','NORMAL',1,
         $8,$9,'EXPLICIT_UI_CORRECTION',
         $10,NULL,'ACTIVE',$10
       )`,
      [
        input.tenantId,
        input.claimId,
        input.conversationId,
        input.messageId,
        input.subjectUserId,
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

  async insertClaimOverrideProvenance(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      provenanceEdgeId: UUID;
      overriddenClaimId: UUID;
      overriddenClaimVersion: number;
      replacementClaimId: UUID;
      replacementClaimVersion: number;
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
         source_claim_id,
         source_claim_version,
         strategy_version,
         created_at
       ) VALUES (
         $1,$2,$3,$4,'OVERRIDDEN_BY',$5,$6,$7,$8
       )`,
      [
        input.tenantId,
        input.provenanceEdgeId,
        input.overriddenClaimId,
        input.overriddenClaimVersion,
        input.replacementClaimId,
        input.replacementClaimVersion,
        input.strategyVersion,
        input.createdAt,
      ],
    );

    if (result.rowCount !== 1) {
      throw new Error(
        "Correction override provenance edge was not inserted",
      );
    }
  }

  async insertClaimInvalidationProvenance(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      provenanceEdgeId: UUID;
      claimId: UUID;
      claimVersion: number;
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
         $1,$2,$3,$4,'INVALIDATED_BY',$5,$6,$7
       )`,
      [
        input.tenantId,
        input.provenanceEdgeId,
        input.claimId,
        input.claimVersion,
        input.repairEventId,
        input.strategyVersion,
        input.createdAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error(
        "Correction invalidation provenance edge was not inserted",
      );
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

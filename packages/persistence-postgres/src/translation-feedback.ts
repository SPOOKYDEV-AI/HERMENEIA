import type {
  ActorContext,
  UUID,
} from "../../domain/src/index.js";
import type {
  SqlExecutor,
  SqlTransactionManager,
} from "../../persistence/src/index.js";

export interface EligibleFeedbackTranslation {
  conversationId: UUID;
  messageId: UUID;
  sourceRevision: number;
}

export class PostgresTranslationFeedbackRepository {
  constructor(
    private readonly transactions: SqlTransactionManager,
  ) {}

  withTransaction<T>(
    work: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return this.transactions.withTransaction(work);
  }

  async loadEligibleTranslation(
    tx: SqlExecutor,
    input: {
      actor: ActorContext;
      translationId: UUID;
    },
  ): Promise<EligibleFeedbackTranslation | undefined> {
    const result = await tx.query<{
      conversation_id: UUID;
      source_message_id: UUID;
      source_revision: number;
    }>(
      `SELECT te.conversation_id,
              te.source_message_id,
              te.source_revision
         FROM translation_executions te
         JOIN conversations c
           ON c.tenant_id = te.tenant_id
          AND c.conversation_id = te.conversation_id
          AND c.status = 'ACTIVE'
         JOIN conversation_members cm
           ON cm.tenant_id = te.tenant_id
          AND cm.conversation_id = te.conversation_id
          AND cm.user_id = $3
          AND cm.status = 'ACTIVE'
         JOIN tenant_memberships tm
           ON tm.tenant_id = te.tenant_id
          AND tm.user_id = $3
          AND tm.status = 'ACTIVE'
         JOIN devices d
           ON d.device_id = $4
          AND d.user_id = $3
          AND d.status = 'ACTIVE'
         JOIN message_metadata mm
           ON mm.tenant_id = te.tenant_id
          AND mm.conversation_id = te.conversation_id
          AND mm.message_id = te.source_message_id
          AND mm.current_revision = te.source_revision
          AND mm.status = 'ACTIVE'
        WHERE te.tenant_id = $1
          AND te.translation_id = $2
          AND te.recipient_user_id = $3
          AND te.status = 'READY'`,
      [
        input.actor.tenantId,
        input.translationId,
        input.actor.userId,
        input.actor.deviceId,
      ],
    );

    const row = result.rows[0];
    return row
      ? {
          conversationId: row.conversation_id,
          messageId: row.source_message_id,
          sourceRevision: Number(row.source_revision),
        }
      : undefined;
  }

  async insertFeedbackRepairEvent(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      repairEventId: UUID;
      conversationId: UUID;
      actorUserId: UUID;
      targetTranslationId: UUID;
      targetMessageId: UUID;
      targetSourceRevision: number;
      kind:
        | "PROBLEM_REPORT"
        | "MEANING_CORRECTION"
        | "TONE_CORRECTION"
        | "TERMINOLOGY_CORRECTION";
      status: "RECORDED" | "NEEDS_CONFIRMATION";
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
      throw new Error(
        "Translation feedback repair event was not inserted",
      );
    }
  }
}

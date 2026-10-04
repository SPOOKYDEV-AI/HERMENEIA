import type {
  ActorContext,
  UUID,
} from "../../domain/src/index.js";
import type {
  ProviderExecutionRecord,
  TranslationExecutionRecord,
  TranslationFanoutPlan,
  TranslationLogicalKey,
  TranslationRecipientDevice,
  TranslationRecoveryRecord,
} from "../../translation-service/src/index.js";
import type {
  SqlExecutor,
  SqlQueryResult,
  SqlTransactionManager,
} from "../../persistence/src/index.js";

function first<Row extends Record<string, unknown>>(
  result: SqlQueryResult<Row>,
): Row | undefined {
  return result.rows[0];
}

type TranslationRow = {
  tenant_id: UUID;
  translation_id: UUID;
  conversation_id: UUID;
  source_message_id: UUID;
  source_revision: number;
  recipient_user_id: UUID;
  target_language_tag: string;
  target_profile_version: number;
  context_snapshot_id: UUID | null;
  strategy_version: string;
  status: TranslationExecutionRecord["status"];
  next_attempt_at: string | null;
  created_at: string;
  ready_at: string | null;
  superseded_at: string | null;
};

function mapTranslation(
  row: TranslationRow,
): TranslationExecutionRecord {
  return {
    tenantId: row.tenant_id,
    translationId: row.translation_id,
    conversationId: row.conversation_id,
    sourceMessageId: row.source_message_id,
    sourceRevision: Number(row.source_revision),
    recipientUserId: row.recipient_user_id,
    targetLanguageTag: row.target_language_tag,
    targetProfileVersion: Number(row.target_profile_version),
    contextSnapshotId: row.context_snapshot_id,
    strategyVersion: row.strategy_version,
    status: row.status,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    supersededAt: row.superseded_at,
  };
}

export class PostgresTranslationRepository {
  constructor(private readonly transactions: SqlTransactionManager) {}

  withTransaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.transactions.withTransaction(work);
  }

  async loadFanoutPlan(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      sourceMessageId: UUID;
      sourceRevision: number;
    },
  ): Promise<TranslationFanoutPlan | undefined> {
    const source = await tx.query<{
      conversation_id: UUID;
      declared_source_language: string | null;
    }>(
      `SELECT mm.conversation_id,
              mr.declared_source_language
         FROM message_metadata mm
         JOIN message_revisions mr
           ON mr.tenant_id = mm.tenant_id
          AND mr.message_id = mm.message_id
          AND mr.revision = $3
        WHERE mm.tenant_id = $1
          AND mm.message_id = $2
          AND mm.current_revision = $3
          AND mm.status = 'ACTIVE'`,
      [
        input.tenantId,
        input.sourceMessageId,
        input.sourceRevision,
      ],
    );
    const sourceRow = first(source);
    if (!sourceRow) return undefined;

    const targets = await tx.query<{
      user_id: UUID;
      target_language_tag: string;
      membership_version: number;
    }>(
      `SELECT cm.user_id,
              COALESCE(
                NULLIF(trim(cm.target_locale_override), ''),
                NULLIF(trim(cm.target_language_tag), '')
              ) AS target_language_tag,
              cm.membership_version
         FROM message_metadata mm
         JOIN conversation_members cm
           ON cm.tenant_id = mm.tenant_id
          AND cm.conversation_id = mm.conversation_id
          AND cm.status = 'ACTIVE'
          AND cm.user_id <> mm.author_user_id
        WHERE mm.tenant_id = $1
          AND mm.message_id = $2
          AND mm.current_revision = $3
          AND mm.status = 'ACTIVE'
          AND COALESCE(
                NULLIF(trim(cm.target_locale_override), ''),
                NULLIF(trim(cm.target_language_tag), '')
              ) IS NOT NULL
        ORDER BY cm.user_id`,
      [
        input.tenantId,
        input.sourceMessageId,
        input.sourceRevision,
      ],
    );

    return {
      conversationId: sourceRow.conversation_id,
      sourceLanguageTag: sourceRow.declared_source_language,
      targets: targets.rows.map((row) => ({
        recipientUserId: row.user_id,
        targetLanguageTag: row.target_language_tag,
        targetProfileVersion: Number(row.membership_version),
      })),
    };
  }

  async findTranslationExecution(
    tx: SqlExecutor,
    key: TranslationLogicalKey,
  ): Promise<TranslationExecutionRecord | undefined> {
    const result = await tx.query<TranslationRow>(
      `SELECT tenant_id,
              translation_id,
              conversation_id,
              source_message_id,
              source_revision,
              recipient_user_id,
              target_language_tag,
              target_profile_version,
              context_snapshot_id,
              strategy_version,
              status,
              next_attempt_at::text AS next_attempt_at,
              created_at::text AS created_at,
              ready_at::text AS ready_at,
              superseded_at::text AS superseded_at
         FROM translation_executions
        WHERE tenant_id = $1
          AND conversation_id = $2
          AND source_message_id = $3
          AND source_revision = $4
          AND recipient_user_id = $5
          AND target_language_tag = $6
          AND target_profile_version = $7
          AND context_snapshot_id IS NOT DISTINCT FROM $8::uuid
          AND strategy_version = $9`,
      [
        key.tenantId,
        key.conversationId,
        key.sourceMessageId,
        key.sourceRevision,
        key.recipientUserId,
        key.targetLanguageTag,
        key.targetProfileVersion,
        key.contextSnapshotId,
        key.strategyVersion,
      ],
    );
    const row = first(result);
    return row ? mapTranslation(row) : undefined;
  }

  async insertTranslationExecution(
    tx: SqlExecutor,
    input: TranslationExecutionRecord,
  ): Promise<TranslationExecutionRecord | undefined> {
    const result = await tx.query<TranslationRow>(
      `INSERT INTO translation_executions(
         tenant_id,
         translation_id,
         conversation_id,
         source_message_id,
         source_revision,
         recipient_user_id,
         target_language_tag,
         target_profile_version,
         context_snapshot_id,
         strategy_version,
         status,
         next_attempt_at,
         created_at,
         ready_at,
         superseded_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15
       )
       ON CONFLICT DO NOTHING
       RETURNING tenant_id,
                 translation_id,
                 conversation_id,
                 source_message_id,
                 source_revision,
                 recipient_user_id,
                 target_language_tag,
                 target_profile_version,
                 context_snapshot_id,
                 strategy_version,
                 status,
                 next_attempt_at::text AS next_attempt_at,
                 created_at::text AS created_at,
                 ready_at::text AS ready_at,
                 superseded_at::text AS superseded_at`,
      [
        input.tenantId,
        input.translationId,
        input.conversationId,
        input.sourceMessageId,
        input.sourceRevision,
        input.recipientUserId,
        input.targetLanguageTag,
        input.targetProfileVersion,
        input.contextSnapshotId,
        input.strategyVersion,
        input.status,
        input.nextAttemptAt,
        input.createdAt,
        input.readyAt,
        input.supersededAt,
      ],
    );
    const row = first(result);
    return row ? mapTranslation(row) : undefined;
  }

  async lockTranslationExecution(
    tx: SqlExecutor,
    tenantId: UUID,
    translationId: UUID,
  ): Promise<TranslationExecutionRecord | undefined> {
    const result = await tx.query<TranslationRow>(
      `SELECT tenant_id,
              translation_id,
              conversation_id,
              source_message_id,
              source_revision,
              recipient_user_id,
              target_language_tag,
              target_profile_version,
              context_snapshot_id,
              strategy_version,
              status,
              next_attempt_at::text AS next_attempt_at,
              created_at::text AS created_at,
              ready_at::text AS ready_at,
              superseded_at::text AS superseded_at
         FROM translation_executions
        WHERE tenant_id = $1
          AND translation_id = $2
        FOR UPDATE`,
      [tenantId, translationId],
    );
    const row = first(result);
    return row ? mapTranslation(row) : undefined;
  }

  async lockCurrentTranslationForPublish(
    tx: SqlExecutor,
    tenantId: UUID,
    translationId: UUID,
  ): Promise<TranslationExecutionRecord | undefined> {
    const result = await tx.query<TranslationRow>(
      `SELECT te.tenant_id,
              te.translation_id,
              te.conversation_id,
              te.source_message_id,
              te.source_revision,
              te.recipient_user_id,
              te.target_language_tag,
              te.target_profile_version,
              te.context_snapshot_id,
              te.strategy_version,
              te.status,
              te.next_attempt_at::text AS next_attempt_at,
              te.created_at::text AS created_at,
              te.ready_at::text AS ready_at,
              te.superseded_at::text AS superseded_at
         FROM translation_executions te
         JOIN message_metadata mm
           ON mm.tenant_id = te.tenant_id
          AND mm.conversation_id = te.conversation_id
          AND mm.message_id = te.source_message_id
          AND mm.current_revision = te.source_revision
          AND mm.status = 'ACTIVE'
         JOIN conversation_members cm
           ON cm.tenant_id = te.tenant_id
          AND cm.conversation_id = te.conversation_id
          AND cm.user_id = te.recipient_user_id
          AND cm.status = 'ACTIVE'
          AND cm.membership_version = te.target_profile_version
          AND COALESCE(
                NULLIF(trim(cm.target_locale_override), ''),
                NULLIF(trim(cm.target_language_tag), '')
              ) = te.target_language_tag
        WHERE te.tenant_id = $1
          AND te.translation_id = $2
          AND te.status = 'PENDING'
        FOR UPDATE OF te, mm, cm`,
      [tenantId, translationId],
    );
    const row = first(result);
    return row ? mapTranslation(row) : undefined;
  }

  async lockTranslationForRecovery(
    tx: SqlExecutor,
    actor: ActorContext,
    translationId: UUID,
  ): Promise<TranslationRecoveryRecord | undefined> {
    const executionResult = await tx.query<
      TranslationRow & {
        expected_source_hash: string;
        message_current_revision: number;
        message_status: "ACTIVE" | "DELETED";
      }
    >(
      `SELECT te.tenant_id,
              te.translation_id,
              te.conversation_id,
              te.source_message_id,
              te.source_revision,
              te.recipient_user_id,
              te.target_language_tag,
              te.target_profile_version,
              te.context_snapshot_id,
              te.strategy_version,
              te.status,
              te.next_attempt_at::text AS next_attempt_at,
              te.created_at::text AS created_at,
              te.ready_at::text AS ready_at,
              te.superseded_at::text AS superseded_at,
              mr.source_hash AS expected_source_hash,
              mm.current_revision AS message_current_revision,
              mm.status AS message_status
         FROM translation_executions te
         JOIN message_metadata mm
           ON mm.tenant_id = te.tenant_id
          AND mm.conversation_id = te.conversation_id
          AND mm.message_id = te.source_message_id
         JOIN message_revisions mr
           ON mr.tenant_id = te.tenant_id
          AND mr.message_id = te.source_message_id
          AND mr.revision = te.source_revision
         JOIN conversation_members actor_cm
           ON actor_cm.tenant_id = te.tenant_id
          AND actor_cm.conversation_id = te.conversation_id
          AND actor_cm.user_id = $3
          AND actor_cm.status = 'ACTIVE'
         JOIN tenant_memberships actor_tm
           ON actor_tm.tenant_id = te.tenant_id
          AND actor_tm.user_id = $3
          AND actor_tm.status = 'ACTIVE'
         JOIN devices actor_device
           ON actor_device.device_id = $4
          AND actor_device.user_id = $3
          AND actor_device.status = 'ACTIVE'
        WHERE te.tenant_id = $1
          AND te.translation_id = $2
          AND mr.source_hash IS NOT NULL
        FOR UPDATE OF te, mm
        FOR SHARE OF actor_cm, actor_tm, actor_device`,
      [
        actor.tenantId,
        translationId,
        actor.userId,
        actor.deviceId,
      ],
    );

    const executionRow = first(executionResult);
    if (!executionRow) return undefined;

    const targetResult = await tx.query<{
      status: "ACTIVE" | "LEFT" | "REMOVED" | "BLOCKED";
      membership_version: number;
      target_language_tag: string | null;
    }>(
      `SELECT cm.status,
              cm.membership_version,
              COALESCE(
                NULLIF(trim(cm.target_locale_override), ''),
                NULLIF(trim(cm.target_language_tag), '')
              ) AS target_language_tag
         FROM conversation_members cm
        WHERE cm.tenant_id = $1
          AND cm.conversation_id = $2
          AND cm.user_id = $3
        FOR SHARE`,
      [
        actor.tenantId,
        executionRow.conversation_id,
        executionRow.recipient_user_id,
      ],
    );
    const targetRow = first(targetResult);

    return {
      execution: mapTranslation(executionRow),
      expectedSourceHash: executionRow.expected_source_hash,
      messageCurrentRevision: Number(
        executionRow.message_current_revision,
      ),
      messageStatus: executionRow.message_status,
      targetMembershipStatus: targetRow?.status ?? null,
      currentTargetProfileVersion: targetRow
        ? Number(targetRow.membership_version)
        : null,
      currentTargetLanguageTag:
        targetRow?.target_language_tag ?? null,
    };
  }

  async resumeSourceRequired(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      translationId: UUID;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE translation_executions
          SET status = 'PENDING',
              next_attempt_at = NULL
        WHERE tenant_id = $1
          AND translation_id = $2
          AND status = 'SOURCE_REQUIRED'`,
      [input.tenantId, input.translationId],
    );
    return result.rowCount === 1;
  }

  async resumeFailed(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      translationId: UUID;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE translation_executions
          SET status = 'PENDING',
              next_attempt_at = NULL
        WHERE tenant_id = $1
          AND translation_id = $2
          AND status = 'FAILED'`,
      [input.tenantId, input.translationId],
    );
    return result.rowCount === 1;
  }

  async listRecipientControlDevices(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      recipientUserId: UUID;
    },
  ): Promise<UUID[]> {
    const result = await tx.query<{ device_id: UUID }>(
      `SELECT d.device_id
         FROM devices d
         JOIN tenant_memberships tm
           ON tm.tenant_id = $1
          AND tm.user_id = d.user_id
          AND tm.status = 'ACTIVE'
        WHERE d.user_id = $2
          AND d.status = 'ACTIVE'
        ORDER BY d.device_id`,
      [input.tenantId, input.recipientUserId],
    );
    return result.rows.map((row) => row.device_id);
  }

  async listRecipientDevicesForPublish(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      recipientUserId: UUID;
    },
  ): Promise<TranslationRecipientDevice[]> {
    const result = await tx.query<{
      device_id: UUID;
      credential_version: number;
      public_material_ref: string;
    }>(
      `SELECT d.device_id,
              d.credential_version,
              d.public_material_ref
         FROM devices d
         JOIN tenant_memberships tm
           ON tm.tenant_id = $1
          AND tm.user_id = d.user_id
          AND tm.status = 'ACTIVE'
        WHERE d.user_id = $2
          AND d.status = 'ACTIVE'
          AND length(d.public_material_ref) > 0
        ORDER BY d.device_id
        FOR SHARE OF d`,
      [input.tenantId, input.recipientUserId],
    );
    return result.rows.map((row) => ({
      deviceId: row.device_id,
      credentialVersion: Number(row.credential_version),
      publicMaterialRef: row.public_material_ref,
    }));
  }

  async scheduleRetry(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      translationId: UUID;
      nextAttemptAt: string;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE translation_executions
          SET next_attempt_at = $3
        WHERE tenant_id = $1
          AND translation_id = $2
          AND status = 'PENDING'`,
      [
        input.tenantId,
        input.translationId,
        input.nextAttemptAt,
      ],
    );
    return result.rowCount === 1;
  }

  async markFailed(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      translationId: UUID;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE translation_executions
          SET status = 'FAILED',
              next_attempt_at = NULL
        WHERE tenant_id = $1
          AND translation_id = $2
          AND status = 'PENDING'`,
      [input.tenantId, input.translationId],
    );
    return result.rowCount === 1;
  }

  async markReady(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      translationId: UUID;
      readyAt: string;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE translation_executions
          SET status = 'READY',
              next_attempt_at = NULL,
              ready_at = $3
        WHERE tenant_id = $1
          AND translation_id = $2
          AND status = 'PENDING'`,
      [
        input.tenantId,
        input.translationId,
        input.readyAt,
      ],
    );
    return result.rowCount === 1;
  }

  async markSuperseded(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      translationId: UUID;
      supersededAt: string;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE translation_executions
          SET status = 'SUPERSEDED',
              next_attempt_at = NULL,
              superseded_at = $3
        WHERE tenant_id = $1
          AND translation_id = $2
          AND status IN (
            'PENDING',
            'SOURCE_REQUIRED',
            'READY',
            'FAILED',
            'EXPIRED'
          )`,
      [
        input.tenantId,
        input.translationId,
        input.supersededAt,
      ],
    );
    return result.rowCount === 1;
  }

  async markSourceRequired(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      translationId: UUID;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE translation_executions
          SET status = 'SOURCE_REQUIRED',
              next_attempt_at = NULL
        WHERE tenant_id = $1
          AND translation_id = $2
          AND status = 'PENDING'`,
      [input.tenantId, input.translationId],
    );
    return result.rowCount === 1;
  }

  async nextProviderAttemptNumber(
    tx: SqlExecutor,
    tenantId: UUID,
    translationId: UUID,
  ): Promise<number> {
    const result = await tx.query<{ attempt_no: number }>(
      `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
         FROM provider_executions
        WHERE tenant_id = $1
          AND translation_id = $2`,
      [tenantId, translationId],
    );
    const row = first(result);
    if (!row) {
      throw new Error(
        "Invariant violation: provider attempt sequence unavailable",
      );
    }
    return Number(row.attempt_no);
  }

  async insertProviderExecution(
    tx: SqlExecutor,
    input: ProviderExecutionRecord,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO provider_executions(
         tenant_id,
         attempt_id,
         translation_id,
         attempt_no,
         provider_id,
         model_id,
         provider_region,
         status,
         input_tokens,
         output_tokens,
         billed_cost_microunits,
         latency_ms,
         error_class,
         started_at,
         completed_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15
       )`,
      [
        input.tenantId,
        input.attemptId,
        input.translationId,
        input.attemptNo,
        input.providerId,
        input.modelId,
        input.providerRegion,
        input.status,
        input.inputTokens,
        input.outputTokens,
        input.billedCostMicrounits,
        input.latencyMs,
        input.errorClass,
        input.startedAt,
        input.completedAt,
      ],
    );
  }

  async completeProviderExecution(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      attemptId: UUID;
      status:
        | "SUCCEEDED"
        | "FAILED"
        | "TIMED_OUT"
        | "RATE_LIMITED"
        | "CANCELLED_LOGICALLY";
      inputTokens?: number | null;
      outputTokens?: number | null;
      billedCostMicrounits?: number | null;
      latencyMs?: number | null;
      errorClass?: string | null;
      completedAt: string;
    },
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE provider_executions
          SET status = $3,
              input_tokens = $4,
              output_tokens = $5,
              billed_cost_microunits = $6,
              latency_ms = $7,
              error_class = $8,
              completed_at = $9
        WHERE tenant_id = $1
          AND attempt_id = $2
          AND status = 'STARTED'`,
      [
        input.tenantId,
        input.attemptId,
        input.status,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.billedCostMicrounits ?? null,
        input.latencyMs ?? null,
        input.errorClass ?? null,
        input.completedAt,
      ],
    );
    return result.rowCount === 1;
  }
}

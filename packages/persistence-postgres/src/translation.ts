import type { UUID } from "../../domain/src/index.js";
import type {
  ProviderExecutionRecord,
  TranslationExecutionRecord,
  TranslationLogicalKey,
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

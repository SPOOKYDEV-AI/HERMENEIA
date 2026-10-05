import type { UUID } from "../../domain/src/index.js";
import type {
  ContextRecoveryMode,
  ContextSnapshot,
  ContextStrategy,
} from "../../context-engine/src/index.js";
import type {
  SqlExecutor,
  SqlTransactionManager,
} from "../../persistence/src/index.js";

interface ContextSnapshotRow
  extends Record<string, unknown> {
  snapshot_id: UUID;
  conversation_id: UUID;
  message_id: UUID;
  source_revision: number;
  recipient_user_id: UUID;
  target_language_tag: string;
  target_profile_version: number;
  strategy: ContextStrategy;
  strategy_version: string;
  context_state_version: number | null;
  active_episode_id: UUID | null;
  selected_candidate_ids: unknown;
  selected_source_revision_refs: unknown;
  selected_claim_refs: unknown;
  processed_prefix_sequence: number;
  processing_gap_refs: unknown;
  erasure_epoch: number;
  policy_version: number;
  token_estimate: number;
  recovery_mode: ContextRecoveryMode;
  created_at: string;
}

export class PostgresContextSnapshotRepository {
  constructor(
    private readonly transactions: SqlTransactionManager,
  ) {}

  withTransaction<T>(
    work: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return this.transactions.withTransaction(work);
  }

  async insertContextSnapshot(
    tx: SqlExecutor,
    tenantId: UUID,
    snapshot: ContextSnapshot,
  ): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO context_snapshots(
         tenant_id,
         snapshot_id,
         conversation_id,
         message_id,
         source_revision,
         recipient_user_id,
         target_language_tag,
         target_profile_version,
         strategy,
         strategy_version,
         context_state_version,
         active_episode_id,
         selected_candidate_ids,
         selected_source_revision_refs,
         selected_claim_refs,
         processed_prefix_sequence,
         processing_gap_refs,
         erasure_epoch,
         policy_version,
         token_estimate,
         recovery_mode,
         created_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
         $13::jsonb,$14::jsonb,$15::jsonb,
         $16,$17::jsonb,$18,$19,$20,$21,$22
       )
       ON CONFLICT (tenant_id, snapshot_id)
       DO NOTHING`,
      [
        tenantId,
        snapshot.snapshotId,
        snapshot.conversationId,
        snapshot.messageId,
        snapshot.sourceRevision,
        snapshot.recipientUserId,
        snapshot.targetLanguageTag,
        snapshot.targetProfileVersion,
        snapshot.strategy,
        snapshot.strategyVersion,
        snapshot.contextStateVersion,
        snapshot.activeEpisodeId,
        JSON.stringify(
          snapshot.selectedCandidateIds,
        ),
        JSON.stringify(
          snapshot.selectedSourceRevisionRefs,
        ),
        JSON.stringify(snapshot.selectedClaimRefs),
        snapshot.processedPrefixOperationSequence,
        JSON.stringify(snapshot.processingGapOperationSequences),
        snapshot.erasureEpoch,
        snapshot.policyVersion,
        snapshot.tokenEstimate,
        snapshot.recoveryMode,
        snapshot.createdAt,
      ],
    );

    return result.rowCount === 1;
  }

  async getContextSnapshot(
    tx: SqlExecutor,
    tenantId: UUID,
    snapshotId: UUID,
  ): Promise<ContextSnapshot | undefined> {
    const result =
      await tx.query<ContextSnapshotRow>(
        `SELECT
           snapshot_id,
           conversation_id,
           message_id,
           source_revision,
           recipient_user_id,
           target_language_tag,
           target_profile_version,
           strategy,
           strategy_version,
           context_state_version,
           active_episode_id,
           selected_candidate_ids,
           selected_source_revision_refs,
           selected_claim_refs,
           processed_prefix_sequence,
           processing_gap_refs,
           erasure_epoch,
           policy_version,
           token_estimate,
           recovery_mode,
           created_at::text AS created_at
         FROM context_snapshots
        WHERE tenant_id = $1
          AND snapshot_id = $2`,
        [tenantId, snapshotId],
      );

    const row = result.rows[0];
    if (!row) return undefined;

    return {
      snapshotId: row.snapshot_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      sourceRevision: Number(row.source_revision),
      recipientUserId: row.recipient_user_id,
      targetLanguageTag: row.target_language_tag,
      targetProfileVersion: Number(row.target_profile_version),
      strategy: row.strategy,
      strategyVersion: row.strategy_version,
      contextStateVersion:
        row.context_state_version === null
          ? null
          : Number(row.context_state_version),
      activeEpisodeId: row.active_episode_id,
      selectedCandidateIds:
        parseStringArray(
          row.selected_candidate_ids,
          "selected_candidate_ids",
        ),
      selectedSourceRevisionRefs:
        parseStringArray(
          row.selected_source_revision_refs,
          "selected_source_revision_refs",
        ),
      selectedClaimRefs:
        parseStringArray(
          row.selected_claim_refs,
          "selected_claim_refs",
        ),
      processedPrefixOperationSequence: Number(
        row.processed_prefix_sequence,
      ),
      processingGapOperationSequences:
        parseNumberArray(
          row.processing_gap_refs,
          "processing_gap_refs",
        ),
      erasureEpoch: Number(row.erasure_epoch),
      policyVersion: Number(row.policy_version),
      tokenEstimate: Number(row.token_estimate),
      recoveryMode: row.recovery_mode,
      createdAt: row.created_at,
    };
  }
}


export interface PostgresContextPlanningFrame {
  currentMessageSequence: number;
  currentOperationSequence: number;
  currentMessageAcceptedAt: string;
  currentSourceAuthorUserId: UUID;
  currentSourceLanguageTag: string | null;
  erasureEpoch: number;
  policyVersion: number;
  recentMessages: Array<{
    messageId: UUID;
    sourceRevision: number;
    messageSequence: number;
    operationSequence: number;
    acceptedAt: string;
  }>;
}

export class PostgresContextPlanningRepository {
  constructor(
    private readonly transactions: SqlTransactionManager,
  ) {}

  withTransaction<T>(
    work: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return this.transactions.withTransaction(work);
  }

  async loadPlanningFrame(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      conversationId: UUID;
      sourceMessageId: UUID;
      sourceRevision: number;
      recipientUserId: UUID;
    },
    recentMessageLimit: number,
  ): Promise<PostgresContextPlanningFrame> {
    if (
      !Number.isInteger(recentMessageLimit) ||
      recentMessageLimit < 1
    ) {
      throw new TypeError(
        "recentMessageLimit must be a positive integer",
      );
    }

    const current = await tx.query<{
      message_seq: number;
      op_seq: number;
      accepted_at: string;
      author_user_id: UUID;
      declared_source_language: string | null;
      erasure_epoch: number;
      policy_version: number;
    }>(
      `SELECT mm.message_seq,
              mr.op_seq,
              mr.created_at::text AS accepted_at,
              mm.author_user_id,
              mr.declared_source_language,
              c.erasure_epoch
         FROM message_metadata mm
         JOIN message_revisions mr
           ON mr.tenant_id = mm.tenant_id
          AND mr.conversation_id = mm.conversation_id
          AND mr.message_id = mm.message_id
          AND mr.revision = $4
         JOIN conversations c
           ON c.tenant_id = mm.tenant_id
          AND c.conversation_id = mm.conversation_id
          AND c.status = 'ACTIVE'
         JOIN conversation_members cm
           ON cm.tenant_id = mm.tenant_id
          AND cm.conversation_id = mm.conversation_id
          AND cm.user_id = $5
          AND cm.status = 'ACTIVE'
         JOIN tenant_memberships tm
           ON tm.tenant_id = mm.tenant_id
          AND tm.user_id = $5
          AND tm.status = 'ACTIVE'
        WHERE mm.tenant_id = $1
          AND mm.conversation_id = $2
          AND mm.message_id = $3
          AND mm.current_revision = $4
          AND mm.status = 'ACTIVE'`,
      [
        input.tenantId,
        input.conversationId,
        input.sourceMessageId,
        input.sourceRevision,
        input.recipientUserId,
      ],
    );

    const currentRow = current.rows[0];
    if (!currentRow) {
      throw new Error(
        "Context planning source message is not current or recipient is not active",
      );
    }

    const recent = await tx.query<{
      message_id: UUID;
      current_revision: number;
      message_seq: number;
      op_seq: number;
      accepted_at: string;
    }>(
      `SELECT mm.message_id,
              mm.current_revision,
              mm.message_seq,
              mr.op_seq,
              mm.accepted_at::text AS accepted_at
         FROM message_metadata mm
         JOIN message_revisions mr
           ON mr.tenant_id = mm.tenant_id
          AND mr.conversation_id = mm.conversation_id
          AND mr.message_id = mm.message_id
          AND mr.revision = mm.current_revision
        WHERE mm.tenant_id = $1
          AND mm.conversation_id = $2
          AND mm.status = 'ACTIVE'
          AND mm.message_seq < $3
        ORDER BY mm.message_seq DESC
        LIMIT $4`,
      [
        input.tenantId,
        input.conversationId,
        Number(currentRow.message_seq),
        recentMessageLimit,
      ],
    );

    return {
      currentMessageSequence: Number(currentRow.message_seq),
      currentOperationSequence: Number(currentRow.op_seq),
      currentMessageAcceptedAt: currentRow.accepted_at,
      currentSourceAuthorUserId:
        currentRow.author_user_id,
      currentSourceLanguageTag:
        currentRow.declared_source_language,
      erasureEpoch: Number(currentRow.erasure_epoch),
      policyVersion: Number(currentRow.policy_version),
      recentMessages: recent.rows.map((row) => ({
        messageId: row.message_id,
        sourceRevision: Number(row.current_revision),
        messageSequence: Number(row.message_seq),
        operationSequence: Number(row.op_seq),
        acceptedAt: row.accepted_at,
      })),
    };
  }
}

function parseStringArray(
  value: unknown,
  field: string,
): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new Error(
      `Invalid context snapshot JSON field: ${field}`,
    );
  }
  return [...value];
}

function parseNumberArray(
  value: unknown,
  field: string,
): number[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== "number" ||
        !Number.isInteger(item),
    )
  ) {
    throw new Error(
      `Invalid context snapshot JSON field: ${field}`,
    );
  }
  return [...value];
}

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

interface ContextSnapshotRow {
  snapshot_id: UUID;
  conversation_id: UUID;
  message_id: UUID;
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
         token_estimate,
         recovery_mode,
         created_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,
         $9::jsonb,$10::jsonb,$11::jsonb,
         $12,$13::jsonb,$14,$15,$16,$17
       )
       ON CONFLICT (tenant_id, snapshot_id)
       DO NOTHING`,
      [
        tenantId,
        snapshot.snapshotId,
        snapshot.conversationId,
        snapshot.messageId,
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
        snapshot.processedPrefixSequence,
        JSON.stringify(snapshot.processingGapRefs),
        snapshot.erasureEpoch,
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
      processedPrefixSequence: Number(
        row.processed_prefix_sequence,
      ),
      processingGapRefs:
        parseNumberArray(
          row.processing_gap_refs,
          "processing_gap_refs",
        ),
      erasureEpoch: Number(row.erasure_epoch),
      tokenEstimate: Number(row.token_estimate),
      recoveryMode: row.recovery_mode,
      createdAt: row.created_at,
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

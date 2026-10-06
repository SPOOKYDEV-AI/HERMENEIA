import type {
  UUID,
} from "../../domain/src/index.js";
import type {
  ConversationContextState,
  ActiveEpisodeState,
} from "../../context-state/src/index.js";
import {
  buildSanitisedRecoverySeed,
  type RecoveryCheckpointV1,
  type SanitisedRecoveryPayloadV1,
} from "../../context-recovery/src/index.js";
import type {
  SqlExecutor,
  SqlTransactionManager,
} from "../../persistence/src/index.js";

export type RecoveryCheckpointCaptureResult =
  | "CAPTURED"
  | "SKIPPED"
  | "STALE"
  | "ALREADY_CAPTURED";

interface RecoveryCheckpointRow {
  tenant_id: UUID;
  conversation_id: UUID;
  checkpoint_version: number;
  schema_version: number;
  context_strategy_version: string;
  base_context_state_version: number;
  processed_prefix_sequence: number;
  processing_gap_manifest: unknown;
  membership_epoch: number;
  erasure_epoch: number;
  policy_version: number;
  tenant_policy_version: number;
  payload: unknown;
  status:
    | "ACTIVE"
    | "SUPERSEDED"
    | "INVALIDATED"
    | "CORRUPT";
  created_at: string;
  expires_at: string;
}

export class PostgresRecoveryCheckpointRepository {
  constructor(
    private readonly transactions:
      SqlTransactionManager,
  ) {}

  withTransaction<T>(
    work: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return this.transactions.withTransaction(work);
  }

  async capture(
    state: ConversationContextState,
    now: string,
    ttlSeconds = 86_400,
  ): Promise<RecoveryCheckpointCaptureResult> {
    const seed =
      buildSanitisedRecoverySeed(state);
    if (!seed) return "SKIPPED";

    if (!Number.isFinite(Date.parse(now))) {
      throw new TypeError(
        "Recovery checkpoint capture timestamp is invalid",
      );
    }
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 300 ||
      ttlSeconds > 2_592_000
    ) {
      throw new TypeError(
        "Recovery checkpoint ttlSeconds must be between 300 and 2592000",
      );
    }

    const expiresAt = new Date(
      Date.parse(now) + ttlSeconds * 1_000,
    ).toISOString();

    return this.withTransaction(async (tx) => {
      const authority = await tx.query<{
        membership_epoch: number;
        erasure_epoch: number;
        policy_version: number;
        tenant_policy_version: number;
      }>(
        `SELECT c.membership_epoch,
                c.erasure_epoch,
                c.policy_version,
                t.policy_version AS tenant_policy_version
           FROM conversations c
           JOIN tenants t
             ON t.tenant_id = c.tenant_id
            AND t.status = 'ACTIVE'
          WHERE c.tenant_id = $1
            AND c.conversation_id = $2
            AND c.status = 'ACTIVE'
          FOR SHARE OF c, t`,
        [
          state.tenantId,
          state.conversationId,
        ],
      );
      const current = authority.rows[0];
      if (
        !current ||
        Number(current.membership_epoch) !==
          seed.membershipEpoch ||
        Number(current.erasure_epoch) !==
          seed.erasureEpoch ||
        Number(current.policy_version) !==
          seed.policyVersion
      ) {
        return "STALE";
      }

      const exact = await tx.query<{
        status: string;
      }>(
        `SELECT status
           FROM recovery_checkpoints
          WHERE tenant_id = $1
            AND conversation_id = $2
            AND checkpoint_version = $3
          FOR UPDATE`,
        [
          state.tenantId,
          state.conversationId,
          seed.baseContextStateVersion,
        ],
      );
      if (exact.rowCount > 0) {
        return "ALREADY_CAPTURED";
      }

      const active = await tx.query<{
        checkpoint_version: number;
      }>(
        `SELECT checkpoint_version
           FROM recovery_checkpoints
          WHERE tenant_id = $1
            AND conversation_id = $2
            AND status = 'ACTIVE'
          FOR UPDATE`,
        [
          state.tenantId,
          state.conversationId,
        ],
      );
      const activeVersion = active.rows[0]
        ? Number(
            active.rows[0].checkpoint_version,
          )
        : null;
      if (
        activeVersion !== null &&
        activeVersion >=
          seed.baseContextStateVersion
      ) {
        return "STALE";
      }

      if (activeVersion !== null) {
        await tx.query(
          `UPDATE recovery_checkpoints
              SET status = 'SUPERSEDED'
            WHERE tenant_id = $1
              AND conversation_id = $2
              AND status = 'ACTIVE'`,
          [
            state.tenantId,
            state.conversationId,
          ],
        );
      }

      const inserted = await tx.query(
        `INSERT INTO recovery_checkpoints(
           tenant_id,
           conversation_id,
           checkpoint_version,
           schema_version,
           context_strategy_version,
           base_context_state_version,
           processed_prefix_sequence,
           processing_gap_manifest,
           membership_epoch,
           erasure_epoch,
           policy_version,
           tenant_policy_version,
           payload,
           status,
           created_at,
           expires_at
         ) VALUES (
           $1,$2,$3,1,$4,$3,$5,'[]'::jsonb,
           $6,$7,$8,$9,$10::jsonb,'ACTIVE',$11,$12
         )`,
        [
          state.tenantId,
          state.conversationId,
          seed.baseContextStateVersion,
          seed.contextStrategyVersion,
          seed.processedPrefixOpSeq,
          seed.membershipEpoch,
          seed.erasureEpoch,
          seed.policyVersion,
          Number(
            current.tenant_policy_version,
          ),
          JSON.stringify(
            encodePayload(seed.payload),
          ),
          now,
          expiresAt,
        ],
      );
      if (inserted.rowCount !== 1) {
        throw new Error(
          "Recovery checkpoint was not inserted",
        );
      }

      await tx.query(
        `DELETE FROM recovery_checkpoints rc
          WHERE rc.tenant_id = $1
            AND rc.conversation_id = $2
            AND rc.status = 'SUPERSEDED'
            AND rc.checkpoint_version NOT IN (
              SELECT keep.checkpoint_version
                FROM recovery_checkpoints keep
               WHERE keep.tenant_id = $1
                 AND keep.conversation_id = $2
                 AND keep.status = 'SUPERSEDED'
               ORDER BY keep.checkpoint_version DESC
               LIMIT 1
            )`,
        [
          state.tenantId,
          state.conversationId,
        ],
      );

      return "CAPTURED";
    });
  }

  async loadValidForRestore(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      conversationId: UUID;
      requiredProcessedPrefixOpSeq: number;
      strategyVersion: string;
      now: string;
    },
  ): Promise<RecoveryCheckpointV1 | undefined> {
    if (
      !Number.isInteger(
        input.requiredProcessedPrefixOpSeq,
      ) ||
      input.requiredProcessedPrefixOpSeq < 0 ||
      !input.strategyVersion ||
      !Number.isFinite(Date.parse(input.now))
    ) {
      throw new TypeError(
        "Invalid recovery checkpoint restore query",
      );
    }

    const result =
      await tx.query<RecoveryCheckpointRow>(
        `SELECT rc.tenant_id,
                rc.conversation_id,
                rc.checkpoint_version,
                rc.schema_version,
                rc.context_strategy_version,
                rc.base_context_state_version,
                rc.processed_prefix_sequence,
                rc.processing_gap_manifest,
                rc.membership_epoch,
                rc.erasure_epoch,
                rc.policy_version,
                rc.tenant_policy_version,
                rc.payload,
                rc.status,
                rc.created_at::text AS created_at,
                rc.expires_at::text AS expires_at
           FROM recovery_checkpoints rc
           JOIN conversations c
             ON c.tenant_id = rc.tenant_id
            AND c.conversation_id =
                rc.conversation_id
            AND c.status = 'ACTIVE'
           JOIN tenants t
             ON t.tenant_id = rc.tenant_id
            AND t.status = 'ACTIVE'
          WHERE rc.tenant_id = $1
            AND rc.conversation_id = $2
            AND rc.status = 'ACTIVE'
            AND rc.schema_version = 1
            AND rc.context_strategy_version = $3
            AND rc.processed_prefix_sequence = $4
            AND rc.processing_gap_manifest = '[]'::jsonb
            AND rc.expires_at > $5
            AND rc.membership_epoch =
                c.membership_epoch
            AND rc.erasure_epoch =
                c.erasure_epoch
            AND rc.policy_version =
                c.policy_version
            AND rc.tenant_policy_version =
                t.policy_version
          ORDER BY rc.checkpoint_version DESC
          LIMIT 1`,
        [
          input.tenantId,
          input.conversationId,
          input.strategyVersion,
          input.requiredProcessedPrefixOpSeq,
          input.now,
        ],
      );

    const row = result.rows[0];
    return row
      ? mapCheckpointRow(row)
      : undefined;
  }
}

function encodePayload(
  payload: SanitisedRecoveryPayloadV1,
): Record<string, unknown> {
  return {
    schema_version: 1,
    ...(payload.activeEpisode
      ? {
          active_episode:
            encodeEpisode(
              payload.activeEpisode,
            ),
        }
      : {}),
    terminology_claim_refs: [
      ...payload.terminologyClaimRefs,
    ],
    lexical_claim_refs: [
      ...payload.lexicalClaimRefs,
    ],
    correction_claim_refs: [
      ...payload.correctionClaimRefs,
    ],
  };
}

function encodeEpisode(
  episode: ActiveEpisodeState,
): Record<string, unknown> {
  return {
    episode_id: episode.episodeId,
    episode_version: episode.episodeVersion,
    continuity_confidence:
      episode.continuityConfidence,
    ...(episode.startOperationSequence !==
    undefined
      ? {
          start_operation_sequence:
            episode.startOperationSequence,
        }
      : {}),
    ...(episode.lastOperationSequence !==
    undefined
      ? {
          last_operation_sequence:
            episode.lastOperationSequence,
        }
      : {}),
    ...(episode.startedAt
      ? { started_at: episode.startedAt }
      : {}),
    ...(episode.lastActivityAt
      ? {
          last_activity_at:
            episode.lastActivityAt,
        }
      : {}),
  };
}

function mapCheckpointRow(
  row: RecoveryCheckpointRow,
): RecoveryCheckpointV1 {
  const payload = decodePayload(row.payload);
  if (
    !Array.isArray(row.processing_gap_manifest) ||
    row.processing_gap_manifest.length !== 0
  ) {
    throw new Error(
      "Recovery checkpoint gap manifest is not clean",
    );
  }

  return {
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    checkpointVersion:
      Number(row.checkpoint_version),
    schemaVersion: 1,
    contextStrategyVersion:
      row.context_strategy_version,
    baseContextStateVersion:
      Number(
        row.base_context_state_version,
      ),
    processedPrefixOpSeq:
      Number(row.processed_prefix_sequence),
    membershipEpoch:
      Number(row.membership_epoch),
    erasureEpoch:
      Number(row.erasure_epoch),
    policyVersion:
      Number(row.policy_version),
    tenantPolicyVersion:
      Number(row.tenant_policy_version),
    payload,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function decodePayload(
  value: unknown,
): SanitisedRecoveryPayloadV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "Recovery checkpoint payload is malformed",
    );
  }
  const row = value as Record<string, unknown>;
  if (row.schema_version !== 1) {
    throw new Error(
      "Unsupported recovery checkpoint payload schema",
    );
  }

  const terminologyClaimRefs =
    decodeRefs(
      row.terminology_claim_refs,
      "terminology_claim_refs",
    );
  const lexicalClaimRefs =
    decodeRefs(
      row.lexical_claim_refs,
      "lexical_claim_refs",
    );
  const correctionClaimRefs =
    decodeRefs(
      row.correction_claim_refs,
      "correction_claim_refs",
    );

  const activeEpisode =
    row.active_episode === undefined
      ? undefined
      : decodeEpisode(row.active_episode);

  return {
    schemaVersion: 1,
    ...(activeEpisode
      ? { activeEpisode }
      : {}),
    terminologyClaimRefs,
    lexicalClaimRefs,
    correctionClaimRefs,
  };
}

function decodeRefs(
  value: unknown,
  field: string,
): UUID[] {
  if (
    !Array.isArray(value) ||
    value.length > 128 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length < 1 ||
        item.length > 128,
    )
  ) {
    throw new Error(
      `Recovery checkpoint ${field} is malformed`,
    );
  }
  return [...new Set(value as string[])];
}

function decodeEpisode(
  value: unknown,
): ActiveEpisodeState {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "Recovery checkpoint active_episode is malformed",
    );
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.episode_id !== "string" ||
    !Number.isInteger(row.episode_version) ||
    Number(row.episode_version) < 1 ||
    typeof row.continuity_confidence !==
      "number"
  ) {
    throw new Error(
      "Recovery checkpoint active_episode is malformed",
    );
  }

  return {
    episodeId: row.episode_id,
    episodeVersion:
      Number(row.episode_version),
    continuityConfidence:
      row.continuity_confidence,
    ...(row.start_operation_sequence !==
    undefined
      ? {
          startOperationSequence:
            Number(
              row.start_operation_sequence,
            ),
        }
      : {}),
    ...(row.last_operation_sequence !==
    undefined
      ? {
          lastOperationSequence:
            Number(
              row.last_operation_sequence,
            ),
        }
      : {}),
    ...(typeof row.started_at === "string"
      ? { startedAt: row.started_at }
      : {}),
    ...(typeof row.last_activity_at ===
    "string"
      ? {
          lastActivityAt:
            row.last_activity_at,
        }
      : {}),
  };
}

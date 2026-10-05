import type { UUID } from "../../domain/src/index.js";
import type {
  ConversationContextState as EngineConversationContextState,
} from "../../context-engine/src/index.js";
import {
  cloneValidatedContextState,
  processingGapRefs,
  type ConversationContextState,
} from "../../context-state/src/index.js";
import type {
  SqlExecutor,
  SqlTransactionManager,
} from "../../persistence/src/index.js";

interface ContextStateRow extends Record<string, unknown> {
  tenant_id: UUID;
  conversation_id: UUID;
  state_version: number;
  causal_floor_sequence: number;
  processed_prefix_sequence: number;
  pending_operations: unknown;
  active_episode_state: unknown;
  terminology_claim_refs: unknown;
  lexical_claim_refs: unknown;
  correction_claim_refs: unknown;
  style_claim_refs: unknown;
  entity_handles: unknown;
  unresolved_reference_handles: unknown;
  style_state: unknown;
  pragmatic_state: unknown;
  membership_epoch: number;
  erasure_epoch: number;
  policy_version: number;
  strategy_version: string;
  state_schema_version: number;
  recovery_mode: "FULL" | "DEGRADED_BASELINE";
  status: "ACTIVE" | "DEGRADED";
  updated_at: string;
}

export class PostgresConversationContextStateRepository {
  constructor(
    private readonly transactions: SqlTransactionManager,
  ) {}

  withTransaction<T>(
    work: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    return this.transactions.withTransaction(work);
  }

  async loadState(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      conversationId: UUID;
      forUpdate?: boolean;
    },
  ): Promise<ConversationContextState | undefined> {
    const lock = input.forUpdate ? " FOR UPDATE" : "";
    const result = await tx.query<ContextStateRow>(
      `SELECT tenant_id,
              conversation_id,
              state_version,
              causal_floor_sequence,
              processed_prefix_sequence,
              pending_operations,
              active_episode_state,
              terminology_claim_refs,
              lexical_claim_refs,
              correction_claim_refs,
              entity_handles,
              unresolved_reference_handles,
              style_state,
              pragmatic_state,
              membership_epoch,
              erasure_epoch,
              policy_version,
              strategy_version,
              state_schema_version,
              recovery_mode,
              status,
              updated_at::text AS updated_at
         FROM conversation_context_states
        WHERE tenant_id = $1
          AND conversation_id = $2${lock}`,
      [input.tenantId, input.conversationId],
    );

    const row = result.rows[0];
    return row ? stateFromRow(row) : undefined;
  }

  async insertState(
    tx: SqlExecutor,
    state: ConversationContextState,
  ): Promise<boolean> {
    const value = cloneValidatedContextState(state);
    const result = await tx.query(
      `INSERT INTO conversation_context_states(
         tenant_id,
         conversation_id,
         state_version,
         causal_floor_sequence,
         processed_prefix_sequence,
         pending_operations,
         active_episode_state,
         terminology_claim_refs,
         lexical_claim_refs,
         correction_claim_refs,
         style_claim_refs,
         entity_handles,
         unresolved_reference_handles,
         style_state,
         pragmatic_state,
         membership_epoch,
         erasure_epoch,
         policy_version,
         strategy_version,
         state_schema_version,
         recovery_mode,
         status,
         updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,
         $6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
         $11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,
         $16,$17,$18,$19,$20,$21,$22,$23
       )
       ON CONFLICT (tenant_id, conversation_id)
       DO NOTHING`,
      stateParams(value),
    );
    return result.rowCount === 1;
  }

  async updateState(
    tx: SqlExecutor,
    input: {
      expectedStateVersion: number;
      state: ConversationContextState;
    },
  ): Promise<boolean> {
    const value = cloneValidatedContextState(input.state);
    if (
      !Number.isInteger(input.expectedStateVersion) ||
      input.expectedStateVersion < 1 ||
      value.stateVersion <= input.expectedStateVersion
    ) {
      throw new TypeError(
        "ContextState update requires a newer stateVersion",
      );
    }

    const params = stateParams(value);
    const result = await tx.query(
      `UPDATE conversation_context_states
          SET state_version = $3,
              causal_floor_sequence = $4,
              processed_prefix_sequence = $5,
              pending_operations = $6::jsonb,
              active_episode_state = $7::jsonb,
              terminology_claim_refs = $8::jsonb,
              lexical_claim_refs = $9::jsonb,
              correction_claim_refs = $10::jsonb,
              entity_handles = $11::jsonb,
              unresolved_reference_handles = $12::jsonb,
              style_state = $13::jsonb,
              pragmatic_state = $14::jsonb,
              membership_epoch = $15,
              erasure_epoch = $16,
              policy_version = $17,
              strategy_version = $18,
              state_schema_version = $19,
              recovery_mode = $20,
              status = $21,
              updated_at = $22
        WHERE tenant_id = $1
          AND conversation_id = $2
          AND state_version = $23`,
      [...params, input.expectedStateVersion],
    );
    return result.rowCount === 1;
  }

  async loadEngineState(
    tx: SqlExecutor,
    input: {
      tenantId: UUID;
      conversationId: UUID;
    },
  ): Promise<EngineConversationContextState | null> {
    const state = await this.loadState(tx, input);
    return state ? toEngineContextState(state) : null;
  }
}

export function toEngineContextState(
  state: ConversationContextState,
): EngineConversationContextState {
  const value = cloneValidatedContextState(state);
  return {
    conversationId: value.conversationId,
    contextVersion: value.stateVersion,
    processedPrefixOperationSequence:
      value.processedPrefixOpSeq,
    processingGapOperationSequences:
      processingGapRefs(value).map((operation) => operation.opSeq),
    erasureEpoch: value.erasureEpoch,
    policyVersion: value.policyVersion,
    activeEpisodeId: value.activeEpisode?.episodeId ?? null,
    activeEpisodeVersion:
      value.activeEpisode?.episodeVersion ?? null,
    terminologyClaimRefs: [...value.terminologyClaimRefs],
    lexicalClaimRefs: [...value.lexicalClaimRefs],
    correctionClaimRefs: [...value.correctionClaimRefs],
    styleClaimRefs: [...value.styleClaimRefs],
    updatedAt: value.updatedAt,
  };
}

function stateFromRow(
  row: ContextStateRow,
): ConversationContextState {
  const activeEpisodeState =
    requireObject(row.active_episode_state, "active_episode_state");
  const state: ConversationContextState = {
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    stateVersion: Number(row.state_version),
    causalFloorOpSeq: Number(row.causal_floor_sequence),
    processedPrefixOpSeq: Number(row.processed_prefix_sequence),
    pendingOperations: requireArray(
      row.pending_operations,
      "pending_operations",
    ) as ConversationContextState["pendingOperations"],
    membershipEpoch: Number(row.membership_epoch),
    erasureEpoch: Number(row.erasure_epoch),
    policyVersion: Number(row.policy_version),
    strategyVersion: row.strategy_version,
    stateSchemaVersion:
      Number(row.state_schema_version) as 1,
    recoveryMode: row.recovery_mode,
    status: row.status,
    ...(Object.keys(activeEpisodeState).length > 0
      ? {
          activeEpisode:
            activeEpisodeState as unknown as NonNullable<
              ConversationContextState["activeEpisode"]
            >,
        }
      : {}),
    terminologyClaimRefs: requireStringArray(
      row.terminology_claim_refs,
      "terminology_claim_refs",
    ),
    lexicalClaimRefs: requireStringArray(
      row.lexical_claim_refs,
      "lexical_claim_refs",
    ),
    correctionClaimRefs: requireStringArray(
      row.correction_claim_refs,
      "correction_claim_refs",
    ),
    styleClaimRefs: requireStringArray(
      row.style_claim_refs,
      "style_claim_refs",
    ),
    entityHandles: requireStringArray(
      row.entity_handles,
      "entity_handles",
    ),
    unresolvedReferenceHandles: requireStringArray(
      row.unresolved_reference_handles,
      "unresolved_reference_handles",
    ),
    styleState:
      requireObject(
        row.style_state,
        "style_state",
      ) as ConversationContextState["styleState"],
    pragmaticState:
      requireObject(
        row.pragmatic_state,
        "pragmatic_state",
      ) as ConversationContextState["pragmaticState"],
    updatedAt: row.updated_at,
  };

  return cloneValidatedContextState(state);
}

function stateParams(
  state: ConversationContextState,
): Array<string | number> {
  return [
    state.tenantId,
    state.conversationId,
    state.stateVersion,
    state.causalFloorOpSeq,
    state.processedPrefixOpSeq,
    JSON.stringify(state.pendingOperations),
    JSON.stringify(state.activeEpisode ?? {}),
    JSON.stringify(state.terminologyClaimRefs),
    JSON.stringify(state.lexicalClaimRefs),
    JSON.stringify(state.correctionClaimRefs),
    JSON.stringify(state.styleClaimRefs),
    JSON.stringify(state.entityHandles),
    JSON.stringify(state.unresolvedReferenceHandles),
    JSON.stringify(state.styleState),
    JSON.stringify(state.pragmaticState),
    state.membershipEpoch,
    state.erasureEpoch,
    state.policyVersion,
    state.strategyVersion,
    state.stateSchemaVersion,
    state.recoveryMode,
    state.status,
    state.updatedAt,
  ];
}

function requireArray(
  value: unknown,
  field: string,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid ConversationState JSON field: ${field}`,
    );
  }
  return value;
}

function requireStringArray(
  value: unknown,
  field: string,
): string[] {
  const values = requireArray(value, field);
  if (values.some((item) => typeof item !== "string")) {
    throw new Error(
      `Invalid ConversationState string-array field: ${field}`,
    );
  }
  return [...values] as string[];
}

function requireObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      `Invalid ConversationState object field: ${field}`,
    );
  }
  return value as Record<string, unknown>;
}

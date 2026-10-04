BEGIN;

CREATE TABLE context_snapshots (
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  strategy text NOT NULL CHECK (
    strategy IN ('T0','T1','T2_ADAPTIVE_V1')
  ),
  strategy_version text NOT NULL CHECK (
    length(trim(strategy_version)) > 0
  ),
  context_state_version bigint CHECK (
    context_state_version IS NULL OR context_state_version >= 1
  ),
  active_episode_id uuid,
  selected_candidate_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(selected_candidate_ids) = 'array'
  ),
  selected_source_revision_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(selected_source_revision_refs) = 'array'
  ),
  selected_claim_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(selected_claim_refs) = 'array'
  ),
  processed_prefix_sequence bigint NOT NULL CHECK (
    processed_prefix_sequence >= 0
  ),
  processing_gap_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(processing_gap_refs) = 'array'
  ),
  erasure_epoch bigint NOT NULL CHECK (erasure_epoch >= 0),
  token_estimate integer NOT NULL CHECK (token_estimate >= 0),
  recovery_mode text NOT NULL CHECK (
    recovery_mode IN ('FAST','PARTIAL','DEGRADED')
  ),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, snapshot_id),
  FOREIGN KEY (tenant_id, conversation_id, message_id)
    REFERENCES message_metadata(tenant_id, conversation_id, message_id)
);

CREATE INDEX context_snapshots_message_idx
  ON context_snapshots(
    tenant_id,
    message_id,
    created_at DESC
  );

CREATE INDEX context_snapshots_conversation_idx
  ON context_snapshots(
    tenant_id,
    conversation_id,
    created_at DESC
  );

ALTER TABLE translation_executions
  ADD CONSTRAINT translation_executions_context_snapshot_fk
  FOREIGN KEY (tenant_id, context_snapshot_id)
  REFERENCES context_snapshots(tenant_id, snapshot_id);

COMMIT;

BEGIN;

CREATE TABLE recovery_checkpoints (
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  checkpoint_version bigint NOT NULL
    CHECK (checkpoint_version >= 1),
  schema_version integer NOT NULL
    CHECK (schema_version = 1),
  context_strategy_version text NOT NULL
    CHECK (length(context_strategy_version) BETWEEN 1 AND 128),
  base_context_state_version bigint NOT NULL
    CHECK (base_context_state_version >= 1),
  processed_prefix_sequence bigint NOT NULL
    CHECK (processed_prefix_sequence >= 0),
  processing_gap_manifest jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(processing_gap_manifest) = 'array')
    CHECK (octet_length(processing_gap_manifest::text) <= 16384),
  membership_epoch bigint NOT NULL
    CHECK (membership_epoch >= 0),
  erasure_epoch bigint NOT NULL
    CHECK (erasure_epoch >= 0),
  policy_version bigint NOT NULL
    CHECK (policy_version >= 1),
  tenant_policy_version bigint NOT NULL
    CHECK (tenant_policy_version >= 1),
  payload jsonb NOT NULL
    CHECK (jsonb_typeof(payload) = 'object')
    CHECK (octet_length(payload::text) <= 32768),
  status text NOT NULL
    CHECK (
      status IN (
        'ACTIVE',
        'SUPERSEDED',
        'INVALIDATED',
        'CORRUPT'
      )
    ),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_id,
    conversation_id,
    checkpoint_version
  ),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, conversation_id),
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX recovery_checkpoints_one_active_per_conversation
  ON recovery_checkpoints(tenant_id, conversation_id)
  WHERE status = 'ACTIVE';

CREATE INDEX recovery_checkpoints_restore_lookup
  ON recovery_checkpoints(
    tenant_id,
    conversation_id,
    status,
    processed_prefix_sequence DESC,
    checkpoint_version DESC
  );

COMMIT;

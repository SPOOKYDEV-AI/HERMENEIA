\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users(user_id, status)
VALUES
  ('b1000000-0000-0000-0000-000000000001','ACTIVE'),
  ('b1000000-0000-0000-0000-000000000002','ACTIVE');

INSERT INTO tenants(tenant_id, kind, status, home_region)
VALUES (
  'b2000000-0000-0000-0000-000000000001',
  'ORGANISATION',
  'ACTIVE',
  'eu-test'
);

INSERT INTO tenant_memberships(tenant_id, user_id, role, status)
VALUES
  (
    'b2000000-0000-0000-0000-000000000001',
    'b1000000-0000-0000-0000-000000000001',
    'OWNER',
    'ACTIVE'
  ),
  (
    'b2000000-0000-0000-0000-000000000001',
    'b1000000-0000-0000-0000-000000000002',
    'MEMBER',
    'ACTIVE'
  );

INSERT INTO devices(
  device_id,
  user_id,
  status,
  credential_version,
  public_material_ref,
  platform
)
VALUES (
  'b3000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'ACTIVE',
  1,
  'test:context-author-device',
  'OTHER'
);

INSERT INTO conversations(
  tenant_id,
  conversation_id,
  kind,
  status,
  home_region
)
VALUES (
  'b2000000-0000-0000-0000-000000000001',
  'b4000000-0000-0000-0000-000000000001',
  'DIRECT',
  'ACTIVE',
  'eu-test'
);

INSERT INTO conversation_members(
  tenant_id,
  conversation_id,
  user_id,
  role,
  status
)
VALUES
  (
    'b2000000-0000-0000-0000-000000000001',
    'b4000000-0000-0000-0000-000000000001',
    'b1000000-0000-0000-0000-000000000001',
    'MEMBER',
    'ACTIVE'
  ),
  (
    'b2000000-0000-0000-0000-000000000001',
    'b4000000-0000-0000-0000-000000000001',
    'b1000000-0000-0000-0000-000000000002',
    'MEMBER',
    'ACTIVE'
  );

INSERT INTO message_metadata(
  tenant_id,
  message_id,
  conversation_id,
  author_user_id,
  author_device_id,
  client_message_id,
  message_seq,
  current_revision,
  status
)
VALUES (
  'b2000000-0000-0000-0000-000000000001',
  'b5000000-0000-0000-0000-000000000001',
  'b4000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'b3000000-0000-0000-0000-000000000001',
  'b6000000-0000-0000-0000-000000000001',
  1,
  1,
  'ACTIVE'
);

INSERT INTO message_revisions(
  tenant_id,
  conversation_id,
  message_id,
  revision,
  op_seq,
  mutation_type,
  actor_user_id,
  source_hash
)
VALUES (
  'b2000000-0000-0000-0000-000000000001',
  'b4000000-0000-0000-0000-000000000001',
  'b5000000-0000-0000-0000-000000000001',
  1,
  1,
  'CREATED',
  'b1000000-0000-0000-0000-000000000001',
  'hmac-sha256:test:context-source'
);

INSERT INTO context_snapshots(
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
  token_estimate,
  recovery_mode,
  created_at
)
VALUES (
  'b2000000-0000-0000-0000-000000000001',
  'b7000000-0000-0000-0000-000000000001',
  'b4000000-0000-0000-0000-000000000001',
  'b5000000-0000-0000-0000-000000000001',
  1,
  'b1000000-0000-0000-0000-000000000002',
  'es-CO',
  3,
  'T2_ADAPTIVE_V1',
  'adaptive-context-v1',
  4,
  NULL,
  '["candidate-1"]'::jsonb,
  '["message-previous:1"]'::jsonb,
  '["correction:1"]'::jsonb,
  0,
  '[]'::jsonb,
  0,
  18,
  'FAST',
  now()
);

-- Exact translation identity may reference the snapshot.
INSERT INTO translation_executions(
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
  status
)
VALUES (
  'b2000000-0000-0000-0000-000000000001',
  'b8000000-0000-0000-0000-000000000001',
  'b4000000-0000-0000-0000-000000000001',
  'b5000000-0000-0000-0000-000000000001',
  1,
  'b1000000-0000-0000-0000-000000000002',
  'es-CO',
  3,
  'b7000000-0000-0000-0000-000000000001',
  'adaptive-context-v1',
  'PENDING'
);

DO $$
BEGIN
  BEGIN
    -- Same snapshot, different target profile: must be rejected by the
    -- composite ContextSnapshot foreign key.
    INSERT INTO translation_executions(
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
      status
    )
    VALUES (
      'b2000000-0000-0000-0000-000000000001',
      'b8000000-0000-0000-0000-000000000002',
      'b4000000-0000-0000-0000-000000000001',
      'b5000000-0000-0000-0000-000000000001',
      1,
      'b1000000-0000-0000-0000-000000000002',
      'es-CO',
      4,
      'b7000000-0000-0000-0000-000000000001',
      'adaptive-context-v1',
      'PENDING'
    );
    RAISE EXCEPTION
      'expected mismatched target profile ContextSnapshot FK to fail';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;
END $$;

ROLLBACK;

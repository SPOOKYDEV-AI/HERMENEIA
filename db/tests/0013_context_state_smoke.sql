\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users(user_id, status)
VALUES ('00000000-0000-0000-0000-000000000011','ACTIVE');

INSERT INTO tenants(tenant_id, kind, status, home_region)
VALUES (
  '10000000-0000-0000-0000-000000000011',
  'ORGANISATION',
  'ACTIVE',
  'eu-test'
);

INSERT INTO tenant_memberships(tenant_id, user_id, role, status)
VALUES (
  '10000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000011',
  'OWNER',
  'ACTIVE'
);

INSERT INTO conversations(
  tenant_id, conversation_id, kind, status, home_region,
  membership_epoch, erasure_epoch, policy_version,
  next_message_seq, next_op_seq
)
VALUES (
  '10000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  'DIRECT',
  'ACTIVE',
  'eu-test',
  1,
  1,
  1,
  1,
  1
);

INSERT INTO conversation_members(
  tenant_id, conversation_id, user_id, role, status
)
VALUES (
  '10000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000011',
  'MEMBER',
  'ACTIVE'
);

INSERT INTO conversation_context_states(
  tenant_id,
  conversation_id,
  state_version,
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
  claim_set_version,
  glossary_set_version,
  correction_set_version,
  membership_epoch,
  erasure_epoch,
  policy_version,
  strategy_version,
  state_schema_version,
  status,
  updated_at
)
VALUES (
  '10000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  1,
  0,
  '[]'::jsonb,
  '{}'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '["entity:project-alpha"]'::jsonb,
  '[]'::jsonb,
  '{"formality":"MEDIUM","confidence":0.8}'::jsonb,
  '{"stance":"NEUTRAL","confidence":0.8}'::jsonb,
  0,
  0,
  0,
  1,
  1,
  1,
  'context-v1',
  1,
  'ACTIVE',
  now()
);

DO $$
BEGIN
  BEGIN
    UPDATE conversation_context_states
       SET style_state =
         '{"raw_text":"verbatim conversation content"}'::jsonb
     WHERE tenant_id = '10000000-0000-0000-0000-000000000011'
       AND conversation_id = '30000000-0000-0000-0000-000000000011';

    RAISE EXCEPTION 'expected hidden raw_text in context state to fail';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END $$;

INSERT INTO translation_repair_events(
  tenant_id,
  repair_event_id,
  conversation_id,
  actor_user_id,
  kind,
  status,
  structured_payload,
  command_id,
  created_at
)
VALUES (
  '10000000-0000-0000-0000-000000000011',
  '81000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000011',
  'TERMINOLOGY_CORRECTION',
  'APPLIED',
  '{"concept_type":"TERMINOLOGY","surface_form":"CR"}'::jsonb,
  '82000000-0000-0000-0000-000000000011',
  now()
);

DO $$
BEGIN
  BEGIN
    INSERT INTO context_claims(
      tenant_id,
      claim_id,
      claim_version,
      conversation_id,
      claim_type,
      proposition_ref,
      modality,
      authority_class,
      retention_class,
      sensitivity_class,
      confidence,
      scope_kind,
      scope_conversation_id,
      trigger_kind,
      status,
      created_at
    )
    VALUES (
      '10000000-0000-0000-0000-000000000011',
      '83000000-0000-0000-0000-000000000099',
      1,
      '30000000-0000-0000-0000-000000000011',
      'TERMINOLOGY',
      '{"surface_form":"CR","corrected_meaning":"change request"}'::jsonb,
      'CORRECTION',
      'CONFIRMED_CORRECTION',
      'CORRECTIVE_DURABLE',
      'NORMAL',
      1,
      'CONVERSATION',
      '30000000-0000-0000-0000-000000000011',
      NULL,
      'ACTIVE',
      now()
    );

    RAISE EXCEPTION 'expected corrective memory without authorised trigger to fail';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO context_claims(
      tenant_id,
      claim_id,
      claim_version,
      conversation_id,
      claim_type,
      proposition_ref,
      modality,
      authority_class,
      retention_class,
      sensitivity_class,
      confidence,
      scope_kind,
      scope_conversation_id,
      status,
      created_at
    )
    VALUES (
      '10000000-0000-0000-0000-000000000011',
      '83000000-0000-0000-0000-000000000098',
      1,
      NULL,
      'TERMINOLOGY',
      '{"surface_form":"CR","corrected_meaning":"change request"}'::jsonb,
      'ASSERTION',
      'INFERRED',
      'EPHEMERAL',
      'NORMAL',
      0.5,
      'CONVERSATION',
      '30000000-0000-0000-0000-000000000011',
      'ACTIVE',
      now()
    );

    RAISE EXCEPTION 'expected conversation-scoped claim without conversation_id to fail';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END $$;

INSERT INTO users(user_id, status)
VALUES ('00000000-0000-0000-0000-000000000099','ACTIVE');

DO $$
BEGIN
  BEGIN
    INSERT INTO context_claims(
      tenant_id,
      claim_id,
      claim_version,
      conversation_id,
      subject_user_id,
      claim_type,
      proposition_ref,
      modality,
      authority_class,
      retention_class,
      sensitivity_class,
      confidence,
      scope_kind,
      scope_conversation_id,
      status,
      created_at
    )
    VALUES (
      '10000000-0000-0000-0000-000000000011',
      '83000000-0000-0000-0000-000000000097',
      1,
      '30000000-0000-0000-0000-000000000011',
      '00000000-0000-0000-0000-000000000099',
      'PREFERENCE',
      '{"preference_ref":"pref:1"}'::jsonb,
      'ASSERTION',
      'EXPLICIT_PREFERENCE',
      'EPHEMERAL',
      'NORMAL',
      1,
      'CONVERSATION',
      '30000000-0000-0000-0000-000000000011',
      'ACTIVE',
      now()
    );

    RAISE EXCEPTION 'expected subject_user_id outside tenant to fail';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;
END $$;

INSERT INTO context_claims(
  tenant_id,
  claim_id,
  claim_version,
  conversation_id,
  claim_type,
  proposition_ref,
  modality,
  authority_class,
  retention_class,
  sensitivity_class,
  confidence,
  scope_kind,
  scope_conversation_id,
  trigger_kind,
  status,
  created_at
)
VALUES (
  '10000000-0000-0000-0000-000000000011',
  '83000000-0000-0000-0000-000000000011',
  1,
  '30000000-0000-0000-0000-000000000011',
  'TERMINOLOGY',
  '{"surface_form":"CR","corrected_meaning":"change request"}'::jsonb,
  'CORRECTION',
  'CONFIRMED_CORRECTION',
  'CORRECTIVE_DURABLE',
  'NORMAL',
  1,
  'CONVERSATION',
  '30000000-0000-0000-0000-000000000011',
  'EXPLICIT_TEXTUAL_CORRECTION',
  'ACTIVE',
  now()
);

INSERT INTO provenance_edges(
  tenant_id,
  provenance_edge_id,
  derived_claim_id,
  derived_claim_version,
  relation,
  source_repair_event_id,
  strategy_version,
  created_at
)
VALUES (
  '10000000-0000-0000-0000-000000000011',
  '84000000-0000-0000-0000-000000000011',
  '83000000-0000-0000-0000-000000000011',
  1,
  'CORRECTED_BY',
  '81000000-0000-0000-0000-000000000011',
  'correction-v1',
  now()
);

INSERT INTO recovery_checkpoints(
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
)
VALUES (
  '10000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000011',
  1,
  1,
  'context-v1',
  1,
  0,
  '[]'::jsonb,
  1,
  1,
  1,
  1,
  '{"correction_claim_refs":["83000000-0000-0000-0000-000000000011"]}'::jsonb,
  'ACTIVE',
  now(),
  now() + interval '1 hour'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO recovery_checkpoints(
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
    )
    VALUES (
      '10000000-0000-0000-0000-000000000011',
      '30000000-0000-0000-0000-000000000011',
      2,
      1,
      'context-v1',
      1,
      0,
      '[]'::jsonb,
      1,
      1,
      1,
      1,
      '{}'::jsonb,
      'ACTIVE',
      now(),
      now() + interval '1 hour'
    );

    RAISE EXCEPTION 'expected second ACTIVE checkpoint to fail';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO recovery_checkpoints(
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
    )
    VALUES (
      '10000000-0000-0000-0000-000000000011',
      '30000000-0000-0000-0000-000000000011',
      3,
      1,
      'context-v1',
      1,
      0,
      '[]'::jsonb,
      1,
      1,
      1,
      1,
      '{"messages":["this must never be a checkpoint transcript"]}'::jsonb,
      'CANDIDATE',
      now(),
      now() + interval '1 hour'
    );

    RAISE EXCEPTION 'expected transcript-like checkpoint payload to fail';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END $$;

ROLLBACK;

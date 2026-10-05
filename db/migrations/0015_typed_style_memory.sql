BEGIN;

ALTER TABLE conversation_context_states
  ADD COLUMN style_claim_refs jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE conversation_context_states
  ADD CONSTRAINT conversation_context_states_style_claim_refs_array_check
    CHECK (jsonb_typeof(style_claim_refs) = 'array'),
  ADD CONSTRAINT conversation_context_states_style_claim_refs_size_check
    CHECK (octet_length(style_claim_refs::text) <= 16384);

ALTER TABLE context_claims
  DROP CONSTRAINT IF EXISTS context_claims_retention_class_check;

ALTER TABLE context_claims
  ADD CONSTRAINT context_claims_retention_class_check
    CHECK (
      retention_class IN (
        'EPHEMERAL',
        'CORRECTIVE_DURABLE',
        'PREFERENCE_DURABLE',
        'POLICY_REFERENCE'
      )
    );

ALTER TABLE context_claims
  ADD CONSTRAINT context_claims_preference_durable_shape_check
    CHECK (
      retention_class <> 'PREFERENCE_DURABLE'
      OR (
        authority_class = 'EXPLICIT_PREFERENCE'
        AND modality = 'ASSERTION'
        AND trigger_kind = 'EXPLICIT_PREFERENCE_CHANGE'
        AND subject_user_id IS NOT NULL
        AND scope_kind = 'CONVERSATION'
        AND conversation_id IS NOT NULL
        AND scope_conversation_id = conversation_id
      )
    );

COMMIT;

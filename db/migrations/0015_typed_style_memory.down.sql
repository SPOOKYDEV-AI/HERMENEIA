BEGIN;

ALTER TABLE context_claims
  DROP CONSTRAINT IF EXISTS context_claims_preference_durable_shape_check;

ALTER TABLE context_claims
  DROP CONSTRAINT IF EXISTS context_claims_retention_class_check;

ALTER TABLE context_claims
  ADD CONSTRAINT context_claims_retention_class_check
    CHECK (
      retention_class IN (
        'EPHEMERAL',
        'CORRECTIVE_DURABLE',
        'POLICY_REFERENCE'
      )
    );

ALTER TABLE conversation_context_states
  DROP CONSTRAINT IF EXISTS conversation_context_states_style_claim_refs_size_check,
  DROP CONSTRAINT IF EXISTS conversation_context_states_style_claim_refs_array_check,
  DROP COLUMN IF EXISTS style_claim_refs;

COMMIT;

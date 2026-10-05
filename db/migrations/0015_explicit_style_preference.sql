BEGIN;

ALTER TABLE context_claims
  DROP CONSTRAINT context_claims_retention_class_check;

ALTER TABLE context_claims
  ADD CONSTRAINT context_claims_retention_class_check
  CHECK (
    retention_class IN (
      'EPHEMERAL',
      'CORRECTIVE_DURABLE',
      'POLICY_REFERENCE',
      'PREFERENCE_REFERENCE'
    )
  );

ALTER TABLE context_claims
  ADD CONSTRAINT context_claims_preference_reference_check
  CHECK (
    retention_class <> 'PREFERENCE_REFERENCE'
    OR (
      authority_class = 'EXPLICIT_PREFERENCE'
      AND modality = 'ASSERTION'
      AND trigger_kind = 'EXPLICIT_STYLE_PREFERENCE'
      AND subject_user_id IS NOT NULL
      AND scope_kind = 'CONVERSATION'
      AND conversation_id IS NOT NULL
      AND scope_conversation_id = conversation_id
    )
  );

COMMIT;

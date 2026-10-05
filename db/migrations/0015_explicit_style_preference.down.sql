BEGIN;

DO $preference_rows$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM context_claims
     WHERE retention_class = 'PREFERENCE_REFERENCE'
  ) THEN
    RAISE EXCEPTION
      'Cannot rollback 0015 while PREFERENCE_REFERENCE claims exist';
  END IF;
END
$preference_rows$;

ALTER TABLE context_claims
  DROP CONSTRAINT IF EXISTS context_claims_preference_reference_check;

ALTER TABLE context_claims
  DROP CONSTRAINT context_claims_retention_class_check;

ALTER TABLE context_claims
  ADD CONSTRAINT context_claims_retention_class_check
  CHECK (
    retention_class IN (
      'EPHEMERAL',
      'CORRECTIVE_DURABLE',
      'POLICY_REFERENCE'
    )
  );

COMMIT;

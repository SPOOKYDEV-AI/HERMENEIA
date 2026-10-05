BEGIN;

DO $style_column$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'conversation_context_states'
       AND column_name = 'style_claim_refs'
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'conversation_context_states.style_claim_refs must exist and be NOT NULL';
  END IF;
END
$style_column$;

DO $preference_retention$
DECLARE
  retention_def text;
  shape_def text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO retention_def
    FROM pg_constraint
   WHERE conname = 'context_claims_retention_class_check';

  SELECT pg_get_constraintdef(oid)
    INTO shape_def
    FROM pg_constraint
   WHERE conname = 'context_claims_preference_durable_shape_check';

  IF retention_def IS NULL
     OR retention_def NOT LIKE '%PREFERENCE_DURABLE%' THEN
    RAISE EXCEPTION
      'context_claims retention class must allow PREFERENCE_DURABLE';
  END IF;

  IF shape_def IS NULL
     OR shape_def NOT LIKE '%EXPLICIT_PREFERENCE%'
     OR shape_def NOT LIKE '%EXPLICIT_PREFERENCE_CHANGE%' THEN
    RAISE EXCEPTION
      'durable preference shape constraint missing';
  END IF;
END
$preference_retention$;

ROLLBACK;

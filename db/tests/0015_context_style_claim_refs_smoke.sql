BEGIN;

DO $style_claim_refs$
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

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'conversation_context_states'
       AND column_name = 'style_claim_refs'
       AND column_default LIKE '%[]%'
  ) THEN
    RAISE EXCEPTION
      'style_claim_refs must default to an empty JSON array';
  END IF;
END
$style_claim_refs$;

ROLLBACK;

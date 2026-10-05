BEGIN;

DO $$
DECLARE
  legacy_default text;
BEGIN
  SELECT column_default
    INTO legacy_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'context_snapshots'
     AND column_name = 'policy_version';

  IF legacy_default IS NOT NULL THEN
    RAISE EXCEPTION
      'context_snapshots.policy_version must not retain a default';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'context_snapshots'
       AND column_name = 'policy_version'
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'context_snapshots.policy_version must exist and be NOT NULL';
  END IF;
END
$$;

ROLLBACK;

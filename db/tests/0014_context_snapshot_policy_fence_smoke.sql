BEGIN;

DO $
DECLARE
  sentinel_default text;
BEGIN
  SELECT column_default
    INTO sentinel_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'context_snapshots'
     AND column_name = 'policy_version';

  IF sentinel_default IS NULL
     OR sentinel_default NOT LIKE '%0%' THEN
    RAISE EXCEPTION
      'context_snapshots.policy_version must keep fail-closed default 0';
  END IF;
END
$;

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

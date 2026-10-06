BEGIN;

DO $checkpoint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'recovery_checkpoints'
       AND column_name = 'tenant_policy_version'
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'recovery_checkpoints.tenant_policy_version must exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname =
         'recovery_checkpoints_one_active_per_conversation'
  ) THEN
    RAISE EXCEPTION
      'active recovery checkpoint uniqueness index missing';
  END IF;
END
$checkpoint$;

ROLLBACK;

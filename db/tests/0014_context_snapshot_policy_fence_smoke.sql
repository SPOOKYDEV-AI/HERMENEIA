BEGIN;

DO $policy_columns$
DECLARE
  conversation_default text;
  tenant_default text;
BEGIN
  SELECT column_default
    INTO conversation_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'context_snapshots'
     AND column_name = 'policy_version';

  SELECT column_default
    INTO tenant_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'context_snapshots'
     AND column_name = 'tenant_policy_version';

  IF conversation_default IS NULL
     OR conversation_default NOT LIKE '%0%' THEN
    RAISE EXCEPTION
      'context_snapshots.policy_version must keep fail-closed default 0';
  END IF;

  IF tenant_default IS NULL
     OR tenant_default NOT LIKE '%0%' THEN
    RAISE EXCEPTION
      'context_snapshots.tenant_policy_version must keep fail-closed default 0';
  END IF;

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

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'context_snapshots'
       AND column_name = 'tenant_policy_version'
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'context_snapshots.tenant_policy_version must exist and be NOT NULL';
  END IF;
END
$policy_columns$;

ROLLBACK;

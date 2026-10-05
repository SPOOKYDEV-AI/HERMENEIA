BEGIN;

DO $preferences$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'user_language_preferences'
  ) THEN
    RAISE EXCEPTION
      'user_language_preferences table missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'translation_executions'
       AND column_name = 'preferred_register'
  ) THEN
    RAISE EXCEPTION
      'translation_executions.preferred_register missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'translation_executions_logical_idx'
       AND indexdef LIKE '%preferred_register%'
  ) THEN
    RAISE EXCEPTION
      'translation logical index must include preferred_register';
  END IF;
END
$preferences$;

ROLLBACK;

BEGIN;

DO $language_preferences$
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

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'user_language_preferences'
       AND column_name = 'preferred_register'
  ) THEN
    RAISE EXCEPTION
      'durable preferred_register must not exist in language preferences';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'user_language_preferences'
       AND column_name = 'preference_version'
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'user_language_preferences.preference_version missing';
  END IF;
END
$language_preferences$;

ROLLBACK;

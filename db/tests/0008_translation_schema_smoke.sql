\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  definition text;
BEGIN
  IF to_regclass('public.translation_executions') IS NULL THEN
    RAISE EXCEPTION 'translation_executions table missing';
  END IF;

  IF to_regclass('public.provider_executions') IS NULL THEN
    RAISE EXCEPTION 'provider_executions table missing';
  END IF;

  SELECT pg_get_constraintdef(oid)
    INTO definition
    FROM pg_constraint
   WHERE conrelid = 'provider_executions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%CANCELLED_LOGICALLY%'
   LIMIT 1;

  IF definition IS NULL THEN
    RAISE EXCEPTION
      'provider execution status constraint missing CANCELLED_LOGICALLY';
  END IF;

  SELECT pg_get_constraintdef(oid)
    INTO definition
    FROM pg_constraint
   WHERE conrelid = 'translation_executions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%SUPERSEDED%'
     AND pg_get_constraintdef(oid) LIKE '%SOURCE_REQUIRED%'
   LIMIT 1;

  IF definition IS NULL THEN
    RAISE EXCEPTION
      'translation execution status constraint missing required terminal states';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'delivery_envelopes_translation_fk'
       AND conrelid = 'delivery_envelopes'::regclass
       AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'delivery envelope translation FK missing';
  END IF;

  SELECT pg_get_constraintdef(oid)
    INTO definition
    FROM pg_constraint
   WHERE conname = 'device_inbox_events_event_type_check'
     AND conrelid = 'device_inbox_events'::regclass;

  IF definition IS NULL
     OR position('translation.source_required' in definition) = 0 THEN
    RAISE EXCEPTION
      'device inbox event type constraint missing translation.source_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname =
       'device_inbox_events_translation_source_required_check'
       AND conrelid = 'device_inbox_events'::regclass
  ) THEN
    RAISE EXCEPTION
      'translation.source_required metadata shape constraint missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'outbox_jobs_message_revision_idx'
       AND indexdef LIKE
         '%translation.request%translation.execute%'
  ) THEN
    RAISE EXCEPTION
      'translation request/execute supersession index missing';
  END IF;
END $$;

ROLLBACK;

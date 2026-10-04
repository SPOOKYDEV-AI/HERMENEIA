BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM provider_executions)
     OR EXISTS (SELECT 1 FROM translation_executions)
     OR EXISTS (
       SELECT 1
         FROM device_inbox_events
        WHERE event_type LIKE 'translation.%'
     )
  THEN
    RAISE EXCEPTION
      '0007 rollback requires no translation executions/events';
  END IF;
END $$;

ALTER TABLE device_inbox_events
  DROP CONSTRAINT IF EXISTS device_inbox_events_envelope_shape_check;

ALTER TABLE device_inbox_events
  DROP CONSTRAINT IF EXISTS device_inbox_events_event_type_check;

ALTER TABLE device_inbox_events
  ADD CONSTRAINT device_inbox_events_event_type_check
  CHECK (
    event_type IN (
      'message.available',
      'message.edited',
      'message.deleted'
    )
  );

ALTER TABLE device_inbox_events
  ADD CONSTRAINT device_inbox_events_envelope_shape_check
  CHECK (
    (
      event_type IN ('message.available','message.edited')
      AND envelope_id IS NOT NULL
    )
    OR
    (
      event_type = 'message.deleted'
      AND envelope_id IS NULL
    )
  );

DROP INDEX IF EXISTS delivery_translation_per_device_idx;

ALTER TABLE delivery_envelopes
  DROP CONSTRAINT IF EXISTS delivery_envelopes_translation_fk;

DROP TABLE IF EXISTS provider_executions;
DROP TABLE IF EXISTS translation_executions;

ALTER TABLE conversation_members
  DROP COLUMN IF EXISTS target_profile_version;

COMMIT;

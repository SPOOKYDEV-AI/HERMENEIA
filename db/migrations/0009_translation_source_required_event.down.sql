BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM device_inbox_events
     WHERE event_type = 'translation.source_required'
  ) THEN
    RAISE EXCEPTION
      '0009 rollback requires no translation.source_required inbox events';
  END IF;
END $$;

ALTER TABLE device_inbox_events
  DROP CONSTRAINT IF EXISTS device_inbox_events_translation_source_required_check;

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

COMMIT;

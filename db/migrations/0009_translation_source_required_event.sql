BEGIN;

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
      'message.deleted',
      'translation.source_required'
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
      event_type IN ('message.deleted','translation.source_required')
      AND envelope_id IS NULL
    )
  );

ALTER TABLE device_inbox_events
  ADD CONSTRAINT device_inbox_events_translation_source_required_check
  CHECK (
    event_type <> 'translation.source_required'
    OR (
      metadata ? 'translation_id'
      AND metadata ? 'source_revision'
      AND metadata ? 'source_ref'
      AND length(trim(metadata->>'translation_id')) > 0
      AND (metadata->>'source_revision') ~ '^[1-9][0-9]*$'
      AND length(trim(metadata->>'source_ref')) >= 16
    )
  );

COMMIT;

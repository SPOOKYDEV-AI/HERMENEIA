BEGIN;

-- Development rollback only. Refuse to destroy or rewrite edit/delete history.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM device_inbox_events
     WHERE event_type <> 'message.available'
        OR envelope_id IS NULL
  ) THEN
    RAISE EXCEPTION
      '0003 rollback requires no message.edited/message.deleted/null-envelope events';
  END IF;
END $$;

ALTER TABLE device_inbox_events
  DROP CONSTRAINT IF EXISTS device_inbox_events_envelope_shape_check;

ALTER TABLE device_inbox_events
  DROP CONSTRAINT IF EXISTS device_inbox_events_event_type_check;

ALTER TABLE device_inbox_events
  ADD CONSTRAINT device_inbox_events_event_type_check
  CHECK (event_type IN ('message.available'));

ALTER TABLE device_inbox_events
  ALTER COLUMN envelope_id SET NOT NULL;

DROP INDEX IF EXISTS sessions_tenant_status_idx;

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_tenant_membership_fk;

ALTER TABLE sessions
  DROP COLUMN IF EXISTS tenant_id;

COMMIT;

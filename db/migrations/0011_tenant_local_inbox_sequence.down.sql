BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM device_inbox_events
     GROUP BY device_id, inbox_epoch, offset_value
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      '0011 rollback requires globally unique device inbox offsets';
  END IF;
END $$;

DROP INDEX IF EXISTS device_inbox_events_event_time_idx;

ALTER TABLE device_inbox_events
  DROP CONSTRAINT device_inbox_events_pkey;

ALTER TABLE device_inbox_events
  ADD PRIMARY KEY (
    device_id,
    inbox_epoch,
    offset_value
  );

CREATE INDEX device_inbox_events_event_time_idx
  ON device_inbox_events(
    device_id,
    inbox_epoch,
    created_at
  );

ALTER TABLE tenant_device_sync_states
  DROP CONSTRAINT IF EXISTS tenant_device_sync_states_next_offset_check;

ALTER TABLE tenant_device_sync_states
  DROP COLUMN IF EXISTS next_offset;

COMMIT;

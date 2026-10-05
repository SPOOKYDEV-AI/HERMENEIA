BEGIN;

ALTER TABLE tenant_device_sync_states
  ADD COLUMN next_offset bigint;

UPDATE tenant_device_sync_states tds
   SET next_offset = COALESCE(
     (
       SELECT MAX(die.offset_value) + 1
         FROM device_inbox_events die
        WHERE die.tenant_id = tds.tenant_id
          AND die.device_id = tds.device_id
          AND die.inbox_epoch = tds.inbox_epoch
     ),
     1
   );

ALTER TABLE tenant_device_sync_states
  ALTER COLUMN next_offset SET DEFAULT 1,
  ALTER COLUMN next_offset SET NOT NULL;

ALTER TABLE tenant_device_sync_states
  ADD CONSTRAINT tenant_device_sync_states_next_offset_check
  CHECK (next_offset >= 1);

ALTER TABLE device_inbox_events
  DROP CONSTRAINT device_inbox_events_pkey;

ALTER TABLE device_inbox_events
  ADD PRIMARY KEY (
    tenant_id,
    device_id,
    inbox_epoch,
    offset_value
  );

DROP INDEX IF EXISTS device_inbox_events_event_time_idx;

CREATE INDEX device_inbox_events_event_time_idx
  ON device_inbox_events(
    tenant_id,
    device_id,
    inbox_epoch,
    created_at
  );

COMMIT;

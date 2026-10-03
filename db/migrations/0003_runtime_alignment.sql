BEGIN;

-- Session ActorContext is tenant-bound. Existing rows remain nullable so this
-- migration can be applied safely before a dedicated session backfill/issuer.
ALTER TABLE sessions
  ADD COLUMN tenant_id uuid;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_tenant_membership_fk
  FOREIGN KEY (tenant_id, user_id)
  REFERENCES tenant_memberships(tenant_id, user_id);

CREATE INDEX sessions_tenant_status_idx
  ON sessions(tenant_id, status)
  WHERE tenant_id IS NOT NULL;

-- Runtime now supports edits (new protected payload) and deletes
-- (content-free control event). The original schema only allowed
-- message.available and required envelope_id for every event.
ALTER TABLE device_inbox_events
  ALTER COLUMN envelope_id DROP NOT NULL;

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

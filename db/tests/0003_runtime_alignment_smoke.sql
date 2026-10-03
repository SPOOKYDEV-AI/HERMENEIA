\set ON_ERROR_STOP on

BEGIN;

-- Runtime alignment checks: edited events carry a fresh envelope while deleted
-- events are content-free and therefore have no envelope_id.

INSERT INTO device_inbox_events(
  device_id, inbox_epoch, offset_value, event_id, event_type,
  tenant_id, conversation_id, message_id, envelope_id, metadata
)
VALUES (
  '20000000-0000-0000-0000-000000000002',
  1,
  2,
  '70000000-0000-0000-0000-000000000002',
  'message.edited',
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000001',
  '{"source_revision":2}'::jsonb
);

INSERT INTO device_inbox_events(
  device_id, inbox_epoch, offset_value, event_id, event_type,
  tenant_id, conversation_id, message_id, envelope_id, metadata
)
VALUES (
  '20000000-0000-0000-0000-000000000002',
  1,
  3,
  '70000000-0000-0000-0000-000000000003',
  'message.deleted',
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  NULL,
  '{"source_revision":3}'::jsonb
);

DO $$
BEGIN
  BEGIN
    INSERT INTO device_inbox_events(
      device_id, inbox_epoch, offset_value, event_id, event_type,
      tenant_id, conversation_id, message_id, envelope_id, metadata
    )
    VALUES (
      '20000000-0000-0000-0000-000000000002',
      1,
      4,
      '70000000-0000-0000-0000-000000000004',
      'message.deleted',
      '10000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
      '{"source_revision":3}'::jsonb
    );
    RAISE EXCEPTION 'expected deleted event with envelope to fail';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END $$;

ROLLBACK;

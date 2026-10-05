\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users(user_id, status)
VALUES ('a1000000-0000-0000-0000-000000000001','ACTIVE');

INSERT INTO tenants(tenant_id, kind, status, home_region)
VALUES
  ('a2000000-0000-0000-0000-000000000001','ORGANISATION','ACTIVE','eu-test'),
  ('a2000000-0000-0000-0000-000000000002','ORGANISATION','ACTIVE','eu-test');

INSERT INTO devices(
  device_id,
  user_id,
  status,
  credential_version,
  public_material_ref,
  platform,
  revocation_epoch
)
VALUES (
  'a3000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'ACTIVE',
  1,
  'test:tenant-local-sequence',
  'OTHER',
  0
);

INSERT INTO tenant_device_sync_states(
  tenant_id,
  device_id,
  inbox_epoch,
  last_acked_offset,
  next_offset
)
VALUES
  (
    'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000001',
    1,
    0,
    2
  ),
  (
    'a2000000-0000-0000-0000-000000000002',
    'a3000000-0000-0000-0000-000000000001',
    1,
    0,
    2
  );

-- The same physical device/epoch/offset is legal in two different tenants.
INSERT INTO device_inbox_events(
  device_id,
  inbox_epoch,
  offset_value,
  event_id,
  event_type,
  tenant_id,
  conversation_id,
  message_id,
  envelope_id,
  metadata
)
VALUES
  (
    'a3000000-0000-0000-0000-000000000001',
    1,
    1,
    'a4000000-0000-0000-0000-000000000001',
    'message.deleted',
    'a2000000-0000-0000-0000-000000000001',
    'a5000000-0000-0000-0000-000000000001',
    'a6000000-0000-0000-0000-000000000001',
    NULL,
    '{"source_revision":2}'::jsonb
  ),
  (
    'a3000000-0000-0000-0000-000000000001',
    1,
    1,
    'a4000000-0000-0000-0000-000000000002',
    'message.deleted',
    'a2000000-0000-0000-0000-000000000002',
    'a5000000-0000-0000-0000-000000000002',
    'a6000000-0000-0000-0000-000000000002',
    NULL,
    '{"source_revision":2}'::jsonb
  );

DO $$
DECLARE
  event_count integer;
BEGIN
  SELECT COUNT(*)
    INTO event_count
    FROM device_inbox_events
   WHERE device_id = 'a3000000-0000-0000-0000-000000000001'
     AND inbox_epoch = 1
     AND offset_value = 1;

  IF event_count <> 2 THEN
    RAISE EXCEPTION
      'expected same device/epoch/offset in two tenants, got % rows',
      event_count;
  END IF;

  BEGIN
    INSERT INTO device_inbox_events(
      device_id,
      inbox_epoch,
      offset_value,
      event_id,
      event_type,
      tenant_id,
      conversation_id,
      message_id,
      envelope_id,
      metadata
    )
    VALUES (
      'a3000000-0000-0000-0000-000000000001',
      1,
      1,
      'a4000000-0000-0000-0000-000000000003',
      'message.deleted',
      'a2000000-0000-0000-0000-000000000001',
      'a5000000-0000-0000-0000-000000000003',
      'a6000000-0000-0000-0000-000000000003',
      NULL,
      '{"source_revision":3}'::jsonb
    );
    RAISE EXCEPTION
      'expected duplicate tenant-local inbox offset to fail';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE tenant_device_sync_states
       SET next_offset = 0
     WHERE tenant_id = 'a2000000-0000-0000-0000-000000000001'
       AND device_id = 'a3000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'expected next_offset lower bound to fail';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END $$;

UPDATE tenant_device_sync_states
   SET next_offset = 7
 WHERE tenant_id = 'a2000000-0000-0000-0000-000000000001'
   AND device_id = 'a3000000-0000-0000-0000-000000000001';

DO $$
DECLARE
  tenant_a_offset bigint;
  tenant_b_offset bigint;
BEGIN
  SELECT next_offset
    INTO tenant_a_offset
    FROM tenant_device_sync_states
   WHERE tenant_id = 'a2000000-0000-0000-0000-000000000001'
     AND device_id = 'a3000000-0000-0000-0000-000000000001';

  SELECT next_offset
    INTO tenant_b_offset
    FROM tenant_device_sync_states
   WHERE tenant_id = 'a2000000-0000-0000-0000-000000000002'
     AND device_id = 'a3000000-0000-0000-0000-000000000001';

  IF tenant_a_offset <> 7 OR tenant_b_offset <> 2 THEN
    RAISE EXCEPTION
      'tenant-local next_offset leaked across tenants: a=% b=%',
      tenant_a_offset,
      tenant_b_offset;
  END IF;
END $$;

ROLLBACK;

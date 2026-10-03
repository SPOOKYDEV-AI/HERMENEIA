\set ON_ERROR_STOP on

BEGIN;

-- This smoke test is intended for an empty temporary database after applying
-- 0001_core_messaging.sql. IDs are deterministic UUID literals for readability.

INSERT INTO users(user_id, status)
VALUES
  ('00000000-0000-0000-0000-000000000001','ACTIVE'),
  ('00000000-0000-0000-0000-000000000002','ACTIVE');

INSERT INTO tenants(tenant_id, kind, status, home_region)
VALUES ('10000000-0000-0000-0000-000000000001','ORGANISATION','ACTIVE','eu-test');

INSERT INTO tenant_memberships(tenant_id, user_id, role, status)
VALUES
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','OWNER','ACTIVE'),
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','MEMBER','ACTIVE');

INSERT INTO devices(device_id, user_id, status, credential_version, public_material_ref)
VALUES
  ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','ACTIVE',1,'test:a'),
  ('20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','ACTIVE',1,'test:b');

INSERT INTO device_sync_states(device_id)
VALUES
  ('20000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000002');

INSERT INTO conversations(
  tenant_id, conversation_id, kind, status, home_region
)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'DIRECT',
  'ACTIVE',
  'eu-test'
);

INSERT INTO conversation_members(
  tenant_id, conversation_id, user_id, role, status
)
VALUES
  (
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'MEMBER',
    'ACTIVE'
  ),
  (
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    'MEMBER',
    'ACTIVE'
  );

INSERT INTO message_metadata(
  tenant_id, message_id, conversation_id, author_user_id, author_device_id,
  client_message_id, message_seq, current_revision, status
)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  1,
  1,
  'ACTIVE'
);

INSERT INTO message_revisions(
  tenant_id, conversation_id, message_id, revision, op_seq,
  mutation_type, actor_user_id, source_hash
)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  1,
  1,
  'CREATED',
  '00000000-0000-0000-0000-000000000001',
  'sha256:test'
);

INSERT INTO delivery_envelopes(
  tenant_id, envelope_id, conversation_id, message_id, source_revision,
  recipient_user_id, recipient_device_id, recipient_credential_version,
  rendition_type, protected_payload, status, expires_at
)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  1,
  '00000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000002',
  1,
  'ORIGINAL',
  decode('00','hex'),
  'PENDING',
  now() + interval '1 hour'
);

INSERT INTO device_inbox_events(
  device_id, inbox_epoch, offset_value, event_id, event_type,
  tenant_id, conversation_id, message_id, envelope_id
)
VALUES (
  '20000000-0000-0000-0000-000000000002',
  1,
  1,
  '70000000-0000-0000-0000-000000000001',
  'message.available',
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000001'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO message_metadata(
      tenant_id, message_id, conversation_id, author_user_id, author_device_id,
      client_message_id, message_seq, current_revision, status
    )
    VALUES (
      '10000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000002',
      '30000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001',
      '50000000-0000-0000-0000-000000000001',
      2,
      1,
      'ACTIVE'
    );
    RAISE EXCEPTION 'expected duplicate client_message_id to fail';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;
END $$;

ROLLBACK;

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users(user_id, status)
VALUES
  ('00000000-0000-0000-0000-000000000001','ACTIVE'),
  ('00000000-0000-0000-0000-000000000002','ACTIVE');

INSERT INTO tenants(tenant_id, kind, status, home_region)
VALUES
  ('10000000-0000-0000-0000-000000000001','ORGANISATION','ACTIVE','eu-test');

INSERT INTO tenant_memberships(tenant_id, user_id, role, status)
VALUES
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','OWNER','ACTIVE'),
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','MEMBER','ACTIVE');

INSERT INTO devices(
  device_id, user_id, status, credential_version, public_material_ref
)
VALUES
  ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','ACTIVE',1,'test:a'),
  ('20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','ACTIVE',1,'test:b');

INSERT INTO device_sync_states(device_id)
VALUES ('20000000-0000-0000-0000-000000000002');

INSERT INTO sessions(
  session_id, tenant_id, user_id, device_id,
  refresh_secret_hash, access_credential_ref,
  status, issued_at, expires_at
)
VALUES (
  '21000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'refresh-test-runtime-alignment',
  'access-ref-runtime-alignment',
  'ACTIVE',
  now(),
  now() + interval '1 hour'
);

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
  3,
  'DELETED'
);

INSERT INTO message_revisions(
  tenant_id, conversation_id, message_id, revision, op_seq,
  mutation_type, actor_user_id, source_hash
)
VALUES
  (
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    1,1,'CREATED',
    '00000000-0000-0000-0000-000000000001',
    'sha256:v1'
  ),
  (
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    2,2,'EDITED',
    '00000000-0000-0000-0000-000000000001',
    'sha256:v2'
  ),
  (
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    3,3,'DELETED',
    '00000000-0000-0000-0000-000000000001',
    NULL
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
  2,
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
  tenant_id, conversation_id, message_id, envelope_id, metadata
)
VALUES
  (
    '20000000-0000-0000-0000-000000000002',
    1,
    1,
    '70000000-0000-0000-0000-000000000001',
    'message.edited',
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    '60000000-0000-0000-0000-000000000001',
    '{"source_revision":2}'::jsonb
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    1,
    2,
    '70000000-0000-0000-0000-000000000002',
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
      3,
      '70000000-0000-0000-0000-000000000003',
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

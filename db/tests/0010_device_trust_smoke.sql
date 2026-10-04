\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users(user_id, status)
VALUES ('90000000-0000-0000-0000-000000000001','ACTIVE');

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
  '91000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  'ACTIVE',
  1,
  'test:device-material',
  'ANDROID',
  0
);

DO $$
BEGIN
  BEGIN
    INSERT INTO devices(
      device_id, user_id, status, credential_version,
      public_material_ref, platform
    )
    VALUES (
      '91000000-0000-0000-0000-000000000002',
      '90000000-0000-0000-0000-000000000001',
      'ACTIVE',
      1,
      'test:invalid-platform',
      'WATCH'
    );
    RAISE EXCEPTION 'expected invalid device platform to fail';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO devices(
      device_id, user_id, status, credential_version,
      public_material_ref, platform
    )
    VALUES (
      '91000000-0000-0000-0000-000000000003',
      '90000000-0000-0000-0000-000000000001',
      'ACTIVE',
      1,
      '',
      'OTHER'
    );
    RAISE EXCEPTION 'expected empty public material reference to fail';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END $$;

ROLLBACK;

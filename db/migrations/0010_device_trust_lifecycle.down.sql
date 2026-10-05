BEGIN;

DROP INDEX IF EXISTS devices_user_registered_idx;

ALTER TABLE devices
  DROP CONSTRAINT IF EXISTS devices_public_material_ref_length_check;

ALTER TABLE devices
  DROP CONSTRAINT IF EXISTS devices_platform_check;

ALTER TABLE devices
  DROP COLUMN IF EXISTS platform;

COMMIT;

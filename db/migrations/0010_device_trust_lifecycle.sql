BEGIN;

ALTER TABLE devices
  ADD COLUMN platform text NOT NULL DEFAULT 'OTHER';

ALTER TABLE devices
  ADD CONSTRAINT devices_platform_check
  CHECK (platform IN ('WEB','ANDROID','IOS','DESKTOP','OTHER'));

ALTER TABLE devices
  ADD CONSTRAINT devices_public_material_ref_length_check
  CHECK (
    char_length(public_material_ref) BETWEEN 1 AND 4096
  ) NOT VALID;

CREATE INDEX devices_user_registered_idx
  ON devices(user_id, registered_at, device_id);

COMMIT;

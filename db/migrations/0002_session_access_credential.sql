BEGIN;

ALTER TABLE sessions
  ADD COLUMN access_credential_ref text;

CREATE UNIQUE INDEX sessions_access_credential_ref_uidx
  ON sessions(access_credential_ref)
  WHERE access_credential_ref IS NOT NULL;

COMMIT;

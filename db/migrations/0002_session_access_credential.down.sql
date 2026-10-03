BEGIN;

DROP INDEX IF EXISTS sessions_access_credential_ref_uidx;

ALTER TABLE sessions
  DROP COLUMN IF EXISTS access_credential_ref;

COMMIT;

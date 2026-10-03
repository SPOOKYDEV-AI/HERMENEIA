BEGIN;

DROP INDEX IF EXISTS command_receipts_actor_status_idx;

ALTER TABLE command_receipts
  DROP COLUMN IF EXISTS command_fingerprint;

COMMIT;

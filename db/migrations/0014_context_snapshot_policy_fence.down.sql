BEGIN;

ALTER TABLE context_snapshots
  DROP COLUMN IF EXISTS policy_version;

COMMIT;

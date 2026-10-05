BEGIN;

ALTER TABLE context_snapshots
  ADD COLUMN policy_version bigint NOT NULL DEFAULT 0
    CHECK (policy_version >= 0);

-- 0 is a deliberate legacy-invalid sentinel. Historical snapshots predate
-- policy-version capture and must never be treated as current merely because
-- the migration runs under today's policy version.
ALTER TABLE context_snapshots
  ALTER COLUMN policy_version DROP DEFAULT;

COMMIT;

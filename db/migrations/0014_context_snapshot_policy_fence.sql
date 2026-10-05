BEGIN;

ALTER TABLE context_snapshots
  ADD COLUMN policy_version bigint NOT NULL DEFAULT 0
    CHECK (policy_version >= 0);

-- 0 is a deliberate legacy-invalid sentinel. Historical writers that omit
-- the new column remain compatible, but the resulting snapshot can never
-- match a real conversation policy version (which is always >= 1).

COMMIT;

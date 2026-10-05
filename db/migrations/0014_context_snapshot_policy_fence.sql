BEGIN;

ALTER TABLE context_snapshots
  ADD COLUMN policy_version bigint NOT NULL DEFAULT 0
    CHECK (policy_version >= 0),
  ADD COLUMN tenant_policy_version bigint NOT NULL DEFAULT 0
    CHECK (tenant_policy_version >= 0);

-- 0 is a deliberate legacy-invalid sentinel. Historical writers that omit
-- either new column remain schema-compatible, but those snapshots can never
-- match real conversation/tenant policy versions (which are always >= 1).

COMMIT;

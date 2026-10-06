BEGIN;

ALTER TABLE recovery_checkpoints
  ADD COLUMN tenant_policy_version bigint;

UPDATE recovery_checkpoints rc
   SET tenant_policy_version = t.policy_version
  FROM tenants t
 WHERE t.tenant_id = rc.tenant_id
   AND rc.tenant_policy_version IS NULL;

ALTER TABLE recovery_checkpoints
  ALTER COLUMN tenant_policy_version SET NOT NULL;

ALTER TABLE recovery_checkpoints
  ADD CONSTRAINT recovery_checkpoints_tenant_policy_version_check
  CHECK (tenant_policy_version >= 1);

ALTER INDEX recovery_checkpoints_one_active_idx
  RENAME TO recovery_checkpoints_one_active_per_conversation;

COMMIT;

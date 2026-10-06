BEGIN;

ALTER INDEX recovery_checkpoints_one_active_per_conversation
  RENAME TO recovery_checkpoints_one_active_idx;

ALTER TABLE recovery_checkpoints
  DROP COLUMN tenant_policy_version;

COMMIT;

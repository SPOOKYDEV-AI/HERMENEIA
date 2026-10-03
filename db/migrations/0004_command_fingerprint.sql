BEGIN;

ALTER TABLE command_receipts
  ADD COLUMN command_fingerprint text;

CREATE INDEX command_receipts_actor_status_idx
  ON command_receipts(tenant_id, actor_user_id, actor_device_id, status);

COMMIT;

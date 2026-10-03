BEGIN;

ALTER TABLE command_receipts
  ADD COLUMN command_fingerprint text;

CREATE INDEX command_receipts_actor_status_idx
  ON command_receipts(tenant_id, actor_user_id, actor_device_id, status);

CREATE INDEX command_receipts_message_result_idx
  ON command_receipts(
    tenant_id,
    actor_user_id,
    ((result_ref->>'message_id'))
  )
  WHERE command_type = 'message.send'
    AND status = 'SUCCEEDED';

COMMIT;

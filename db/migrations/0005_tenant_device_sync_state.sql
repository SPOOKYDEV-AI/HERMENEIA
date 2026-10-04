BEGIN;

-- Device inbox offsets remain globally monotonic per physical device, but a
-- tenant-bound session must keep its replay/purge watermark isolated from
-- every other tenant the same user/device may belong to.
CREATE TABLE tenant_device_sync_states (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  inbox_epoch bigint NOT NULL CHECK (inbox_epoch >= 1),
  last_acked_offset bigint NOT NULL DEFAULT 0 CHECK (last_acked_offset >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

-- Existing pre-production inboxes are conservatively backfilled at offset 0.
-- We do not copy the former global last_acked_offset because it cannot prove
-- which tenant caused that purge watermark.
INSERT INTO tenant_device_sync_states(
  tenant_id,
  device_id,
  inbox_epoch,
  last_acked_offset,
  updated_at
)
SELECT DISTINCT
       die.tenant_id,
       die.device_id,
       dss.inbox_epoch,
       0,
       now()
  FROM device_inbox_events die
  JOIN device_sync_states dss
    ON dss.device_id = die.device_id
ON CONFLICT (tenant_id, device_id) DO NOTHING;

CREATE INDEX tenant_device_sync_states_device_idx
  ON tenant_device_sync_states(device_id, tenant_id);

COMMIT;

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

-- Reconstruct the largest terminal prefix visible to each tenant/device.
--
-- Global device offsets may contain gaps belonging to another tenant. That is
-- fine: a tenant cursor may advance across offsets for which that tenant has
-- no event. The only blocker is the first content event for this tenant whose
-- envelope is still PENDING or whose envelope row is missing unexpectedly.
--
-- Deleted events are content-free control events and therefore never block the
-- recoverable prefix.
WITH tenant_devices AS (
  SELECT DISTINCT
         die.tenant_id,
         die.device_id,
         dss.inbox_epoch,
         dss.next_offset
    FROM device_inbox_events die
    JOIN device_sync_states dss
      ON dss.device_id = die.device_id
),
first_blockers AS (
  SELECT td.tenant_id,
         td.device_id,
         td.inbox_epoch,
         td.next_offset,
         MIN(die.offset_value) FILTER (
           WHERE die.envelope_id IS NOT NULL
             AND (
               de.envelope_id IS NULL
               OR de.status = 'PENDING'
             )
         ) AS first_blocking_offset
    FROM tenant_devices td
    LEFT JOIN device_inbox_events die
      ON die.tenant_id = td.tenant_id
     AND die.device_id = td.device_id
     AND die.inbox_epoch = td.inbox_epoch
    LEFT JOIN delivery_envelopes de
      ON de.tenant_id = die.tenant_id
     AND de.envelope_id = die.envelope_id
     AND de.recipient_device_id = die.device_id
   GROUP BY
         td.tenant_id,
         td.device_id,
         td.inbox_epoch,
         td.next_offset
)
INSERT INTO tenant_device_sync_states(
  tenant_id,
  device_id,
  inbox_epoch,
  last_acked_offset,
  updated_at
)
SELECT tenant_id,
       device_id,
       inbox_epoch,
       CASE
         WHEN first_blocking_offset IS NULL
           THEN GREATEST(next_offset - 1, 0)
         ELSE GREATEST(first_blocking_offset - 1, 0)
       END,
       now()
  FROM first_blockers
ON CONFLICT (tenant_id, device_id) DO NOTHING;

CREATE INDEX tenant_device_sync_states_device_idx
  ON tenant_device_sync_states(device_id, tenant_id);

COMMIT;

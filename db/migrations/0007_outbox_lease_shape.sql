BEGIN;

ALTER TABLE outbox_jobs
  ADD CONSTRAINT outbox_jobs_lifecycle_shape_check
  CHECK (
    (
      status = 'AVAILABLE'
      AND lease_until IS NULL
      AND completed_at IS NULL
    )
    OR
    (
      status = 'LEASED'
      AND lease_until IS NOT NULL
      AND completed_at IS NULL
    )
    OR
    (
      status IN ('DONE','DEAD','SUPERSEDED')
      AND lease_until IS NULL
      AND completed_at IS NOT NULL
    )
  );

COMMIT;

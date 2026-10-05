BEGIN;

ALTER TABLE outbox_jobs
  DROP CONSTRAINT IF EXISTS outbox_jobs_lifecycle_shape_check;

COMMIT;

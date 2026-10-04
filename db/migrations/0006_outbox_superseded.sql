BEGIN;

ALTER TABLE outbox_jobs
  DROP CONSTRAINT IF EXISTS outbox_jobs_status_check;

ALTER TABLE outbox_jobs
  ADD CONSTRAINT outbox_jobs_status_check
  CHECK (
    status IN (
      'AVAILABLE',
      'LEASED',
      'DONE',
      'DEAD',
      'SUPERSEDED'
    )
  );

CREATE INDEX outbox_jobs_message_revision_idx
  ON outbox_jobs(
    tenant_id,
    job_type,
    ((payload_ref->>'message_id')),
    (((payload_ref->>'source_revision')::integer)),
    status
  )
  WHERE job_type = 'translation.request';

COMMIT;

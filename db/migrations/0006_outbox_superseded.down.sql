BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM outbox_jobs
     WHERE status = 'SUPERSEDED'
  ) THEN
    RAISE EXCEPTION
      '0006 rollback requires no SUPERSEDED outbox jobs';
  END IF;
END $$;

DROP INDEX IF EXISTS outbox_jobs_message_revision_idx;

ALTER TABLE outbox_jobs
  DROP CONSTRAINT IF EXISTS outbox_jobs_status_check;

ALTER TABLE outbox_jobs
  ADD CONSTRAINT outbox_jobs_status_check
  CHECK (status IN ('AVAILABLE','LEASED','DONE','DEAD'));

COMMIT;

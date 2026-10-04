BEGIN;

ALTER TABLE translation_executions
  DROP CONSTRAINT IF EXISTS translation_executions_context_snapshot_fk;

DROP TABLE IF EXISTS context_snapshots;

COMMIT;

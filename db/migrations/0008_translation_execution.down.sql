BEGIN;

ALTER TABLE delivery_envelopes
  DROP CONSTRAINT IF EXISTS delivery_envelopes_translation_fk;

DROP TABLE IF EXISTS provider_executions;
DROP TABLE IF EXISTS translation_executions;

COMMIT;

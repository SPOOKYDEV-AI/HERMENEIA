BEGIN;

ALTER TABLE conversation_context_states
  DROP COLUMN IF EXISTS style_claim_refs;

COMMIT;

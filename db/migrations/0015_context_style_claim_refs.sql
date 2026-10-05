BEGIN;

ALTER TABLE conversation_context_states
  ADD COLUMN style_claim_refs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(style_claim_refs) = 'array')
    CHECK (octet_length(style_claim_refs::text) <= 16384);

COMMIT;

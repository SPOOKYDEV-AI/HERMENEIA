BEGIN;

DROP TABLE IF EXISTS recovery_checkpoints;
DROP TABLE IF EXISTS provenance_edges;
DROP TABLE IF EXISTS context_claims;
DROP TABLE IF EXISTS translation_repair_events;
DROP TABLE IF EXISTS conversation_context_states;
DROP FUNCTION IF EXISTS hermeneia_context_jsonb_has_forbidden_key(jsonb);

COMMIT;

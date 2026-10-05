BEGIN;

DROP INDEX translation_executions_logical_idx;

ALTER TABLE translation_executions
  DROP COLUMN IF EXISTS preferred_register;

CREATE UNIQUE INDEX translation_executions_logical_idx
  ON translation_executions(
    tenant_id,
    source_message_id,
    source_revision,
    recipient_user_id,
    target_language_tag,
    target_profile_version,
    COALESCE(
      context_snapshot_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    ),
    strategy_version
  );

DROP TABLE IF EXISTS user_language_preferences;

COMMIT;

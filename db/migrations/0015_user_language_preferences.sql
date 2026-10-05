BEGIN;

CREATE TABLE user_language_preferences (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  target_language_tag text NOT NULL
    CHECK (length(trim(target_language_tag)) BETWEEN 1 AND 64),
  target_locale_override text
    CHECK (
      target_locale_override IS NULL
      OR length(trim(target_locale_override)) BETWEEN 1 AND 64
    ),
  preferred_register text
    CHECK (
      preferred_register IS NULL
      OR preferred_register IN ('NEUTRAL','FORMAL','INFORMAL')
    ),
  preference_version bigint NOT NULL DEFAULT 1
    CHECK (preference_version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES tenant_memberships(tenant_id, user_id)
);

ALTER TABLE translation_executions
  ADD COLUMN preferred_register text
    CHECK (
      preferred_register IS NULL
      OR preferred_register IN ('NEUTRAL','FORMAL','INFORMAL')
    );

DROP INDEX translation_executions_logical_idx;

CREATE UNIQUE INDEX translation_executions_logical_idx
  ON translation_executions(
    tenant_id,
    source_message_id,
    source_revision,
    recipient_user_id,
    target_language_tag,
    target_profile_version,
    COALESCE(preferred_register, ''),
    COALESCE(
      context_snapshot_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    ),
    strategy_version
  );

COMMIT;

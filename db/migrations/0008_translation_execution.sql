BEGIN;

CREATE TABLE translation_executions (
  tenant_id uuid NOT NULL,
  translation_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  source_message_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision >= 1),
  recipient_user_id uuid NOT NULL,
  target_language_tag text NOT NULL CHECK (length(trim(target_language_tag)) > 0),
  target_profile_version bigint NOT NULL CHECK (target_profile_version >= 1),
  context_snapshot_id uuid,
  strategy_version text NOT NULL CHECK (length(trim(strategy_version)) > 0),
  status text NOT NULL CHECK (
    status IN (
      'PENDING',
      'READY',
      'FAILED',
      'SOURCE_REQUIRED',
      'EXPIRED',
      'SUPERSEDED'
    )
  ),
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  superseded_at timestamptz,
  PRIMARY KEY (tenant_id, translation_id),
  FOREIGN KEY (tenant_id, conversation_id, source_message_id)
    REFERENCES message_metadata(tenant_id, conversation_id, message_id),
  FOREIGN KEY (tenant_id, source_message_id, source_revision)
    REFERENCES message_revisions(tenant_id, message_id, revision),
  FOREIGN KEY (tenant_id, conversation_id, recipient_user_id)
    REFERENCES conversation_members(tenant_id, conversation_id, user_id),
  CHECK (next_attempt_at IS NULL OR status = 'PENDING'),
  CHECK (
    (
      status = 'READY'
      AND ready_at IS NOT NULL
      AND superseded_at IS NULL
    )
    OR
    (
      status = 'SUPERSEDED'
      AND superseded_at IS NOT NULL
    )
    OR
    (
      status IN (
        'PENDING',
        'FAILED',
        'SOURCE_REQUIRED',
        'EXPIRED'
      )
      AND ready_at IS NULL
      AND superseded_at IS NULL
    )
  )
);

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

CREATE INDEX translation_executions_source_idx
  ON translation_executions(
    tenant_id,
    source_message_id,
    source_revision,
    status
  );

CREATE INDEX translation_executions_pending_idx
  ON translation_executions(
    status,
    next_attempt_at,
    created_at
  )
  WHERE status = 'PENDING';

CREATE TABLE provider_executions (
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  translation_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  provider_id text NOT NULL CHECK (length(trim(provider_id)) > 0),
  model_id text NOT NULL CHECK (length(trim(model_id)) > 0),
  provider_region text,
  status text NOT NULL CHECK (
    status IN (
      'STARTED',
      'SUCCEEDED',
      'FAILED',
      'TIMED_OUT',
      'RATE_LIMITED',
      'CANCELLED_LOGICALLY'
    )
  ),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  billed_cost_microunits bigint CHECK (
    billed_cost_microunits IS NULL
    OR billed_cost_microunits >= 0
  ),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_class text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, attempt_id),
  UNIQUE (tenant_id, translation_id, attempt_no),
  FOREIGN KEY (tenant_id, translation_id)
    REFERENCES translation_executions(tenant_id, translation_id),
  CHECK (
    (
      status = 'STARTED'
      AND completed_at IS NULL
    )
    OR
    (
      status <> 'STARTED'
      AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX provider_executions_translation_idx
  ON provider_executions(
    tenant_id,
    translation_id,
    attempt_no DESC
  );

ALTER TABLE delivery_envelopes
  ADD CONSTRAINT delivery_envelopes_translation_fk
  FOREIGN KEY (tenant_id, translation_id)
  REFERENCES translation_executions(tenant_id, translation_id);

COMMIT;

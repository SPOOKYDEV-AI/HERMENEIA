BEGIN;

ALTER TABLE conversation_members
  ADD COLUMN target_profile_version bigint NOT NULL DEFAULT 1
  CHECK (target_profile_version >= 1);

CREATE TABLE translation_executions (
  tenant_id uuid NOT NULL,
  translation_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  source_message_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision >= 1),
  recipient_user_id uuid NOT NULL,
  target_language_tag text NOT NULL,
  target_profile_version bigint NOT NULL CHECK (target_profile_version >= 1),
  context_snapshot_id uuid,
  strategy_version text NOT NULL,
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
  CHECK (status <> 'READY' OR ready_at IS NOT NULL),
  CHECK (status <> 'SUPERSEDED' OR superseded_at IS NOT NULL)
);

CREATE UNIQUE INDEX translation_executions_logical_uidx
  ON translation_executions(
    tenant_id,
    source_message_id,
    source_revision,
    recipient_user_id,
    target_profile_version,
    COALESCE(
      context_snapshot_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    ),
    strategy_version
  );

CREATE INDEX translation_executions_status_idx
  ON translation_executions(tenant_id, status, next_attempt_at, created_at);

CREATE TABLE provider_executions (
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  translation_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  provider_id text NOT NULL,
  model_id text NOT NULL,
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
    billed_cost_microunits IS NULL OR billed_cost_microunits >= 0
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
    status = 'STARTED'
    OR completed_at IS NOT NULL
  )
);

CREATE INDEX provider_executions_translation_idx
  ON provider_executions(tenant_id, translation_id, attempt_no DESC);

ALTER TABLE delivery_envelopes
  ADD CONSTRAINT delivery_envelopes_translation_fk
  FOREIGN KEY (tenant_id, translation_id)
  REFERENCES translation_executions(tenant_id, translation_id);

CREATE UNIQUE INDEX delivery_translation_per_device_idx
  ON delivery_envelopes(
    tenant_id,
    translation_id,
    recipient_device_id,
    recipient_credential_version
  )
  WHERE rendition_type = 'TRANSLATION';

ALTER TABLE device_inbox_events
  DROP CONSTRAINT IF EXISTS device_inbox_events_event_type_check;

ALTER TABLE device_inbox_events
  DROP CONSTRAINT IF EXISTS device_inbox_events_envelope_shape_check;

ALTER TABLE device_inbox_events
  ADD CONSTRAINT device_inbox_events_event_type_check
  CHECK (
    event_type IN (
      'message.available',
      'message.edited',
      'message.deleted',
      'translation.ready',
      'translation.failed',
      'translation.source_required',
      'translation.expired'
    )
  );

ALTER TABLE device_inbox_events
  ADD CONSTRAINT device_inbox_events_envelope_shape_check
  CHECK (
    (
      event_type IN (
        'message.available',
        'message.edited',
        'translation.ready'
      )
      AND envelope_id IS NOT NULL
    )
    OR
    (
      event_type IN (
        'message.deleted',
        'translation.failed',
        'translation.source_required',
        'translation.expired'
      )
      AND envelope_id IS NULL
    )
  );

COMMIT;

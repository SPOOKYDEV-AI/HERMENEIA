BEGIN;

CREATE FUNCTION hermeneia_context_jsonb_has_forbidden_key(document jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_path_exists(
    document,
    '$.**.keyvalue() ? (
      @.key == "raw_text"
      || @.key == "message_text"
      || @.key == "source_text"
      || @.key == "translated_text"
      || @.key == "transcript"
      || @.key == "messages"
      || @.key == "prompt"
      || @.key == "provider_output"
    )'
  )
$$;

CREATE TABLE conversation_context_states (
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  state_version bigint NOT NULL CHECK (state_version >= 1),
  processed_prefix_sequence bigint NOT NULL DEFAULT 0
    CHECK (processed_prefix_sequence >= 0),
  pending_operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  active_episode_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  terminology_claim_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  lexical_claim_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  correction_claim_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  entity_handles jsonb NOT NULL DEFAULT '[]'::jsonb,
  unresolved_reference_handles jsonb NOT NULL DEFAULT '[]'::jsonb,
  style_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  pragmatic_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  claim_set_version bigint NOT NULL DEFAULT 0
    CHECK (claim_set_version >= 0),
  glossary_set_version bigint NOT NULL DEFAULT 0
    CHECK (glossary_set_version >= 0),
  correction_set_version bigint NOT NULL DEFAULT 0
    CHECK (correction_set_version >= 0),
  membership_epoch bigint NOT NULL CHECK (membership_epoch >= 1),
  erasure_epoch bigint NOT NULL CHECK (erasure_epoch >= 1),
  policy_version bigint NOT NULL CHECK (policy_version >= 1),
  strategy_version text NOT NULL
    CHECK (
      length(strategy_version) BETWEEN 1 AND 80
      AND strategy_version ~ '^[A-Za-z0-9._:-]+$'
    ),
  state_schema_version integer NOT NULL DEFAULT 1
    CHECK (state_schema_version = 1),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','DEGRADED')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, conversation_id),
  CHECK (jsonb_typeof(pending_operations) = 'array'),
  CHECK (jsonb_typeof(active_episode_state) = 'object'),
  CHECK (jsonb_typeof(terminology_claim_refs) = 'array'),
  CHECK (jsonb_typeof(lexical_claim_refs) = 'array'),
  CHECK (jsonb_typeof(correction_claim_refs) = 'array'),
  CHECK (jsonb_typeof(entity_handles) = 'array'),
  CHECK (jsonb_typeof(unresolved_reference_handles) = 'array'),
  CHECK (jsonb_typeof(style_state) = 'object'),
  CHECK (jsonb_typeof(pragmatic_state) = 'object'),
  CHECK (octet_length(pending_operations::text) <= 65536),
  CHECK (octet_length(active_episode_state::text) <= 8192),
  CHECK (octet_length(terminology_claim_refs::text) <= 16384),
  CHECK (octet_length(lexical_claim_refs::text) <= 16384),
  CHECK (octet_length(correction_claim_refs::text) <= 16384),
  CHECK (octet_length(entity_handles::text) <= 16384),
  CHECK (octet_length(unresolved_reference_handles::text) <= 8192),
  CHECK (octet_length(style_state::text) <= 8192),
  CHECK (octet_length(pragmatic_state::text) <= 8192),
  CHECK (NOT hermeneia_context_jsonb_has_forbidden_key(pending_operations)),
  CHECK (NOT hermeneia_context_jsonb_has_forbidden_key(active_episode_state)),
  CHECK (NOT hermeneia_context_jsonb_has_forbidden_key(style_state)),
  CHECK (NOT hermeneia_context_jsonb_has_forbidden_key(pragmatic_state))
);

CREATE TABLE translation_repair_events (
  tenant_id uuid NOT NULL,
  repair_event_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  target_translation_id uuid,
  target_message_id uuid,
  target_source_revision integer,
  kind text NOT NULL CHECK (
    kind IN (
      'PROBLEM_REPORT',
      'EXPLICIT_CORRECTION',
      'MEANING_CORRECTION',
      'TONE_CORRECTION',
      'TERMINOLOGY_CORRECTION'
    )
  ),
  status text NOT NULL CHECK (
    status IN ('RECORDED','NEEDS_CONFIRMATION','APPLIED','REJECTED')
  ),
  structured_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, repair_event_id),
  UNIQUE (tenant_id, command_id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, conversation_id, actor_user_id)
    REFERENCES conversation_members(tenant_id, conversation_id, user_id),
  FOREIGN KEY (tenant_id, target_message_id, target_source_revision)
    REFERENCES message_revisions(tenant_id, message_id, revision),
  CHECK (
    (target_message_id IS NULL AND target_source_revision IS NULL)
    OR
    (target_message_id IS NOT NULL AND target_source_revision IS NOT NULL)
  ),
  CHECK (jsonb_typeof(structured_payload) = 'object'),
  CHECK (octet_length(structured_payload::text) <= 8192),
  CHECK (NOT hermeneia_context_jsonb_has_forbidden_key(structured_payload))
);

CREATE TABLE context_claims (
  tenant_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  claim_version integer NOT NULL CHECK (claim_version >= 1),
  conversation_id uuid,
  message_id uuid,
  subject_user_id uuid,
  claim_type text NOT NULL
    CHECK (length(trim(claim_type)) BETWEEN 1 AND 80),
  proposition_ref jsonb NOT NULL,
  modality text NOT NULL CHECK (
    modality IN (
      'ASSERTION',
      'QUESTION',
      'NEGATION',
      'HYPOTHESIS',
      'QUOTATION',
      'CORRECTION'
    )
  ),
  authority_class text NOT NULL CHECK (
    authority_class IN (
      'POLICY',
      'EXPLICIT_PREFERENCE',
      'APPROVED_GLOSSARY',
      'EXPLICIT_MESSAGE',
      'CONFIRMED_CORRECTION',
      'INFERRED',
      'HYPOTHESIS'
    )
  ),
  retention_class text NOT NULL CHECK (
    retention_class IN (
      'EPHEMERAL',
      'CORRECTIVE_DURABLE',
      'POLICY_REFERENCE'
    )
  ),
  sensitivity_class text NOT NULL DEFAULT 'NORMAL'
    CHECK (sensitivity_class IN ('NORMAL','RESTRICTED')),
  confidence numeric CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  scope_kind text NOT NULL CHECK (
    scope_kind IN ('TENANT','CONVERSATION')
  ),
  scope_conversation_id uuid,
  trigger_kind text,
  valid_from timestamptz,
  valid_until timestamptz,
  status text NOT NULL CHECK (
    status IN (
      'ACTIVE',
      'UNRESOLVED',
      'STALE',
      'CONTESTED',
      'INVALIDATED',
      'EXPIRED',
      'REVOKED'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, claim_id, claim_version),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, conversation_id),
  FOREIGN KEY (tenant_id, scope_conversation_id)
    REFERENCES conversations(tenant_id, conversation_id),
  FOREIGN KEY (subject_user_id)
    REFERENCES users(user_id),
  CHECK (jsonb_typeof(proposition_ref) = 'object'),
  CHECK (octet_length(proposition_ref::text) <= 8192),
  CHECK (NOT hermeneia_context_jsonb_has_forbidden_key(proposition_ref)),
  CHECK (
    (scope_kind = 'TENANT' AND scope_conversation_id IS NULL)
    OR
    (
      scope_kind = 'CONVERSATION'
      AND scope_conversation_id IS NOT NULL
      AND conversation_id = scope_conversation_id
    )
  ),
  CHECK (
    valid_until IS NULL
    OR valid_from IS NULL
    OR valid_until > valid_from
  ),
  CHECK (
    retention_class <> 'CORRECTIVE_DURABLE'
    OR (
      modality = 'CORRECTION'
      AND authority_class = 'CONFIRMED_CORRECTION'
      AND trigger_kind IN (
        'EXPLICIT_UI_CORRECTION',
        'EXPLICIT_TEXTUAL_CORRECTION',
        'APPROVED_GLOSSARY_CHANGE',
        'TENANT_POLICY_CHANGE'
      )
    )
  )
);

CREATE INDEX context_claims_conversation_status_idx
  ON context_claims(
    tenant_id,
    conversation_id,
    retention_class,
    status,
    created_at DESC
  )
  WHERE conversation_id IS NOT NULL;

CREATE INDEX context_claims_scope_status_idx
  ON context_claims(
    tenant_id,
    scope_kind,
    scope_conversation_id,
    status
  );

CREATE TABLE provenance_edges (
  tenant_id uuid NOT NULL,
  provenance_edge_id uuid NOT NULL,
  derived_claim_id uuid NOT NULL,
  derived_claim_version integer NOT NULL,
  relation text NOT NULL CHECK (
    relation IN (
      'EXTRACTED_FROM',
      'INFERRED_FROM',
      'CORRECTED_BY',
      'INVALIDATED_BY',
      'OVERRIDDEN_BY'
    )
  ),
  source_message_id uuid,
  source_revision integer,
  source_claim_id uuid,
  source_claim_version integer,
  source_repair_event_id uuid,
  strategy_version text NOT NULL
    CHECK (length(trim(strategy_version)) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provenance_edge_id),
  FOREIGN KEY (tenant_id, derived_claim_id, derived_claim_version)
    REFERENCES context_claims(tenant_id, claim_id, claim_version),
  FOREIGN KEY (tenant_id, source_message_id, source_revision)
    REFERENCES message_revisions(tenant_id, message_id, revision),
  FOREIGN KEY (tenant_id, source_claim_id, source_claim_version)
    REFERENCES context_claims(tenant_id, claim_id, claim_version),
  FOREIGN KEY (tenant_id, source_repair_event_id)
    REFERENCES translation_repair_events(tenant_id, repair_event_id),
  CHECK (
    (
      CASE
        WHEN source_message_id IS NOT NULL
         AND source_revision IS NOT NULL
        THEN 1 ELSE 0
      END
      +
      CASE
        WHEN source_claim_id IS NOT NULL
         AND source_claim_version IS NOT NULL
        THEN 1 ELSE 0
      END
      +
      CASE
        WHEN source_repair_event_id IS NOT NULL
        THEN 1 ELSE 0
      END
    ) = 1
  ),
  CHECK (
    (source_message_id IS NULL) = (source_revision IS NULL)
  ),
  CHECK (
    (source_claim_id IS NULL) = (source_claim_version IS NULL)
  )
);

CREATE INDEX provenance_edges_source_message_idx
  ON provenance_edges(
    tenant_id,
    source_message_id,
    source_revision
  )
  WHERE source_message_id IS NOT NULL;

CREATE INDEX provenance_edges_source_claim_idx
  ON provenance_edges(
    tenant_id,
    source_claim_id,
    source_claim_version
  )
  WHERE source_claim_id IS NOT NULL;

CREATE INDEX provenance_edges_source_repair_idx
  ON provenance_edges(
    tenant_id,
    source_repair_event_id
  )
  WHERE source_repair_event_id IS NOT NULL;

CREATE TABLE recovery_checkpoints (
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  checkpoint_version bigint NOT NULL CHECK (checkpoint_version >= 1),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  context_strategy_version text NOT NULL
    CHECK (length(trim(context_strategy_version)) BETWEEN 1 AND 80),
  base_context_state_version bigint NOT NULL
    CHECK (base_context_state_version >= 1),
  processed_prefix_sequence bigint NOT NULL
    CHECK (processed_prefix_sequence >= 0),
  processing_gap_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  membership_epoch bigint NOT NULL CHECK (membership_epoch >= 1),
  erasure_epoch bigint NOT NULL CHECK (erasure_epoch >= 1),
  policy_version bigint NOT NULL CHECK (policy_version >= 1),
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'CANDIDATE',
      'ACTIVE',
      'SUPERSEDED',
      'INVALIDATED',
      'CORRUPT'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, conversation_id, checkpoint_version),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, conversation_id),
  CHECK (expires_at > created_at),
  CHECK (jsonb_typeof(processing_gap_manifest) = 'array'),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (octet_length(processing_gap_manifest::text) <= 32768),
  CHECK (octet_length(payload::text) <= 65536),
  CHECK (NOT hermeneia_context_jsonb_has_forbidden_key(processing_gap_manifest)),
  CHECK (NOT hermeneia_context_jsonb_has_forbidden_key(payload))
);

CREATE UNIQUE INDEX recovery_checkpoints_one_active_idx
  ON recovery_checkpoints(tenant_id, conversation_id)
  WHERE status = 'ACTIVE';

CREATE INDEX recovery_checkpoints_expiry_idx
  ON recovery_checkpoints(expires_at)
  WHERE status IN ('CANDIDATE','ACTIVE','SUPERSEDED');

COMMIT;

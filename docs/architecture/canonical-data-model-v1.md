# Canonical Domain & Data Model — V1

**Status:** Canonical pre-migration contract  
**Scope:** Core Messaging V1 + Translation Baseline V1 + minimal Context Research V1

This document defines the logical persistence model and invariants that future PostgreSQL migrations must implement.

It deliberately does **not** define ORM classes or choose the backend runtime.

## 1. Global conventions

### Identifiers

Use opaque UUID identifiers.

Identifiers never imply:

- ordering;
- authorisation;
- creation time;
- tenant ownership.

### Tenant boundary

Every business object belongs to a `tenant_id`.

A conversation belongs to exactly one tenant.

Business foreign keys should include `tenant_id` wherever this prevents accidental cross-tenant relationships.

A consumer deployment may use a shared logical tenant, but conversation membership remains an independent authorisation boundary.

### Time

Server timestamps are UTC.

Client-authored time is optional declarative metadata and never determines authoritative ordering.

### Concurrency

Use explicit numeric versions/epochs for compare-and-swap.

Never use `updated_at` as a concurrency token.

### Plaintext

No canonical durable Core table contains the original plaintext message body by default.

The durable source body belongs to the authorised client/customer history layer.

## 2. Three independent orders

HERMENEIA has three independent ordering domains.

### message_seq

Monotonic per conversation.

Orders newly accepted logical messages only.

### op_seq

Monotonic per conversation.

Orders mutations relevant to conversation state:

- create;
- edit;
- delete;
- correction;
- membership/context-invalidating operations when required.

### device inbox offset

Monotonic within a device inbox epoch.

Orders delivery/synchronisation events for one device.

These numbers are not interchangeable.

## 3. Entity catalogue

### 3.1 User

Purpose: global identity anchor.

Fields:

    user_id UUID PK
    status enum(ACTIVE, SUSPENDED, DELETED)
    default_language_tag text nullable
    created_at timestamptz
    deleted_at timestamptz nullable

No conversation authorisation is inferred from User existence.

### 3.2 Tenant

Purpose: policy/data boundary.

Fields:

    tenant_id UUID PK
    kind enum(CONSUMER_SHARED, ORGANISATION)
    status enum(ACTIVE, SUSPENDED, DELETED)
    home_region text
    policy_version bigint
    erasure_epoch bigint
    created_at timestamptz

Future Workspace is deferred until a requirement distinguishes it from Tenant.

### 3.3 TenantMembership

Fields:

    tenant_id UUID
    user_id UUID
    role enum(MEMBER, ADMIN, OWNER)
    status enum(ACTIVE, REVOKED)
    joined_at timestamptz
    revoked_at timestamptz nullable

PK:

    (tenant_id, user_id)

FKs:

    tenant_id -> Tenant
    user_id -> User

### 3.4 Device

Purpose: delivery target and client-security lifecycle.

Fields:

    device_id UUID PK
    user_id UUID
    status enum(ACTIVE, REVOKED, LOST)
    credential_version bigint
    public_material_ref text
    revocation_epoch bigint
    registered_at timestamptz
    revoked_at timestamptz nullable
    last_seen_at timestamptz nullable

Indexes:

    (user_id, status)

The exact credential/key material format is defined by the later reviewed implementation.

### 3.5 Session

Purpose: revocable authenticated session distinct from device identity.

Fields:

    session_id UUID PK
    user_id UUID
    device_id UUID
    access_credential_ref text unique
    refresh_secret_hash text unique
    status enum(ACTIVE, REVOKED, EXPIRED)
    issued_at timestamptz
    expires_at timestamptz
    revoked_at timestamptz nullable

Indexes:

    (user_id, status)
    (device_id, status)
    expires_at

### 3.6 Conversation

Fields:

    tenant_id UUID
    conversation_id UUID
    kind enum(DIRECT)
    status enum(ACTIVE, CLOSED, DELETED)
    home_region text
    next_message_seq bigint
    next_op_seq bigint
    membership_epoch bigint
    erasure_epoch bigint
    policy_version bigint
    created_at timestamptz
    deleted_at timestamptz nullable

PK:

    (tenant_id, conversation_id)

V1 has one logical writer region per conversation.

### 3.7 ConversationMember

Fields:

    tenant_id UUID
    conversation_id UUID
    user_id UUID
    role enum(MEMBER, MODERATOR)
    status enum(ACTIVE, LEFT, REMOVED, BLOCKED)
    joined_at timestamptz
    left_at timestamptz nullable
    target_language_tag text nullable
    target_locale_override text nullable
    read_message_seq bigint
    membership_version bigint

PK:

    (tenant_id, conversation_id, user_id)

FK must prove the User belongs to the same Tenant where required by product profile.

Current membership does not automatically grant access to historical content that predates authorised membership.

### 3.8 MessageMetadata

Purpose: durable identity/ordering of a logical source message without storing plaintext body.

Fields:

    tenant_id UUID
    message_id UUID
    conversation_id UUID
    author_user_id UUID
    author_device_id UUID
    client_message_id UUID
    message_seq bigint
    current_revision integer
    status enum(ACTIVE, DELETED)
    reply_to_message_id UUID nullable
    accepted_at timestamptz
    client_authored_at timestamptz nullable
    deleted_at timestamptz nullable

PK:

    (tenant_id, message_id)

Unique:

    (tenant_id, conversation_id, message_seq)
    (tenant_id, author_user_id, client_message_id)

Indexes:

    (tenant_id, conversation_id, message_seq)
    (tenant_id, author_user_id, accepted_at desc)

A reply target must belong to the same conversation.

### 3.9 MessageRevision

Purpose: immutable metadata for source mutations.

Fields:

    tenant_id UUID
    message_id UUID
    revision integer
    op_seq bigint
    mutation_type enum(CREATED, EDITED, DELETED)
    actor_user_id UUID
    source_hash text nullable
    declared_source_language text nullable
    created_at timestamptz

PK:

    (tenant_id, message_id, revision)

Unique:

    (tenant_id, conversation_id-derived, op_seq) through validated relation/constraint strategy

No plaintext body is stored here.

`source_hash` identifies an exact authorised source revision for re-supply; it is not anonymisation.

### 3.10 ContextSnapshot

Purpose: immutable causal manifest used for one logical translation.

Fields:

    tenant_id UUID
    snapshot_id UUID
    conversation_id UUID
    source_message_id UUID
    source_revision integer
    strategy_version text
    context_state_version bigint
    processed_prefix_sequence bigint
    processing_gap_manifest jsonb
    selected_source_revision_refs jsonb
    selected_claim_refs jsonb
    correction_set_version bigint
    glossary_set_version bigint
    membership_epoch bigint
    erasure_epoch bigint
    policy_version bigint
    degraded boolean
    token_estimate integer
    created_at timestamptz

PK:

    (tenant_id, snapshot_id)

No raw selected text is required in the durable manifest.

### 3.11 TranslationExecution

Purpose: one logical target rendition.

Fields:

    tenant_id UUID
    translation_id UUID
    conversation_id UUID
    source_message_id UUID
    source_revision integer
    recipient_user_id UUID
    target_language_tag text
    target_profile_version bigint
    context_snapshot_id UUID
    strategy_version text
    status enum(PENDING, READY, FAILED, SOURCE_REQUIRED, EXPIRED, SUPERSEDED)
    next_attempt_at timestamptz nullable
    created_at timestamptz
    ready_at timestamptz nullable
    superseded_at timestamptz nullable

PK:

    (tenant_id, translation_id)

Logical uniqueness:

    source revision
    + recipient/cohort identity
    + target profile version
    + context snapshot
    + translation strategy version

The exact unique index may use a derived stable cohort key.

### 3.12 ProviderExecution

Purpose: concrete provider attempt, separate from logical TranslationExecution.

Fields:

    tenant_id UUID
    attempt_id UUID
    translation_id UUID
    attempt_no integer
    provider_id text
    model_id text
    provider_region text nullable
    status enum(STARTED, SUCCEEDED, FAILED, TIMED_OUT, RATE_LIMITED, CANCELLED_LOGICALLY)
    input_tokens integer nullable
    output_tokens integer nullable
    billed_cost_microunits bigint nullable
    latency_ms integer nullable
    error_class text nullable
    started_at timestamptz
    completed_at timestamptz nullable

PK:

    (tenant_id, attempt_id)

Unique:

    (tenant_id, translation_id, attempt_no)

No prompt/body in routine durable execution logs.

### 3.13 DeliveryEnvelope

Purpose: durable per-device delivery unit.

Fields:

    tenant_id UUID
    envelope_id UUID
    conversation_id UUID
    message_id UUID
    source_revision integer
    translation_id UUID nullable
    recipient_user_id UUID
    recipient_device_id UUID
    recipient_credential_version bigint
    rendition_type enum(ORIGINAL, TRANSLATION)
    protected_payload bytea/blob
    status enum(PENDING, ACKED, EXPIRED, REVOKED)
    created_at timestamptz
    expires_at timestamptz
    acked_at timestamptz nullable

PK:

    (tenant_id, envelope_id)

Unique:

    rendition identity
    + recipient_device_id
    + recipient_credential_version

Indexes:

    (recipient_device_id, status, created_at)
    expires_at

ACK is per envelope/device.

### 3.14 CommandReceipt

Purpose: durable command-status/idempotency lookup for transport retries where the client may have lost the original response.

Fields:

    tenant_id UUID
    command_id UUID
    actor_user_id UUID
    actor_device_id UUID
    command_type text
    status enum(IN_PROGRESS, SUCCEEDED, FAILED)
    result_ref jsonb
    created_at timestamptz
    updated_at timestamptz

PK:

    (tenant_id, command_id)

`result_ref` is bounded structured result metadata and must not contain a raw message transcript.

### 3.15 DeviceSyncState

Fields:

    device_id UUID PK
    inbox_epoch bigint
    next_offset bigint
    last_acked_offset bigint
    updated_at timestamptz

Changing/resetting the inbox increments `inbox_epoch`.

### 3.16 DeviceInboxEvent

Purpose: ordered sync/realtime journal per device.

Fields:

    device_id UUID
    inbox_epoch bigint
    offset bigint
    event_id UUID
    event_type text
    tenant_id UUID
    conversation_id UUID nullable
    message_id UUID nullable
    envelope_id UUID nullable
    metadata jsonb
    created_at timestamptz
    expires_at timestamptz nullable

PK:

    (device_id, inbox_epoch, offset)

Unique:

    event_id

`metadata` is schema-bounded and must not become a hidden transcript.

### 3.17 ConversationContextState

Purpose: current bounded derived projection.

Fields:

    tenant_id UUID
    conversation_id UUID
    state_version bigint
    processed_prefix_sequence bigint
    processing_gaps jsonb
    active_episode_state jsonb
    terminology_state jsonb
    lexical_state jsonb
    style_state jsonb
    pragmatic_state jsonb
    claim_set_version bigint
    glossary_set_version bigint
    correction_set_version bigint
    membership_epoch bigint
    erasure_epoch bigint
    policy_version bigint
    state_schema_version integer
    updated_at timestamptz

PK:

    (tenant_id, conversation_id)

Writes require CAS on `state_version` plus epoch compatibility.

The projection is bounded and may be partially restorable, not universally rebuildable.

### 3.18 ContextClaim

Purpose: structured assertion with explicit authority/provenance semantics.

Fields:

    tenant_id UUID
    claim_id UUID
    claim_version integer
    conversation_id UUID nullable
    message_id UUID nullable
    subject_user_id UUID nullable
    claim_type text
    proposition_ref/jsonb
    modality enum(ASSERTION, QUESTION, NEGATION, HYPOTHESIS, QUOTATION, CORRECTION)
    authority_class enum(POLICY, EXPLICIT_PREFERENCE, APPROVED_GLOSSARY, EXPLICIT_MESSAGE, CONFIRMED_CORRECTION, INFERRED, HYPOTHESIS)
    retention_class enum(EPHEMERAL, CORRECTIVE_DURABLE, POLICY_REFERENCE)
    sensitivity_class enum(NORMAL, RESTRICTED)
    confidence numeric nullable
    valid_from timestamptz nullable
    valid_until timestamptz nullable
    status enum(ACTIVE, UNRESOLVED, STALE, CONTESTED, INVALIDATED, EXPIRED, REVOKED)
    created_at timestamptz

PK:

    (tenant_id, claim_id, claim_version)

Scope must be represented through explicit typed columns/constraints, not an unconstrained `scope_type/scope_id` pair.

`CORRECTIVE_DURABLE` requires an authorised repair/glossary/policy trigger.

### 3.19 ProvenanceEdge

Purpose: bounded dependency graph for invalidation.

Fields:

    tenant_id UUID
    provenance_edge_id UUID
    derived_claim_id UUID
    derived_claim_version integer
    relation enum(EXTRACTED_FROM, INFERRED_FROM, CORRECTED_BY, INVALIDATED_BY, OVERRIDDEN_BY)

Exactly one typed source family must be populated:

    source_message_id + source_revision
    OR source_claim_id + source_claim_version
    OR source_repair_event_id
    OR source_glossary_entry_id + source_glossary_version

Created_at timestamptz.

Reverse indexes from each source family to derived claims are required.

### 3.20 TranslationRepairEvent

Purpose: capture feedback/repair without assuming a correction exists.

Fields:

    tenant_id UUID
    repair_event_id UUID
    conversation_id UUID
    actor_user_id UUID
    target_translation_id UUID nullable
    target_message_id UUID nullable
    target_source_revision integer nullable
    kind enum(PROBLEM_REPORT, EXPLICIT_CORRECTION, MEANING_CORRECTION, TONE_CORRECTION, TERMINOLOGY_CORRECTION)
    status enum(RECORDED, NEEDS_CONFIRMATION, APPLIED, REJECTED)
    structured_payload jsonb
    command_id UUID
    created_at timestamptz

Unique:

    (tenant_id, command_id)

A vague problem report creates no durable semantic correction by itself.

### 3.21 CorrectionMemory

CorrectionMemory is a **logical subtype of ContextClaim**, not a generic table.

Requirements:

    retention_class = CORRECTIVE_DURABLE
    modality = CORRECTION
    provenance includes authorised TranslationRepairEvent / approved source
    explicit bounded scope
    actor authorisation validated

There is intentionally no generic persistent `MemoryItem` table in V1.

### 3.22 GlossaryEntry

Fields:

    tenant_id UUID
    entry_id UUID
    version integer
    scope_kind enum(TENANT, CONVERSATION)
    scope_conversation_id UUID nullable
    source_language_tag text
    target_language_tag text nullable
    source_term text
    normalized_term text
    definition jsonb
    target_equivalents jsonb
    preserve_policy enum(TRANSLATE, PRESERVE, EXPAND_ONCE, APPROVED_EQUIVALENT)
    status enum(DRAFT, APPROVED, SUPERSEDED, REVOKED)
    approved_by UUID nullable
    created_at timestamptz
    valid_from timestamptz nullable
    valid_until timestamptz nullable

PK:

    (tenant_id, entry_id, version)

Scope CHECK:

    TENANT => scope_conversation_id IS NULL
    CONVERSATION => scope_conversation_id IS NOT NULL

Project/team scope is deferred until the domain contains a real Project/Workspace entity.

### 3.23 RecoveryCheckpoint

Fields:

    tenant_id UUID
    conversation_id UUID
    checkpoint_version bigint
    schema_version integer
    context_strategy_version text
    base_context_state_version bigint
    processed_prefix_sequence bigint
    processing_gap_manifest jsonb
    membership_epoch bigint
    erasure_epoch bigint
    policy_version bigint
    payload jsonb
    status enum(CANDIDATE, ACTIVE, SUPERSEDED, INVALIDATED, CORRUPT)
    created_at timestamptz
    expires_at timestamptz

PK:

    (tenant_id, conversation_id, checkpoint_version)

Only one ACTIVE pointer/state per conversation.

Publication is conditional on all base versions/epochs still matching.

### 3.24 OutboxJob

Purpose: durable server-side work queue using PostgreSQL initially.

Fields:

    job_id UUID PK
    tenant_id UUID
    job_type text
    business_key text
    payload_ref jsonb
    priority smallint
    status enum(AVAILABLE, LEASED, DONE, DEAD)
    available_at timestamptz
    lease_until timestamptz nullable
    fencing_token bigint
    attempt_count integer
    created_at timestamptz
    completed_at timestamptz nullable

Unique:

    (tenant_id, job_type, business_key)

Workers may use leases/`SKIP LOCKED`, but correctness still relies on idempotent effects and publication guards.

### 3.25 DeletionLedger

Purpose: prevent resurrection after restore/replay.

Fields:

    tenant_id UUID
    deletion_id UUID
    scope_kind enum(USER, CONVERSATION, MESSAGE, DEVICE)
    user_id UUID nullable
    conversation_id UUID nullable
    message_id UUID nullable
    device_id UUID nullable
    erasure_epoch bigint
    requested_at timestamptz
    applied_at timestamptz nullable
    status enum(PENDING, APPLIED, FAILED)

Exactly one typed target is required.

No deleted content is stored.

### 3.26 UsageLedger

Purpose: budget and cost admission.

Fields:

    tenant_id UUID
    usage_id UUID
    category enum(PROVIDER, NETWORK_EGRESS, DELIVERY, OTHER)
    provider_id text nullable
    model_id text nullable
    units bigint
    cost_microunits bigint nullable
    occurred_at timestamptz
    translation_id UUID nullable

Indexes support tenant/day/provider aggregation.

## 4. Value objects, not first-class tables in V1

### EpisodeState

Contained inside ConversationContextState/checkpoint.

### TargetLanguageProfile

Derived from:

- User default;
- ConversationMember override;
- tenant policy;
- explicit current request constraints.

### ConversationStyleProfileBySpeakerOrDirection

Ephemeral/working value object keyed by speaker and optionally recipient direction.

Not a durable personal profile.

### NetworkProfile

Client-local runtime value object.

### Draft / DraftFragment

Client-local/experimental. Not a Core V1 durable table.

## 5. Sequence allocation

### New message

Within one short PostgreSQL transaction:

1. lock/update Conversation sequence counters;
2. allocate `message_seq`;
3. allocate create `op_seq`;
4. write MessageMetadata + MessageRevision;
5. write DeliveryEnvelope rows;
6. append DeviceInboxEvent rows using each device inbox counter;
7. write OutboxJob rows;
8. commit;
9. only then return `ACCEPTED`.

No provider/network AI call occurs under the transaction lock.

### Edit/delete/correction

Allocate `op_seq` from the conversation counter and publish a new immutable operation/revision.

## 6. Publication guard

Before any derived translation/rendition becomes visible:

    source revision is still current
    AND source is not deleted
    AND recipient/device remains authorised
    AND membership epoch matches or remains admissible
    AND erasure epoch matches
    AND processing policy remains allowed
    AND referenced correction/glossary versions remain valid
    AND execution is not superseded
    AND result validates against output schema

A message arriving later does not by itself invalidate an older causal snapshot.

## 7. Context causal frontier

`processed_prefix_sequence` means all required context operations through that message sequence have been incorporated.

Out-of-order completions above the prefix remain represented in `processing_gaps`/pending state.

The prefix may advance only when the contiguous gap closes.

For translation of message N:

- contextual conversation sources are causally prior to N;
- current source N is included separately;
- N+1 and later are forbidden.

## 8. Initial retention/budget configuration

These are **experimental defaults**, not validated promises:

    Core transient plaintext:
      max 5 minutes
      bounded by conversation count/bytes and global pressure

    RecoveryCheckpoint:
      active + previous
      bounded payload
      max age configurable; restoration never resets original expiry

    DeliveryEnvelope:
      until ACK/revocation/deletion or configured max TTL

    technical traces:
      no message/prompt/output plaintext

    durable correction:
      bounded structured value + provenance
      revocable/expirable

Exact limits belong to deployment policy and must be measured.

## 9. Deferred decisions

Not required before migrations:

- partitioning strategy;
- Redis;
- pgvector;
- Workspace/Project entity;
- group translation cohorts;
- multi-region active-active;
- generic CRDT;
- speculative draft persistence.

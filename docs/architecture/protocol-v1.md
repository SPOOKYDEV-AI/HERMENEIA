# API & Realtime Protocol — V1

**Status:** Canonical pre-implementation contract  
**Transport:** HTTP commands + WebSocket events + long-poll sync fallback  
**Rule:** business semantics are transport-independent

## 1. Principles

- session identity determines user/device/tenant context; clients do not self-assert trusted identities;
- every command has a stable `command_id`;
- Send has a stable `client_message_id`;
- transport retries are expected;
- server effects are idempotent;
- realtime event delivery and historical message backup are separate concerns;
- translation status is independent from message acceptance/delivery;
- all errors are typed and retry semantics are explicit.

## 2. Command envelope

Conceptual shape:

    {
      "protocol_version": 1,
      "command_id": "uuid",
      "type": "message.send",
      "conversation_id": "uuid",
      "payload": { ... }
    }

Trusted identity fields are derived from the authenticated session.

## 3. Server event envelope

Conceptual shape:

    {
      "protocol_version": 1,
      "event_id": "uuid",
      "cursor": "opaque-device-cursor",
      "type": "translation.ready",
      "server_time": "RFC3339",
      "tenant_id": "uuid",
      "conversation_id": "uuid|null",
      "payload": { ... }
    }

The same event shape is used by WebSocket and long-poll sync.

## 4. Commands / endpoints

### 4.1 Send message

    POST /v1/conversations/{conversation_id}/messages

Request:

    command_id
    client_message_id
    source.text
    source.language_hint? (BCP47)
    reply_to_message_id?
    client_authored_at?

Response after durable commit:

    status = ACCEPTED
    message_id
    message_seq
    source_revision
    accepted_at
    translation_status

Idempotency:

- same `client_message_id` is replayable only when the original logical Send still matches: conversation, revision-1 source fingerprint, reply target and client-authored instant;
- same logical key with different semantics => `409 IDEMPOTENCY_CONFLICT`.

Provider translation never gates this response.

### 4.2 Command status

    GET /v1/commands/{command_id}

Used after client timeout when the server may have committed.

Returns:

    UNKNOWN | IN_PROGRESS | SUCCEEDED | FAILED

with the original logical result when available.

### 4.3 Sync / long poll

    GET /v1/sync?cursor={cursor}&limit={n}&wait_ms={ms}

Returns ordered tenant-and-device-scoped events and the next opaque cursor.

A missing/expired epoch returns `SYNC_RESET_REQUIRED`.

### 4.4 Realtime

    GET /v1/realtime

Upgrade/connection mechanism is implementation-specific.

The application event schema remains identical to /sync.

### 4.5 Delivery ACK

    POST /v1/delivery/acks

Request contains bounded list of:

    envelope_id
    persisted_at

The client sends ACK only after the envelope/rendition is committed to local durable storage.

ACK is idempotent. Server purge-watermark advancement is tenant/device scoped and may advance only across a contiguous prefix of terminal envelope states; an ACK arriving out of order cannot skip an earlier pending delivery.

### 4.6 Read cursor

    PUT /v1/conversations/{conversation_id}/read-cursor

Request:

    expected_membership_version?
    read_message_seq

Read state is distinct from per-device delivery state.

### 4.7 Edit message

    PATCH /v1/messages/{message_id}

Request:

    command_id
    expected_revision
    source.text
    source.language_hint?

Success creates a new immutable source revision and `op_seq`, revokes stale pending delivery envelopes and supersedes stale translation work before publishing the fresh revision.

A stale revision returns `REVISION_CONFLICT`.

### 4.8 Delete message

    DELETE /v1/messages/{message_id}

Request:

    command_id
    expected_revision

Success creates a content-free tombstone mutation, revokes stale pending delivery envelopes and invalidates publication of stale derived work.

### 4.9 Translation feedback

    POST /v1/translations/{translation_id}/feedback

Examples:

    PROBLEM
    WRONG_MEANING
    WRONG_TONE
    TERMINOLOGY
    OTHER

A feedback event does not automatically create durable semantic memory.

### 4.10 Structured correction

    POST /v1/conversations/{conversation_id}/corrections

Request explicitly identifies:

    target message/revision or translation
    correction kind
    bounded corrected structure
    requested scope

Server authorisation determines the maximum scope the actor may mutate.

### 4.11 Source re-supply

    POST /v1/translations/{translation_id}/source

Used only for a `SOURCE_REQUIRED` translation.

Request:

    message_id
    source_revision
    source_hash
    source.text
    language_hint?

Mismatched revision/hash => `SOURCE_REVISION_MISMATCH`.

### 4.12 Translation retry

    POST /v1/translations/{translation_id}/retry

Retry is subject to:

    current source availability
    policy
    quota/budget
    execution status

### 4.13 Language preferences

    PUT /v1/me/language-preferences

Stores explicit user defaults.

Conversation-specific target override may be updated through a conversation-member preference endpoint.

### 4.14 Device management

Required protocol families:

    POST /v1/devices
    GET  /v1/devices
    POST /v1/devices/{device_id}/revoke

Enrollment is authenticated and binds a device delivery identity to the current user.

### 4.15 Glossary management

CRUD is versioned and authorisation-scoped.

V1 approved scopes:

    TENANT
    CONVERSATION

Project/workspace scope is deferred until the domain includes those entities.

### 4.16 Draft speculation

Reserved experimental namespace:

    /v1/experimental/drafts/...

Disabled in Core V1.

## 5. Required server events

### Messaging

    message.accepted
    message.available
    message.edited
    message.deleted

### Translation

    translation.pending
    translation.ready
    translation.failed
    translation.source_required
    translation.expired

### Delivery/sync

    delivery.expired
    sync.reset_required

### Membership/preferences

    membership.changed
    preferences.changed
    device.revoked

Optional sender-facing state events may report device delivery/read aggregation without changing envelope ACK semantics.

## 6. Message state machine

Client local:

    QUEUED_LOCAL
      -> SENDING
      -> ACCEPTED

On transient network failure before known result:

    SENDING
      -> RETRY_WAIT
      -> SENDING

After permanent policy/auth failure:

    -> FAILED_PERMANENT

`ACCEPTED` is terminal for the logical Send acceptance operation.

Later edit/delete are separate operations.

## 7. Translation state machine

    NOT_REQUESTED
      -> PENDING
      -> READY

Failure branches:

    PENDING -> FAILED
    PENDING -> SOURCE_REQUIRED
    PENDING -> EXPIRED
    PENDING -> SUPERSEDED

Retry may move:

    FAILED -> PENDING
    SOURCE_REQUIRED -> PENDING after exact source re-supply

A READY result can later be superseded by a new source revision/profile decision without rewriting the old execution record.

## 8. Device delivery state machine

Per envelope:

    PENDING
      -> ACKED
      -> terminal

or:

    PENDING -> EXPIRED
    PENDING -> REVOKED

ACK from Device A has no effect on Device B's envelope.

## 9. Sync transaction rule

Client event application is one local transaction:

1. verify event ID not already applied;
2. apply event/rendition mutation;
3. persist any received envelope content;
4. update the tenant/device cursor;
5. commit;
6. ACK delivery envelope if applicable.

Cursor advance before local persistence is forbidden.

## 10. Cursor reset

If the server can no longer honour a cursor:

    SYNC_RESET_REQUIRED

The reset response may include:

- current authorised membership/conversation metadata;
- pending relay envelopes still retained;
- current preferences/policy refs;
- new inbox epoch/cursor.

It does **not** promise to recreate raw historical message bodies that have expired from authorised sources.

## 11. Causal translation publication

A provider result is not visible merely because the provider returned success.

Before publishing `translation.ready`, verify:

    source_revision == current_revision
    message not deleted
    recipient still authorised
    membership/erasure/policy epochs admissible
    referenced corrections/glossaries still valid
    translation execution not superseded
    output schema valid

If any condition fails:

    discard logical publication
    record execution outcome
    schedule a newer execution only if policy/source allow

## 12. Error model

Every API error has:

    code
    message
    retryable boolean
    retry_after_ms optional
    details bounded object optional

Required codes:

    IDEMPOTENCY_CONFLICT
    REVISION_CONFLICT
    NOT_AUTHORIZED
    DEVICE_REVOKED
    SOURCE_REQUIRED
    SOURCE_EXPIRED
    SOURCE_REVISION_MISMATCH
    SYNC_CURSOR_EXPIRED
    SYNC_RESET_REQUIRED
    POLICY_REJECTED
    QUOTA_EXCEEDED
    PROVIDER_UNAVAILABLE
    DELIVERY_EXPIRED
    INVALID_COMMAND
    PAYLOAD_TOO_LARGE
    NOT_FOUND
    INTERNAL_ERROR

Policy rejection never falls back to a less restrictive provider.

## 13. Transport retry ownership

### Client command retries

Owned by Network Orchestrator.

Uses:

    bounded exponential backoff
    jitter
    Retry-After
    stable command/client message IDs

### Provider retries

Owned only by Translation Orchestrator/Provider Router.

Provider SDK implicit retries must be known/controlled to avoid multiplicative retry storms.

### Worker retries

Owned by OutboxJob execution policy.

At-least-once worker execution + idempotent effects + publication fencing.

## 14. Priority classes

    P0  Send, durable acceptance, delivery ACK, auth/recovery required by P0
    P1  original delivery, final translation
    P2  context enrichment required for future quality
    P3  experimental speculation
    P4  optional telemetry/maintenance

Dependency work inherits the priority of the operation it blocks.

## 15. Versioning

Every command/event includes:

    protocol_version

Breaking changes require a new version or explicit backward-compatible negotiation.

Domain versions remain separate:

    source_revision
    context_state_version
    policy_version
    membership_epoch
    erasure_epoch
    target_profile_version
    strategy_version

## 16. Security invariants

- tenant/user/device identity comes from authenticated server session context;
- client payload IDs never grant access;
- all conversation/message commands re-check membership;
- device revocation affects pending/new delivery;
- corrections/glossary mutations require explicit action authorisation;
- ordinary chat text cannot grant tenant/admin authority;
- rate limits and quotas apply before expensive provider work.

## 17. Protocol acceptance scenarios

Core protocol is not ready until tests can express:

### Scenario A — lost response after commit

1. sender stores local outbox item;
2. server commits Send;
3. response connection drops;
4. sender retries same ID;
5. server returns original acceptance;
6. recipient comes online;
7. recipient receives exactly one visible original.

AI unavailable throughout.

### Scenario B — recipient offline

Message remains deliverable until ACK/expiry/revocation according to relay policy.

### Scenario C — edit while translation in flight

Old provider response is recorded but never published.

### Scenario D — delete while checkpoint/worker in flight

Old erasure epoch fails publication and cannot resurrect content.

### Scenario E — translation source expires

Original remains deliverable; translation enters SOURCE_REQUIRED rather than fabricating source.

### Scenario F — device ACK isolation

ACK from one device does not remove another device's envelope.

### Scenario G — cursor expiry

Client receives controlled reset without losing its local history or being promised unavailable server history.

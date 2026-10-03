# Data Lifecycle — V1

**Status:** Canonical contract  
**Scope:** plaintext source, metadata, delivery envelopes, derived context, corrections, checkpoints, deletion

## 1. Data classes

### A. Client-owned durable history

Examples:

    original plaintext messages
    received translations
    local outbox
    drafts
    local sync cursor

Default owner: authorised client/customer-controlled store.

### B. Core transient source

Examples:

    current source text
    bounded immediate context supplied for current processing

Properties:

    plaintext allowed
    strict TTL
    bounded by count/bytes and global pressure
    never copied to routine logs/traces
    not backed up as conversation history

### C. Delivery relay

Examples:

    encrypted per-device original/translation envelopes
    routing metadata
    expiry/ACK metadata

Properties:

    durable enough for declared delivery guarantee
    ciphertext at rest
    TTL + delete-on-ACK/revocation

### D. Durable structured control/context

Examples:

    MessageMetadata / revisions
    Conversation membership
    approved glossary
    CorrectionMemory / authorised claims
    Context State projection
    RecoveryCheckpoint
    execution/cost metadata
    deletion ledger

No generic durable transcript.

## 2. Memory promotion

Inference confidence, repeated usefulness or repeated model output are never sufficient to create durable corrective memory.

Durable corrective state requires an authorised trigger such as:

    explicit UI correction
    explicit textual correction with bounded scope
    approved glossary/policy change
    authorised administrative action

Confidence may influence ephemeral working state only.

## 3. Recovery classes

HERMENEIA distinguishes:

### RESTORABLE

Can be restored from authorised durable structured state.

Examples:

    approved correction
    glossary
    current policy
    compatible recovery checkpoint

### RECALCULABLE_IF_SOURCE_AVAILABLE

Requires authorised source text to recompute.

Examples:

    translation
    some contextual claims
    embeddings/summaries

### IRRECOVERABLE

Source has expired or been deleted and no authorised source remains.

The system must expose degraded/source-required state instead of inventing reconstruction.

## 4. Recovery checkpoint

Checkpoint schema is closed and bounded.

A checkpoint must not contain:

    raw transcript
    free-form history dump
    weak one-off hypotheses
    inferred sensitive traits by default

Checkpoint publication requires CAS over base state version plus applicable erasure/policy/membership epochs.

## 5. Erasure

Every scope that can be deleted owns an `erasure_epoch`.

Deletion must invalidate:

    transient source
    derived claims
    active/superseded checkpoints
    pending translation publication
    delivery envelopes when policy requires
    caches/indexes
    provider work when cancellable

Late workers include the epoch they started from and fail publication if it changed.

A durable DeletionLedger records minimum metadata needed to prevent resurrection during restore/replay without retaining deleted content.

## 6. Backups and restore

Backups must not silently resurrect expired/deleted derived state.

Restore procedure:

1. restore durable database into isolated environment;
2. apply deletion/erasure ledger newer than backup point;
3. validate key/device revocation epochs;
4. rebuild or invalidate derived projections;
5. only then reopen traffic.

## 7. Initial experimental budgets

These are configuration defaults for experiments, not validated final values:

    transient Core plaintext: max 5 minutes
    recovery checkpoint: active + previous only
    inferred working claims: bounded TTL, max 24h
    delivery envelope: until ACK/revocation or max configured TTL
    routine technical traces: no plaintext

Exact values are deployment policy and must be measured.

## 8. No hidden retention

Forbidden retention paths:

    exception logs with message text
    tracing spans containing prompts
    queue dead letters with plaintext
    crash dumps copied to analytics
    provider debug logs not covered by policy
    vector index of old raw messages

A feature is not ephemeral merely because the UI hides it.

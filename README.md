# HERMENEIA

> **Traduire les mots. Préserver le sens.**

HERMENEIA is an open-source research and engineering project exploring **context-aware multilingual communication** with a global, mobile-first messaging product direction.

The project aims to build a real-time messaging system where each participant can write and read in their preferred language. Its core research problem is not translation alone: HERMENEIA must determine **which conversational context is still relevant at a given moment**, use that context to resolve ambiguity, and preserve meaning, tone and terminology across languages.

## Why HERMENEIA?

Traditional translation pipelines often translate one message in isolation or attach a fixed number of previous messages. Both approaches are limited:

- isolated messages lose pronouns, references, tone and intent;
- fixed windows waste context and can introduce stale or unrelated information;
- complete histories increase latency, cost and confusion;
- conversational meaning evolves over time.

HERMENEIA therefore treats context as a first-class, temporal data model.

## Core idea

```text
message
  ↓
context analysis
  ↓
active conversational episode
  + relevant recent messages
  + relevant long-term memory
  ↓
context builder
  ↓
translation engine
  ↓
quality / safety checks
  ↓
translated message
```

The original message always remains the source of truth. A translation is a derived, versioned artifact.

## Research question

> How can a messaging system dynamically select the smallest useful conversational context that improves translation quality without unnecessarily sending the complete history?

The project will compare three strategies:

- **T0 — Message only**
- **T1 — Fixed recent-message window**
- **T2 — Adaptive temporal context**

Quality, latency, token usage and cost will be measured on the same evaluation corpus.

## Product scope

The initial MVP targets:

- private 1:1 text conversations;
- automatic language detection;
- per-user preferred language;
- real-time translated messages;
- access to the original message;
- temporal conversation segmentation into episodes;
- contextual retrieval and memory;
- translation feedback;
- measurable T0/T1/T2 evaluation.

Voice, video, public rooms, image translation and native mobile applications are deliberately outside the first MVP.

## Architecture direction

HERMENEIA starts as a **modular monolith with asynchronous workers**, not a premature microservice platform.

Planned logical modules:

- Messaging
- Identity & Access
- Context Engine
- Context Memory / Retrieval
- Translation Engine
- Provider Adapters
- Evaluation
- Observability

The Context Engine is the main research and engineering differentiator. Messaging reliability, latency and mobile/network behaviour are treated as product prerequisites rather than secondary scaffolding.

## Engineering principles

- raw message bodies are transient in HERMENEIA Core by default;
- translations are replaceable and versioned;
- context selection is observable and reproducible;
- AI providers remain replaceable;
- messaging must continue when translation is degraded;
- asynchronous work must be idempotent and recoverable;
- privacy and data minimisation are design constraints;
- no real private conversations belong in the repository;
- every meaningful AI improvement must be measurable.

## Repository status

**Persistent Core V1, executable T0/T1 Context Engine runtime and the first durable ConversationState runtime are qualified against disposable PostgreSQL 16. Send, command recovery, edit/delete, tenant-scoped sync/ACK, session/device trust, translation outbox/recovery, metadata-only ContextSnapshots, bounded transient context, causal ContextState reduction, HPKE publication, recipient decrypt and ACK/payload purge execute through the real persistence/runtime path. The qualification suite currently passes 407/407 Node regressions, migrations and rollbacks through 0013, real process/SIGTERM checks and PostgreSQL translation E2E.**

The runtime now persists bounded ConversationState, registers messaging operations independently of translation-provider availability, reduces them through fenced outbox jobs, and projects state causally before the message being translated so current/future evidence cannot leak backwards. Metadata-only state does not masquerade as T2: adaptive T2 is selected only when a derived candidate source materialises real evidence, and that enrichment boundary fails soft to T1/T0.

The first authoritative T2 semantic path is now executable end to end. ConversationState-referenced confirmed corrections and approved glossary/policy claims are revalidated for authority, scope, sensitivity, validity and bounded structured proposition shape before becoming provider context. The existing `POST /v1/conversations/{conversation_id}/corrections` contract is now backed by the persistent runtime: it uses the shared command ledger for idempotency, validates target visibility, records a structured repair event, creates versioned claim provenance when promotion is authorised, and links the claim atomically into bounded ConversationState.

Conversation-scoped structured corrections now support two distinct authority paths. Any active member may authoritatively correct **their own source message/meaning**; the resulting durable claim is bound to that speaker through `subject_user_id` and is eligible only for future source revisions authored by the same user. A conversation `MODERATOR` or tenant `ADMIN/OWNER` may still apply a generic conversation correction when justified. An ordinary member cannot promote a correction anchored to another speaker or an unanchored shared rule. Message-scoped corrections remain repair events, while tenant-wide and TONE corrections remain `NEEDS_CONFIRMATION`. Claims are also evaluated strictly as-of the current **source revision** creation timestamp, preventing both cross-speaker and backward-in-time leakage. PostgreSQL E2E now proves a plain MEMBER can self-correct in a 1:1 conversation and drive speaker-scoped T2 without requiring an artificial moderator role.

Translation feedback is now executable through the persistent runtime. Feedback is recipient-only, accepted only for a READY translation of the current source revision, idempotent through the shared command ledger, and deliberately remains a repair/problem signal rather than automatically creating durable memory. Free-form feedback notes are never persisted in plaintext: Core stores only bounded note metadata while the command fingerprint carries an HMAC-protected note fingerprint.

Correction memory now has deterministic supersession. A newly promoted correction invalidates older ACTIVE confirmed corrections with the same conversation, speaker/generic subject and semantic key, records `OVERRIDDEN_BY` provenance from the old claim to the replacement, and atomically removes superseded refs from ConversationState. The PostgreSQL E2E proves two contradictory self-corrections leave only the later meaning eligible for T2/provider context.

Correction memory can also be explicitly revoked without destructive deletion. A speaker may revoke only a speaker-scoped correction bound to themselves; even a conversation moderator or tenant owner cannot use this endpoint to erase another speaker's declared meaning. Generic corrections remain revocable by conversation moderators or tenant admins/owners. Revocation marks the claim `REVOKED`, records `INVALIDATED_BY` provenance to an explicit repair/audit event, removes the working ConversationState ref, and the E2E proves subsequent provider context no longer contains `CORRECTION_MEMORY`.

Authoritative claim materialisation also has a deterministic conflict-arbitration boundary before Context Engine ranking. Approved control-plane claims (`POLICY` / `APPROVED_GLOSSARY`) suppress lower correction evidence for the same semantic key when the approved sources agree. Speaker-scoped corrections are preferred over generic corrections by scope relevance when no approved control-plane claim applies. If the applicable authority level itself contains contradictory values, that semantic key is dropped from T2 entirely rather than asking the model to resolve the conflict. Identical authoritative claims collapse into one candidate while preserving every supporting claim reference in the ContextSnapshot provenance.

Language qualifiers are now part of claim admissibility. PostgreSQL projects the current revision's authoritative `declared_source_language`; a claim with `source_language_tag` is rejected when that language is unknown or does not match, while target-language constraints are checked against the actual recipient target. After those filters, overlapping generic and language-specific claims are arbitrated on the same effective semantic key, preventing a generic rule and a matching `fr-FR` rule from bypassing conflict detection simply because their qualifiers differ.

Message edit/delete advance the conversation content-invalidation frontier, and translation publication rejects snapshots whose erasure epoch is stale before provider invocation/publication. Episode inference, feedback/correction moderation, pending-correction approval, tenant-wide policy distribution, TONE/style memory, recovery-checkpoint materialisation, dependency-aware invalidation, independent cryptographic/platform review, live external-provider qualification with controlled credentials and target-deployment crash/restart recovery remain open gates. Translation workers are intentionally embedded for now: raw source is process-local transient state, so cross-process worker mode fails fast until HERMENEIA has a reviewed secure transient-source transport rather than silently degrading every message to source re-supply.

## Documentation

- [Product requirements](docs/specification/product-requirements.md)
- [Product North Star — Global Messaging First](docs/specification/product-north-star.md)
- [Implementation Scope — V1](docs/specification/implementation-scope-v1.md)
- [Architecture](docs/architecture/README.md)
- [Delivery Contract — V1](docs/architecture/delivery-contract-v1.md)
- [Canonical Domain & Data Model — V1](docs/architecture/canonical-data-model-v1.md)
- [API & Realtime Protocol — V1](docs/architecture/protocol-v1.md)
- [OpenAPI V1](api/openapi.yaml)
- [Data Lifecycle — V1](docs/architecture/data-lifecycle-v1.md)
- [Device Trust and Delivery Envelope Security — V1](docs/security/device-trust-v1.md)
- [Session & Device Authentication — V1](docs/security/session-device-auth-v1.md)
- [Architecture Decision Records](docs/architecture/adr/README.md)
- [Context evaluation protocol](docs/research/evaluation-protocol.md)
- [Pilot evaluation harness](research/eval/README.md)
- [Local / sandbox CI](docs/engineering/local-ci.md)
- [Executable Core Skeleton](docs/engineering/executable-core-skeleton.md)
- [HTTP / Sync Adapter — V1 Slice](docs/engineering/http-sync-adapter-v1.md)
- [Client Local Outbox & Sync Engine — V1 Slice](docs/engineering/client-outbox-sync-v1.md)
- [Message Mutations & Command Recovery — V1 Slice](docs/engineering/message-mutations-command-recovery-v1.md)
- [PostgreSQL Core Schema — V1](docs/engineering/postgres-core-schema-v1.md)
- [PostgreSQL Persistence Ports — V1](docs/engineering/postgres-persistence-ports-v1.md)
- [Persistent Messaging Execution — V1](docs/architecture/persistent-send-v1.md)
- [Context Engine — V1](docs/architecture/context-engine-v1.md)
- [Context Integrity, Provenance and Memory Safety — V1](docs/architecture/context-integrity-v1.md)
- [OpenAI Translation Provider — V1](docs/engineering/openai-translation-provider-v1.md)
- [Explicit Correction Ingestion — V1](docs/engineering/context-correction-ingestion-v1.md)
- [Translation Feedback — V1](docs/engineering/translation-feedback-v1.md)
- [Privacy and data minimisation](docs/security/privacy-data-minimisation.md)
- [Ephemeral messages and corrective memory](docs/architecture/ephemeral-message-memory-v1.md)
- [Sanitised recovery checkpoints](docs/architecture/recovery-checkpoint-v1.md)
- [Progressive long-message translation — experimental](docs/architecture/progressive-long-message-v1.md)
- [Draft stability and reversible speculation](docs/architecture/draft-stability-v1.md)
- [Mobile network and performance architecture](docs/architecture/mobile-network-performance-v1.md)
- [GitHub architecture landscape scan](docs/research/github-landscape-2026-10-03.md)
- [Product profiles](docs/specification/product-profiles.md)
- [Dataset policy](datasets/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)

## Open source

HERMENEIA is developed in the open to make the architecture, experiments and research reproducible and reviewable.

The project is licensed under the [Apache License 2.0](LICENSE).

Do **not** commit secrets, API keys, private conversation exports or non-anonymised personal datasets.

## Project name

**HERMENEIA** comes from Ancient Greek *hermēneía*: interpretation, explanation and the expression or translation of meaning.

That idea defines the project: translation should preserve meaning, not merely replace words.

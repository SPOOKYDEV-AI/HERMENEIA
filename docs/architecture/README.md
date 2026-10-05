# Architecture

## Status

This document defines HERMENEIA's initial architecture constraints. It intentionally avoids premature implementation detail.

## Architecture style

The MVP starts as a **modular monolith with asynchronous workers**.

Reasons:

- domain boundaries are still evolving;
- transactions and consistency are simpler;
- local development remains accessible to contributors;
- observability is easier;
- deployment cost and operational overhead remain low;
- modules can later be extracted if measurements justify it.

Microservices are not an MVP goal.

## Logical components

```text
Web client
   │
HTTPS / WebSocket
   │
Application
   ├── Identity & Access
   ├── Messaging
   ├── Context Engine
   │    ├── Episode Detection
   │    ├── Retrieval
   │    ├── Memory
   │    └── Context Builder
   ├── Translation
   │    └── Provider Adapters
   ├── Evaluation
   └── Observability
        │
        ├── PostgreSQL / vector capability
        └── queue/cache when justified
```

## Dependency direction

Core domain logic must not import provider SDK concepts.

Preferred direction:

```text
domain
  ↑
application
  ↑
infrastructure/adapters
```

Provider adapters implement interfaces owned by the application/domain boundary.

## Core invariants

### Message

The original message is the semantic source of truth for its translation, but HERMENEIA Core does not durably retain raw message bodies by default. Content is processed transiently and may be retained by the client or a customer-controlled store.

### Translation

A translation is derived, versioned and repeatable.

### Context

A ContextSnapshot identifies what information was selected for a translation and which strategy produced that selection.

### Messaging availability

Messaging and translation availability are separate concerns.

### Async work

Any queued operation that may run more than once must be idempotent.

## Initial persistence direction

PostgreSQL is the system of record for durable metadata, approved policy/glossary state, bounded structured Context State, corrective memory and recovery checkpoints — not raw conversation bodies by default.

Vector search may use PostgreSQL vector capabilities initially rather than introducing a second specialised database before scale requires it.

A queue/cache may be added for:

- translation jobs;
- async summarisation;
- embedding generation;
- short-lived cache.

It must not become a hidden durable conversation archive.

## Observability

Every user-visible message operation should be traceable through stable technical identifiers without logging full private content.

Measure:

- request latency;
- message persistence latency;
- translation latency;
- provider errors/timeouts;
- retry counts;
- queue age;
- context token size;
- retrieval candidates/selection;
- T0/T1/T2 strategy version.

## Failure model

Expected failures include:

- provider timeout;
- provider quota/rate limit;
- worker crash;
- duplicate delivery;
- WebSocket disconnect;
- process restart;
- database unavailability;
- queue/cache loss.

Design must make these failures recoverable rather than exceptional assumptions.

## Security boundary

Authorization belongs at the application boundary and must be enforced for every conversation-scoped operation.

A resource ID is not proof of authorization.

## Context Engine

The Context Engine is specified in [Context Engine V1](context-engine-v1.md), with pragmatic/emoji handling defined in [Pragmatics, Emotion Signals and Emoji — V1](pragmatics-affect-v1.md) and informal-language resolution defined in [Colloquial Language, Acronyms and SMS Resolver — V1](colloquial-language-v1.md), professional terminology defined in [Domain Terminology and Jargon Resolver — V1](domain-terminology-v1.md), and locale/style adaptation defined in [Locale and Conversation Style Engine — V1](locale-style-v1.md), derived-memory correctness defined in [Context Integrity, Provenance and Memory Safety — V1](context-integrity-v1.md), no-retention/corrective learning defined in [Ephemeral Message and Corrective Memory Model — V1](ephemeral-message-memory-v1.md), crash recovery defined in [Sanitised Recovery Checkpoint — V1](recovery-checkpoint-v1.md), experimental long-message latency optimisation defined in [Progressive Long-Message Translation — Experimental](progressive-long-message-v1.md), and typing/edit fluidity rules defined in [Draft Stability and Reversible Speculation — V1](draft-stability-v1.md), and mobile/network behaviour defined in [Mobile Network and Performance Architecture — V1](mobile-network-performance-v1.md).

Its latency model is intentionally incremental: expensive enrichment prepares the next translation asynchronously, while the fast path uses versioned prepared state plus any recent messages that have not yet been processed.

## Architecture decisions

Major decisions are recorded in `docs/architecture/adr/`.

Relevant foundation ADRs:

- [ADR-0001 — Modular monolith first](adr/0001-modular-monolith-first.md)
- [ADR-0002 — Context is temporal and adaptive](adr/0002-context-is-temporal-and-adaptive.md)
- [ADR-0003 — Incremental context processing and latency-first translation](adr/0003-incremental-context-and-latency.md)
- [ADR-0004 — Maintain conversational state instead of replaying history](adr/0004-conversation-state-over-history-replay.md)
- [ADR-0005 — Pragmatic intent and affect are contextual signals, not ground truth](adr/0005-pragmatic-intent-affect-signals.md)
- [ADR-0006 — Colloquial language is resolved contextually before translation](adr/0006-colloquial-language-contextual-resolution.md)
- [ADR-0007 — Domain terminology is resolved with scoped, provenance-aware glossaries](adr/0007-domain-terminology-scoped-glossaries.md)
- [ADR-0008 — Translation style and locale are dynamic contextual profiles](adr/0008-dynamic-locale-and-style-profiles.md)
- [ADR-0009 — Context integrity requires provenance, authority and reversible derived memory](adr/0009-context-integrity-provenance.md)
- [ADR-0010 — Ephemeral message processing and correction-triggered memory](adr/0010-ephemeral-messages-corrective-memory.md)
- [ADR-0011 — Sanitised recovery checkpoints instead of raw history replay](adr/0011-sanitised-recovery-checkpoints.md)
- [ADR-0012 — Progressive draft translation for long messages](adr/0012-progressive-draft-translation.md)
- [ADR-0013 — Draft speculation uses reversible stability, not predicted user intent](adr/0013-reversible-draft-stability.md)
- [ADR-0014 — Mobile-network-first adaptive transport and client orchestration](adr/0014-mobile-network-first-adaptive-transport.md)
- [ADR-0015 — Messaging parity is a product prerequisite; contextual translation is the differentiator](adr/0015-messaging-parity-contextual-translation.md)
- [ADR-0016 — Durable acceptance, source ownership and causal publication](adr/0016-durable-acceptance-source-ownership-causal-publication.md)

## Privacy architecture

HERMENEIA's privacy/data-minimisation model is documented in [Privacy and Data-Minimisation Architecture](../security/privacy-data-minimisation.md).

The central rule is stronger than avoiding replay: HERMENEIA Core does not durably retain raw conversation bodies by default. It operates on transient message content, bounded structured state, event-driven corrective memory and sanitised recovery checkpoints.


## Mobile/network architecture

HERMENEIA treats mobile network conditions as a first-class runtime concern.

The client owns a Network Orchestrator for:

- local outbox;
- connectivity vs service reachability;
- retry/backoff;
- request priorities;
- connection recovery;
- adaptive speculative translation;
- foreground/background behavior.

The application protocol remains transport-independent so WebSocket, HTTP streaming/long-poll and future HTTP/3/QUIC optimisations can be benchmarked without changing domain logic.

Research references and candidate technologies are tracked in [GitHub Architecture Landscape Scan — 2026-10-03](../research/github-landscape-2026-10-03.md).


## Product architecture North Star

HERMENEIA is globally language-agnostic at the domain layer.

One source message may later produce multiple recipient-specific translations, each using the recipient's target language/locale/profile while preserving one shared source event.

Messaging interaction quality is treated as a prerequisite. HERMENEIA's differentiated architecture remains the Context/Memory/Translation system rather than unrelated social-network feature breadth.

See [Product North Star — Global Messaging First](../specification/product-north-star.md).


## Canonical execution contracts

The current execution-level contracts are:

- [Delivery Contract — V1](delivery-contract-v1.md);
- [Persistent Send Execution — V1](persistent-send-v1.md);
- [Data Lifecycle — V1](data-lifecycle-v1.md);
- [Canonical Domain & Data Model — V1](canonical-data-model-v1.md);
- [API & Realtime Protocol — V1](protocol-v1.md);
- [Device Trust and Delivery Envelope Security — V1](../security/device-trust-v1.md);
- [Implementation Scope — V1](../specification/implementation-scope-v1.md).

These documents reconcile older design language. In particular, durable acceptance is independent of translation, the Core does not own durable plaintext history by default, recovery is explicitly partial when sources have expired, and causal publication/erasure epochs guard stale workers and checkpoints.


## Canonical ordering model

Implementation must preserve three independent orders:

- conversation `message_seq` for new logical messages;
- conversation `op_seq` for edits/deletes/corrections and other state-changing operations;
- device inbox `epoch + offset` for synchronisation.

A global SQL sequence or client timestamp must not be reused as a substitute for these domain-specific orders.

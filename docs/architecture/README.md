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

The original message is source-of-truth data and is not overwritten by a translation.

### Translation

A translation is derived, versioned and repeatable.

### Context

A ContextSnapshot identifies what information was selected for a translation and which strategy produced that selection.

### Messaging availability

Messaging and translation availability are separate concerns.

### Async work

Any queued operation that may run more than once must be idempotent.

## Initial persistence direction

PostgreSQL is the system of record.

Vector search may use PostgreSQL vector capabilities initially rather than introducing a second specialised database before scale requires it.

A queue/cache may be added for:

- translation jobs;
- async summarisation;
- embedding generation;
- short-lived cache.

It must not become the source of truth for durable messages.

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

## Architecture decisions

Major decisions are recorded in `docs/architecture/adr/`.

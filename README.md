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

**Foundation / pre-implementation.**

The project is intentionally defining its contracts, architecture and evaluation methodology before committing to application code or model-specific implementations.

## Documentation

- [Product requirements](docs/specification/product-requirements.md)
- [Product North Star — Global Messaging First](docs/specification/product-north-star.md)
- [Implementation Scope — V1](docs/specification/implementation-scope-v1.md)
- [Architecture](docs/architecture/README.md)
- [Delivery Contract — V1](docs/architecture/delivery-contract-v1.md)
- [Data Lifecycle — V1](docs/architecture/data-lifecycle-v1.md)
- [Device Trust and Delivery Envelope Security — V1](docs/security/device-trust-v1.md)
- [Architecture Decision Records](docs/architecture/adr/README.md)
- [Context evaluation protocol](docs/research/evaluation-protocol.md)
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

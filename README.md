# HERMENEIA

> **Traduire les mots. Préserver le sens.**

HERMENEIA is an open-source research and engineering project exploring **context-aware multilingual communication**.

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

The Context Engine is the main research and engineering differentiator.

## Engineering principles

- original messages are immutable source data;
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

The repository documentation will cover:

- product requirements;
- architecture decisions;
- context-engine design;
- evaluation methodology;
- security and privacy;
- contribution rules;
- dataset policy.

## Open source

HERMENEIA is developed in the open to make the architecture, experiments and research reproducible and reviewable.

Do **not** commit secrets, API keys, private conversation exports or non-anonymised personal datasets.

## Project name

**HERMENEIA** comes from Ancient Greek *hermēneía*: interpretation, explanation and the expression or translation of meaning.

That idea defines the project: translation should preserve meaning, not merely replace words.

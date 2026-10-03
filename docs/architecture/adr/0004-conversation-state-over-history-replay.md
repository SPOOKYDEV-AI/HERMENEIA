# ADR-0004 — Maintain conversational state instead of replaying history

**Status:** Accepted  
**Date:** 2026-10-03

## Context

A translation system can preserve conversational continuity in two fundamentally different ways:

1. resend a window or the full history for each new message;
2. maintain a compact, versioned representation of the conversation as it evolves.

The first option is simple but repeatedly processes and potentially retransmits old raw messages. It also scales poorly in tokens, latency and privacy exposure.

HERMENEIA targets both consumer and professional usage, including organisations that may require strict data minimisation, tenant isolation, provider controls and regional deployment.

## Decision

HERMENEIA will maintain a **Conversation State** that follows the conversation over time.

The Context Engine should not routinely reconstruct meaning by rereading the entire raw history.

Instead, after each message it incrementally updates a bounded state containing only information useful for future translation, such as:

- active topic/episode identity;
- continuity features;
- unresolved references;
- relevant entities or pseudonymous entity handles;
- terminology currently in use;
- tone/register indicators;
- active temporal references;
- compact episode summary where justified;
- selected durable memory references;
- freshness/version metadata.

For message N+1, translation context is built from:

- the complete current message;
- the minimum immediate raw context required;
- the current Conversation State;
- explicitly retrieved older context only when needed.

Raw historical messages are not automatically resent to an external AI provider.

## Important limitation

The current message itself generally must be processed in full to translate it.

This ADR therefore does **not** claim that HERMENEIA can translate arbitrary text without processing the text being translated.

The minimisation benefit concerns primarily:

- repeated processing of old messages;
- retransmission of historical content;
- context-window size;
- provider exposure;
- retention of unnecessary derived data.

## Privacy model

Derived state is not assumed anonymous.

Summaries, embeddings, entity mappings and contextual features can remain personal data when they are linked or linkable to identifiable users.

Therefore they remain subject to:

- access control;
- retention rules;
- deletion/invalidation;
- tenant isolation;
- provider/data-transfer policy;
- auditability where applicable.

## Data exposure principle

Each translation request should expose the smallest sufficient data set.

Conceptually:

    current message
    + minimum immediate context
    + compact relevant state
    + explicit retrieval if needed

and not:

    current message
    + complete conversation history

## Enterprise consequences

The architecture must remain compatible with professional deployment requirements without forcing them into the MVP.

Future deployment profiles may include:

- shared SaaS with strict tenant isolation;
- EU-region processing;
- customer-managed provider credentials;
- customer-controlled retention;
- dedicated tenant deployment;
- private cloud/VPC deployment;
- self-hosted/on-premise deployment where justified.

These are compatibility goals, not promises that all modes exist in V1.

## Consequences

Benefits:

- bounded context size;
- lower repeated token consumption;
- lower context-engine latency;
- reduced raw historical content sent to providers;
- clearer privacy boundaries;
- better fit for enterprise retention policies;
- easier provider replacement.

Costs:

- Conversation State becomes a sensitive derived data asset;
- state invalidation and source provenance must be tracked;
- state quality must be measurable;
- recovery/rebuild procedures are required;
- bad compression can lose useful meaning.

## Alternatives considered

### Fixed recent-message window

Retained as baseline T1, but rejected as the primary design because it repeatedly exposes raw history and does not understand semantic continuity.

### Full-history prompt

Rejected due to cost, latency, stale-context risk and unnecessary processing.

### Provider-managed conversation memory

Rejected as the architectural source of truth because it creates provider lock-in and weakens control over retention, deletion and data location.

## Revisit when

Revisit if experiments show that a compact Conversation State materially harms translation quality compared with bounded raw context, or if a new provider architecture offers equivalent privacy and portability guarantees without local state.

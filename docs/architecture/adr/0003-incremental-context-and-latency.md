# ADR-0003 — Incremental context processing and latency-first translation

**Status:** Accepted  
**Date:** 2026-10-03

## Context

HERMENEIA must translate messages quickly while using conversation context.

Rebuilding semantic state, summaries, embeddings, entities and long-term memory from the conversation history for every incoming message would place expensive work directly on the critical translation path.

A purely asynchronous context pipeline is also insufficient: a new message can arrive before the previous message has finished background analysis, which can make the cached context stale.

## Decision

HERMENEIA will maintain conversation understanding **incrementally**.

After every persisted message, the system will update or schedule updates for a versioned conversation context state.

Translation uses two coordinated paths.

### Fast path

Runs on the critical user-visible path and must do only work needed to translate the current message:

1. persist/idempotently accept the original message;
2. load the latest context state;
3. detect whether the state is behind the current conversation sequence;
4. supplement it with recent unprocessed messages when necessary;
5. select a bounded ContextSnapshot;
6. invoke the selected translation provider;
7. persist and deliver the translation.

### Slow path

Runs asynchronously and prepares future translations:

- embeddings;
- entity extraction;
- episode scoring/closure;
- episode summaries;
- memory candidate extraction;
- memory promotion/decay;
- retrieval indexes;
- evaluation metadata;
- cache refresh.

The slow path must never be required to complete before the original message is safely persisted.

## Context freshness

Each conversation context state must expose at least:

    conversation_id
    context_version
    last_processed_sequence
    updated_at
    active_episode_id
    active_episode_version

Each persisted message receives a server-side conversation sequence.

When:

    last_processed_sequence < current_message_sequence - 1

the fast path treats the prepared context as partially stale and includes the missing recent messages directly during ContextSnapshot construction.

This prevents background lag from silently dropping relevant context.

## Precomputation

HERMENEIA should compute as much future-useful context as practical **after message N so message N+1 is cheap**.

Examples:

- message embedding prepared after persistence;
- active-episode centroid incrementally updated;
- recent entity set maintained incrementally;
- compact episode summary refreshed on thresholds/debounce rather than rebuilt for every message;
- retrieval candidates/indexes warmed while users are still conversing.

## Latency budget

The project will separately measure:

1. application overhead;
2. Context Engine overhead;
3. provider network/model latency;
4. persistence/delivery overhead.

Initial engineering target for the mature MVP:

    Context Engine fast-path overhead
    p50 <= 50 ms
    p95 <= 150 ms

This excludes translation-provider inference/network time.

These are design targets, not claims of achieved performance. They must be validated on a documented reference environment.

## Consequences

Benefits:

- most context work moves out of the critical path;
- translation latency becomes dominated by the provider rather than repeated context reconstruction;
- active conversations naturally stay warm;
- context can become richer over time without making each translation proportionally slower;
- stale-context races are detectable and recoverable.

Costs:

- context state becomes versioned mutable derived data;
- workers and fast-path logic must coordinate via sequence/version metadata;
- eventual consistency must be explicitly tested;
- summaries/indexes need rebuild/recovery procedures.

## Alternatives considered

### Rebuild all context per message

Rejected because latency and cost grow with conversation history.

### Keep only an in-memory context object

Rejected because crashes/restarts would lose derived state and multi-process execution would become unsafe.

### Block translation until every enrichment job completes

Rejected because non-essential enrichment would directly degrade user-visible latency.

### Ignore slow-path lag

Rejected because translations could silently omit the immediately previous messages.

## Revisit when

Revisit this decision if measurements show that:

- background enrichment complexity outweighs its latency benefit;
- a provider-native persistent-context mechanism becomes reliable, portable and privacy-compatible enough to replace part of the local state;
- conversation scale requires extracting context processing into independently scalable services.

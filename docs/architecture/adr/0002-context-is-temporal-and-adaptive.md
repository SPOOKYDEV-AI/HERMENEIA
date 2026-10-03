# ADR-0002 — Context is temporal and adaptive

**Status:** Accepted  
**Date:** 2026-10-03

## Context

A fixed number of previous messages is simple but does not represent how human conversations evolve.

Useful context can disappear because a topic changes, remain relevant after a long pause, or become obsolete with time.

A hard reset at midnight is also incorrect: a conversation may continue across a date boundary.

## Decision

HERMENEIA models context using:

- immediate context;
- an active conversational episode;
- retrievable previous episodes;
- selected durable memory.

Time is a strong signal but not a hard boundary.

Context selection is a versioned strategy that operates under an explicit budget and produces a reproducible ContextSnapshot.

## Consequences

Benefits:

- context can be smaller and more relevant;
- old topics can be resumed;
- stale information can be penalised;
- T2 can be measured against simpler baselines.

Costs:

- episode segmentation adds classification complexity;
- memory lifecycle and deletion become first-class concerns;
- evaluation requires purpose-built conversation datasets.

## Alternatives considered

### Last N messages only

Retained as baseline T1, not as the target architecture.

### Full history

Rejected because cost, latency and stale-context risk scale poorly.

### Daily reset

Rejected because calendar boundaries do not imply conversational boundaries.

## Revisit when

Revisit the ranking/segmentation algorithm whenever evaluation shows a simpler strategy performs equivalently or better.

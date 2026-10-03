# ADR-0013 — Draft speculation uses reversible stability, not predicted user intent

**Status:** Accepted as experimental design — not a Core V1 gate  
**Date:** 2026-10-03

## Context

Progressive translation can reduce long-message latency by preparing stable parts of a draft before Send.

The dangerous interpretation would be to predict that a user has "finished an idea" and treat that prediction as final.

Real users:

- type;
- pause;
- delete;
- rewrite;
- move the cursor backwards;
- merge paragraphs;
- paste content;
- change terminology;
- replace the beginning after writing the end.

Therefore draft optimisation must remain fully reversible and must never depend on a claim that HERMENEIA knows the user's future intent.

## Decision

HERMENEIA will use **reversible draft stability**.

The client identifies fragments that are *currently stable enough to speculate on*, not fragments that are assumed final.

Every speculative artifact is tied to:

- draft ID;
- draft revision;
- fragment ID;
- fragment revision;
- exact source hash;
- relevant context/profile/strategy versions.

Any edit that changes the source or invalidates its dependencies immediately makes the speculative artifact unusable.

## Mutable frontier

The most recently edited region is a **mutable frontier**.

HERMENEIA should be conservative near this frontier.

Older blocks may become stable islands when signals indicate that the user has moved on, for example:

- cursor has moved beyond the block;
- one or more later blocks now exist;
- the block has not been touched for a configurable stability interval;
- sentence/paragraph boundaries are syntactically plausible;
- no composition/IME operation is active.

These are operational signals, not intent inference.

## Stable islands

A long draft may contain several independent stable islands.

Example:

    paragraph 1   STABLE
    paragraph 2   STABLE
    paragraph 3   DIRTY
    paragraph 4   EDITING

Only stable islands are eligible for speculative translation.

## Edit invalidation

If a user edits a stable fragment:

    source hash changes
      -> speculative result becomes INVALID
      -> in-flight request is cancelled when possible
      -> late result is discarded
      -> affected dependent draft state is recomputed

No stale speculative result may re-enter the final message.

## Dependency-aware invalidation

An edit should invalidate only what can actually be affected.

Examples:

- punctuation change in paragraph 3 may invalidate only paragraph 3;
- changing a defined acronym in paragraph 1 may invalidate later fragments that reused that terminology;
- changing an antecedent may invalidate later pronoun/reference decisions;
- deleting a paragraph may shift discourse structure and require broader reconciliation.

The draft engine therefore needs lightweight dependency metadata between fragments.

## Late-result rule

Every speculative response must carry the input revision/hash.

When a response arrives:

    response.fragment_revision == current.fragment_revision
    AND
    response.source_hash == current.source_hash
    AND
    strategy/context versions remain compatible

Otherwise:

    discard

This check is mandatory even if request cancellation was attempted.

## No UI interference

Draft optimisation must never degrade typing fluidity.

Requirements:

- no network call on every keystroke;
- no blocking work on the main UI thread;
- no cursor jumps;
- no visible replacement of user text;
- no typing debounce that prevents input;
- speculation may be paused under high edit churn.

The optimisation is invisible background work.

## Consequences

Benefits:

- long-message acceleration remains safe under aggressive editing;
- the system follows user behaviour instead of fighting it;
- stale translations cannot survive a rewrite;
- compute is focused on genuinely stable portions.

Costs:

- more client-side revision bookkeeping;
- some speculative work will be wasted;
- dependency-aware invalidation adds complexity.

## Alternatives considered

### Predict semantic completion with an AI model

Rejected as the primary mechanism because prediction of future user intent is unreliable and unnecessarily invasive.

### Translate after every pause

Rejected because ordinary thinking pauses would trigger excessive work.

### Translate every paragraph immediately after Enter

Rejected because users frequently return to earlier paragraphs.

## Revisit when

Revisit stability heuristics after measuring edit patterns, speculative reuse rate, wasted compute and send-to-ready latency on real opt-in usage.


## Implementation scope note

This ADR remains a valid research/design direction, but [Implementation Scope — V1](../../specification/implementation-scope-v1.md) classifies progressive pre-Send translation as experimental. It must not delay the reliable messaging, delivery, translation-baseline or minimal T2 milestones.

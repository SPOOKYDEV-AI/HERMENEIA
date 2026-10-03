# ADR-0015 — Messaging parity is a product prerequisite; contextual translation is the differentiator

**Status:** Accepted  
**Date:** 2026-10-03

## Context

HERMENEIA could be implemented as a translation interface wrapped around chat primitives.

That would miss the product goal.

Users compare messaging interactions against mature communication products, not against research prototypes. Translation value is lost if messaging itself feels slow, fragile or unfamiliar.

At the same time, reproducing every social feature of large messaging/social platforms would distract from the core research and product hypothesis.

## Decision

HERMENEIA separates:

### Messaging baseline

Must be exceptionally reliable and low-friction:

- instant local composition;
- idempotent Send;
- local outbox;
- reconnect/recovery;
- mobile background handling;
- low-bandwidth operation;
- message ordering;
- replies;
- delivery state;
- original reveal;
- accessibility and international text correctness.

### Translation differentiator

HERMENEIA-specific value:

- adaptive context;
- corrective memory;
- pragmatic/affective cues;
- emoji;
- slang/SMS;
- domain terminology;
- regional locale;
- conversation style;
- progressive long-message translation;
- provider routing.

Messaging baseline is not itself the research differentiator, but failure there invalidates the product.

## Scope rule

The MVP should not copy unrelated social-network features merely for parity.

Examples not required for the initial research product:

    stories
    reels
    feeds
    public creator discovery
    advertising surfaces

The benchmark is interaction quality, not feature count.

## Global language rule

The system must not use a privileged language as a domain-level pivot.

Every translation request is represented as a source-to-target communication problem with recipient-specific locale/style context.

## Group-chat compatibility

Even if V1 is 1:1, message and translation identities must allow one source message to produce multiple recipient-specific translations later.

## Consequences

Benefits:

- clear product identity;
- research effort remains focused;
- messaging quality receives first-class engineering treatment;
- global/group evolution does not require rewriting translation ownership.

Costs:

- messaging engineering cannot be treated as scaffolding;
- mobile/realtime/offline testing becomes substantial;
- product scope must remain disciplined to avoid copying every consumer feature.

## Revisit when

Revisit feature scope after core multilingual conversation quality is validated with users.

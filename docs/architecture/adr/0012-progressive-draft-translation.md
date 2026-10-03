# ADR-0012 — Progressive draft translation for long messages

**Status:** Accepted as experimental design — not a Core V1 gate  
**Date:** 2026-10-03

## Context

Long messages create a poor interactive experience when translation begins only after the sender presses Send.

For a multi-paragraph business message, most of the content may already be stable seconds before submission. Waiting until Send to start every translation step wastes this available time.

However, unsent drafts are more sensitive than sent messages. HERMENEIA must not leak draft content to recipients, durably store it, or continuously stream every keystroke to providers.

## Decision

HERMENEIA may use **Progressive Draft Translation** for sufficiently long messages.

The client detects stable sentence/paragraph boundaries locally. Stable draft fragments may be translated speculatively under an explicit product/tenant policy.

Speculative results:

- remain invisible to the recipient;
- are stored only ephemerally;
- are keyed by draft/fragment revision and content hash;
- are invalidated immediately when the source fragment changes;
- are reused at Send only if their source hash and relevant context/profile/strategy versions still match.

At Send, HERMENEIA performs a final reconciliation step before delivery.

## Stability rule

A fragment is considered translation-eligible only after signals such as:

- sentence terminator + debounce;
- paragraph break + debounce;
- no edits inside the fragment for a short stability interval;
- fragment length threshold;
- syntax/boundary heuristic indicating likely completion.

The exact thresholds are configurable and must be benchmarked.

## No keystroke streaming

The system must not send each keystroke to the Core/provider.

Draft segmentation occurs client-side.

Only stable fragments may leave the client, and only when the selected policy permits speculative translation.

## Privacy modes

Possible policy modes:

    DISABLED
    CLIENT_SEGMENT_ONLY
    SPECULATIVE_TRANSLATION_ALLOWED

Enterprise tenants may disable speculative draft processing entirely.

## Final send

When Send occurs:

1. freeze final draft revision;
2. compare final fragment hashes with speculative fragments;
3. reuse only exact matching fragments under compatible context/profile/strategy versions;
4. translate changed/new fragments;
5. run final message-level coherence/terminology/style reconciliation;
6. deliver only the final reconciled translation.

No speculative translation is ever shown as final before this validation.

## Context continuity

Fragments within the same draft share a DraftTranslationState that may contain:

- source-language decision;
- terminology decisions;
- entity references;
- target locale/profile;
- discourse relation between paragraphs;
- previous translated fragment tail;
- style constraints.

This state is ephemeral and bounded.

## Provider independence

The architecture must not require provider-native streaming sessions.

A provider adapter may use native incremental capabilities when available, but the Core contract remains fragment/revision based.

## Consequences

Benefits:

- dramatically lower perceived latency for long messages;
- better continuity for multi-paragraph translations;
- unchanged recipient trust boundary: drafts are never delivered;
- provider/model choice remains interchangeable.

Costs:

- unsent draft privacy requires explicit governance;
- edits can invalidate speculative work;
- final reconciliation adds implementation complexity;
- speculative calls may waste compute if the user rewrites or abandons a draft.

## Cost control

Speculation should activate only when expected latency savings justify the cost.

Possible gates:

- minimum character/token count;
- minimum stable fragment length;
- provider cost budget;
- tenant policy;
- network condition;
- predicted send probability / inactivity pattern only if privacy-compatible and locally computed.

Abandoned speculative work is purged and never used as training data by HERMENEIA.

## Revisit when

Revisit if measurements show that speculative translation costs more than its UX benefit, or if on-device translation becomes capable enough to eliminate server-side draft exposure for common language pairs.


## Implementation scope note

This ADR remains a valid research/design direction, but [Implementation Scope — V1](../../specification/implementation-scope-v1.md) classifies progressive pre-Send translation as experimental. It must not delay the reliable messaging, delivery, translation-baseline or minimal T2 milestones.

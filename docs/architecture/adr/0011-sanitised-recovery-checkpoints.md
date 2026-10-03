# ADR-0011 — Sanitised recovery checkpoints instead of raw history replay

**Status:** Accepted  
**Date:** 2026-10-03

## Context

HERMENEIA Core does not durably store raw conversation bodies by default.

This improves privacy and limits data exposure, but it removes the ability to rebuild context by replaying the complete message history after a crash, corrupted state or faulty worker execution.

The system therefore needs a recovery mechanism that is useful enough to restore continuity without becoming a hidden archive of the conversation.

## Decision

HERMENEIA will maintain a bounded **Sanitised Recovery Checkpoint** for active conversations.

The checkpoint is a compact, structured snapshot of the minimum validated state required to resume contextual translation.

It must not contain a verbatim conversation transcript.

A checkpoint may contain:

- active episode identity/version;
- last processed sequence;
- validated terminology mappings;
- unresolved-reference handles;
- current style/locale profile;
- pragmatic state at coarse resolution;
- approved CorrectionMemory references;
- high-confidence entity handles;
- context strategy/version;
- checkpoint creation time;
- integrity hash/version metadata.

It should avoid raw message bodies and free-form summaries unless a deployment explicitly allows them.

## Clean checkpoint rule

Only state that passes checkpoint eligibility may be persisted.

Eligible state should normally be:

- explicit/confirmed;
- high-confidence and low-risk;
- bounded;
- still useful after restart;
- non-sensitive unless explicitly justified;
- traceable to provenance metadata.

Weak hypotheses, transient affect and unconfirmed one-off interpretations should not survive a recovery checkpoint.

## Checkpoint lifecycle

Conceptually:

    live Conversation State
          |
          v
    checkpoint eligibility filter
          |
          v
    SanitisedRecoveryCheckpoint
          |
          +--> periodic replacement
          +--> event-triggered replacement
          +--> restart recovery

The checkpoint should be replaced atomically.

Older checkpoints should be expired according to a small retention policy.

## Checkpoint triggers

A checkpoint may be refreshed:

- after a confirmed correction;
- after an episode transition;
- after a meaningful terminology update;
- after a bounded number of processed messages;
- after a short inactivity debounce;
- before graceful shutdown when possible.

It must not be rewritten for every token/message if this creates unnecessary I/O or retention.

## Automatic recovery

After a crash/restart:

1. load the latest valid checkpoint;
2. validate checksum/schema/strategy compatibility;
3. restore bounded Conversation State;
4. restore approved CorrectionMemory references;
5. mark uncertain ephemeral fields as unknown;
6. continue translation immediately in recovery mode;
7. refine state from new messages as they arrive.

The system should not fabricate missing historical details.

## Corruption handling

If the latest checkpoint is corrupt or incompatible:

- fall back to the previous valid checkpoint when allowed;
- otherwise initialise a clean minimal state;
- keep CorrectionMemory and tenant policy/glossary state;
- report a recovery metric/event;
- continue service in degraded but safe mode.

## Privacy boundary

A recovery checkpoint is still potentially personal data.

It therefore requires:

- tenant/conversation access control;
- encryption at rest;
- explicit retention;
- deletion with conversation/account lifecycle;
- no analytics reuse;
- no model-training reuse.

The checkpoint is a continuity aid, not a secondary history store.

## Consequences

Benefits:

- automatic recovery without raw history replay;
- low recovery latency;
- reduced privacy exposure;
- correction memory survives restart;
- context can resume safely after worker/process failure.

Costs:

- not all pre-crash nuances can be reconstructed;
- checkpoint schema/version migrations are required;
- checkpoint eligibility rules must be carefully tested.

## Alternatives considered

### Keep full raw history

Rejected as the default because it defeats the data-minimisation goal.

### Keep no recovery state at all

Rejected because restart would unnecessarily destroy useful validated context and increase translation errors.

### Persist free-form summaries of everything

Rejected because summaries can reproduce sensitive content and hallucinated facts.

## Revisit when

Revisit if deployment-specific requirements justify richer customer-controlled recovery state, but raw server-side conversation retention must remain opt-in and separately governed.

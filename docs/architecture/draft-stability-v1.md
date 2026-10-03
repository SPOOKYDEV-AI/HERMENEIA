# Draft Stability and Reversible Speculation — V1

**Status:** Design baseline  
**Scope:** Client + Progressive Translation  
**Goal:** accelerate long messages while remaining perfectly fluid under typing, deletion and rewrites

## 1. Principle

HERMENEIA does not try to know when a user is "done thinking".

It only determines whether a fragment is currently stable enough for disposable speculative work.

Speculation is always reversible.

## 2. Local edit model

The client maintains:

    DraftRevision
    FragmentRevision
    EditSpan
    CursorPosition
    CompositionState
    StableSince
    SourceHash

This state remains local unless a fragment becomes eligible for speculative processing.

## 3. Fragment states

Suggested state machine:

    EDITING
      -> QUIET
      -> STABLE_CANDIDATE
      -> SPECULATING
      -> SPECULATIVE_READY
      -> FINAL_REUSED

Any source-changing edit may move:

    QUIET / STABLE_CANDIDATE / SPECULATING / SPECULATIVE_READY
      -> DIRTY
      -> EDITING

Discarded/removed fragments move to:

    DELETED

## 4. Mutable frontier

The current edit zone is treated as volatile.

A simple V1 rule can define a mutable frontier around:

- the paragraph containing the caret;
- neighbouring sentence/paragraph blocks;
- any block touched within the recent edit window.

Fragments outside the frontier may become stable islands.

## 5. Stability signals

Positive signals:

    valid sentence/paragraph boundary
    cursor moved into a later block
    later text exists
    no edits for stability interval
    user is not in IME composition
    fragment is above minimum useful size
    edit churn is low

Negative signals:

    caret inside fragment
    selection overlaps fragment
    recent backspace/delete activity near boundary
    repeated edits in fragment
    paragraph merge/split
    IME composition active
    paste operation still being normalised

The V1 decision should be deterministic and cheap.

## 6. Adaptive stability interval

A single hard-coded pause is unlikely to fit all users.

The client may adapt the stability interval locally based on edit churn.

Conceptually:

    high churn
      -> wait longer

    user has moved several blocks forward
      -> allow earlier block sooner

    long untouched paragraph
      -> strong stability evidence

This adaptation must remain local and must not become behavioural profiling.

## 7. Stable island example

Draft:

    P1: untouched for a while, cursor far below
    P2: untouched, later paragraph exists
    P3: recently edited
    P4: current caret

State:

    P1 -> SPECULATIVE_READY
    P2 -> SPECULATING
    P3 -> DIRTY
    P4 -> EDITING

P1/P2 may be reused later if their hashes and dependencies still match.

## 8. Deletion

If the user deletes a fragment:

    mark fragment DELETED
    cancel in-flight request when possible
    purge speculative source/result
    remove fragment from DraftTranslationState
    invalidate dependants when necessary

A late provider result for the deleted revision is discarded.

## 9. Rewrite

If:

    "The contract starts Monday."

becomes:

    "The contract might start next month."

the fragment revision changes.

The old speculative translation is invalid even if most characters are similar.

V1 uses exact source revision/hash validity rather than fuzzy reuse.

## 10. Boundary changes

Editing punctuation can change segmentation.

Example:

    "No. We deploy tomorrow."

becomes:

    "No, we deploy tomorrow."

The segmenter must be able to merge/split fragment boundaries and invalidate affected speculative results.

Fragment identity must therefore be independent from simple character offsets where practical.

## 11. Cross-fragment dependencies

DraftTranslationState may record lightweight relations:

    terminology_dep
    entity_dep
    pronoun_dep
    discourse_dep
    style_dep

Example:

    P1 defines "CR" = change request
    P3 uses "CR"

Editing that definition invalidates P3's speculative terminology decision.

## 12. Cancellation and stale responses

Each speculative request has:

    request_id
    draft_id
    draft_revision
    fragment_id
    fragment_revision
    source_hash

On local invalidation:

    cancel request if supported

But correctness never relies on cancellation.

Every returned response is checked against current revision/hash before acceptance.

## 13. Main-thread performance

Typing must remain the highest priority.

Heavy work should not run synchronously in the input event path.

Implementation direction:

- cheap edit bookkeeping in the input path;
- segmentation/dependency work deferred or moved to a Web Worker where justified;
- network work asynchronous;
- no speculative operation blocks rendering/input.

## 14. Churn protection

If a user is rewriting heavily:

    speculative_invalidated_rate rises
    edit velocity remains high

the client may temporarily pause speculation.

This saves compute and avoids useless traffic.

Speculation resumes when stable islands appear.

## 15. Send barrier

When Send is pressed:

    freeze final draft revision
    stop accepting speculative results for older revisions
    compute final fragment map
    reuse exact-valid speculative fragments
    translate remaining fragments
    final reconciliation
    deliver

The Send action never waits for obsolete speculative jobs.

## 16. Privacy

Keystroke-level data stays local.

Only eligible stable fragment snapshots may leave the device when progressive translation is allowed.

If the user deletes an unsent fragment:

- local speculative metadata is removed;
- remote ephemeral content/result is purged according to the transient policy;
- no durable memory is created.

## 17. Metrics

Useful metrics:

    fragment_stability_wait_ms
    stable_island_count
    speculative_reuse_rate
    speculative_invalidation_rate
    speculative_cancel_rate
    stale_response_discard_rate
    high_churn_pause_count
    send_reusable_fraction
    send_to_ready_ms

No keystroke text is required for these metrics.

## 18. Quality invariant

Fluidity optimisation must never change the final semantic result.

For the same final source message and same context/profile versions:

    progressive path

should be evaluated against:

    full post-Send path

for semantic and stylistic equivalence.

## 19. Acceptance criteria

V1 is not complete until:

1. editing a speculated fragment invalidates it immediately;
2. deleting a fragment purges/invalidates its speculative state;
3. late responses for stale revisions are always discarded;
4. no speculative operation blocks typing;
5. the active edit frontier remains conservative;
6. earlier stable islands can still be speculated independently;
7. terminology/reference dependencies can invalidate downstream fragments;
8. heavy rewrite churn can pause speculation automatically;
9. Send freezes one final draft revision before reuse;
10. final delivered translation never contains stale text from an earlier draft revision.

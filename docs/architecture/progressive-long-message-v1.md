# Progressive Long-Message Translation — Experimental

**Status:** Experimental hypothesis — not required for Core V1  
**Scope:** Client, Context Engine, Translation Engine, Privacy  
**Goal:** make long multilingual messages feel nearly instantaneous at Send

## 1. User experience goal

For short messages:

    type
      -> Send
      -> translate normally

For long messages:

    paragraph 1 becomes stable
      -> speculative translation prepared

    paragraph 2 becomes stable
      -> speculative translation prepared with continuity

    final paragraph still being typed

    Send
      -> reuse stable work
      -> translate remaining tail
      -> reconcile full message
      -> deliver final translation

The recipient never sees draft fragments.

## 2. Draft identity

Conceptually:

    Draft {
      draft_id
      conversation_id
      local_revision
      target_profile_version
      context_state_version
      created_at
    }

A draft is not a durable message.

## 3. Fragment model

    DraftFragment {
      draft_id
      fragment_id
      ordinal
      revision
      source_hash
      boundary_type
      stable_since
      speculative_status
    }

Possible boundaries:

    SENTENCE
    PARAGRAPH
    LIST_ITEM
    BLOCK

## 4. Client-side boundary detection

Boundary detection happens before draft content is sent to HERMENEIA Core.

Signals may include:

- punctuation;
- paragraph breaks;
- Markdown/list boundaries;
- language-specific sentence segmentation;
- debounce after typing stops;
- local syntax heuristics.

The client must avoid splitting:

- URLs;
- email addresses;
- decimals;
- abbreviations;
- code blocks;
- known acronyms.

## 5. Stability state machine

Detailed stability/invalidation behaviour is defined in [Draft Stability and Reversible Speculation — V1](draft-stability-v1.md).


A fragment may move through:

    EDITING
      -> STABLE_CANDIDATE
      -> SPECULATING
      -> SPECULATIVE_READY
      -> INVALIDATED
      -> FINAL_REUSED

Any edit touching a fragment after speculation changes its revision/hash and invalidates the old result.

The current edit region is treated as a conservative **mutable frontier**. Earlier untouched blocks may become independent **stable islands** eligible for speculation.

## 6. Speculative request

A speculative request may contain only:

- stable fragment content;
- bounded prepared Conversation State;
- DraftTranslationState;
- target language/locale/profile;
- terminology constraints;
- strategy/model metadata.

It should not contain unrelated draft paragraphs or complete historical conversation by default.

## 7. DraftTranslationState

Ephemeral state shared across fragments:

    source_language
    target_language_profile_ref
    terminology_decisions
    entity_handles
    style_constraints
    discourse_state
    source_tail_context_refs
    strategy_version
    context_state_version

This allows paragraph N+1 to remain consistent with paragraph N using source-derived context and explicit terminology/entity decisions. Previous translated text is never semantic evidence.

## 8. Final reconciliation

A final message-level pass validates:

- semantic completeness;
- pronoun/reference consistency;
- terminology consistency;
- paragraph transitions;
- register/style consistency;
- punctuation/emoji preservation;
- target-locale naturalness.

The reconciliation step may operate on:

- final source message;
- pretranslated fragment outputs;
- compact DraftTranslationState;
- Conversation State.

It should avoid retranslating every fragment from scratch when speculative output is still valid.

## 9. Trust rule

Only the final reconciled translation is deliverable.

States such as:

    speculative
    partial
    stale
    validating

must never be represented to the recipient as final.

## 10. Privacy

Unsent draft content is more sensitive than sent content.

Requirements:

- disabled unless product/tenant policy permits it;
- ephemeral only;
- no durable logs;
- no analytics payload containing draft text;
- no training/evaluation reuse;
- purge on send, discard, logout, timeout or conversation switch;
- provider policy must explicitly permit transient draft processing.

## 11. Enterprise controls

Possible tenant settings:

    progressive_translation = disabled | allowed
    draft_processing_region = EU
    allowed_providers = [...]
    max_draft_ttl_seconds
    max_speculative_cost_per_message
    require_dedicated_provider = true/false

## 12. Cost-aware activation

Speculation should normally remain off below a message-size threshold.

Example decision inputs:

    current_char_count
    stable_fragment_count
    estimated_provider_latency
    provider_cost
    target_language complexity
    tenant budget
    network RTT

The exact activation rule is benchmarked.

## 13. Abandoned drafts

When a user abandons a draft:

    speculative result -> purge
    transient source -> purge
    DraftTranslationState -> purge

No CorrectionMemory or durable language memory is created from an unsent draft.

## 14. Context updates

Unsent draft content must not update durable Conversation State.

It may influence only DraftTranslationState.

After Send, the final accepted message can update normal working Conversation State.

## 15. Corrections

Correctness depends on exact revision/hash validation, not on predicting that the user has finished an idea.


If the user edits an already speculated paragraph:

    source_hash mismatch
      -> invalidate speculative fragment
      -> recompute only affected fragment and dependent continuity state

Avoid invalidating unrelated earlier stable fragments unless cross-fragment meaning actually depends on the changed content.

## 16. Failure handling

If speculative translation fails:

    continue typing unaffected
    Send still works through normal translation path

Speculation is an optimisation, never a dependency.

If final reconciliation fails:

    fall back to translating the final message normally
    never deliver unchecked speculative fragments

## 17. Metrics

Required metrics:

    progressive_translation_activation_rate
    speculative_fragments_total
    speculative_fragment_reuse_rate
    speculative_invalidated_rate
    abandoned_speculative_rate
    send_to_translation_ready_ms
    final_reconciliation_ms
    speculative_cost_waste_ratio
    draft_ttl_purge_count

No raw draft text is required for these metrics.

## 18. Performance target

Primary UX metric:

    send_to_translation_ready_ms

For long messages with reusable speculative work, this should be materially lower than translating the complete message only after Send.

Cold-path and progressive-path percentiles must be reported separately.

## 19. Evaluation

Test scenarios include:

1. three-paragraph message typed normally;
2. edit of paragraph 1 after paragraph 3 has begun;
3. abandoned long draft;
4. acronym/terminology consistency across fragments;
5. pronoun referring to an earlier paragraph;
6. code block and URLs inside a long message;
7. emoji and regional style across paragraphs;
8. provider speculative failure followed by normal Send;
9. context state changes while a draft is open;
10. tenant policy disabling draft processing.

## 20. Experimental adoption criteria

This feature is not required for Core V1. It may graduate only after:

1. no draft fragment is delivered before Send;
2. stable fragments can be translated before Send under allowed policy;
3. every speculative result is tied to exact source hash/revision;
4. edits invalidate affected speculative output;
5. final reconciliation occurs before delivery;
6. speculative failure never blocks Send;
7. abandoned drafts are purged;
8. unsent drafts never create durable Conversation State or CorrectionMemory;
9. tenant policy can disable all draft processing;
10. progressive path measurably reduces send-to-ready latency on long messages.


## 21. Graduation gate

Progressive translation remains disabled by default until a controlled benchmark demonstrates:

- materially lower p95 Send-to-Ready latency on eligible long messages;
- non-inferior semantic/style quality against full post-Send translation;
- bounded speculative cost/waste;
- no measurable degradation of Send/ACK SLO;
- acceptable radio/battery impact on constrained mobile networks.

Stable-island complexity is preserved as a research design, not a prerequisite for the first production messaging core.

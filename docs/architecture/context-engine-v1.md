# HERMENEIA Context Engine V1

**Status:** Executable T0/T1 plus authoritative claim-backed T2, speaker style, transient active episode and bounded semantic episode enrichment; recovery enrichment remains incomplete  
**Version:** 1  
**Primary goals:** translation quality, low latency, temporal correctness, reproducibility

## 1. Responsibility

The Context Engine answers one question:

> What is the smallest useful context required to translate this message correctly now?

It does not own message transport and does not call a specific AI provider directly.

Its output is a versioned ContextSnapshot consumed by the Translation Engine.

### Executable baseline qualified in PostgreSQL

The current V1 runtime implements and tests:

- metadata-only immutable `ContextSnapshot` persistence in migration 0012;
- T0 snapshots even when no contextual candidate is selected, so translation decisions remain traceable without persisting plaintext;
- T1 recent-message context sourced only from the bounded transient source store;
- bounded in-memory context payloads with TTL and fail-closed T0 fallback when contextual payload cannot be admitted or recovered;
- exact source revision, recipient profile and active-conversation fences before translation publication;
- a conversation content-invalidation frontier carried by `erasure_epoch`;
- edit and delete advancing that frontier transactionally;
- a conversation-policy invalidation frontier carried by authoritative `conversations.policy_version`, also used to reject stale ConversationState;
- a tenant-policy invalidation frontier carried independently by `tenants.policy_version` and persisted as ContextSnapshot `tenant_policy_version`;
- stale ContextSnapshots being rejected when their erasure epoch, conversation policy version, or tenant policy version no longer matches authoritative state;
- a real PostgreSQL E2E proving stale-content and stale tenant-policy contextual work are superseded before another provider call and cannot publish a TRANSLATION envelope.

The persistent runtime does **not** yet make T2 production-complete. Migration 0013 provides the bounded durable ConversationState/claim/provenance/checkpoint schema; PostgreSQL persistence, messaging-operation registration, a fenced `context.reduce` worker and the ConversationState-to-planner boundary are now executable. Context planning projects state strictly before the current operation, strips current/future pending operations from historical gap checks, and rejects state that has already processed the message being translated. A compatible state alone is not called T2: T2 requires material derived candidates, and enrichment failure degrades to T1/T0.

The first material T2 source is authoritative structured claim memory. The planner may materialise only claims already referenced by ConversationState and revalidated at read time. Eligible classes are confirmed corrections, approved glossary entries and tenant policy references. Restricted/sensitive, inactive, expired, out-of-scope, malformed or unauthorised claims are dropped. Supported V1 propositions are bounded structured `TERM_MEANING` and `PREFERRED_RENDERING` records; arbitrary free-form prompt payloads are not accepted as provider context. Selected claim provenance is recorded as `claim_id:claim_version` in ContextSnapshot metadata.

Language-scoped claims are additionally fenced against the authoritative current source revision. `message_revisions.declared_source_language` is projected into the planning frame; a non-null proposition `source_language_tag` is admissible only on an exact normalised match, and fails closed when the current source language is unknown. Target-language qualifiers must likewise match the active translation target. Because applicability is resolved before arbitration, generic and matching language-specific claims that overlap for the current message are grouped under the same effective semantic key and cannot carry contradictory values into provider context.

Tenant control-plane evidence is projected as a separate bounded read-time overlay. Active generic tenant `APPROVED_GLOSSARY` / `POLICY` claims do not need to be copied into each conversation's state reference arrays. The PostgreSQL repository loads them as-of the same current source-revision boundary in the same transaction as referenced claim memory. More than 128 active eligible tenant policy claims is treated as an enrichment failure and degrades the translation to T1/T0 rather than applying a partial arbitrary policy set.

Explicit style is a separate working-state source, not claim memory. ConversationState may hold at most 16 speaker profiles, each containing only a bounded preferred register (`NEUTRAL`, `FORMAL`, `INFORMAL`), repair-event provenance, confidence and timestamps. During planning, only the profile whose `speakerUserId` equals the current source revision author may become a `STYLE_PROFILE` candidate. It is admissible only when its `updatedAt` is strictly before the current source revision acceptance time and any `expiresAt` remains in the future. The provider payload removes the speaker identity and carries only `{"kind":"trusted_conversation_style","preferred_register":"..."}`. `DEFAULT` clears the actor's explicit profile. The mutation side is also executable: authenticated tenant `ADMIN` / `OWNER` actors may create or replace only the two supported structured proposition shapes; semantic replacement invalidates the prior ACTIVE claim at the same authority class, records `OVERRIDDEN_BY` provenance and advances `tenants.policy_version`; explicit revocation retains the claim row as `REVOKED` and advances that frontier again. The tenant actor is derived from authentication and is never accepted from request payload.

A PostgreSQL E2E now proves an explicit correction can move through `correction command -> TranslationRepairEvent -> ContextClaim -> provenance -> ConversationState reference -> T2 ContextSnapshot -> provider context`. The correction command uses the same durable command ledger as messaging, so retrying the same command is idempotent and reusing its identifier for different content is rejected.

Promotion is intentionally authority- and speaker-aware. Any active member may promote a supported conversation correction when it is anchored to that member's own source revision. Such a claim stores `subject_user_id` and is materialised only when the current source revision was authored by that same user. This makes an explicit user correction authoritative for the user's own intended meaning without granting permission to redefine another participant. An unanchored or cross-speaker correction from an ordinary member remains `NEEDS_CONFIRMATION`; conversation `MODERATOR` and tenant `ADMIN/OWNER` roles retain the generic conversation-level override path. Message scope remains repair-only, while `TENANT` and `TONE` remain `NEEDS_CONFIRMATION`. Claim retrieval is independently fenced **as-of the current source revision's `message_revisions.created_at`**, so a later correction cannot retroactively affect an earlier revision.

Translation feedback is now recorded as a durable repair/problem signal without automatic memory promotion. Only the recipient of a READY translation for the current source revision may submit it, and free-form feedback notes are excluded from durable plaintext storage.

Pending review is now an explicit authority boundary. Elevated reviewers may reject a pending repair, but semantic approval is allowed only when the repair can be cryptographically/auditably tied through its command receipt to the exact original structured `context.correction` proposal. The reviewer action creates a separate `EXPLICIT_CORRECTION` audit event and promotes a generic conversation claim from that reviewed proposal. Vague feedback, tenant-wide proposals and TONE proposals cannot cross this boundary into T2 memory.

Promoted correction memory is also supersession-safe: a new correction invalidates older ACTIVE confirmed corrections with the same conversation, subject and semantic key, writes `OVERRIDDEN_BY` claim-to-claim provenance and removes the stale refs from ConversationState before the transaction commits. This prevents contradictory historical meanings from remaining simultaneously eligible for T2.

Explicit revocation without replacement is executable as a separate authority path. It preserves the claim row with `REVOKED` status and `INVALIDATED_BY` repair-event provenance, removes the claim from working ConversationState, and does not create replacement semantics. Speaker-scoped correction revocation belongs only to that speaker; generic correction revocation remains an elevated moderator/admin operation.

A second conflict fence runs during claim materialisation, before candidate ranking. Claims are grouped by typed semantic key. Approved `POLICY` / `APPROVED_GLOSSARY` evidence is considered first; when no such approved control-plane evidence applies, a matching speaker-scoped correction is more relevant than a generic correction for that speaker. The applicable level must have value consensus. Contradictory values at the same applicable authority/scope level cause that semantic key to be omitted from T2, not scored against each other. Identical claims are collapsed to one provider candidate with all supporting versioned claim refs retained for snapshot provenance.

Richer semantic episode signals beyond lexical/language/time V1, inferred style, recovery-checkpoint materialisation, dependency-aware invalidation and a production cross-process worker transport remain future work. The current raw-source store is process-local and transient, so `TRANSLATION_WORKER_MODE=external` fails fast rather than pretending a separate process can access plaintext that it does not own.

## 2. Design principle: understand progressively

HERMENEIA must not wait for a new message and then rediscover the conversation from scratch.

Conversation understanding is maintained incrementally:

    message N accepted transiently
          |
          +-- immediate state update
          |
          +-- async enrichment
                 |
                 +-- embedding
                 +-- entities
                 +-- episode state
                 +-- summary
                 +-- memory candidates
                 +-- retrieval index
                        |
                        v
              warm context for message N+1

The next translation should therefore begin from prepared state rather than raw history.

## 3. Critical path

    incoming message
          |
          v
    validate + authorize
          |
          v
    idempotent metadata acceptance
          |
          v
    server sequence assigned
          |
          v
    load warm ContextState
          |
          v
    freshness check
          |
          +-- state current -> use prepared candidates
          |
          +-- state behind  -> append/reconcile missing raw recent messages
          |
          v
    candidate ranking + budget
          |
          v
    ContextSnapshot
          |
          v
    Translation Engine
          |
          v
    persist translation
          |
          v
    deliver

No expensive full-history scan belongs on this path.

## 4. Derived ContextState

A logical ConversationContextState contains:

    conversation_id
    context_version
    processed_prefix_sequence
    processing_gaps
    erasure_epoch
    active_episode_id
    active_episode_version
    active_topic_embedding
    recent_entity_set
    recent_language_style
    pragmatic_state
    lexical_state
    domain_terminology_state
    target_language_profile_ref
    conversation_style_profile
    summary_ref
    memory_index_version
    claim_graph_version
    updated_at

This state is derived. It is **partially restorable** from authorised structured state and recalculable only when required source revisions are still available. Missing source must produce degraded/source-required state, not fabricated reconstruction.

PostgreSQL remains the durable source of truth for metadata, policies, corrective memory, bounded structured state and recovery checkpoints. Raw message bodies are transient by default.

An in-memory or Redis representation may accelerate access but is never authoritative.

## 5. Message sequence

Every message receives a monotonic server-side sequence within its conversation.

Example:

    conversation 42

    seq 101  "Tu as trouvé le bug ?"
    seq 102  "Oui, c'était le cache."
    seq 103  "Tu l'as corrigé comment ?"

Context freshness is based on this sequence, not only wall-clock timestamps.

This protects ordering against client clock differences and enables deterministic recovery.

## 6. Immediate context

The immediate layer contains the smallest recent set needed to resolve:

- pronouns;
- ellipsis;
- reply targets;
- short answers;
- local references;
- negation;
- conversational tone;
- emoji contribution;
- punctuation/casing intensity;
- pragmatic intent.

This layer is cheap and may directly include raw recent messages.

It is the fallback when richer enrichment is behind.

## 7. Episode state

An episode represents a coherent segment of conversation.

The **executable V1** keeps a privacy-minimal structural episode and now permits bounded semantic continuity scoring from transient primary evidence. ConversationState persists no transcript and no episode summary. It stores only:

    episode_id
    episode_version
    continuity_confidence
    start_operation_sequence
    last_operation_sequence
    started_at
    last_activity_at

For `MESSAGE_CREATED`, the temporal baseline continues the active episode while the registered-time gap is at most 20 minutes. A larger gap starts a new episode and a clock regression starts a new low-confidence episode. When transient plaintext is still available, semantic enrichment reconstructs at most eight CREATED source revisions from the durable structural op-sequence range, reads their bodies only from the transient source store and scores lexical overlap, language continuity and temporal distance. A confident `CONTINUE_ACTIVE` or `START_NEW` refines the temporal patch; `UNCERTAIN`, missing transient evidence or scorer failure keeps the temporal result.

The current provider-facing episode is materialised only at planning time from source texts that are still available in the bounded transient source store. With the six-message planning window and nominal three-message immediate window, the `ACTIVE_EPISODE` capsule uses only messages 4–6 from the recent window while messages 1–3 by recency remain immediate context. Each episode source is included whole or skipped; no source body is truncated to manufacture a capsule, and missing/expired transient sources result in no episode payload.

The richer research model remains a later enrichment layer. V1 semantic enrichment is deliberately lexical/language/time only. Future classification may add embeddings, entity/topic evidence, reply/reference signals and `REACTIVATE_PRIOR`; those capabilities must not be retroactively claimed by this heuristic.

## 8. Continuity features

Post-temporal-V1 enrichment may combine:

- time delta;
- semantic similarity to active episode;
- similarity to recent messages;
- entity overlap;
- reply/quote relationship;
- lexical continuity;
- explicit discourse markers;
- explicit references to an older topic.

The scoring strategy must have an identifier such as:

    continuity_strategy = "heuristic-v1"

and its component scores should be observable for evaluation.

## 9. Temporal decay

Time reduces relevance but does not delete meaning.

A candidate may receive a temporal factor based on its class.

Conceptually:

    temporal_relevance = decay(age, memory_scope)

Different scopes should decay differently:

- ephemeral: aggressive decay;
- session: short decay;
- episode: moderate decay;
- terminology/preference: slow or event-driven invalidation;
- explicitly referenced context: temporary boost even when old.

V1 should prefer simple explainable decay functions before learned ranking.

## 10. Retrieval candidates

Candidates can come from:

1. bounded transient recent messages;
2. active episode state;
3. sanitised recovery checkpoint state;
4. approved CorrectionMemory;
5. authorised durable ContextClaims/CorrectionMemory permitted by policy;
6. explicit reply/quote targets available in the transient/client-supplied context.

Each candidate carries metadata:

    candidate_id
    candidate_type
    source_ids
    semantic_score
    temporal_score
    confidence
    importance
    token_estimate
    explicit_reference
    privacy_scope

## 11. Ranking

A V1 candidate ranking can use a configurable function such as:

    utility =
        semantic_weight * semantic_score
      + temporal_weight * temporal_score
      + confidence_weight * confidence
      + importance_weight * importance
      + explicit_reference_bonus
      + active_episode_bonus
      - token_cost_penalty

The exact formula is not a product contract.

The important constraints are:

- deterministic for the same strategy/config/input where practical;
- versioned;
- inspectable;
- benchmarkable;
- bounded by a token/context budget.

## 12. Context budget

The Context Builder should reserve budget in priority bands rather than letting retrieval fill the whole window.

Example conceptual allocation:

    system/instruction reserve
    current message
    immediate context reserve
    active episode reserve
    retrieved memory reserve
    safety margin

Unused budget can flow to lower-priority candidates.

Provider maximum context size must not define the target budget. Sending more context is not inherently better.

## 13. ContextSnapshot

A snapshot is an immutable record of what the Translation Engine was given conceptually.

It should identify:

    snapshot_id
    conversation_id
    message_id
    strategy_version
    context_state_version
    active_episode_id
    selected_candidate_ids
    selected_source_revision_refs
    selected_claim_refs
    processed_prefix_sequence
    processing_gap_refs
    erasure_epoch
    policy_version
    tenant_policy_version
    token_estimate
    created_at

`processing_gap_refs` identifies causally prior operations not yet incorporated in the prepared projection. A simple maximum/lag count is insufficient because workers may finish out of order.

The snapshot must be sufficient to explain and reproduce evaluation decisions without unnecessarily duplicating private text.

The executable V1 schema persists snapshot metadata/provenance only. Selected plaintext remains in the bounded transient context payload store. A T0 decision still receives a durable snapshot with an empty selected-candidate set.

`erasure_epoch` is the authoritative **content-invalidation frontier** for prepared context in the current V1 runtime. Replacing a source through edit or removing it through delete advances the epoch in the same transaction as the mutation. Two policy frontiers remain distinct: `policy_version` records the current **conversation authority version** and must also match ConversationState before derived state may be reused; `tenant_policy_version` records the current **tenant control-plane version** from `tenants.policy_version` for tenant-wide glossary/policy overlay evidence. Every new ContextSnapshot persists both. Translation publication accepts a referenced snapshot only when erasure, conversation-policy, and tenant-policy frontiers all still match their authoritative rows. Migration 0014 gives omitted/legacy values for both snapshot policy columns the sentinel `0`; real conversation and tenant policy versions are always >= 1, so old writers/snapshots fail closed. This avoids mass-updating every conversation when tenant policy changes while still preventing old content or old tenant policy from being reintroduced.

## 14. Fast-path stale-state reconciliation

Example race:

    seq 100 persisted
    async enrichment starts

    seq 101 arrives immediately
    ContextState.processed_prefix_sequence = 99
    processing_gaps includes seq 100

HERMENEIA must not wait for enrichment of seq 100.

Instead it builds the snapshot from:

    prepared context through seq 99
    +
    transient message seq 100 (if still within TTL / supplied by authorised client)
    +
    current message seq 101

The slow path later incorporates the missing causal operation and advances the contiguous processed prefix. A completion for seq 102 cannot advance the prefix through an unresolved seq 100/101 gap.

## 15. Async enrichment

Background tasks should be independently retryable and idempotent.

Logical tasks may include:

- embed_message(message_id);
- update_episode_features(conversation_id, sequence);
- refresh_episode_summary(episode_id);
- extract_ephemeral_context_claims(message_id);
- expire_or_invalidate_ephemeral_claims(...);
- update_retrieval_index(...);
- update_context_claims_and_provenance(...);
- refresh_pragmatic_state(conversation_id, sequence);
- refresh_lexical_state(conversation_id, sequence);
- refresh_domain_terminology_state(conversation_id, sequence);
- refresh_conversation_style_profile(conversation_id, sequence).

This logical separation does not imply separate microservices.

## 16. Debounce and batching

Do not invoke an expensive LLM summary after every short message.

Example policy to evaluate:

- cheap features update every message;
- summary refresh after N meaningful messages;
- or after a token threshold;
- or after a short inactivity debounce;
- force refresh when an episode closes.

The policy must be benchmarked because aggressive background AI can cost more than the translation itself.

## 17. Hot conversations

Active conversations should remain warm.

Possible hot-state optimisations:

- cached ContextState;
- cached token estimates;
- already computed embeddings;
- active-episode centroid;
- preselected/recent high-value memory candidates;
- persistent HTTP connections to providers.

Warm caches are optimisations only. Correctness must survive a cold cache.

## 18. Provider latency

Context optimisation cannot eliminate model/network latency.

Measurements therefore separate:

    T_total =
      T_accept
    + T_context
    + T_provider
    + T_persist_translation
    + T_delivery

The project should optimise each component independently.

Connection reuse, provider selection and model choice belong to Translation infrastructure, not Context correctness.

## 19. Perceived latency

For short messages, returning a complete translation may produce better UX than visibly streaming unstable partial translation.

For longer content, streaming may be evaluated later.

The original message can be safely persisted immediately while the translated bubble remains in a short translating state.

UX must never represent an incomplete translation as final.

## 20. Failure and recovery

If ContextState is unavailable or corrupt:

1. do not lose the accepted message;
2. restore approved corrections/glossaries and the latest compatible sanitised checkpoint;
3. use authorised transient/client-supplied source revisions when available;
4. otherwise enter DEGRADED_CONTEXT / SOURCE_REQUIRED rather than inventing missing history;
5. translate only when the required source is available;
6. schedule safe projection recovery.

If background enrichment repeatedly fails, translation must continue through a bounded fallback strategy.

## 21. Data lifecycle

Derived context must remain traceable to source data.

Deletion/invalidation may affect:

- embeddings;
- summaries;
- episode state;
- durable corrective claims;
- cached candidates;
- ContextSnapshots according to retention policy.

Caches must not resurrect deleted data after authoritative deletion.

For the executable persistent baseline, edit/delete invalidation is intentionally conversation-wide through `erasure_epoch`; conversation authority is fenced by `policy_version`; and tenant-wide control-plane authority is fenced independently by `tenant_policy_version`. Transient payload bytes may remain resident until their bounded TTL expires, but a stale snapshot cannot pass the authoritative publish fence after any relevant frontier advances. Future T2 dependency indexing may narrow invalidation while preserving the same fail-closed publication rule.

## 22. Latency SLO candidates

Initial engineering targets, to be validated on a documented environment:

    context fast path
      p50 <= 50 ms
      p95 <= 150 ms

    message metadata acceptance before AI
      p95 <= 150 ms

    end-to-end short-message translation
      provider dependent; measured, not assumed

The project should report cold and warm paths separately.

## 23. Required metrics

At minimum:

    context_fast_path_ms
    context_freshness_gap
    context_candidates_total
    context_candidates_selected
    context_tokens_estimated
    context_cache_hit
    episode_decision
    episode_decision_confidence
    pragmatic_inference_ms
    pragmatic_confidence
    emoji_preservation_rate
    colloquial_resolution_ms
    ambiguous_acronym_rate
    conversation_lexical_cache_hit_rate
    glossary_hit_rate
    terminology_ambiguity_rate
    terminology_consistency_rate
    style_profile_update_ms
    locale_resolution_ms
    neutral_locale_fallback_rate
    stale_derived_write_rejections
    context_claims_invalidated
    low_confidence_claim_usage_rate
    async_context_lag_sequences
    translation_provider_ms
    translation_end_to_end_ms

Percentiles are more useful than averages for interactive latency.

## 24. V1 acceptance tests

The Context Engine V1 is not complete until tests demonstrate:

1. message N+1 does not require rescanning the complete history;
2. a warm active conversation uses prepared ContextState;
3. slow-path lag does not omit unprocessed recent messages;
4. a cold cache can restore a valid minimal snapshot from sanitised checkpoint/policy/correction state without raw history;
5. duplicate async jobs do not corrupt state;
6. out-of-order worker completion cannot skip a causal gap, advance the contiguous prefix incorrectly, or leak future-message information into an earlier translation;
7. crossing midnight does not force an episode reset;
8. stale memory can be penalised;
9. explicit old-topic references can retrieve older episodes;
10. snapshots expose the strategy/state versions used;
11. latency metrics separate Context Engine overhead from provider latency;
12. deletion cannot leave a cache that reintroduces removed context;
13. raw message bodies expire from Core according to transient TTL;
14. explicit correction can create scoped CorrectionMemory;
15. restart can enter FAST/PARTIAL/DEGRADED recovery without raw-history replay, and source-dependent work becomes SOURCE_REQUIRED when necessary.

## 25. Non-goals for V1

V1 does not require:

- learned episode classifiers;
- custom translation model training;
- distributed context microservices;
- a dedicated vector database;
- uncontrolled keystroke streaming to the server;
- delivery of speculative draft translations before Send.

The engine should first prove that incremental, temporal context selection improves translation under controlled measurement.


## 26. Context integrity

Context Engine V1 must follow the rules in [Context Integrity, Provenance and Memory Safety — V1](context-integrity-v1.md).

In particular:

- translations are never primary semantic evidence;
- every durable derived claim has provenance;
- derived repetition cannot increase authority by itself;
- stale worker output cannot move Context State backwards;
- edits, deletions and corrections invalidate dependent derived state;
- memory promotion is bounded, versioned and reversible;
- durable memory requires a defined correction/policy trigger;
- raw message bodies are transient by default;
- recovery uses sanitised checkpoints, not conversation transcripts.


## 27. Ephemeral messages and recovery

Context Engine V1 follows [Ephemeral Message and Corrective Memory Model — V1](ephemeral-message-memory-v1.md) and [Sanitised Recovery Checkpoint — V1](recovery-checkpoint-v1.md).

The Core keeps raw content only within a bounded transient window required for immediate context, retries and repair detection. Durable learning is event-driven. After failure/restart, validated structured state is restored from a sanitised recovery checkpoint; missing nuance is relearned from new messages rather than fabricated.


## 28. Progressive long-message translation

Long-message optimisation follows [Progressive Long-Message Translation — V1](progressive-long-message-v1.md).

Draft segmentation happens client-side. Only stable sentence/paragraph fragments may be translated speculatively under allowed policy. Draft content never updates durable Conversation State before Send, and speculative output is never deliverable until final reconciliation.


## 29. Reversible draft stability

Draft speculation follows [Draft Stability and Reversible Speculation — V1](draft-stability-v1.md).

The Context Engine never assumes that a user has definitively completed an idea before Send. It accepts only exact-valid stable fragment snapshots, discards stale revisions, and treats draft edit history/cursor behaviour as client-local operational signals rather than durable context.


## 30. Contract precedence

For delivery acceptance, source ownership, causal publication and checkpoint freshness, ADR-0016 plus [Delivery Contract — V1](delivery-contract-v1.md) and [Data Lifecycle — V1](data-lifecycle-v1.md) are canonical.

The Context Engine does not own the durable Send ACK. It consumes an already accepted source revision and produces a derived result that is published only after causal dependency validation.

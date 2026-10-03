# HERMENEIA Context Engine V1

**Status:** Design baseline  
**Version:** 1  
**Primary goals:** translation quality, low latency, temporal correctness, reproducibility

## 1. Responsibility

The Context Engine answers one question:

> What is the smallest useful context required to translate this message correctly now?

It does not own message transport and does not call a specific AI provider directly.

Its output is a versioned ContextSnapshot consumed by the Translation Engine.

## 2. Design principle: understand progressively

HERMENEIA must not wait for a new message and then rediscover the conversation from scratch.

Conversation understanding is maintained incrementally:

    message N persisted
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
    idempotent persistence
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
    last_processed_sequence
    active_episode_id
    active_episode_version
    active_topic_embedding
    recent_entity_set
    recent_language_style
    pragmatic_state
    summary_ref
    memory_index_version
    updated_at

This state is derived and rebuildable.

PostgreSQL remains the durable source of truth for original messages and durable derived records.

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

The active episode maintains incrementally updated features such as:

- semantic centroid or representation;
- start/last activity timestamps;
- active entities;
- topic keywords/features;
- compact summary;
- continuity confidence.

Episode classification for a new message produces a decision and evidence:

    CONTINUE_ACTIVE
    START_NEW
    REACTIVATE_PRIOR
    UNCERTAIN

UNCERTAIN must be a valid state. The engine should not fabricate certainty when signals conflict.

## 8. Continuity features

V1 may combine:

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

1. recent raw messages;
2. active episode state;
3. prior episode summaries;
4. durable MemoryItems;
5. explicit reply/quote targets.

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
    selected_message_ids
    selected_memory_ids
    token_estimate
    created_at
    freshness_gap

freshness_gap indicates how many messages were not yet represented in the prepared state when the fast path began.

The snapshot must be sufficient to explain and reproduce evaluation decisions without unnecessarily duplicating private text.

## 14. Fast-path stale-state reconciliation

Example race:

    seq 100 persisted
    async enrichment starts

    seq 101 arrives immediately
    ContextState.last_processed_sequence = 99

HERMENEIA must not wait for enrichment of seq 100.

Instead it builds the snapshot from:

    prepared context through seq 99
    +
    raw message seq 100
    +
    current message seq 101

The slow path later catches up and advances last_processed_sequence.

## 15. Async enrichment

Background tasks should be independently retryable and idempotent.

Logical tasks may include:

- embed_message(message_id);
- update_episode_features(conversation_id, sequence);
- refresh_episode_summary(episode_id);
- extract_memory_candidates(message_id);
- promote_or_invalidate_memory(...);
- update_retrieval_index(...);
- refresh_pragmatic_state(conversation_id, sequence).

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

1. do not lose the message;
2. reconstruct a minimal safe context from durable recent messages;
3. translate using a degraded strategy;
4. mark the execution/snapshot as degraded;
5. schedule ContextState rebuild.

If background enrichment repeatedly fails, translation must continue through a bounded fallback strategy.

## 21. Data lifecycle

Derived context must remain traceable to source data.

Deletion/invalidation may affect:

- embeddings;
- summaries;
- episode state;
- MemoryItems;
- cached candidates;
- ContextSnapshots according to retention policy.

Caches must not resurrect deleted data after authoritative deletion.

## 22. Latency SLO candidates

Initial engineering targets, to be validated on a documented environment:

    context fast path
      p50 <= 50 ms
      p95 <= 150 ms

    message persistence before AI
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
    async_context_lag_sequences
    translation_provider_ms
    translation_end_to_end_ms

Percentiles are more useful than averages for interactive latency.

## 24. V1 acceptance tests

The Context Engine V1 is not complete until tests demonstrate:

1. message N+1 does not require rescanning the complete history;
2. a warm active conversation uses prepared ContextState;
3. slow-path lag does not omit unprocessed recent messages;
4. a cold cache can rebuild a valid minimal snapshot from durable data;
5. duplicate async jobs do not corrupt state;
6. out-of-order worker completion cannot move last_processed_sequence backwards;
7. crossing midnight does not force an episode reset;
8. stale memory can be penalised;
9. explicit old-topic references can retrieve older episodes;
10. snapshots expose the strategy/state versions used;
11. latency metrics separate Context Engine overhead from provider latency;
12. deletion cannot leave a cache that reintroduces removed context.

## 25. Non-goals for V1

V1 does not require:

- learned episode classifiers;
- custom translation model training;
- distributed context microservices;
- a dedicated vector database;
- speculative generation before a user sends a message;
- keystroke capture for pre-translation.

The engine should first prove that incremental, temporal context selection improves translation under controlled measurement.

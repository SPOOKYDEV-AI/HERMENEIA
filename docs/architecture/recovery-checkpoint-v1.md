# Sanitised Recovery Checkpoint — V1

**Status:** Design baseline  
**Scope:** Context Engine, Recovery, Memory, Privacy

## 1. Goal

Resume contextual translation automatically after a crash or context-state failure without replaying or durably storing the raw conversation.

## 2. Recovery state vs conversation history

A recovery checkpoint is not a history.

Bad:

    messages:
      - "..."
      - "..."
      - "..."

Good:

    active_episode = technical_support
    terminology:
      CR -> change_request
    style:
      formal = 0.82
      technicality = 0.91
    unresolved_refs:
      ISSUE_3
    processed_prefix_sequence = 184
    correction_memory_refs = [...]

The checkpoint stores current validated understanding, not the text that created it.

## 3. Checkpoint structure

Conceptually:

    RecoveryCheckpoint {
      id
      tenant_id
      conversation_id
      checkpoint_version
      schema_version
      context_strategy_version
      processed_prefix_sequence
      processing_gap_refs
      erasure_epoch
      membership_epoch
      policy_version
      active_episode_state
      terminology_state
      lexical_state
      target_language_profile_ref
      conversation_style_state
      pragmatic_state_coarse
      entity_handles
      unresolved_reference_handles
      correction_memory_ids
      created_at
      expires_at
      integrity_hash
      status
    }

Possible status:

    ACTIVE
    SUPERSEDED
    INVALIDATED
    CORRUPT

## 4. Eligibility filter

Before state is copied into a checkpoint, each element passes:

    authority check
    confidence check
    sensitivity check
    scope check
    usefulness-after-restart check
    size/budget check

A low-confidence working hypothesis should normally be dropped rather than persisted.

## 5. Sensitive-state rule

The checkpoint should avoid retaining inferred sensitive traits.

Examples that should not survive by default:

    health condition inference
    political/religious inference
    sexual-orientation inference
    psychological-state inference
    financial-distress inference

If a deployment has a legitimate need for sensitive terminology context, that should be handled through explicit policy/glossary mechanisms rather than silent inference.

## 6. Coarse pragmatic recovery

Detailed transient emotional state should not be persisted.

Instead, recovery may keep coarse conversational state such as:

    formal
    informal
    professional
    playful
    neutral

with confidence/TTL.

This gives continuity without turning recovery state into emotional profiling.

## 7. Event-triggered checkpointing

Useful refresh triggers:

    correction_confirmed
    terminology_confirmed
    episode_changed
    style_profile_stabilised
    N_messages_processed
    inactivity_debounce
    graceful_shutdown

Checkpoint creation should be debounced and bounded.

## 8. Conditional atomic publication

Checkpoint writes must be atomic **and freshness-checked**.

Pattern:

    create candidate checkpoint
      -> validate schema/content bounds
      -> CAS base Context State version
      -> verify processed prefix/gaps
      -> verify erasure/membership/policy epochs
      -> mark ACTIVE
      -> mark previous SUPERSEDED

A partially written or causally stale checkpoint must never become active.

## 9. Compatibility

A checkpoint records:

    schema_version
    context_strategy_version

On restart:

    compatible
      -> restore

    migratable
      -> migrate and validate

    incompatible
      -> discard state and recover cleanly

Never force incompatible state into a newer engine.

## 10. Recovery modes

### FAST_RECOVERY

Latest valid checkpoint restored.

### PARTIAL_RECOVERY

Checkpoint restored but some sections dropped because of version/sensitivity/expiry.

### DEGRADED_RECOVERY

No sufficiently valid checkpoint/source set. Start with:

    tenant policy
    target language profile
    approved glossary
    CorrectionMemory
    empty live Conversation State

The next messages rebuild contextual state incrementally. Source-dependent pending work becomes `SOURCE_REQUIRED` when exact source content is no longer authorised/available.

## 11. Corrective memory priority

Approved CorrectionMemory is more durable than ordinary checkpoint state.

If the checkpoint says:

    CR -> compte rendu

but a newer CorrectionMemory says:

    CR -> change request

the correction wins.

Recovery must apply current policy/correction state after loading the checkpoint.

## 12. Failure isolation

A bad checkpoint must not make messaging unavailable.

Recovery failure should result in clean/degraded context, not service failure.

## 13. Deletion

Deleting a conversation/user scope must delete or invalidate:

    active checkpoint
    superseded checkpoints
    correction memory in that scope
    transient buffers
    caches

A deleted checkpoint must not be recreated by an old worker.

## 14. Metrics

Required metrics:

    recovery_checkpoint_write_ms
    recovery_checkpoint_size_bytes
    recovery_checkpoint_age_seconds
    recovery_checkpoint_restore_ms
    recovery_mode
    recovery_checkpoint_invalid_count
    recovery_checkpoint_migration_count
    recovery_dropped_state_count

## 15. Size budget

Checkpoint size must be explicitly bounded.

If the checkpoint grows continuously with conversation length, the design has failed and recreated conversation history indirectly.

## 16. Security

Recovery state should be:

    encrypted at rest
    access-controlled by tenant/conversation
    excluded from routine logs
    excluded from training/evaluation reuse
    protected by integrity verification

## 17. Acceptance criteria

V1 is not complete until:

1. restart can recover useful context without raw message history;
2. checkpoint contains no verbatim conversation transcript by default;
3. low-confidence hypotheses are excluded;
4. CorrectionMemory overrides stale checkpoint interpretation;
5. corrupt/incompatible checkpoints fall back safely;
6. checkpoint publication is atomic and guarded by Context State/erasure/membership/policy versions;
7. checkpoint size remains bounded as conversation length grows;
8. deletion removes active/superseded checkpoints;
9. stale workers cannot recreate invalidated checkpoints;
10. recovery metrics identify FAST/PARTIAL/DEGRADED modes.

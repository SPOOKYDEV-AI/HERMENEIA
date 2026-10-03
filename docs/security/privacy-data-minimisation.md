# Privacy and Data-Minimisation Architecture

**Status:** Foundation  
**Audience:** engineering, product, security, legal/compliance reviewers

## 1. Goal

HERMENEIA should preserve conversational meaning while processing the minimum amount of personal data necessary for each translation.

This document defines architectural constraints. It is not legal advice and does not replace a deployment-specific GDPR analysis.

## 2. Core principle

HERMENEIA distinguishes between:

- **source data**: original messages and user/account data;
- **derived conversational state**: bounded information extracted to support future translation;
- **provider request data**: the exact subset sent to a translation/AI provider;
- **telemetry**: technical metadata used for reliability and performance.

These categories must not be conflated.

## 3. Source data

Original messages are durable source-of-truth data only when the selected product/deployment policy requires their storage.

A future deployment may support shorter retention or ephemeral modes, but those modes must not be simulated by merely hiding messages from the UI.

Source data must have explicit:

- purpose;
- retention;
- access policy;
- deletion behaviour;
- backup behaviour;
- tenant ownership.

## 4. Conversation State

Conversation State exists to avoid repeated full-history analysis.

It should contain only information useful to future translation.

Possible elements:

    conversation_id
    state_version
    last_processed_sequence
    active_episode_id
    unresolved_references
    active_entity_handles
    terminology_state
    tone_register_state
    pragmatic_state
    temporal_reference_state
    compact_summary_ref
    memory_refs
    updated_at

The state must remain bounded.

If state size grows without limit, the architecture has recreated full-history replay in another form.

## 5. Prefer references over duplicated content

When practical, derived objects should point to source identifiers rather than duplicate raw message text.

Example:

    ContextCandidate
      source_message_ids = [101, 104]
      feature = "reply relationship"
      score = 0.91

is preferable to copying both message bodies into multiple derived records.

This reduces duplication and simplifies deletion.

## 6. Provider request minimisation

The provider payload should normally contain only:

1. current message;
2. minimum immediate context;
3. compact relevant Conversation State;
4. specifically retrieved older context when required;
5. translation instructions.

The system must be able to measure:

    raw_history_messages_sent
    raw_history_chars_sent
    context_tokens_sent
    retrieved_old_context_count
    provider_payload_bytes

These metrics enable verification that minimisation is actually happening.

## 7. No hidden training assumption

Conversation content must not be reused for model training merely because the product stores it.

Training/evaluation/research are separate purposes and require separate governance.

The default architecture should assume:

- production conversations are not training data;
- evaluation datasets are separately governed;
- provider settings/contracts must be reviewed for retention and training use;
- no provider switch may silently change data-use conditions.

## 8. Pseudonymous entity handles

Where useful, the Context Engine may maintain local handles instead of repeating identifying strings.

Example:

    PERSON_1 -> local conversation entity
    COMPANY_2 -> local conversation entity

This can reduce repeated exposure, but pseudonymisation is not anonymisation.

Mappings remain sensitive and must be protected.

## 9. Embeddings

Embeddings must be treated as potentially personal derived data when they originate from personal communications.

Requirements:

- tenant/conversation access controls;
- deletion/invalidation strategy;
- no cross-tenant retrieval;
- no assumption that vectors are harmless because they are not human-readable;
- provider/location review if embeddings are computed externally.

## 10. Summaries

Summaries can concentrate sensitive information.

Therefore:

- summaries must be purpose-limited;
- avoid adding facts not required for translation;
- track source provenance where feasible;
- version summary strategies;
- invalidate/rebuild after relevant source deletion;
- do not log summaries by default.

## 11. Sensitive data

The product should assume conversations may contain sensitive or confidential information even if it does not intentionally request it.

Enterprise users may discuss:

- internal projects;
- customer information;
- HR matters;
- financial information;
- legal information;
- health information;
- credentials accidentally pasted by users.

Architecture must therefore avoid relying on the idea that "chat text is low sensitivity".

## 12. Logging

Routine technical logs must not contain full message bodies, full provider prompts or full summaries.

Prefer:

    trace_id
    tenant_id / pseudonymous tenant handle
    conversation_id
    message_id
    context_version
    provider
    latency
    token counts
    error class

Debug access to message content, if ever introduced, must be explicitly controlled and auditable.

## 13. Deletion

Deletion must account for derived data.

A conversation deletion may require removal/invalidation of:

- messages;
- translations;
- embeddings;
- episode summaries;
- memory items;
- context snapshots according to retention policy;
- caches;
- retrieval indexes;
- backup copies according to documented backup lifecycle.

A deleted message must not reappear because a stale cache repopulated it.

## 14. Tenant isolation

Professional use requires strict tenant boundaries.

No retrieval query, cache key, vector lookup, background job or admin operation may cross tenant boundaries unintentionally.

Tenant identity must be part of every relevant storage/retrieval boundary.

## 15. Deployment profiles

The architecture should support future profiles without forking core domain logic:

### Consumer SaaS

- shared platform;
- strict per-user/conversation authorization;
- platform-managed provider configuration;
- clear retention controls.

### Business SaaS

- tenant isolation;
- organisation administration;
- configurable retention;
- audit capabilities;
- enterprise identity integration where required.

### Dedicated / regulated deployment

Potential later profile:

- dedicated infrastructure;
- EU-region or customer-selected region;
- customer-managed encryption/provider keys;
- private network integration;
- self-host/VPC/on-premise where justified.

These are roadmap capabilities, not current features.

## 16. GDPR design alignment

The architecture is intentionally compatible with GDPR principles including:

- purpose limitation;
- data minimisation;
- storage limitation;
- privacy by design and by default.

Compliance still depends on the actual controller/processor roles, legal basis, notices, contracts, retention, transfers, security measures and deployed provider configuration.

## 17. Affect and intent inference

Pragmatic and affective features derived from messages remain protected derived data when linked to users.

HERMENEIA should minimise these features by default:

- prefer message/episode-scoped signals over durable profiles;
- attach confidence and temporal scope;
- expire transient affect aggressively;
- never infer or persist psychological/mental-health profiles merely to improve translation;
- do not expose raw affective content in routine logs;
- delete/invalidate derived pragmatic state together with its authorised source lifecycle.

Affect inference exists to preserve communication intent, not to profile users.

## 18. Engineering acceptance criteria

Privacy minimisation is not considered implemented until tests/metrics can show that:

1. full history is not routinely resent for each message;
2. provider payload size stays bounded as conversation history grows;
3. cross-tenant retrieval is impossible;
4. deleted data cannot be resurrected from cache;
5. Conversation State remains bounded;
6. provider payload composition is observable without logging private text;
7. a context-state rebuild can be performed from authorised durable data;
8. translation still works when no old raw history is available beyond the configured retention window.

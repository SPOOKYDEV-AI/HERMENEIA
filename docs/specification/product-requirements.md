# HERMENEIA Product Requirements

**Version:** 0.1  
**Status:** Foundation  
**Scope:** MVP and research baseline

## 1. Product statement

HERMENEIA is a real-time multilingual messaging system that translates conversations while selecting context dynamically according to semantic relevance, temporal continuity and conversational structure.

The product must preserve meaning without requiring every translation request to include the entire conversation history.

## 2. Core research problem

> Given a new message, which prior information is still useful enough to improve its translation?

The system must compare adaptive context retrieval against simpler baselines rather than assuming more context is better.

## 3. MVP users

### Standard user

A user can:

- create/authenticate an account;
- configure a preferred language;
- start a private 1:1 conversation;
- send and receive text messages;
- receive automatic translations;
- reveal the original message;
- report a translation problem.

### Administrator

An administrator may operate the system and inspect technical metrics, but administrator status must not imply unrestricted access to private message bodies.

## 4. MVP in scope

- responsive web application;
- authentication;
- private 1:1 conversations;
- text messages;
- automatic source-language detection;
- per-recipient translation;
- WebSocket or equivalent real-time delivery;
- original message bodies processed transiently by HERMENEIA Core rather than durably stored by default;
- versioned translation execution metadata without requiring durable message-body retention;
- temporal conversational episodes;
- contextual retrieval;
- durable corrective linguistic/terminology memory only when triggered by explicit or strongly evidenced correction events;
- emoji-aware and pragmatic-intent-aware translation;
- preservation of tone/register with uncertainty handling;
- contextual understanding of slang, acronyms, SMS abbreviations and mixed-language messages;
- scoped professional/domain terminology with tenant/project glossary precedence;
- locale- and region-aware target formulation;
- dynamic conversation style profiling from the first exchanges with confidence and ongoing updates;
- provenance-aware memory and reversible context derivation;
- correction-triggered context updates with no random durable self-learning;
- sanitised recovery checkpoints for automatic context recovery without raw-history replay;
- progressive translation of stable fragments for long messages, with final reconciliation before delivery;
- adaptive mobile networking across Wi-Fi/3G/4G/5G and intermittent connectivity;
- local outbox and idempotent send/retry;
- connection/session recovery without full state replay;
- mobile background/push-aware delivery behavior;
- user feedback;
- T0/T1/T2 evaluation;
- technical metrics and failure visibility.

## 5. Explicitly out of scope for MVP

- voice/video calls;
- live speech translation;
- native mobile apps;
- public channels;
- social-network features;
- arbitrary file/image translation;
- custom model training;
- end-to-end encryption that prevents required server-side AI processing.

Out-of-scope features may be reconsidered only after the core context hypothesis is measured.

## 6. Context model

Context is not equivalent to the last N messages.

The system recognises four layers:

1. **Immediate context** — directly adjacent messages needed for references and local ambiguity.
2. **Active episode** — the current coherent conversational topic/session.
3. **Relevant prior episodes** — older topics explicitly or semantically resumed.
4. **Durable memory** — selected terminology or interaction preferences that remain useful over time.

A date boundary is a signal, never a hard reset.

## 7. Episode continuity

Episode continuity should consider:

- time since previous message;
- semantic similarity;
- entity overlap;
- reply/quote relationships;
- explicit references to previous topics;
- lexical/topic continuity;
- indicators of topic change.

The initial engine may use a weighted heuristic, but its inputs and version must be observable and replaceable.

## 8. Temporal memory

Remembered information may include:

- `created_at`;
- `valid_from`;
- `valid_until`;
- `last_confirmed_at`;
- `last_used_at`;
- `temporal_scope`;
- `confidence`.

Old information must not be treated as permanently true.

## 9. Context budget

The Context Builder must operate under an explicit budget. Candidate context should be ranked by usefulness relative to token/latency cost.

A conceptual ranking may combine:

```text
semantic relevance
× temporal relevance
× confidence
× importance
× relationship/episode relevance
```

The exact formula is an implementation detail and must be versioned.

## 10. Translation invariants

- HERMENEIA Core does not durably retain raw original message bodies by default.
- Original content may remain available through the client or customer-controlled storage layer.
- A failed translation must not require durable server-side retention of the message body.
- Translation provider/model/strategy are recorded.
- Provider-specific code stays behind an adapter boundary.
- A translation can be regenerated when the authorised client/customer store supplies the required source content/context.

## 11. Baselines

Every context improvement must remain comparable with:

- **T0:** message only;
- **T1:** fixed window of recent messages;
- **T2:** adaptive temporal context.

## 12. Reliability requirements

- client retries must not create duplicate messages;
- server ordering must not depend only on client timestamps;
- translation failure must not make messaging unavailable;
- retries must be bounded and use backoff;
- unfinished async work must be recoverable;
- database constraints must protect core invariants.

## 13. Security and privacy requirements

- strict conversation membership authorization;
- TLS in deployed environments;
- secure password/session handling;
- input validation and request size limits;
- rate limiting;
- no secrets in prompts or logs;
- no full message bodies in routine technical logs;
- explicit handling of provider data transfers;
- data minimisation;
- deletion of relevant derived data when source conversation data is removed.

## 14. Data entities

Initial domain model:

- User
- Conversation
- ConversationMember
- MessageMetadata
- TranslationExecution
- EpisodeState
- MemoryItem
- TranslationRepairEvent
- CorrectionMemory
- RecoveryCheckpoint
- ContextSnapshot
- TranslationEvaluation
- ModelExecution
- UserFeedback

This is a logical model, not permission to create all tables before their behaviour is implemented.

## 15. Translation traceability

A translation record should be able to identify:

- source message;
- target language;
- provider/model;
- strategy version;
- prompt version;
- context snapshot;
- latency;
- token counts where available;
- execution status;
- creation time.

## 16. Acceptance criteria

The MVP is not considered complete until the following are demonstrated:

1. Two users with different preferred languages can exchange messages.
2. Each recipient receives a translation in their language.
3. The original message remains available through the client or authorised customer-controlled history layer; HERMENEIA Core does not require durable raw-message storage.
4. An ambiguous message can use prior context.
5. Temporal or semantic discontinuity can create a new episode.
6. Crossing midnight alone does not force a new episode.
7. Relevant prior context can be restored from bounded structured state/corrective memory, or supplied by an authorised client history layer when raw detail is required.
8. Stale context is penalised unless explicitly referenced.
9. Provider failure preserves the original message.
10. Failed translation work can be retried safely.
11. Network retries do not duplicate messages.
12. Cross-conversation unauthorised access is rejected.
13. Latency, failures and AI execution metadata are measurable.
14. T0, T1 and T2 can be evaluated on the same corpus.
15. Deleting conversation scope removes transient buffers, derived context, corrective memory and recovery checkpoints according to policy.
16. Emoji and compound emoji are preserved correctly in translation.
17. Tone/intent signals can influence translation without becoming durable emotional profiles.
18. Low-confidence emotion/intent inference falls back toward semantic fidelity rather than aggressive rewriting.
19. Common configured SMS abbreviations can be resolved without a model call.
20. Ambiguous acronyms do not force a single invented meaning when confidence is low.
21. The original shorthand remains available exactly as written in the source message.
22. Tenant-specific glossaries remain isolated from other organisations.
23. Project/team terminology can override tenant/domain defaults deterministically.
24. Terminology provenance and glossary version can be traced for a translation.
25. Common glossary hits do not require a model call.
26. First messages can bootstrap a style profile without permanently fixing it.
27. Explicit recipient locale/style preferences override inferred defaults.
28. Low-confidence regional inference falls back to neutral natural wording.
29. Style adaptation changes formulation without changing semantic meaning.
30. Regional variants can be represented below country level where useful.
31. Every durable derived claim used for context has provenance and authority metadata.
32. Repeated summaries cannot promote an inference into an explicit fact.
33. A user correction invalidates the affected inference for future context.
34. Message edits invalidate dependent derived state.
35. Message deletion cannot allow stale workers/caches to recreate deleted context.
36. Previous translations are never treated as primary semantic evidence.
37. Stale async workers cannot overwrite a newer Context State.
38. Derived Context State can recover safely without assuming raw server-side history exists.
39. Raw message bodies are not durably stored by HERMENEIA Core by default.
40. A vague complaint such as "il a mal traduit" marks prior interpretation suspect but does not invent a correction.
41. An explicit correction can create scoped CorrectionMemory with provenance.
42. Low-confidence inference cannot become durable memory without a defined trigger.
43. Raw transient content is purged according to explicit TTL/conditions.
44. A sanitised RecoveryCheckpoint can restore useful validated context without storing a transcript.
45. Recovery checkpoints remain bounded and exclude weak hypotheses by default.
46. Corrupt/incompatible checkpoints fall back to partial or clean recovery without blocking messaging.
47. Stable long-message fragments can be pretranslated under allowed privacy/tenant policy.
48. No speculative draft fragment is ever delivered before Send.
49. Draft edits invalidate speculative output by revision/hash.
50. Final message-level reconciliation occurs before recipient delivery.
51. Speculative translation failure never blocks normal Send.
52. Abandoned draft content/results are purged and never create durable memory.
53. Progressive translation measurably reduces send-to-ready latency for long messages.
54. Speculation uses reversible fragment stability, not predicted user intent.
55. The active edit region remains conservative while older stable islands may be prepared independently.
56. Any source-changing edit invalidates speculative output by exact revision/hash.
57. Late stale responses are discarded even when request cancellation fails.
58. Heavy edit churn can pause speculation automatically.
59. Draft processing never blocks input/rendering.
60. Final delivery cannot contain text from a stale draft revision.
61. A message queued while offline can send automatically when connectivity returns without duplication.
62. Wi-Fi/cellular transition does not lose or duplicate an accepted message.
63. Service reachability is distinguished from merely being connected to a network.
64. User Send/final translation always preempts speculative/network-optional work.
65. Speculative translation automatically reduces or stops on constrained/expensive connections.
66. Background mobile operation does not assume a permanent socket.
67. Reconnection resumes from bounded session/offset state instead of full conversation replay.
68. Network tests cover high RTT, low bandwidth, jitter, loss, timeout, reset and temporary disconnect.
69. Bytes transferred and retry/reconnect counts are measurable per network profile.
70. Offline-recipient delivery uses an explicit TTL/ACK relay or customer-controlled store rather than implicit plaintext history.
71. Network-path changes cannot let stale transport results overwrite newer connection state.
72. IPv6/dual-stack/NAT64 operation is included in mobile readiness tests.
73. WebSocket-blocked environments have an HTTP-compatible fallback strategy.
74. Transport early-data/replay behaviour cannot duplicate a logical Send.

## 17. Responsiveness and incremental understanding

Context construction must not rebuild the complete conversation on every message.

The system maintains versioned, incrementally prepared conversation state so that message N helps prepare the translation of message N+1.

The user-visible translation path should:

1. accept and sequence the message without durably storing its body;
2. load prepared context state;
3. reconcile bounded transient recent context;
4. build a bounded ContextSnapshot;
5. invoke translation;
6. deliver the result and purge raw transient content according to policy.

Expensive enrichment such as embeddings, summaries, memory extraction and retrieval-index maintenance should normally execute outside the critical path.

The system must measure Context Engine overhead separately from AI-provider latency.

Initial Context Engine targets for a mature MVP are:

    p50 <= 50 ms
    p95 <= 150 ms

excluding provider inference/network time.

These values are engineering targets to validate, not current performance claims.

## 18. Success definition

HERMENEIA succeeds only if adaptive context demonstrates measurable value relative to T0/T1 under a documented evaluation method **without making interactive translation unacceptably slow**.

A visually complete chat UI without quality and latency evidence is not sufficient.

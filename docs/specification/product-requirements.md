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
- immutable original messages;
- versioned translations;
- temporal conversational episodes;
- contextual retrieval;
- long-lived linguistic/terminology memory where justified;
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

- Original content is never replaced by translated content.
- A failed translation never loses the original message.
- Translation provider/model/strategy are recorded.
- Provider-specific code stays behind an adapter boundary.
- A translation can be regenerated without rewriting the original message.

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
- Message
- Translation
- Episode
- EpisodeMessage
- MemoryItem
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
3. The original message remains available.
4. An ambiguous message can use prior context.
5. Temporal or semantic discontinuity can create a new episode.
6. Crossing midnight alone does not force a new episode.
7. A relevant old episode can be retrieved.
8. Stale context is penalised unless explicitly referenced.
9. Provider failure preserves the original message.
10. Failed translation work can be retried safely.
11. Network retries do not duplicate messages.
12. Cross-conversation unauthorised access is rejected.
13. Latency, failures and AI execution metadata are measurable.
14. T0, T1 and T2 can be evaluated on the same corpus.
15. Deleting conversation data follows through to derived context according to the documented retention model.

## 17. Success definition

HERMENEIA succeeds only if adaptive context demonstrates measurable value relative to T0/T1 under a documented evaluation method.

A visually complete chat UI without that evidence is not sufficient.

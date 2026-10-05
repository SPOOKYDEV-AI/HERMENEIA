# Translation Feedback — V1

**Status:** Executable persistent slice  
**Scope:** recipient feedback on a completed translation without automatic durable-memory promotion

## Responsibility

This slice implements:

`POST /v1/translations/{translation_id}/feedback`

Feedback is treated as a repair/problem signal. It is intentionally weaker than an explicit structured correction and cannot create ContextClaims by itself.

## Eligibility

Feedback is accepted only when all of the following are true:

- the actor is the translation recipient;
- the tenant membership is ACTIVE;
- the conversation membership is ACTIVE;
- the submitting device is ACTIVE;
- the translation is `READY`;
- the source message is ACTIVE;
- the translation references the message's current source revision.

This prevents stale or unrelated translation identifiers from producing durable repair signals.

## Feedback kinds

| API kind | Repair event kind | Status |
| --- | --- | --- |
| PROBLEM | PROBLEM_REPORT | RECORDED |
| OTHER | PROBLEM_REPORT | RECORDED |
| WRONG_MEANING | MEANING_CORRECTION | NEEDS_CONFIRMATION |
| WRONG_TONE | TONE_CORRECTION | NEEDS_CONFIRMATION |
| TERMINOLOGY | TERMINOLOGY_CORRECTION | NEEDS_CONFIRMATION |

`NEEDS_CONFIRMATION` does not mean a correction claim has been created. It means the signal is semantically specific enough to enter a future review/correction workflow, but it still lacks an authorised structured corrected proposition.

## Privacy boundary

The optional free-form `note` is never written to durable Core storage in plaintext.

The durable repair event stores only:

```json
{
  "schema_version": 1,
  "feedback_kind": "WRONG_MEANING",
  "note_present": true,
  "note_length": 42
}
```

The command ledger still needs to detect idempotent retries and command-id reuse with changed note content. For that purpose, the note is normalised and passed through the existing HMAC source-fingerprint mechanism. Only the HMAC fingerprint is included in `command_fingerprint`.

The replay path supports HMAC key rotation through configured verification keys.

## Durable transaction

```text
command_receipt
  -> eligible translation lookup
  -> TranslationRepairEvent
  -> command_receipt SUCCEEDED
```

No ContextClaim, provenance edge or ConversationState correction reference is created by feedback.

A retry with the same command returns the stored result. Reusing the command identifier with a different kind, translation or note produces an idempotency conflict.

## Relationship to explicit correction

Feedback and correction are deliberately separate:

```text
feedback
  -> problem / repair signal
  -> RECORDED or NEEDS_CONFIRMATION
  -> no T2 memory

explicit authorised correction
  -> structured corrected proposition
  -> confirmed claim + provenance
  -> ConversationState reference
  -> T2 memory
```

This prevents a complaint such as "wrong meaning" from causing the server or model to invent the corrected meaning.

## Qualification

The persistent qualification suite covers:

- recipient-only READY/current-revision eligibility;
- HMAC-protected note idempotency;
- HMAC key rotation on replay;
- command-id collision with changed note;
- oversized-note rejection;
- HTTP routing;
- SQL repair persistence;
- absence of plaintext note in repair-event payload;
- absence of plaintext note in command fingerprint;
- real PostgreSQL E2E proving feedback creates zero ContextClaims before a separate explicit correction creates T2 memory.

## Not complete

Still separate work:

- review/moderation workflow that converts a `NEEDS_CONFIRMATION` signal into an explicit structured correction;
- aggregate feedback metrics and evaluation dashboards;
- abuse/rate-limit policy specific to feedback;
- tenant policy for optional longer-term feedback analytics.

# Explicit Correction Ingestion — V1

**Status:** Executable persistent slice  
**Scope:** explicit user correction submission, authorisation, durable provenance and conversation-scoped T2 promotion

## Responsibility

This slice implements the existing API contract:

`POST /v1/conversations/{conversation_id}/corrections`

Its job is to turn an explicit correction command into a durable, auditable repair record and, only when the scope and authority justify it, into bounded correction memory consumed by the Context Engine.

It does not infer corrections from arbitrary conversation text and does not treat model output as authoritative evidence.

## Durable transaction

An authorised promotion executes in one PostgreSQL transaction:

```text
command_receipt
  -> authority + target validation
  -> translation_repair_events
  -> context_claims
  -> provenance_edges
  -> conversation_context_states.correction_claim_refs
  -> command_receipt SUCCEEDED
```

A failure rolls the transaction back. A retry with the same command and fingerprint returns the stored result. Reusing a `command_id` for different correction content is an idempotency conflict.

## Authority and scope

| Requested scope / authority | Current V1 result |
| --- | --- |
| MESSAGE | `RECORDED`; no shared durable T2 claim |
| CONVERSATION + MEMBER correcting their own source revision | `APPLIED`; claim gets `subject_user_id = actor` |
| CONVERSATION + MEMBER correcting another speaker or no anchored source | `NEEDS_CONFIRMATION` |
| CONVERSATION + MODERATOR | `APPLIED`; generic conversation claim when not a self-correction |
| CONVERSATION + tenant ADMIN/OWNER | `APPLIED`; generic conversation claim when not a self-correction |
| TENANT | `NEEDS_CONFIRMATION` until tenant-wide distribution exists |
| TONE | `NEEDS_CONFIRMATION` until typed style-memory semantics exist |

Every submitter must still be an active tenant member, active conversation member and active device.

## Supported promotable propositions

V1 promotes only bounded structured propositions already understood by the T2 claim materializer:

- `TERM_MEANING`;
- `PREFERRED_RENDERING`.

The payload is canonicalised before fingerprinting/persistence. Arbitrary prompt/instruction objects are not valid correction memory.

## Target validation

A correction may reference:

- a concrete `message_id + source_revision`;
- a `translation_id` visible to the receiving actor;
- both, only when they resolve to the same source revision.

A MESSAGE-scoped correction must have a concrete target.

Translation-target visibility is recipient-scoped; possession of an arbitrary translation UUID is insufficient.

## Causal safety

Correction memory must not alter a translation retroactively.

The planning repository exposes the creation timestamp of the **current source revision** from `message_revisions.created_at`. Claim retrieval is evaluated strictly as-of that boundary:

```text
claim.valid_from < source_revision.created_at
```

A claim created at the same instant or later is excluded from that translation. This also handles edited revisions correctly because each revision has its own causal timestamp.

Speaker-scoped correction claims add a second independent fence. `subject_user_id` must either be NULL (generic authorised policy/correction) or exactly equal the current source revision's author. The planning query obtains that author from `message_metadata.author_user_id`; the T2 materializer fails closed on a subject mismatch. A user's self-correction can therefore improve their own future wording without silently redefining another participant's language.

ConversationState keeps only the newest 128 correction claim references in its working set. Historical claims and provenance remain durable in PostgreSQL.

If correction ingestion creates a missing ConversationState after historical message operations already exist, it creates a degraded baseline at `next_op_seq - 1` rather than pretending the causal prefix starts at zero.

## T2 path

For a promoted conversation correction:

```text
explicit correction
  -> TranslationRepairEvent
  -> CONFIRMED_CORRECTION ContextClaim
  -> CORRECTED_BY provenance edge
  -> ConversationState correction ref
  -> claim revalidation at planning time
  -> CORRECTION_MEMORY candidate
  -> T2_ADAPTIVE_V1 ContextSnapshot
  -> bounded provider context
```

The OpenAI adapter treats the resulting context as untrusted translation data, never executable provider instructions.

## Supersession

A new promoted correction does not leave an older contradictory correction active.

Before the replacement claim is inserted, PostgreSQL invalidates ACTIVE `CONFIRMED_CORRECTION / CORRECTIVE_DURABLE` claims that have the same:

- tenant and conversation;
- conversation scope;
- speaker subject (including NULL for generic authorised corrections);
- semantic key.

V1 semantic keys are:

```text
TERM_MEANING:
  surface_form
  source_language_tag
  target_language_tag

PREFERRED_RENDERING:
  source_form
  source_language_tag
  target_language_tag
```

The corrected meaning/rendering value itself is intentionally not part of the identity key: changing that value is exactly what causes supersession.

The old claim becomes `INVALIDATED`, receives a bounded `valid_until`, and gets an `OVERRIDDEN_BY` provenance edge whose source is the new claim. ConversationState removes every superseded claim reference and appends the replacement in the same correction transaction.

This preserves history and provenance while ensuring current T2 planning sees one active correction per subject/key rather than contradictory active memories.

## Qualification

The persistent qualification suite exercises:

- command idempotency and command-id collision;
- role-gated promotion;
- MESSAGE/TENANT/TONE fail-safe behaviour;
- target visibility and target-consistency checks;
- missing-state recovery at the existing causal floor;
- bounded/deduplicated correction refs;
- PostgreSQL authority, repair, claim and provenance queries;
- HTTP routing through the injected persistent correction service;
- same-timestamp retroactive-context rejection;
- real PostgreSQL E2E from correction service through T2 provider context.

## Not complete

Still separate work:

- moderation/approval endpoint for `NEEDS_CONFIRMATION` corrections;
- tenant-wide glossary/policy distribution;
- typed TONE/style memory;
- moderation flow that converts `NEEDS_CONFIRMATION` feedback into an explicit structured correction;
- claim revocation/supersession workflow;
- dependency-aware invalidation;
- semantic episode derivation and recovery checkpoints.

# Ephemeral Message and Corrective Memory Model — V1

**Status:** Design baseline  
**Scope:** Messaging, Context Engine, Memory, Privacy

## 1. Goal

HERMENEIA should understand conversations continuously without storing the conversation itself as a durable server-side dataset.

## 2. Three memory layers

### Layer A — transient message buffer

Purpose:

- translate the current message;
- resolve immediate references;
- order messages;
- detect conversational repairs;
- handle bounded retries.

Properties:

    raw content allowed
    short TTL
    memory/ephemeral store preferred
    no long-term backup
    no analytics reuse
    purge after TTL/delivery conditions

### Layer B — working Conversation State

Purpose:

- preserve only the minimum current understanding needed for subsequent messages.

Examples:

    active episode
    unresolved references
    active terminology mappings
    style profile
    pragmatic state
    locale preference
    entity handles
    confidence
    last_processed_sequence

Properties:

    structured
    bounded
    expirable
    provenance-aware
    no unnecessary raw message duplication

### Layer C — corrective durable memory

Purpose:

- remember an explicitly or strongly confirmed correction so the same mistake is not repeated.

Examples:

    token "CR"
    corrected meaning = "change request"
    scope = conversation/project
    trigger = explicit correction
    confidence = 1.0

This layer is small and event-driven.

### Layer D — sanitised recovery checkpoint

Purpose:

- automatically recover validated Conversation State after crash/restart;
- preserve confirmed corrections and stable context without storing a transcript.

Properties:

    structured
    bounded
    no verbatim history by default
    weak hypotheses removed
    versioned
    integrity-checked
    short retention / superseded checkpoints expired

See [Sanitised Recovery Checkpoint — V1](recovery-checkpoint-v1.md).

## 3. Repair detection

HERMENEIA should recognise conversation-repair patterns.

Examples:

    "Non, je voulais dire X."
    "Pas X, Y."
    "La traduction est fausse."
    "Désolé il a mal traduit."
    "I meant X."
    "No, by that I mean..."

Detection should output:

    repair_detected
    target_message_ref
    repair_type
    corrected_meaning_candidate
    confidence

## 4. Complaint vs correction

Important distinction:

### Complaint

    "Il a mal traduit."

Meaning:

    translation likely wrong

But:

    corrected meaning unknown

Action:

    lower trust in prior interpretation
    mark translation/context candidate as suspect
    avoid durable semantic update unless additional evidence appears

### Explicit correction

    "Quand je dis CR, je parle de change request."

Meaning:

    correction known

Action:

    create structured CorrectionMemory
    invalidate conflicting local interpretation
    apply new mapping in the justified scope

## 5. Trigger hierarchy

Durable updates should normally require one of:

    EXPLICIT_UI_CORRECTION
    EXPLICIT_TEXTUAL_CORRECTION
    APPROVED_GLOSSARY_CHANGE
    ADMIN/TENANT_POLICY_CHANGE
    REPEATED_CONFIRMED_REPAIR

Weak signals remain transient.

## 6. No random promotion

The following must not create durable memory on their own:

    model guess
    one low-confidence acronym expansion
    one inferred emotion
    one inferred regional variant
    one inferred relationship
    one translated output
    one summary

These may influence current translation but expire unless confirmed.

## 7. Scope-first learning

CorrectionMemory must carry a scope.

Example:

    correction:
      "mano" = forklift #3

    scope:
      conversation

not:

    global Spanish dictionary

Another example:

    "CR" = change request

could be:

    project scope

if explicitly approved by that project.

## 8. CorrectionMemory

Conceptually:

    CorrectionMemory {
      id
      tenant_id
      scope_type
      scope_id
      concept_type
      surface_form
      corrected_meaning_ref
      language
      locale
      trigger_type
      confidence
      created_at
      last_used_at
      expires_at
      status
      provenance_event_id
    }

## 9. Transient buffer TTL

The exact TTL is deployment-dependent and must be measurable.

The design should support values on the order of seconds/minutes, not indefinite retention.

The buffer may retain only the most recent bounded set required for:

    references
    corrections
    retries
    ordering

The implementation must expose:

    transient_buffer_message_count
    transient_buffer_oldest_age
    transient_content_purge_count

## 10. Client/customer-owned history

If the product UI needs historical conversation display, the history can be stored outside HERMENEIA Core, for example:

- client/device storage;
- a customer-controlled backend;
- an optional deployment-specific message store.

HERMENEIA Core should receive only the content required for the current operation.

## 11. Restart behaviour

After a Core restart, HERMENEIA may have:

    durable CorrectionMemory
    approved glossaries/policies
    latest valid Sanitised Recovery Checkpoint

but no historical raw messages.

Therefore:

- uncertain ephemeral state may reset;
- active conversation state may be rebuilt from structured checkpoints;
- the client may optionally replay a minimal recent window;
- translation must degrade safely rather than fabricate missing context.

## 12. Provenance without raw retention

Because raw text is not durably stored, provenance may use:

    message_id
    sequence_number
    content_hash
    event type
    correction event ID
    strategy version

A hash proves identity/equality of an input but does not allow reconstructing its content.

Do not claim a content hash provides anonymisation.

## 13. Translation traceability

TranslationExecution can store:

    message_id
    source_language
    target_language
    provider
    model
    strategy_version
    context_state_version
    correction_memory_ids
    latency
    token counts
    status

It should not require storing the raw source/translation body indefinitely in Core.

## 14. Error-triggered adaptation

Example sequence:

    User A:
      "On fait le CR demain."

    HERMENEIA:
      interprets CR incorrectly

    User B:
      "Désolé, la traduction est mauvaise."

Action:

    mark prior terminology resolution suspect

Then:

    User A:
      "CR = compte rendu ici."

Action:

    create correction memory
    invalidate prior mapping
    use corrected meaning for subsequent messages

No global model update occurs.

## 15. Automatic update boundaries

"Self-updating" in HERMENEIA means:

    structured local contextual correction

It does not mean:

    fine-tuning the foundation model
    modifying prompts randomly
    globally changing lexicons
    training on private conversations
    copying user messages into datasets

## 16. Security

A malicious user must not be able to convert ordinary chat text into privileged tenant policy.

Natural-language corrections may create only low-privilege contextual memory within authorised scope.

Tenant/project glossary changes require explicit authorised application actions.

## 17. Acceptance criteria

V1 is not complete until:

1. raw message bodies are not durably stored by HERMENEIA Core by default;
2. transient raw content expires according to explicit TTL/purge rules;
3. a vague translation complaint marks context suspect without inventing a correction;
4. an explicit correction can create scoped CorrectionMemory;
5. low-confidence inference cannot become durable memory;
6. corrective memory records trigger/provenance/scope;
7. conversation-local correction cannot leak globally;
8. restart without raw history degrades safely;
9. stale transient workers cannot recreate purged content;
10. metrics prove raw-content purge and bounded transient storage.

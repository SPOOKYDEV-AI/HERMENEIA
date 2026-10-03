# ADR-0010 — Ephemeral message processing and correction-triggered memory

**Status:** Accepted  
**Date:** 2026-10-03

## Context

HERMENEIA is intended to provide contextual translation without becoming a durable archive of user conversations.

Persisting full message bodies server-side would increase data exposure, retention complexity and the consequences of a breach. It would also contradict the product goal of maintaining only the minimum context required for translation.

At the same time, the Context Engine needs enough short-lived context to interpret conversational repairs such as:

    "Non, je voulais dire..."
    "Désolé, il a mal traduit."
    "Quand je dis CR ici, je parle de change request."

These signals can justify updating contextual memory, but random model inferences must not silently become durable learning.

## Decision

HERMENEIA Core will not durably store message bodies by default.

Message content may exist transiently:

- in process memory;
- in a short-lived processing/queue envelope;
- in a bounded recent-context buffer;
- at an authorised AI provider for the duration/retention allowed by the selected provider policy.

The Core may durably store non-content operational metadata and bounded structured context.

Durable contextual memory is updated only through explicit or strongly evidenced events.

## Message lifecycle

Conceptually:

    receive message
      -> validate/authorise
      -> assign message/sequence metadata
      -> use transient content for context + translation
      -> deliver result
      -> update bounded structured Conversation State
      -> purge raw message body from HERMENEIA Core

A short transient retention window may exist for retries, ordering, correction detection and immediate-context resolution. Its maximum duration must be explicit and configurable.

## Durable data allowed

Examples:

    message_id
    conversation_id
    sequence_number
    timestamps
    content hash where justified
    delivery/translation status
    provider/model/strategy metadata
    bounded Context State
    approved glossary/policy state
    TranslationRepairEvent
    CorrectionMemory
    aggregate metrics

Raw message bodies are excluded from durable Core storage by default.

## Correction-triggered learning

HERMENEIA may create durable corrective memory when one of the following occurs:

1. explicit UI feedback/correction;
2. explicit natural-language repair with high confidence;
3. tenant/admin glossary update;
4. repeated independently confirmed correction within the same scope.

Examples of high-signal conversational repairs:

    "Non, par CR je voulais dire change request."
    "Désolé, la traduction est mauvaise : ici 'prod' veut dire production."
    "Je voulais dire X, pas Y."

A vague complaint such as:

    "Il a mal traduit"

is evidence that the latest translation may be wrong, but is not enough by itself to invent the correct meaning.

## No random self-updates

HERMENEIA must not durably update terminology, memory or user preferences merely because a model inferred a likely interpretation.

Model inference may update short-lived working state.

Durable promotion requires a defined trigger and provenance.

## Repair event

A conceptual repair event:

    TranslationRepairEvent {
      id
      tenant_id
      conversation_id
      message_id
      target_language
      repair_type
      affected_span_ref
      previous_interpretation_ref
      corrected_interpretation_ref
      trigger_source
      confidence
      scope
      strategy_version
      created_at
    }

The event should store structured correction information rather than full conversation text whenever possible.

## Scope

Corrections must be applied at the smallest justified scope:

    message
    active episode
    conversation
    project/team
    tenant

A correction observed in one conversation must not become a global language rule.

## Consequences

Benefits:

- HERMENEIA does not become a central conversation archive;
- data exposure and retention burden are reduced;
- contextual learning becomes event-driven and explainable;
- bad model guesses do not silently become durable memory;
- enterprise customers can adopt stricter retention policies.

Costs:

- the server cannot always rebuild full context from raw history after a crash;
- some corrections require a short transient buffer;
- debugging/reproduction is harder without stored source text;
- clients or customer-controlled stores may need to retain originals if historical UI/replay is required.

## Recovery trade-off

Because raw messages are not durably stored by HERMENEIA Core, full deterministic replay is not always possible.

Recovery modes may include:

- rebuild from durable structured Context State;
- request/replay authorised recent context from the client/customer-controlled store;
- fall back to a clean/limited Context State;
- preserve approved corrective memory and policies while discarding uncertain ephemeral state.

Privacy takes precedence over perfect server-side replayability.

## Revisit when

Revisit only if a specific deployment requires server-side message retention and explicitly opts into a separate retention profile with documented purpose, access, security and deletion rules.

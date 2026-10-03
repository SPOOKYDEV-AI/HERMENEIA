# ADR-0009 — Context integrity requires provenance, authority and reversible derived memory

**Status:** Accepted  
**Date:** 2026-10-03

## Context

HERMENEIA maintains derived conversation state so that each new translation does not need to replay the full history.

This creates a major failure mode: an incorrect inference can be summarised, remembered, reused and progressively treated as if it were an explicit fact.

Example:

    source message:
      "Je dois parler à Alex demain."

    bad inference:
      Alex = client

    later summary:
      "The user will speak with client Alex tomorrow."

    later memory:
      Alex -> client

The derived system has now invented information that was never present in a primary source.

Without explicit provenance and authority rules, repeated derived artifacts can "launder" an inference into apparent truth.

## Decision

Every contextual fact used by HERMENEIA must carry:

- provenance;
- authority/source class;
- confidence;
- temporal scope;
- derivation strategy/version;
- source references;
- validity/invalidation state.

Derived information is never allowed to become more authoritative solely because other derived objects repeat it.

## Authority classes

V1 distinguishes at least:

    POLICY
    EXPLICIT_USER_PREFERENCE
    EXPLICIT_MESSAGE_FACT
    EXPLICIT_GLOSSARY
    CONFIRMED_CORRECTION
    INFERRED
    HYPOTHESIS
    DERIVED_SUMMARY

The exact names may evolve, but the distinction between explicit primary evidence and derived interpretation is mandatory.

## Core rule: no confidence laundering

A derived object cannot promote another derived object to a stronger authority class without new primary evidence.

For example:

    HYPOTHESIS
      -> summary
      -> episode summary
      -> memory

must remain traceable to HYPOTHESIS.

It must not silently become EXPLICIT_MESSAGE_FACT.

## Provenance graph

Derived context should be explainable as a graph:

    source message(s)
          |
          v
    extraction / inference
          |
          v
    contextual claim
          |
          +--> episode state
          +--> summary
          +--> memory item
          +--> translation snapshot

Each edge records the strategy/version responsible for the derivation.

## Corrections

A user correction or an explicit glossary entry may invalidate an earlier inference.

Invalidation should propagate to dependent derived artifacts rather than merely adding a newer contradictory fact.

## Message edits and deletion

When a source message is edited or deleted:

1. mark dependent derived claims stale;
2. prevent stale claims from being used for new translations;
3. recompute only the affected derived state where possible;
4. invalidate affected caches;
5. preserve audit metadata according to retention/security policy without retaining deleted content unnecessarily.

## Contradictions

Conflicting evidence should be represented explicitly.

HERMENEIA must not resolve contradictions by choosing whichever derived artifact was created last.

Resolution should consider:

- source authority;
- recency;
- explicit confirmation;
- scope;
- confidence;
- organisation/user policy.

## Consequences

Benefits:

- context errors remain reversible;
- false inferences cannot silently harden into facts;
- memory becomes auditable;
- user corrections have deterministic effects;
- provider/model changes remain reproducible.

Costs:

- additional metadata;
- dependency tracking;
- invalidation/rebuild complexity;
- more explicit uncertainty handling.

## Alternatives considered

### Treat summaries as authoritative state

Rejected because summaries can hallucinate or omit information.

### Keep only the latest state blob

Rejected because it prevents reliable explanation, correction and deletion propagation.

### Rebuild the whole conversation after every correction

Rejected as unnecessarily expensive; targeted dependency invalidation is preferred.

## Revisit when

Revisit the lineage model if measurements show that a simpler dependency representation provides equivalent correctness, deletion and audit guarantees.

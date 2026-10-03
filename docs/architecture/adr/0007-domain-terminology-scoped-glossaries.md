# ADR-0007 — Domain terminology is resolved with scoped, provenance-aware glossaries

**Status:** Accepted  
**Date:** 2026-10-03

## Context

The same token can mean different things depending on profession, organisation, team or project.

Examples:

- "prod" in software usually means production environment;
- "CR" may mean compte rendu, compte-rendu opératoire, change request or something organisation-specific;
- "P1" may mean highest incident priority in one company and a product code in another;
- medical, legal, financial, industrial and engineering language contain abbreviations whose naive translation can be materially wrong.

A global dictionary is therefore unsafe.

## Decision

HERMENEIA will resolve professional terminology using a scoped precedence model.

Default precedence:

    explicit conversation meaning
      >
    team/project glossary
      >
    tenant/organisation glossary
      >
    domain glossary
      >
    generic language model/lexicon

Every resolution must retain provenance and confidence.

Conceptually:

    TerminologyResolution {
      source_span
      selected_meaning
      scope
      glossary_id
      glossary_version
      domain
      confidence
      preserve_term
    }

The original message remains unchanged.

## Domain detection

HERMENEIA may infer one or more active domains from conversation state, such as:

    software
    networking
    medical
    legal
    finance
    automotive
    logistics
    construction

Domain inference is contextual and probabilistic. It must not override an explicit tenant/project glossary.

## Ambiguity

If two meanings remain plausible, the engine must not silently choose a low-confidence interpretation.

It may:

- preserve the original term;
- prefer a known project/tenant definition;
- use surrounding context;
- mark the resolution as ambiguous for evaluation.

## Translation behaviour

The Translation Engine should preserve terminology consistently across a conversation or organisation.

For terms intentionally kept untranslated, glossary entries can specify:

    preserve_term = true

For controlled translations, they can specify target-language equivalents.

## Enterprise governance

Professional tenants may need:

- glossary import/export;
- versioning;
- approval workflow;
- audit trail;
- per-project overrides;
- language-specific equivalents;
- rollback.

These are architecture requirements, not all MVP features.

## Privacy and isolation

Tenant/project terminology must never leak across tenants.

Glossary lookups, caches and embeddings must always include tenant scope.

## Consequences

Benefits:

- better accuracy in specialised conversations;
- deterministic handling of organisation vocabulary;
- less repeated LLM reasoning;
- lower token usage;
- reproducible terminology choices.

Costs:

- glossary lifecycle/versioning;
- conflict resolution;
- domain detection quality;
- admin UX later.

## Alternatives considered

### One global terminology dictionary

Rejected because meanings collide across industries and organisations.

### Pure LLM inference

Rejected as insufficiently deterministic for enterprise terminology.

### Always ask the user

Rejected because it breaks conversational flow and is unnecessary when strong scoped evidence exists.

## Revisit when

Revisit precedence or domain inference when evaluation shows material failure cases or when enterprise governance requirements demand additional scopes.

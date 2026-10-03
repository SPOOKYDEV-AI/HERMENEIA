# Domain Terminology and Jargon Resolver — V1

**Status:** Design baseline  
**Scope:** Context Engine + Translation Engine + future tenant administration

## 1. Goal

Understand professional jargon in context and preserve the correct domain-specific meaning across languages.

## 2. Resolution hierarchy

Default lookup order:

    conversation lexical memory
    project/team glossary
    tenant glossary
    active-domain glossary
    generic colloquial lexicon
    model inference

Earlier scopes have priority when confidence is sufficient.

## 3. Glossary entry

Conceptual structure:

    GlossaryEntry {
      id
      scope
      scope_id
      source_language
      source_term
      source_variants
      domain
      definition
      target_equivalents
      preserve_term
      case_sensitive
      confidence
      version
      status
    }

## 4. Domain state

Conversation State may contain:

    active_domains[]
    domain_confidence
    terminology_refs[]
    terminology_version

Multiple domains may be active at once.

Example:

    software + automotive

for a conversation about vehicle telemetry infrastructure.

## 5. Contextual disambiguation

Signals include:

- neighbouring words;
- active entities;
- conversation topic;
- tenant/project glossary;
- casing;
- previous confirmed usage;
- target audience;
- active domain;
- reply target.

## 6. Consistency

Once a term is resolved with high confidence, HERMENEIA should reuse that resolution within the appropriate scope unless contradicted.

This prevents:

    message 1: "prod" -> "production"
    message 2: "prod" -> "product"
    message 3: "prod" -> "production"

inside the same technical discussion.

## 7. Preserve-vs-translate policy

A glossary can indicate whether a term should:

- remain unchanged;
- be translated;
- be expanded once, then abbreviated;
- use a company-approved equivalent.

Example:

    Kubernetes -> preserve
    "NDF" -> approved target equivalent
    internal product codename -> preserve

## 8. Versioning and provenance

A translation must be able to identify which terminology source influenced it.

Example:

    terminology_source = tenant_glossary
    glossary_id = finance-fr-en
    glossary_version = 7

This is essential for reproducibility and enterprise audit.

## 9. Conflict handling

Possible conflict:

    team glossary: CR = change request
    tenant glossary: CR = compte rendu

The narrower scope wins by default:

    team/project > tenant

but conflicts should be detectable and reportable.

## 10. Fast path

Glossary lookup should be cheap:

- normalised map/trie lookup;
- case-aware matching;
- tenant/project cache;
- preloaded active-domain glossary.

Only ambiguous unresolved terms should require expensive semantic inference.

## 11. Multi-word terminology

The resolver must support phrases, not only tokens.

Examples:

    "mise en production"
    "service level agreement"
    "note de frais"
    "incident majeur"

Longest/highest-confidence match should generally win.

## 12. Morphology and variants

Entries may include variants:

    singular/plural
    abbreviations
    common misspellings
    inflected forms

The resolver must avoid naive substring replacement.

## 13. Code-switching

Professional messages often mix languages:

    "On push en prod après le CAB"

The resolver should understand:

    push -> technical action
    prod -> production environment
    CAB -> organisation/domain acronym

without forcing the entire message into one language.

## 14. Enterprise administration

Future business features may include:

- CSV/JSON glossary import;
- API-based glossary sync;
- approval workflow;
- glossary owners;
- project-specific overrides;
- staging before activation;
- rollback;
- usage analytics without exposing message bodies.

## 15. Security

Glossary content is untrusted input.

It must never become system instructions or executable content.

Tenant IDs must scope:

- storage;
- cache keys;
- retrieval;
- jobs;
- metrics;
- exports.

## 16. Evaluation

The corpus should include:

- same acronym across different industries;
- same word with generic vs technical meaning;
- project-specific terms;
- multi-word terms;
- mixed-language professional chat;
- conflicting glossary scopes;
- preserve-vs-translate cases.

## 17. Metrics

Useful metrics:

    terminology_lookup_ms
    glossary_hit_rate
    tenant_glossary_hit_rate
    domain_glossary_hit_rate
    terminology_ambiguity_rate
    terminology_consistency_rate
    terminology_feedback_error_rate

## 18. Acceptance criteria

V1 is not complete until:

1. scoped glossary precedence is deterministic;
2. tenant terminology cannot leak across tenants;
3. project/team overrides can supersede tenant defaults;
4. multi-word terminology is supported;
5. low-confidence ambiguous terminology is not silently forced;
6. resolved terms remain consistent within scope;
7. preserve-term policy is supported;
8. resolution provenance/version is recorded;
9. common glossary hits require no model call;
10. evaluation contains cross-domain collision cases.

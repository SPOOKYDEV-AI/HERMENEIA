# ADR-0006 — Colloquial language is resolved contextually before translation

**Status:** Accepted  
**Date:** 2026-10-03

## Context

Real messaging contains abbreviations, acronyms, phonetic spelling, typos, slang, code-switching and community-specific shorthand.

Examples include:

- French SMS: `tkt`, `jsp`, `pk`, `stp`, `mdr`, `ptdr`;
- English internet language: `idk`, `imo`, `ngl`, `rn`, `brb`;
- region/community-specific expressions;
- mixed-language messages;
- abbreviations whose meaning changes with domain or casing.

A naive dictionary expansion can create incorrect translations. For example, an acronym can be conversational in one context and technical, medical or corporate in another.

## Decision

HERMENEIA will include a **Colloquial Language Resolver** before translation.

Its role is not to rewrite the user's message into formal language. Its role is to infer, with confidence, the intended meaning of non-standard forms so the Translation Engine can preserve the sender's style.

Resolution uses:

- source language and locale;
- active conversation topic;
- recent pragmatic state;
- relationship/register;
- surrounding words;
- acronym casing;
- known terminology;
- explicit user/organisation glossary;
- prior confirmed use inside the same conversation.

The resolver returns structured hypotheses, not destructive text replacement.

Example:

    token = "mdr"
    candidates =
      - meaning: "laughing"
        language: fr
        confidence: 0.97
      - meaning: "multi-drug resistant"
        domain: medical
        confidence: 0.03

The original text remains unchanged.

## Confidence rule

When confidence is high, the Translation Engine may translate the inferred meaning naturally.

When confidence is low, HERMENEIA should:

- prefer preserving the original token;
- use nearby context conservatively;
- avoid inventing a confident expansion;
- optionally expose ambiguity in diagnostic/evaluation metadata.

## Local lexical memory

Confirmed colloquial meanings may be cached at conversation or tenant scope when useful.

Examples:

    "CR" -> "compte rendu" in one organisation
    "prod" -> "production environment" in one technical team
    "tkt" -> reassurance marker in informal French chat

Such memory must be scoped and versioned. It must not become a global dictionary based on one user's usage.

## Style preservation

Understanding slang does not imply formalising it.

Example:

    "tkt j'arrive mdr"

should not automatically become a stiff equivalent such as:

    "Do not worry, I am arriving, I am laughing."

The target output should preserve the informal communicative style when policy allows.

## Privacy

Colloquial vocabulary can reveal community, profession, region or social context.

Therefore inferred lexical preferences are derived personal data when linkable to a user.

HERMENEIA must avoid using slang analysis to infer sensitive traits that are unnecessary for translation.

## Evaluation

The evaluation corpus must include:

- ambiguous acronyms;
- language-specific SMS abbreviations;
- domain collisions;
- mixed-language messages;
- typos and phonetic spellings;
- slang whose literal expansion would be unnatural;
- cases where preserving the original token is safer than expansion.

## Alternatives considered

### Global static slang dictionary

Rejected as insufficient because meanings vary by locale, domain and conversation.

### Let the translation LLM resolve everything implicitly

Rejected because hidden resolution is difficult to evaluate, cache, constrain and compare.

### Normalize user text permanently

Rejected because it destroys source fidelity and style.

## Revisit when

Revisit if experiments show that direct provider translation handles the same cases with equal quality, lower latency and comparable explainability/privacy.

# ADR-0008 — Translation style and locale are dynamic contextual profiles

**Status:** Accepted  
**Date:** 2026-10-03

## Context

A correct translation can still feel wrong if it uses the wrong register, regional vocabulary or conversational style.

Examples include:

- formal vs informal address;
- short/direct vs elaborated phrasing;
- affectionate vs neutral wording;
- technical vs everyday vocabulary;
- regional lexical variants;
- country/region-specific pronouns or address forms;
- different expectations for professional/customer-support communication.

A single language label such as `es` or `fr` is too coarse for natural messaging.

At the same time, inferring a person's region or identity from a few words can be unreliable and can create stereotypes.

## Decision

HERMENEIA will maintain two separate but related profiles:

1. **Target Language Profile** — explicit and inferred preferences about how the recipient wants translations rendered.
2. **Conversation Style Profile** — a short-lived, confidence-weighted description of how the current conversation is being conducted.

The first message may bootstrap the Conversation Style Profile, but no single message permanently fixes it.

## Target Language Profile

The target profile may include:

    language
    locale
    region
    preferred_address_form
    preferred_register
    terminology_policy
    explicit_user_preferences
    organisation_policy

Explicit user or organisation configuration outranks inferred regional style.

## Conversation Style Profile

The conversational profile may include:

    formality
    warmth
    directness
    brevity
    humour_level
    affection_level
    professionality
    technicality
    politeness
    preferred_sentence_length
    punctuation_style
    confidence
    last_updated_sequence

It is updated incrementally as the conversation evolves.

## First-message bootstrap

The first one or two messages may provide strong initial signals.

Example:

    "Bonjour Madame, je vous contacte concernant votre dossier."

suggests a formal/professional initial profile.

Whereas:

    "wsh ça dit quoi 😂"

suggests a very informal/social initial profile.

These are priors, not permanent labels.

## Regional language

HERMENEIA must support language variation below country level where useful.

Examples can include:

- `es-ES` vs `es-CO`;
- regional address forms within Spanish-speaking countries;
- vocabulary differences across regions of the same country;
- organisation-specific regional terminology.

Regional handling must avoid hard-coded stereotypes.

The system should prefer, in order:

    explicit user preference
      >
    explicit organisation/project policy
      >
    confirmed conversation usage
      >
    locale/region default
      >
    generic language default

## Style adaptation

The Translation Engine may produce different valid formulations for the same semantic content.

Its goal is not literal wording identity, but equivalent meaning and appropriate style.

Example:

    semantic intent: reassurance
    target: informal Colombian Spanish
    profile: warm, concise

may differ from:

    semantic intent: reassurance
    target: formal business Spanish
    profile: professional, concise

## Privacy

Language/region/style preferences can be personal data.

HERMENEIA must not infer ethnicity, nationality or other sensitive identity traits merely from linguistic style.

A linguistic variant should be treated as a translation preference or contextual signal, not an identity claim.

## Evaluation

Evaluation must include:

- same source message translated into multiple target locales;
- formal/informal contrast;
- first-message style bootstrap;
- mid-conversation style shift;
- region-specific lexical variants;
- user preference overriding inferred style;
- low-confidence regional inference falling back to neutral target-language wording.

## Alternatives considered

### One translation per language

Rejected because it produces unnatural output and ignores recipient preference.

### Permanently infer style from first message

Rejected because conversations change and first-message inference can be wrong.

### Infer demographic identity from dialect

Rejected as unnecessary and privacy-invasive.

## Revisit when

Revisit if user studies show that explicit style controls outperform inferred profiles, or if regional adaptation creates more errors than benefits for a given language.

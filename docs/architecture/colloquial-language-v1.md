# Colloquial Language, Acronyms and SMS Resolver — V1

**Status:** Design baseline  
**Scope:** Context Engine + Translation Engine  
**Goal:** understand informal language without destroying style

## 1. Problem

Messaging language is highly compressed.

Users commonly omit words, vowels and punctuation, mix languages, use local slang and invent abbreviations.

Examples:

    tkt
    jsp
    pk
    stp
    mdr
    ptdr
    bg
    wsh

    idk
    imo
    ngl
    rn
    brb
    fr
    lmao

A translator that treats these tokens literally can produce nonsense.

## 2. Resolver output

The resolver should emit structured data.

Conceptually:

    ColloquialResolution {
      source_span
      original_token
      language
      candidate_meanings[]
      selected_meaning
      confidence
      register
      domain
      preserve_surface_form
      source
    }

Where `source` may identify:

    builtin_lexicon
    organisation_glossary
    conversation_memory
    model_inference
    explicit_user_confirmation

## 3. No destructive normalisation

The original message remains immutable.

HERMENEIA may internally understand:

    "tkt"

as:

    intent = reassurance
    semantic meaning = "don't worry"
    register = very informal

but the stored source stays:

    "tkt"

This preserves fidelity and allows future reprocessing.

## 4. Contextual ambiguity

Acronyms must be ranked using context.

Example:

    "MDR"

Possible meanings may include:

- French internet laughter when used informally;
- a technical/medical acronym in specialised contexts;
- an organisation-specific acronym.

Useful signals:

    source_language
    casing
    surrounding tokens
    topic/domain
    active entities
    conversation register
    tenant glossary
    recent confirmed usage

## 5. Code-switching

Messages may contain multiple languages.

Example:

    "tkt bro I'll call you après"

The system should not force one language label over the complete message when token-level or span-level detection is useful.

V1 may represent:

    message_language = mixed
    spans =
      fr: "tkt"
      en: "bro I'll call you"
      fr: "après"

Translation should preserve intent rather than translating each span independently without context.

## 6. Typos and phonetic spelling

The resolver may identify probable forms such as:

    "sava"
    "jsuis"
    "chui"
    "g"
    "c"
    "pk"

but must separate:

    spelling hypothesis
    semantic hypothesis
    confidence

A typo correction must never silently overwrite the original message.

## 7. Locale and regional language

Meaning can vary by country or community.

Relevant dimensions may include:

    language
    country/locale
    organisation
    conversation
    domain

The architecture must support locale-aware lexicons without assuming one "correct" dialect.

## 8. Organisation glossary

Professional tenants may define an explicit glossary.

Examples:

    "CR" = "compte rendu"
    "NDF" = "note de frais"
    "P1" = "priority one"
    "prod" = "production"

Explicit tenant glossary entries should normally outrank generic slang inference within that tenant.

Glossary access must remain tenant-isolated.

## 9. Conversation lexical memory

If a token is repeatedly resolved with high confidence in one conversation, HERMENEIA may maintain a compact local mapping.

Example:

    lexical_memory:
      token: "la mano"
      meaning_ref: specific machine in current conversation
      scope: conversation
      confidence: 0.94

This avoids repeated re-analysis.

The mapping must expire or be invalidated when context changes.

## 10. Translation behaviour

The Translation Engine should receive both:

    original surface form
    resolved semantic intent

This allows it to choose a natural equivalent instead of exposing the expansion literally.

Example:

    source: "tkt"
    semantic: reassurance
    register: informal

Possible English output:

    "dw"
    "don't worry"
    "no worries"

The selected form depends on target-language style policy and confidence.

## 11. Preservation rule

Unknown or ambiguous slang should not be aggressively rewritten.

When confidence falls below a threshold:

    preserve token
    or
    translate surrounding text while leaving token intact

This is preferable to hallucinating an expansion.

## 12. Fast path

Cheap resolution can happen synchronously using:

- finite lexicons;
- hash/map lookup;
- casing;
- regex/token patterns;
- locale;
- tenant glossary;
- conversation lexical cache.

Expensive semantic disambiguation can run asynchronously or only on ambiguous candidates.

This keeps common SMS language cheap.

## 13. Data structures

Possible logical entities:

    LexicalCandidate
    LexicalResolution
    LexiconEntry
    TenantGlossaryEntry
    ConversationLexicalMemory

No separate service is required in V1.

## 14. Provenance

Every non-trivial resolution should be attributable to its origin.

Example:

    token = "CR"
    selected = "compte rendu"
    source = tenant_glossary
    glossary_version = 12

This matters for reproducibility and enterprise governance.

## 15. Security

User-controlled glossary entries and tokens are untrusted input.

They must not be allowed to:

- alter system prompts;
- inject provider instructions;
- escape tenant boundaries;
- execute code;
- create unsafe markup.

## 16. Privacy

Do not build a cross-product behavioural profile from slang usage.

Lexical state should be scoped to the minimum level needed:

    message
    conversation
    tenant glossary

Global user-level lexical profiles require a separately justified product purpose.

## 17. Metrics

Useful metrics include:

    colloquial_resolution_ms
    colloquial_tokens_detected
    ambiguous_acronym_rate
    unresolved_colloquial_rate
    tenant_glossary_hit_rate
    conversation_lexical_cache_hit_rate
    low_confidence_resolution_rate
    slang_translation_feedback_error_rate

Do not log raw message text solely to calculate these metrics.

## 18. Evaluation examples

The corpus should include contrastive examples.

### Informal French

    "tkt ça va"
    "jsp encore"
    "mdr t'es sérieux"
    "pk t'as fait ça"

### English internet language

    "idk tbh"
    "ngl that was wild"
    "brb rn"

### Domain collision

    casual:
      "mdr 😂"

    medical:
      "MDR bacteria"

### Organisation-specific

    "Envoie le CR après le COPIL"

### Mixed language

    "tkt bro I'll call you après"

Human evaluation should score:

- semantic fidelity;
- register preservation;
- ambiguity resolution;
- naturalness;
- unnecessary formalisation.

## 19. Acceptance criteria

V1 is not complete until:

1. common configured SMS abbreviations resolve without a model call;
2. ambiguous acronyms can return multiple candidates with confidence;
3. tenant glossary overrides remain tenant-isolated;
4. original message text is never rewritten in storage;
5. mixed-language messages can retain span-level language metadata where needed;
6. low-confidence resolution does not force an invented expansion;
7. conversation lexical memory can reuse a confirmed local meaning;
8. lexical memory is bounded and expirable;
9. evaluation includes domain-collision cases;
10. latency metrics isolate lexical-resolution cost.

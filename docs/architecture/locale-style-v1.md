# Locale and Conversation Style Engine — V1

**Status:** Design baseline  
**Scope:** Context Engine + Translation Engine  
**Goal:** produce natural formulations for the recipient and current conversation

## 1. Core idea

HERMENEIA should not ask only:

    "What does this sentence mean?"

It should also ask:

    "How would this person naturally receive that meaning in this conversation?"

## 2. Two independent axes

### Target Language Profile

Recipient-oriented and relatively stable.

Possible fields:

    language
    locale
    region
    preferred_register
    address_form
    explicit_style_preferences
    organisation_policy
    terminology_profile_id
    confidence

### Conversation Style Profile

Speaker/direction-oriented and ephemeral.

A conversation must not have one undifferentiated style profile that can cause one participant's register to be imposed on another. V1 models style at least by **speaker**, and may refine it by speaker→recipient direction when the interaction requires it.

Possible fields:

    formality
    warmth
    directness
    brevity
    humour
    affection
    politeness
    professionality
    technicality
    sentence_length_preference
    punctuation_style
    speaker_id
    recipient_id_optional
    confidence
    last_updated_sequence

These must not be collapsed into one object because recipient preference and current conversation tone can differ.

## 3. Bootstrap from the opening

The first message should be analysed immediately for inexpensive style signals.

Examples:

    greeting type
    honorifics
    pronoun/address form
    emoji usage
    punctuation
    slang
    message length
    professional vocabulary
    affectionate terms

The resulting profile starts with limited confidence.

Conceptually:

    formality = 0.82
    professionality = 0.91
    warmth = 0.45
    confidence = 0.66

Each following message from the relevant speaker/direction updates that estimate.

## 4. Dynamic update

Style is not static.

Example:

    beginning:
      formal customer support

    later:
      relaxed conversation after rapport develops

The profile should be updated incrementally instead of retaining the initial style forever.

A smoothing strategy can prevent one unusual message from flipping the entire profile.

## 5. Recipient-first rendering

The sender's style should be preserved semantically, but the target wording should fit the recipient's language variant.

Example dimensions:

    lexical choice
    pronouns
    honorifics
    politeness markers
    contractions
    idioms
    sentence rhythm
    punctuation

The recipient's explicit language preferences outrank automatic inference.

## 6. Locale hierarchy

A useful conceptual hierarchy is:

    language
      -> country/locale
         -> region
            -> organisation/project
               -> user preference
                  -> current conversation usage

Not every language needs every level.

## 7. Regional lexical variants

The resolver should support region-scoped equivalents.

Example structure:

    RegionalLexeme {
      concept_id
      language
      locale
      region
      surface_form
      register
      confidence
      source
      version
    }

A concept may therefore map to multiple valid expressions.

## 8. Same country, different region

Country-level locale alone can still be too broad.

For Spanish, for example, address forms and vocabulary can vary across regions and speakers inside the same country.

HERMENEIA should not infer a region aggressively from one term.

Instead:

    detected_variant
    confidence
    source_evidence
    preferred_target_variant

are maintained separately.

Low confidence falls back to broadly natural wording for the configured target locale.

## 9. Style-preserving paraphrase

A translation may have several semantically valid outputs.

Conceptually:

    source intent
      +
    recipient locale
      +
    conversation style
      +
    terminology constraints
      =
    target formulation

The Translation Engine should be free to choose natural phrasing while respecting semantic fidelity.

## 10. Example

Source:

    "Tkt je te redis ça après 😂"

Semantic/pragmatic interpretation:

    reassurance
    future follow-up
    informal
    playful

Possible target profile A:

    language = English
    locale = en-GB
    register = informal

Possible output style:

    "No worries, I'll get back to you later 😂"

Possible target profile B:

    language = Spanish
    locale = es-CO
    register = informal

The translation may use a different natural formulation while preserving the same intent and emoji.

The exact wording is model/evaluation dependent; the architecture stores the constraints, not one hard-coded sentence.

## 11. Explicit controls

Users should eventually be able to explicitly choose preferences such as:

    language
    locale
    formality default
    preserve slang
    prefer neutral regional vocabulary

Professional tenants may also define policy.

Explicit controls have priority over inferred style.

## 12. Neutral fallback

If region/style confidence is low:

    preserve semantic meaning
    use neutral natural target language
    avoid strongly regional idioms
    avoid strong formality shifts
    preserve original emoji and intent

HERMENEIA should prefer slightly generic correctness over confidently wrong localisation.

## 13. Fast path

Cheap style features can be extracted synchronously:

    greeting markers
    honorifics
    slang presence
    emoji count
    punctuation intensity
    casing
    message length
    sentence count

Prepared per-speaker/per-direction Conversation Style Profile handles more complex inference.

This keeps first-message adaptation fast.

## 14. Learning within a conversation

If the recipient repeatedly prefers or corrects a formulation, HERMENEIA may update conversation-local preferences.

Such learning must remain bounded and traceable.

No silent global user profiling is required for V1.

## 15. Enterprise policy

Possible organisation policies:

    customer_support:
      formal_by_default = true
      regional_slang = conservative

    internal_chat:
      preserve_informal_style = true

    legal:
      semantic_fidelity_priority = maximum
      stylistic_adaptation = minimal

Policy is versioned and included in translation traceability.

## 16. Data structures

Possible logical entities:

    TargetLanguageProfile
    ConversationStyleProfileBySpeakerOrDirection
    RegionalLexeme
    StyleSignal
    StylePolicy

These can remain modules/tables inside the monolith in V1.

## 17. Metrics

Useful metrics:

    style_profile_update_ms
    locale_resolution_ms
    explicit_preference_hit_rate
    neutral_fallback_rate
    regional_variant_usage_rate
    style_feedback_error_rate
    locale_feedback_error_rate

## 18. Evaluation

Tests should include:

1. same semantic source -> different locale outputs;
2. formal opening -> formal translation;
3. informal opening -> informal translation;
4. style changes mid-conversation;
5. same-country regional vocabulary differences;
6. explicit user preference overriding inference;
7. organisation policy overriding casual style where required;
8. low-confidence locale inference using neutral fallback;
9. terminology constraints interacting with regional wording;
10. slang/emoji retained appropriately.

## 19. Acceptance criteria

V1 is not complete until:

1. first messages can bootstrap a style profile;
2. the profile remains mutable;
3. explicit recipient preference outranks inferred style;
4. locale is not reduced to language alone;
5. regional variants can be represented without hard-coded user stereotypes;
6. low-confidence region inference falls back safely;
7. style changes affect formulation without changing semantic meaning;
8. enterprise policy can constrain style adaptation;
9. style/locale provenance is traceable;
10. evaluation demonstrates multiple valid formulations for identical semantic intent;
11. one participant's inferred register cannot silently overwrite another participant's style profile.

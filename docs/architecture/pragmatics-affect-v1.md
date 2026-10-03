# Pragmatics, Emotion Signals and Emoji — V1

**Status:** Design baseline  
**Scope:** Context Engine + Translation Engine  
**Goal:** preserve intent and tone without over-inference

## 1. Problem

Literal translation is insufficient for real conversation.

Consider:

    "D'accord"
    "D'accord."
    "D'accord 😂"
    "D'accord ❤️"
    "D'ACCORD !!!"

The lexical content is similar, but the communicative intent may differ substantially.

HERMENEIA therefore needs a pragmatic layer.

## 2. What HERMENEIA should infer

The system should focus on **communication-relevant signals**, not hidden psychological traits.

Useful V1 signals include:

    speech_act
    stance
    politeness
    intensity
    uncertainty
    humour_likelihood
    sarcasm_likelihood
    affection_signal
    frustration_signal
    urgency_signal
    emoji_signal
    punctuation_signal
    casing_signal
    laughter_style
    confidence

These values are contextual and probabilistic.

## 3. What HERMENEIA must not infer

The product must not derive or persist unsupported claims such as:

- personality type;
- depression/anxiety;
- mental-health diagnosis;
- romantic status unless explicitly present and necessary;
- political or religious beliefs from conversational style;
- stable aggression or emotionality scores.

The system is a translation/context service, not a behavioural-profiling engine.

## 4. Emoji are semantic input

Emoji must not be stripped before analysis.

Examples:

    "ça va"
    "ça va 😅"
    "ça va ❤️"
    "ça va 🙃"

may differ in tone or implied meaning.

The engine should store emoji-aware features without expanding every emoji into verbose text.

Possible compact representation:

    emoji_features:
      count: 2
      clusters: ["❤️", "😂"]
      categories: ["affection", "laughter"]
      intensity: 0.7
      confidence: 0.82

The exact taxonomy must remain versioned and testable.

## 5. Unicode correctness

Implementation must operate on Unicode grapheme clusters rather than raw code points when manipulating emoji.

This is required for:

- family emoji;
- flags;
- skin-tone modifiers;
- gender variants;
- zero-width-joiner sequences;
- variation selectors.

The system should preserve the original emoji sequence in the translated message unless the user explicitly requests adaptation.

## 6. Non-emoji paralinguistic signals

The same reasoning applies to:

- "!!!";
- "...";
- repeated letters: "nooooo";
- casing: "OK";
- emoticons: ":)", ":/";
- laughter forms: "mdr", "ptdr", "jajaja", "kkkk", "ㅋㅋㅋ";
- interjections;
- hesitation markers;
- repeated question marks;
- affectionate abbreviations.

These can affect intent and should be analysed as features rather than discarded during normalisation.

## 7. Context interaction

Pragmatic interpretation should use context.

Example:

    A: "Tu as encore cassé le serveur ? 😂"
    B: "Oui 😭"

The emoji sequence changes the likely reading from a hostile accusation to playful teasing.

The state may temporarily represent:

    stance = playful
    humour_likelihood = 0.88
    tension = low
    confidence = 0.79

The next translation can preserve that tone without storing a permanent emotional label for either person.

## 8. Relationship-aware register

A translation may need to preserve whether the interaction is:

- professional/formal;
- friendly;
- affectionate;
- playful;
- customer/support;
- hierarchical;
- unknown.

This must be inferred conservatively and may also be explicitly configured.

Explicit user or organisation policy has precedence over inferred style.

## 9. Ephemeral state

Recommended scope:

    per-message affect
        TTL: very short

    active-episode stance
        TTL: episode lifetime + short decay

    explicit communication preference
        TTL: durable until changed/deleted

Do not promote a transient emotion into durable memory automatically.

## 10. Confidence and uncertainty

Every inferred pragmatic signal should carry confidence.

Example:

    sarcasm_likelihood = 0.54
    confidence = 0.42

Low-confidence signals should not trigger strong rewriting.

Rule:

    lower confidence
        -> preserve literal meaning
        -> reduce stylistic transformation

## 11. Translation strategy

The Translation Engine should consume a compact structure such as:

    PragmaticContext {
      speech_act
      stance
      politeness
      intensity
      humour_likelihood
      sarcasm_likelihood
      emoji_features
      confidence
    }

It should not need to receive the full historical conversation merely to know that the current episode is playful or formal.

## 12. Fast-path design

Cheap deterministic extraction can run synchronously:

- emoji/grapheme extraction;
- punctuation intensity;
- casing;
- message length;
- repeated characters;
- reply marker;
- simple laughter/interjection patterns.

More expensive semantic/pragmatic inference can be performed asynchronously for the prepared Conversation State.

The fast path can merge:

    current cheap features
    +
    prepared episode pragmatic state

This preserves responsiveness.

## 13. Translation output rules

Default behavior:

- preserve emoji in place where possible;
- do not insert new emoji that the sender did not use;
- do not remove emoji;
- do not exaggerate emotion;
- preserve formality/politeness;
- preserve humour only when confidence is sufficient;
- avoid translating culturally specific laughter mechanically if doing so changes meaning;
- preserve original text on demand.

## 14. Feedback categories

Users should eventually be able to flag translation problems such as:

    wrong meaning
    wrong tone
    too formal
    too informal
    humour lost
    sarcasm lost
    affection lost
    emoji mishandled
    terminology error

This produces much more useful evaluation data than a generic thumbs-down alone.

## 15. Metrics

Useful aggregate metrics:

    pragmatic_inference_ms
    emoji_count
    emoji_preservation_rate
    low_confidence_pragmatic_rate
    tone_feedback_error_rate
    sarcasm_feedback_error_rate
    humour_feedback_error_rate

Do not log the raw emotional content to obtain these metrics.

## 16. Evaluation cases

The evaluation corpus should include contrastive pairs where only pragmatic signals change.

Examples:

    "Super."
    "Super !"
    "Super 😂"
    "Super 🙃"

    "Merci"
    "Merci ❤️"
    "Merci..."

    "Tu viens ?"
    "TU VIENS ???"

Human evaluators should rate whether the target-language output preserves intended tone without inventing meaning.

## 17. Enterprise considerations

Organisation policy may constrain style adaptation.

Examples:

    customer support:
      preserve professional register
      do not amplify slang

    internal team:
      preserve informal style

    legal/compliance context:
      prioritise semantic fidelity over stylistic adaptation

Policy should be explicit and versioned.

## 18. Acceptance criteria

V1 is not complete until:

1. emoji are preserved byte-for-byte or grapheme-equivalently where expected;
2. ZWJ/modifier emoji are not corrupted;
3. punctuation/casing are available as features;
4. transient affect is not promoted to durable memory by default;
5. low-confidence affect does not cause aggressive rewriting;
6. playful vs formal test cases show measurable translation differences where humans expect them;
7. the same lexical message with different emoji can yield appropriately different phrasing;
8. privacy deletion removes associated derived pragmatic state;
9. provider payload can carry pragmatic features without replaying old raw messages;
10. the evaluation protocol includes tone/emoji-specific scoring.

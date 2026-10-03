# ADR-0005 — Pragmatic intent and affect are contextual signals, not ground truth

**Status:** Accepted  
**Date:** 2026-10-03

## Context

Translation quality depends on more than lexical meaning.

The same words can carry different intent depending on:

- emojis;
- punctuation;
- casing;
- repetition;
- discourse markers;
- relationship context;
- previous turns;
- cultural usage;
- sarcasm or irony;
- urgency or hesitation.

Examples such as "ok", "ok.", "ok 😂", "ok ❤️", and "OK!!!" may require different target-language phrasing even though their lexical content is nearly identical.

A naive system may either ignore these signals or overclaim certainty about a user's emotional state.

## Decision

HERMENEIA will model **pragmatic intent and affective cues as probabilistic, short-lived context signals**.

The system must not treat inferred emotion as objective truth.

The Context Engine may derive signals such as:

- conversational stance: neutral, warm, affectionate, playful, formal, tense, apologetic, urgent;
- speech act: question, acknowledgement, reassurance, request, refusal, joke, complaint, thanks;
- intensity;
- uncertainty;
- sarcasm/irony likelihood;
- emoji contribution;
- punctuation/casing contribution;
- laughter/interjection style;
- confidence.

Signals are used to improve translation style and ambiguity resolution, not to diagnose personality, mood disorders, mental state or other sensitive traits.

## Emoji handling

Emoji are first-class message content.

By default, HERMENEIA should:

- preserve the original Unicode emoji sequence in translated output;
- interpret emoji as contextual evidence;
- never split grapheme clusters or zero-width-joiner sequences;
- preserve skin-tone modifiers and compound emoji;
- avoid replacing an emoji with a textual explanation unless explicitly requested;
- avoid assuming one universal meaning when usage is ambiguous.

Emoji interpretation must be combined with surrounding text and conversation state.

## Temporal scope

Most pragmatic/affective signals are ephemeral.

A single frustrated or affectionate message must not become a durable user profile.

Signals should therefore normally be scoped to:

- message;
- immediate context;
- active episode;

with short TTL/decay.

Long-lived storage is allowed only for explicit communication preferences, not inferred emotional personality.

## Translation behavior

The Translation Engine should preserve:

- semantic meaning;
- pragmatic intent;
- politeness level;
- relationship-appropriate register;
- intensity;
- meaningful emoji;
- culturally appropriate idiomatic tone when confidence is sufficient.

If intent is uncertain, the translation should prefer semantic fidelity over aggressive stylistic rewriting.

## Privacy consequence

Affect and intent signals are derived personal data when linked to users.

They must be subject to access control, minimisation, retention and deletion.

HERMENEIA must not silently build behavioural or psychological profiles from conversation history.

## Evaluation consequence

T0/T1/T2 evaluation must include examples where emoji, punctuation, humour, politeness, affection, frustration and sarcasm materially alter the correct translation.

## Alternatives considered

### Ignore emoji and tone

Rejected because it loses meaning and creates unnatural translations.

### Persist a stable "user emotion profile"

Rejected because it is technically unreliable, unnecessary for translation and creates disproportionate privacy risk.

### Ask the LLM to infer emotion freely

Rejected because unstructured hidden inference is hard to evaluate, version and constrain.

## Revisit when

Revisit if evaluation shows that a simpler signal set performs equivalently, or if explicit user controls offer a better way to preserve style with less inference.

# Context Evaluation Protocol

## Purpose

HERMENEIA must demonstrate whether adaptive context improves translation rather than assuming that it does.

## Strategies

### T0 — Message only

Translate only the source message.

### T1 — Fixed window

Translate the source message plus a fixed recent-message window.

The chosen N and token cap must be recorded.

### T2 — Adaptive temporal context

Use the HERMENEIA Context Engine to select:

- immediate messages;
- active-episode summary/data;
- relevant prior episodes;
- relevant durable memory.

## Evaluation unit

Each test case should include:

- conversation history;
- timestamped source message;
- source language;
- target language;
- context that a human evaluator considers relevant;
- ambiguity category;
- reference translation or evaluation guidance.

## Required categories

The corpus should cover at least:

- pronoun/reference resolution;
- proper nouns;
- terminology;
- idioms;
- tone/register;
- emoji-dependent intent;
- punctuation/casing-dependent intent;
- humour and laughter forms;
- affection/reassurance;
- frustration/urgency;
- sarcasm where feasible;
- relative time references;
- topic changes;
- long pauses;
- midnight transitions;
- old-topic resumption;
- intentionally irrelevant old context;
- SMS abbreviations and slang;
- ambiguous acronyms;
- domain-specific shorthand;
- code-switching and mixed-language messages;
- typos/phonetic spellings where meaning remains recoverable.

## Metrics

### Human quality

Prefer blinded evaluation when practical.

Rate:

- meaning fidelity;
- naturalness;
- contextual coherence;
- tone preservation;
- pragmatic-intent preservation;
- emoji handling/preservation;
- colloquial meaning preservation;
- register preservation without unnecessary formalisation;
- ambiguity resolution;
- terminology consistency.

### System metrics

Record:

- end-to-end latency;
- provider latency;
- input/output tokens when available;
- estimated cost where meaningful;
- context token count;
- retrieval candidate count;
- selected item count;
- fallback/error rate.

## Experimental discipline

- T0/T1/T2 must use the same test cases.
- Model/provider versions must be recorded.
- Prompt and context strategy versions must be recorded.
- Do not silently remove failed cases from results.
- Report confidence intervals or uncertainty when sample size permits.
- Separate model improvements from context-engine improvements.

## Contrastive pragmatic tests

The corpus should include minimal pairs where lexical content stays nearly constant while pragmatic signals change, for example:

    "Super."
    "Super !"
    "Super 😂"
    "Super 🙃"

and:

    "Merci"
    "Merci ❤️"
    "Merci..."

These cases test whether HERMENEIA preserves communicative intent without inventing stronger emotion than the source supports.

## Primary question

Does T2 improve contextual translation quality enough to justify its extra latency, complexity and token cost relative to T0 and T1?

A negative result is still useful evidence.

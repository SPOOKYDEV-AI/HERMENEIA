# HERMENEIA Pilot Context Corpus — V1

**Status:** synthetic pilot corpus  
**Purpose:** validate T0/T1/T2 evaluation plumbing before training/tuning any Context Engine  
**Personal data:** none; all examples are deliberately authored synthetic cases

## Splits

- `dev.jsonl` — visible development/debug cases;
- `validation.jsonl` — architecture/heuristic validation;
- `test.jsonl` — final pilot holdout for the first Context Engine experiments.

Do not tune a T2 selector against `test.jsonl`.

## What the gold labels mean

`gold_relevant_context_ids` identifies prior source messages a human author considers useful to resolve the current translation problem.

`gold_irrelevant_context_ids` identifies deliberately stale/distracting history.

`forbidden_future_ids` identifies synthetic future messages that must never be available to a causal selector.

These labels evaluate **context selection**, not whether one exact translation wording is mandatory.

## T2_ORACLE warning

The initial harness provides a `T2_ORACLE` selector that uses gold relevant IDs directly.

It exists only to:

- validate the pipeline;
- provide an upper-bound context-selection reference;
- test budget/causality/reporting code.

It is **not** HERMENEIA's real T2 and must never be reported as adaptive-engine performance.

A real T2 selector must implement the same selector interface without reading gold labels.

## Schema

Each JSONL case contains:

- case/split/category metadata;
- source/target BCP47 tags;
- prior history with server-style sequence numbers;
- current message;
- optional future messages for leakage tests;
- explicit target profile/glossary constraints;
- gold context relevance;
- evaluation guidance.

All source text is synthetic.

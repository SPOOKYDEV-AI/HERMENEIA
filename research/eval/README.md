# Evaluation Harness V1

Dependency-free Python harness for the first HERMENEIA context-selection experiments.

## What it does now

- validates the synthetic pilot corpus;
- enforces causal history invariants;
- runs T0 message-only context selection;
- runs T1 fixed-recent-window context selection;
- runs **T2_ORACLE** using gold labels as an upper-bound/plumbing check;
- enforces an optional provider-independent character budget;
- reports context selection precision/recall, stale-context selection and future leakage;
- emits JSONL run manifests.

It does **not** yet call a translation provider or judge translation quality.

That comes after the provider-neutral Translation contract is implemented.

## Important: T2_ORACLE is not HERMENEIA T2

`T2_ORACLE` reads `gold_relevant_context_ids`.

It must never appear in a paper/report as the adaptive Context Engine result.

The real T2 selector will implement the same selection interface without reading gold labels.

## Requirements

Python 3.11+.

No third-party dependencies.

## Commands

Validate all splits:

    python research/eval/harness.py validate

Validate one split:

    python research/eval/harness.py validate --split test

Run T0:

    python research/eval/harness.py prepare --strategy T0 --split validation

Run T1 with the last 3 causal messages:

    python research/eval/harness.py prepare --strategy T1 --window 3 --split validation

Run the oracle plumbing check:

    python research/eval/harness.py prepare --strategy T2_ORACLE --split validation

Write a machine-readable run manifest:

    python research/eval/harness.py prepare \
      --strategy T1 \
      --window 3 \
      --split test \
      --output artifacts/eval/t1-test.jsonl

Run tests:

    python -m unittest discover -s tests/eval -p "test_*.py"

## Next adapter boundary

Future translation evaluation consumes a prepared run record containing:

    case_id
    strategy
    current source
    selected causal context
    target profile
    glossary constraints
    provider/model/prompt versions

Provider calls and judge calls must remain outside the selector implementation so T0/T1/T2 receive equivalent provider conditions.

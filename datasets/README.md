# Dataset Policy

This directory documents datasets used to evaluate HERMENEIA.

## Default rule

**Do not commit real private conversations or personal-data exports.**

Public repository visibility is not anonymisation.

## Preferred evaluation data

Use, in order of preference:

1. synthetic conversations specifically designed for evaluation;
2. openly licensed corpora compatible with the intended use;
3. deliberately authored test conversations from project contributors;
4. properly anonymised/pseudonymised research data only after provenance, legal basis and redistribution rights are documented.

## Required metadata for any dataset

Document:

- origin/provenance;
- licence;
- permitted uses;
- languages;
- size;
- generation/collection method;
- known limitations and bias;
- presence/absence of personal data;
- preprocessing/anonymisation;
- version/hash where appropriate.

## Local-only data

Private/raw datasets belong outside Git tracking.

The repository `.gitignore` excludes:

```text
datasets/private/
datasets/raw/
```

Do not rely on `.gitignore` as the only protection. Verify staged files before every commit.

## Synthetic data

Synthetic examples must be labelled as synthetic. They must not be presented as evidence of real-world user behaviour.

## Evaluation integrity

Do not tune T2 exclusively against a hidden test set and then report that same set as unbiased evaluation.

Maintain a documented separation between:

- development examples;
- validation examples;
- final evaluation examples.

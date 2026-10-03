# Contributing to HERMENEIA

Thank you for contributing.

HERMENEIA is both an engineering project and a research project. Changes must therefore be maintainable **and measurable**.

## Before contributing

Read:

1. `README.md`
2. `docs/specification/product-requirements.md`
3. `docs/architecture/README.md`
4. relevant ADRs under `docs/architecture/adr/`
5. `SECURITY.md`
6. `datasets/README.md` for any data-related work

## Core rules

- Never commit secrets, tokens, credentials or private datasets.
- Never commit real private conversations.
- Preserve the original message as source-of-truth data.
- Do not couple core logic directly to one AI provider.
- Do not add a new service when a module is sufficient.
- AI behaviour that affects evaluation must be versioned.
- A performance or quality claim must include evidence.
- A change to context selection must be testable against the evaluation corpus.

## Development workflow

1. Open or reference an issue for non-trivial work.
2. Create a focused branch.
3. Keep changes cohesive.
4. Add or update tests.
5. Update documentation when behaviour or architecture changes.
6. Open a pull request with:
   - problem;
   - root cause or motivation;
   - implementation;
   - risks;
   - verification performed.

## Architecture decisions

Changes that alter a major boundary, data contract, persistence model, privacy assumption, provider strategy or evaluation method require an ADR.

Use the format in `docs/architecture/adr/README.md`.

## Definition of done

A contribution is not done merely because it runs once.

Where applicable it must include:

- tests;
- failure-path handling;
- idempotency considerations;
- migration or compatibility impact;
- security/privacy impact;
- observability;
- documentation;
- reproducible verification.

## AI-assisted contributions

AI tools are welcome, but the contributor remains responsible for:

- correctness;
- licensing;
- security;
- generated dependencies;
- test results;
- claims made in the pull request.

Do not submit unreviewed generated code.

## License

By contributing, you agree that your contribution is licensed under the repository's Apache License 2.0.

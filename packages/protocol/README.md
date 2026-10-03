# Protocol package — contract sources

This directory contains runtime-neutral JSON Schema sources for the public application protocol.

The canonical human-readable contract is:

- `docs/architecture/protocol-v1.md`
- `api/openapi.yaml`

Initial schemas:

- `schemas/send-message.schema.json`
- `schemas/server-event.schema.json`
- `schemas/api-error.schema.json`

Future build tooling may generate TypeScript/Kotlin/Swift types from these sources.

Do not hand-maintain generated client types until PR 4 introduces the workspace/build/CI skeleton.

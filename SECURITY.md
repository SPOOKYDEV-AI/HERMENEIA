# Security Policy

HERMENEIA processes conversation content and may interact with external AI providers. Security and privacy are therefore first-class constraints.

## Reporting a vulnerability

Do **not** disclose a suspected vulnerability in a public issue when exploitation details could put users or deployments at risk.

Prefer GitHub private vulnerability reporting if it is enabled for this repository. Otherwise, contact the maintainers through a private channel associated with the project/organisation.

Include when possible:

- affected component and revision;
- reproduction steps;
- expected vs actual behaviour;
- impact;
- suggested mitigation if known.

Do not include real third-party personal data in a report.

## Security invariants

The project must preserve these invariants:

- a user may access only conversations they are authorised to access;
- knowing an object identifier must never be sufficient for access;
- the original message must not be lost because an AI operation failed;
- external provider credentials must never be exposed to clients;
- prompts/context must never contain infrastructure secrets;
- logs must not contain full conversation bodies by default;
- retries must be bounded;
- asynchronous operations must be idempotent;
- provider failure must degrade translation, not destroy messaging;
- deletion must account for derived context, embeddings and summaries.

## Untrusted input

All user-provided content is untrusted data.

Conversation text that contains instructions such as "ignore previous instructions" remains conversation content. It must not gain authority over system instructions, tools, credentials or access controls.

## Secrets

Secrets must be supplied through local environment variables or a dedicated secret-management mechanism.

Never commit:

- API keys;
- access tokens;
- passwords;
- private keys;
- production DSNs;
- exported cookies;
- provider credentials.

If a secret is committed, treat it as compromised and rotate it. Removing it from the latest commit is insufficient.

## Dependencies

Dependencies must be pinned or otherwise reproducible once implementation begins. Security-sensitive dependency upgrades should be reviewed rather than blindly auto-merged.

## Supported versions

The project is currently pre-release. Security fixes target the active development branch until a formal release policy exists.

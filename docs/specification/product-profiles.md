# Product Profiles

HERMENEIA is designed around one core translation/context engine with multiple product profiles.

The profiles must share the same domain logic. Enterprise capability must not become a forked second product.

## Consumer

Target experience:

- simple account;
- private multilingual conversations;
- transparent translation;
- original message available on demand;
- privacy/retention controls;
- low perceived latency.

## Professional / Business

Potential organisation features:

- organisation workspaces;
- tenant isolation;
- central policy management;
- configurable retention;
- domain/identity controls;
- audit/event visibility;
- provider policy controls;
- data-region controls where available;
- admin APIs/integration capabilities.

## Enterprise / Multinational

Potential later requirements:

- SSO/SAML/OIDC;
- SCIM lifecycle integration;
- customer-managed keys where appropriate;
- BYOK for translation/AI providers;
- dedicated or private deployment;
- regional processing/data residency options;
- contractual DPA/subprocessor transparency;
- retention/legal-hold policy integration where legally appropriate;
- export and deletion workflows;
- SIEM/audit integration;
- SLA/support options.

These requirements are architectural compatibility targets, not MVP commitments.

## Product rule

No enterprise feature may weaken the core privacy model.

Conversely, consumer simplicity must not be achieved by making enterprise-grade isolation impossible later.

## Validation

Market demand must be validated with users and organisations. The architecture should preserve the option to serve these segments without assuming demand has already been proven.

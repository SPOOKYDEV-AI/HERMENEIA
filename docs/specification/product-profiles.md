# Product Profiles

HERMENEIA is designed around one global messaging/context core with multiple product profiles. Geography changes language, locale, regulatory and deployment constraints — not the underlying conversation model.

The profiles must share the same domain logic. Enterprise capability must not become a forked second product.

## Global product rule

The product must not assume a French domestic market or a single source/target language pair.

Commercial rollout may deliberately focus on selected countries/language pairs first, but:

- user identity is not tied to one language;
- each conversation participant owns a preferred target language/locale;
- group-message architecture must eventually support different target locales per recipient;
- regional language variants are first-class;
- market sequencing is separate from technical global readiness.

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

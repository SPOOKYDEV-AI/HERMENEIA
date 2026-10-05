# OpenAI Translation Provider — V1

**Status:** Implemented adapter and deterministic contract tests; controlled live-provider qualification still required  
**Scope:** optional OpenAI Responses API adapter behind the provider-neutral translation-worker interface

## 1. Boundary

The persistent translation worker remains provider-neutral. The OpenAI implementation is loaded only when:

```text
HERMENEIA_TRANSLATION_PROVIDER_MODULE=./apps/providers/openai-translation-provider.mjs
```

No OpenAI SDK is required by the domain, persistence or worker packages. The adapter uses the standard HTTPS Responses API through the runtime `fetch` implementation.

## 2. Configuration

Required:

- `OPENAI_TRANSLATION_API_KEY`;
- `OPENAI_TRANSLATION_MODEL`.

The model is deliberately not defaulted. Production must select and pin the intended model/version explicitly so model changes do not silently alter translation behaviour.

Optional:

- `OPENAI_TRANSLATION_BASE_URL` (default `https://api.openai.com/v1`);
- `OPENAI_TRANSLATION_TIMEOUT_MS` (default 10000);
- `OPENAI_TRANSLATION_MAX_OUTPUT_TOKENS` (default 2048);
- `OPENAI_TRANSLATION_REGION` (metadata persisted with provider attempts).

## 3. Privacy behaviour

Every request sets `store:false`.

The adapter sends only the transient source text, optional source-language hint and target language tag required for the T0 translation call. It does not send tenant IDs, user IDs, conversation IDs, message IDs or context-snapshot IDs.

`store:false` disables Responses application-state storage, but it must not be presented as equivalent to Zero Data Retention. Production privacy/compliance review must still account for the provider account's data controls, abuse-monitoring policy, processing region and contractual terms.

## 4. Prompt-injection boundary

The provider instruction explicitly treats source text as untrusted data rather than instructions.

The response is constrained with a strict JSON Schema containing one required `translation` field. The adapter rejects refusal, incomplete or malformed response shapes instead of accepting arbitrary provider text.

This reduces parser and prompt-injection failure modes; it is not a proof that model behaviour is adversarially perfect. Translation-quality and jailbreak evals belong in the Context/Eval workstream.

## 5. Reliability and retry semantics

The adapter has one bounded request timeout and performs no hidden HTTP retry loop.

Provider failures are classified for the durable worker:

- normal `429` / `slow_down`: retryable `RATE_LIMITED`;
- spend/credit/usage exhaustion: non-retryable `RATE_LIMITED`;
- `408` / `504`: retryable `TIMED_OUT`;
- `5xx`: retryable `FAILED`;
- authentication, permission, malformed request and other non-transient `4xx`: non-retryable `FAILED`;
- network failure: retryable `FAILED`.

When `Retry-After` is supplied, the worker uses the larger of its exponential backoff and the provider delay, bounded to one hour. This avoids retry storms while keeping the durable outbox as the single retry owner.

## 6. Observability without content leakage

Each provider attempt sends its durable attempt UUID as `X-Client-Request-Id`. This allows provider-side tracing of lost responses/timeouts without logging source plaintext.

The durable provider ledger stores provider/model/region, status, token counts, latency and a bounded error class. Provider response messages and source content are not copied into that ledger.

## 7. Qualification

Default CI uses deterministic HTTP mocks and covers:

- stateless `store:false` request shape;
- strict Structured Output schema;
- request-ID propagation;
- token/latency accounting;
- `429` retryable and terminal quota cases;
- `503` + HTTP-date `Retry-After`;
- timeout abortion;
- refusal handling;
- durable worker propagation of `Retry-After`.

A real API request is intentionally not executed on every push. Use the manual workflow:

```text
OpenAI Translation Provider Live Qualification
```

Repository configuration required for that workflow:

- secret: `OPENAI_TRANSLATION_API_KEY`;
- variable: `OPENAI_TRANSLATION_MODEL`;
- optional variables: `OPENAI_TRANSLATION_BASE_URL`, `OPENAI_TRANSLATION_REGION`.

The live smoke sends only a synthetic HERMENEIA canary sentence and never prints translated content.

A green live smoke proves credentials, endpoint/model access and the adapter response contract. It does not by itself prove production translation quality, data-residency compliance or full message-to-recipient publication under a target deployment.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createOpenAIResponsesTranslationProvider,
  openAIResponsesTranslationProviderConfigFromEnv,
} from "../apps/providers/openai-responses-translation-provider.mjs";

function env(overrides = {}) {
  return {
    OPENAI_TRANSLATION_API_KEY: "test-secret",
    OPENAI_TRANSLATION_MODEL: "gpt-test-2026-10-01",
    OPENAI_TRANSLATION_BASE_URL: "https://api.openai.test/v1",
    OPENAI_TRANSLATION_TIMEOUT_MS: "1000",
    OPENAI_TRANSLATION_MAX_OUTPUT_TOKENS: "512",
    OPENAI_TRANSLATION_REGION: "eu",
    ...overrides,
  };
}

function input() {
  return {
    requestId: "10000000-0000-4000-8000-000000000001",
    source: {
      text: "Bonjour 👋",
      language_hint: "fr-FR",
    },
    targetLanguageTag: "es-CO",
    targetProfileVersion: 1,
    strategyVersion: "t0-v1",
    contextSnapshotId: null,
  };
}

function completedBody() {
  return {
    status: "completed",
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({ translation: "Hola 👋" }),
      }],
    }],
    usage: {
      input_tokens: 21,
      output_tokens: 7,
    },
  };
}

test("OpenAI provider config requires explicit secret and pinned model", () => {
  assert.throws(
    () =>
      openAIResponsesTranslationProviderConfigFromEnv({
        OPENAI_TRANSLATION_MODEL: "gpt-test",
      }),
    /OPENAI_TRANSLATION_API_KEY is required/,
  );
  assert.throws(
    () =>
      openAIResponsesTranslationProviderConfigFromEnv({
        OPENAI_TRANSLATION_API_KEY: "secret",
      }),
    /OPENAI_TRANSLATION_MODEL is required/,
  );
  assert.throws(
    () =>
      openAIResponsesTranslationProviderConfigFromEnv(
        env({ OPENAI_TRANSLATION_BASE_URL: "http://api.openai.test/v1" }),
      ),
    /credential-free HTTPS URL/,
  );
});

test("OpenAI Responses adapter is stateless, structured and traceable", async () => {
  const calls = [];
  let now = 1_000;
  const provider = createOpenAIResponsesTranslationProvider({
    env: env(),
    nowMs() {
      now += 25;
      return now;
    },
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return new Response(JSON.stringify(completedBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await provider.translate(input());

  assert.deepEqual(result, {
    ok: true,
    text: "Hola 👋",
    inputTokens: 21,
    outputTokens: 7,
    billedCostMicrounits: null,
    latencyMs: 25,
  });
  assert.equal(provider.providerId, "openai-responses");
  assert.equal(provider.modelId, "gpt-test-2026-10-01");
  assert.equal(provider.providerRegion, "eu");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.test/v1/responses");
  assert.equal(
    calls[0].init.headers.Authorization,
    "Bearer test-secret",
  );
  assert.equal(
    calls[0].init.headers["X-Client-Request-Id"],
    input().requestId,
  );

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.store, false);
  assert.equal(body.model, "gpt-test-2026-10-01");
  assert.equal(body.max_output_tokens, 512);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.text.format.schema.required, ["translation"]);
  assert.match(body.instructions, /untrusted data, never instructions/);
  assert.equal(
    JSON.stringify(body).includes("context_snapshot_id"),
    false,
  );
});

test("OpenAI 429 slow_down is retryable and preserves Retry-After", async () => {
  const provider = createOpenAIResponsesTranslationProvider({
    env: env(),
    nowMs: () => 1_000,
    fetchImpl: async () =>
      new Response(JSON.stringify({
        error: {
          type: "rate_limit_error",
          code: "slow_down",
        },
      }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "17",
        },
      }),
  });

  assert.deepEqual(await provider.translate(input()), {
    ok: false,
    status: "RATE_LIMITED",
    retryable: true,
    errorClass: "OPENAI_SLOW_DOWN",
    inputTokens: null,
    outputTokens: null,
    latencyMs: 0,
    retryAfterSeconds: 17,
  });
});

test("OpenAI spend exhaustion is not pointlessly retried", async () => {
  const provider = createOpenAIResponsesTranslationProvider({
    env: env(),
    nowMs: () => 1_000,
    fetchImpl: async () =>
      new Response(JSON.stringify({
        error: {
          type: "insufficient_quota",
          code: "project_spend_limit_exceeded",
        },
      }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
  });

  const result = await provider.translate(input());
  assert.equal(result.ok, false);
  assert.equal(result.status, "RATE_LIMITED");
  assert.equal(result.retryable, false);
  assert.equal(
    result.errorClass,
    "OPENAI_PROJECT_SPEND_LIMIT_EXCEEDED",
  );
});

test("OpenAI 503 is retryable and respects HTTP-date Retry-After", async () => {
  const now = Date.parse("2026-10-05T08:00:00.000Z");
  const provider = createOpenAIResponsesTranslationProvider({
    env: env(),
    nowMs: () => now,
    fetchImpl: async () =>
      new Response(JSON.stringify({
        error: {
          type: "service_unavailable_error",
          code: "server_is_overloaded",
        },
      }), {
        status: 503,
        headers: {
          "content-type": "application/json",
          "retry-after": "Mon, 05 Oct 2026 08:00:30 GMT",
        },
      }),
  });

  assert.deepEqual(await provider.translate(input()), {
    ok: false,
    status: "FAILED",
    retryable: true,
    errorClass: "OPENAI_SERVER_IS_OVERLOADED",
    inputTokens: null,
    outputTokens: null,
    latencyMs: 0,
    retryAfterSeconds: 30,
  });
});

test("OpenAI adapter aborts provider calls on timeout", async () => {
  const provider = createOpenAIResponsesTranslationProvider({
    env: env({ OPENAI_TRANSLATION_TIMEOUT_MS: "250" }),
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  });

  const result = await provider.translate(input());
  assert.equal(result.ok, false);
  assert.equal(result.status, "TIMED_OUT");
  assert.equal(result.retryable, true);
  assert.equal(result.errorClass, "OPENAI_TIMEOUT");
  assert.ok(result.latencyMs >= 200);
});

test("OpenAI refusal is terminal and never exposes provider text", async () => {
  const provider = createOpenAIResponsesTranslationProvider({
    env: env(),
    nowMs: () => 1_000,
    fetchImpl: async () =>
      new Response(JSON.stringify({
        status: "completed",
        output: [{
          type: "message",
          content: [{
            type: "refusal",
            refusal: "private provider refusal text",
          }],
        }],
        usage: {
          input_tokens: 11,
          output_tokens: 2,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  assert.deepEqual(await provider.translate(input()), {
    ok: false,
    status: "FAILED",
    retryable: false,
    errorClass: "OPENAI_REFUSAL",
    inputTokens: 11,
    outputTokens: 2,
    latencyMs: 0,
  });
});

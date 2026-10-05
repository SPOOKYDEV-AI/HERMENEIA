import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  createOpenAIResponsesTranslationProvider,
} from "../apps/providers/openai-responses-translation-provider.mjs";

const provider = createOpenAIResponsesTranslationProvider();

const result = await provider.translate({
  requestId: randomUUID(),
  source: {
    text: "Bonjour, ceci est un test de qualification HERMENEIA.",
    language_hint: "fr-FR",
  },
  targetLanguageTag: "en-US",
  targetProfileVersion: 1,
  strategyVersion: "t0-v1",
  contextSnapshotId: null,
});

if (!result.ok) {
  throw new Error(
    `Live OpenAI provider qualification failed: ${result.errorClass ?? result.status}`,
  );
}

assert.equal(typeof result.text, "string");
assert.ok(result.text.trim().length > 0);
assert.ok(
  result.inputTokens === null ||
  result.inputTokens === undefined ||
  Number.isInteger(result.inputTokens),
);
assert.ok(
  result.outputTokens === null ||
  result.outputTokens === undefined ||
  Number.isInteger(result.outputTokens),
);

process.stdout.write(
  [
    "OPENAI_PROVIDER_LIVE_SMOKE=PASS",
    `provider=${provider.providerId}`,
    `model=${provider.modelId}`,
    `input_tokens=${result.inputTokens ?? "unknown"}`,
    `output_tokens=${result.outputTokens ?? "unknown"}`,
  ].join(" ") + "\n",
);

import test from "node:test";
import assert from "node:assert/strict";

import {
  createPersistentSendRuntime,
  persistentSendConfigFromEnv,
} from "../apps/api/persistent-send-runtime.mjs";

function keyBase64(fill) {
  return Buffer.alloc(32, fill).toString("base64");
}

function env(overrides = {}) {
  return {
    DATABASE_URL: "postgresql://example",
    SOURCE_FINGERPRINT_HMAC_KEY_VERSION: "k1",
    SOURCE_FINGERPRINT_HMAC_KEY_BASE64: keyBase64(1),
    SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON: "[]",
    ...overrides,
  };
}

class FakeClient {
  async query() {
    return { rows: [], rowCount: 0 };
  }

  release() {}
}

class FakePool {
  static instances = [];

  constructor(config) {
    this.config = config;
    this.ended = false;
    FakePool.instances.push(this);
  }

  async connect() {
    return new FakeClient();
  }

  async end() {
    this.ended = true;
  }
}

const originalProtector = {
  protect() {
    return "protected-original";
  },
};

test("translation worker config exposes strategy and bounded retries", () => {
  const config = persistentSendConfigFromEnv(env({
    TRANSLATION_STRATEGY_VERSION: "t0-test",
    TRANSLATION_MAX_PROVIDER_ATTEMPTS: "4",
    TRANSLATION_RETRY_BASE_SECONDS: "7",
  }));

  assert.deepEqual(config.translation, {
    strategyVersion: "t0-test",
    maxProviderAttempts: 4,
    retryBaseSeconds: 7,
  });
});

test("partial translation worker configuration fails before PostgreSQL opens", async () => {
  FakePool.instances.length = 0;

  await assert.rejects(
    () =>
      createPersistentSendRuntime({
        env: env(),
        pgModule: { Pool: FakePool },
        envelopeProtector: originalProtector,
        translationProvider: {
          providerId: "provider-a",
          modelId: "model-a",
          async translate() {
            return { ok: true, text: "translated" };
          },
        },
      }),
    /translationProvider and translationEnvelopeProtector/,
  );

  assert.equal(FakePool.instances.length, 0);
});

test("runtime composes translation worker only with provider and translation protector", async () => {
  FakePool.instances.length = 0;

  const runtime = await createPersistentSendRuntime({
    env: env(),
    pgModule: { Pool: FakePool },
    envelopeProtector: originalProtector,
    translationProvider: {
      providerId: "provider-a",
      modelId: "model-a",
      providerRegion: "eu-west",
      async translate() {
        return { ok: true, text: "translated" };
      },
    },
    translationEnvelopeProtector: {
      protect() {
        return "protected-translation";
      },
    },
    clock: {
      now() {
        return "2026-10-04T12:00:00.000Z";
      },
    },
  });

  assert.equal(typeof runtime.translationWorker.runFanoutOnce, "function");
  assert.equal(typeof runtime.translationWorker.runExecuteOnce, "function");

  await runtime.close();
  assert.equal(FakePool.instances[0].ended, true);
});

test("runtime keeps translation worker disabled when provider is absent", async () => {
  FakePool.instances.length = 0;

  const runtime = await createPersistentSendRuntime({
    env: env(),
    pgModule: { Pool: FakePool },
    envelopeProtector: originalProtector,
  });

  assert.equal(runtime.translationWorker, null);
  await runtime.close();
});

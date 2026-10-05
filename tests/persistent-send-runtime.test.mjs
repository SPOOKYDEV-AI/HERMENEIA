import test from "node:test";
import assert from "node:assert/strict";

import {
  createNodePostgresPool,
  postgresPoolConfigFromEnv,
} from "../apps/api/postgres-pool.mjs";
import {
  createPersistentSendRuntime,
  persistentSendConfigFromEnv,
} from "../apps/api/persistent-send-runtime.mjs";

function keyBase64(fill) {
  return Buffer.alloc(32, fill).toString("base64");
}

function env(overrides = {}) {
  return {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/hermeneia",
    SOURCE_FINGERPRINT_HMAC_KEY_VERSION: "k2",
    SOURCE_FINGERPRINT_HMAC_KEY_BASE64: keyBase64(2),
    SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON: JSON.stringify([
      {
        key_version: "k1",
        key_base64: keyBase64(1),
      },
    ]),
    ...overrides,
  };
}

class FakeClient {
  constructor(owner) {
    this.owner = owner;
    this.released = false;
  }

  async query(text, params = []) {
    this.owner.queries.push({ text, params: [...params] });

    if (/has_message_metadata/.test(text)) {
      return {
        rows: [{
          has_message_metadata: true,
          has_tenant_sync: true,
          has_translation_executions: true,
          has_provider_executions: true,
          has_context_snapshots: true,
          has_command_fingerprint: true,
          has_source_required_constraint: true,
          has_device_platform: true,
          has_device_material_constraint: true,
        }],
        rowCount: 1,
      };
    }

    if (/SELECT s\.tenant_id/.test(text)) {
      return {
        rows: [{
          tenant_id: "tenant-1",
          user_id: "user-1",
          device_id: "device-1",
        }],
        rowCount: 1,
      };
    }

    if (text === "SELECT nullable-rowcount") {
      return {
        rows: [{ value: 1 }],
        rowCount: null,
      };
    }

    return { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
    this.owner.releases += 1;
  }
}

class FakePool {
  static instances = [];

  constructor(config) {
    this.config = config;
    this.queries = [];
    this.releases = 0;
    this.ended = false;
    FakePool.instances.push(this);
  }

  async connect() {
    return new FakeClient(this);
  }

  async end() {
    this.ended = true;
  }
}

test("node-postgres adapter maps configuration and normalizes nullable rowCount", async () => {
  FakePool.instances.length = 0;

  const pool = await createNodePostgresPool({
    connectionString: "postgresql://example",
    max: 7,
    idleTimeoutMillis: 1234,
    connectionTimeoutMillis: 2345,
    pgModule: { Pool: FakePool },
  });

  const raw = FakePool.instances[0];
  assert.deepEqual(raw.config, {
    connectionString: "postgresql://example",
    max: 7,
    idleTimeoutMillis: 1234,
    connectionTimeoutMillis: 2345,
  });

  const connection = await pool.connect();
  const result = await connection.query("SELECT nullable-rowcount");
  assert.deepEqual(result, {
    rows: [{ value: 1 }],
    rowCount: 1,
  });

  connection.release();
  connection.release();
  assert.equal(raw.releases, 1);

  await assert.rejects(
    () => connection.query("SELECT after-release"),
    /already released/,
  );

  await pool.close();
  assert.equal(raw.ended, true);
});

test("postgres pool env parser is bounded and fail-closed", () => {
  assert.deepEqual(
    postgresPoolConfigFromEnv({
      DATABASE_URL: "postgresql://db",
      DB_POOL_MAX: "4",
      DB_POOL_IDLE_TIMEOUT_MS: "5000",
      DB_POOL_CONNECT_TIMEOUT_MS: "2000",
    }),
    {
      connectionString: "postgresql://db",
      max: 4,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 2000,
    },
  );

  assert.throws(
    () => postgresPoolConfigFromEnv({}),
    /DATABASE_URL is required/,
  );
  assert.throws(
    () =>
      postgresPoolConfigFromEnv({
        DATABASE_URL: "postgresql://db",
        DB_POOL_MAX: "0",
      }),
    /DB_POOL_MAX must be a positive integer/,
  );
});

test("persistent Send config decodes active and verification HMAC keys", () => {
  const config = persistentSendConfigFromEnv(env({
    TRANSIENT_SOURCE_TTL_SECONDS: "120",
    TRANSIENT_SOURCE_MAX_ENTRIES: "50",
    TRANSIENT_SOURCE_MAX_APPROX_BYTES: "4096",
    DELIVERY_ENVELOPE_TTL_SECONDS: "600",
    OUTBOX_LEASE_SECONDS: "45",
    CONTEXT_RECENT_MESSAGE_LIMIT: "4",
    CONTEXT_PAYLOAD_TTL_SECONDS: "90",
    CONTEXT_PAYLOAD_MAX_ENTRIES: "25",
    CONTEXT_PAYLOAD_MAX_TOTAL_CHARS: "12000",
    CONTEXT_TOTAL_TOKENS: "1536",
  }));

  assert.equal(config.sourceFingerprint.keyVersion, "k2");
  assert.equal(config.sourceFingerprint.key.length, 32);
  assert.equal(config.sourceFingerprint.verificationKeys.length, 1);
  assert.equal(
    config.sourceFingerprint.verificationKeys[0].keyVersion,
    "k1",
  );
  assert.deepEqual(config.transientSource, {
    ttlSeconds: 120,
    maxEntries: 50,
    maxApproxBytes: 4096,
  });
  assert.equal(config.envelopeTtlSeconds, 600);
  assert.equal(config.outboxLeaseSeconds, 45);
  assert.deepEqual(config.context, {
    recentMessageLimit: 4,
    payloadTtlSeconds: 90,
    payloadMaxEntries: 25,
    payloadMaxTotalChars: 12000,
    totalTokens: 1536,
  });
});

test("persistent Send config rejects malformed or weak HMAC material", () => {
  assert.throws(
    () =>
      persistentSendConfigFromEnv(env({
        SOURCE_FINGERPRINT_HMAC_KEY_BASE64:
          Buffer.alloc(8, 1).toString("base64"),
      })),
    /at least 32 bytes/,
  );

  assert.throws(
    () =>
      persistentSendConfigFromEnv(env({
        SOURCE_FINGERPRINT_HMAC_KEY_BASE64: "not base64!!",
      })),
    /valid base64/,
  );

  assert.throws(
    () =>
      persistentSendConfigFromEnv(env({
        SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON: "{}",
      })),
    /must be an array/,
  );
});

test("persistent Send runtime refuses to start without reviewed envelope protection", async () => {
  FakePool.instances.length = 0;

  await assert.rejects(
    () =>
      createPersistentSendRuntime({
        env: env(),
        pgModule: { Pool: FakePool },
      }),
    /reviewed envelopeProtector/,
  );

  assert.equal(FakePool.instances.length, 0);
});


test("duplicate fingerprint key versions fail before opening PostgreSQL", async () => {
  FakePool.instances.length = 0;

  await assert.rejects(
    () =>
      createPersistentSendRuntime({
        env: env({
          SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON: JSON.stringify([
            {
              key_version: "k2",
              key_base64: keyBase64(1),
            },
          ]),
        }),
        pgModule: { Pool: FakePool },
        envelopeProtector: {
          protect() {
            return "unused";
          },
        },
      }),
    /Duplicate HMAC source fingerprint keyVersion/,
  );

  assert.equal(FakePool.instances.length, 0);
});

test("persistent Send runtime composes PostgreSQL service and persistent bearer auth", async () => {
  FakePool.instances.length = 0;

  const runtime = await createPersistentSendRuntime({
    env: env(),
    pgModule: { Pool: FakePool },
    envelopeProtector: {
      protect() {
        return Buffer.from("reviewed-by-test-boundary").toString("base64");
      },
    },
    clock: {
      now() {
        return "2026-10-04T08:30:00.000Z";
      },
    },
  });

  assert.equal(await runtime.readinessService.check(), true);
  assert.equal(typeof runtime.sendService.sendMessage, "function");
  assert.equal(typeof runtime.commandService.getCommandStatus, "function");
  assert.equal(typeof runtime.mutationService.editMessage, "function");
  assert.equal(typeof runtime.mutationService.deleteMessage, "function");
  assert.equal(typeof runtime.deliveryService.sync, "function");
  assert.equal(typeof runtime.deviceService.enrollDevice, "function");
  assert.equal(typeof runtime.deviceService.rotateMaterial, "function");
  assert.equal(typeof runtime.deviceService.revokeDevice, "function");
  assert.equal(typeof runtime.deliveryService.acknowledge, "function");
  assert.equal(typeof runtime.outboxService.leaseNext, "function");
  assert.equal(typeof runtime.outboxService.complete, "function");
  assert.equal(typeof runtime.outboxService.retry, "function");
  assert.equal(typeof runtime.outboxService.deadLetter, "function");
  assert.equal(typeof runtime.translationService.ensurePending, "function");
  assert.equal(
    typeof runtime.translationService.startProviderAttempt,
    "function",
  );
  assert.equal(
    typeof runtime.translationService.completeProviderAttempt,
    "function",
  );
  assert.equal(typeof runtime.authenticate, "function");

  const authenticated = await runtime.authenticate({
    headers: {
      authorization: "Bearer high-entropy-token",
    },
  });

  assert.deepEqual(authenticated, {
    tenantId: "tenant-1",
    userId: "user-1",
    deviceId: "device-1",
  });

  const raw = FakePool.instances[0];
  assert.match(
    raw.queries.find((query) => /SELECT s\.tenant_id/.test(query.text)).text,
    /s\.tenant_id IS NOT NULL/,
  );
  assert.equal(raw.releases, 2);

  await runtime.close();
  assert.equal(raw.ended, true);
});


test("persistent readiness returns false when PostgreSQL connect fails", async () => {
  class FailingPool {
    async connect() {
      throw new Error("database unavailable");
    }
    async end() {}
  }

  const runtime = await createPersistentSendRuntime({
    env: env(),
    pgModule: { Pool: FailingPool },
    envelopeProtector: {
      protect() {
        return "unused";
      },
    },
  });

  assert.equal(await runtime.readinessService.check(), false);
  await runtime.close();
});


test("persistent readiness rejects reachable but incomplete schema", async () => {
  class IncompleteClient {
    async query(text) {
      if (/has_message_metadata/.test(text)) {
        return {
          rows: [{
            has_message_metadata: true,
            has_tenant_sync: true,
            has_translation_executions: false,
            has_provider_executions: false,
            has_command_fingerprint: true,
            has_source_required_constraint: false,
            has_device_platform: false,
            has_device_material_constraint: false,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }
    release() {}
  }

  class IncompletePool {
    async connect() {
      return new IncompleteClient();
    }
    async end() {}
  }

  const runtime = await createPersistentSendRuntime({
    env: env(),
    pgModule: { Pool: IncompletePool },
    envelopeProtector: {
      protect() {
        return "unused";
      },
    },
  });

  assert.equal(await runtime.readinessService.check(), false);
  await runtime.close();
});


test("persistent runtime composes context bridge when translation provider is enabled", async () => {
  FakePool.instances.length = 0;

  const runtime = await createPersistentSendRuntime({
    env: env(),
    pgModule: { Pool: FakePool },
    envelopeProtector: {
      protect() {
        return "original-protected";
      },
    },
    translationProvider: {
      providerId: "provider-test",
      modelId: "model-test",
      async translate() {
        return {
          status: "SUCCESS",
          translatedText: "translated",
          providerRequestId: "provider-request-1",
        };
      },
    },
    translationEnvelopeProtector: {
      protect() {
        return "translation-protected";
      },
    },
    clock: {
      now() {
        return "2026-10-04T20:00:00.000Z";
      },
    },
  });

  assert.ok(runtime.contextRuntime);
  assert.equal(
    typeof runtime.contextRuntime.contextService.prepareForTranslation,
    "function",
  );
  assert.equal(
    typeof runtime.contextRuntime.contextBridge.prepare,
    "function",
  );
  assert.equal(
    typeof runtime.contextRuntime.contextBridge.resolve,
    "function",
  );
  assert.ok(runtime.translationWorker);

  await runtime.close();
});

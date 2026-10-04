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

  assert.equal(typeof runtime.sendService.sendMessage, "function");
  assert.equal(typeof runtime.commandService.getCommandStatus, "function");
  assert.equal(typeof runtime.deliveryService.sync, "function");
  assert.equal(typeof runtime.deliveryService.acknowledge, "function");
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
  assert.equal(raw.releases, 1);

  await runtime.close();
  assert.equal(raw.ended, true);
});

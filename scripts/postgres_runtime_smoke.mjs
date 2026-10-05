import assert from "node:assert/strict";

import {
  startPersistentServerProcess,
} from "../apps/api/start-persistent-server.mjs";

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

const databaseUrl =
  process.env.HERMENEIA_TEST_DATABASE_URL ||
  process.env.DATABASE_URL;

if (!databaseUrl) {
  process.stdout.write(
    "POSTGRES_RUNTIME_SMOKE=SKIP database_url=no\n",
  );
  process.exit(0);
}

const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  SOURCE_FINGERPRINT_HMAC_KEY_VERSION:
    process.env.SOURCE_FINGERPRINT_HMAC_KEY_VERSION || "ci-v1",
  SOURCE_FINGERPRINT_HMAC_KEY_BASE64: required(
    process.env,
    "SOURCE_FINGERPRINT_HMAC_KEY_BASE64",
  ),
  SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON:
    process.env.SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON || "[]",
};

let processRuntime;

try {
  processRuntime = await startPersistentServerProcess({
    env,
    host: "127.0.0.1",
    port: 0,
  });

  const baseUrl =
    `http://127.0.0.1:${processRuntime.port}`;

  const healthResponse = await fetch(`${baseUrl}/healthz`);
  assert.equal(
    healthResponse.status,
    200,
    "persistent runtime healthz must be live",
  );
  assert.deepEqual(await healthResponse.json(), {
    status: "ok",
  });

  const readinessResponse = await fetch(`${baseUrl}/readyz`);
  assert.equal(
    readinessResponse.status,
    200,
    "persistent runtime readyz must confirm the migrated PostgreSQL schema",
  );
  assert.deepEqual(await readinessResponse.json(), {
    status: "ready",
  });

  const connection =
    await processRuntime.runtime.sqlPool.connect();
  try {
    const result = await connection.query(
      `SELECT
         current_database() AS database_name,
         to_regclass('public.message_metadata') IS NOT NULL
           AS has_message_metadata,
         to_regclass('public.tenant_device_sync_states') IS NOT NULL
           AS has_tenant_sync`,
    );

    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0]?.has_message_metadata, true);
    assert.equal(result.rows[0]?.has_tenant_sync, true);
    assert.equal(
      typeof result.rows[0]?.database_name,
      "string",
    );
  } finally {
    connection.release();
  }

  await processRuntime.close();
  await processRuntime.close();

  process.stdout.write("POSTGRES_RUNTIME_SMOKE=PASS\n");
} finally {
  await processRuntime?.close();
}

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import {
  createPersistentHermeneiaHttpRuntime,
} from "../apps/api/persistent-server.mjs";

function keyBase64(fill) {
  return Buffer.alloc(32, fill).toString("base64");
}

const env = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/hermeneia",
  SOURCE_FINGERPRINT_HMAC_KEY_VERSION: "k1",
  SOURCE_FINGERPRINT_HMAC_KEY_BASE64: keyBase64(1),
  SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON: "[]",
};

class FakeClient {
  constructor(pool) {
    this.pool = pool;
  }

  async query(text, params = []) {
    this.pool.queries.push({ text, params: [...params] });

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

    if (/FROM command_receipts/.test(text)) {
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  }

  release() {
    this.pool.releases += 1;
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

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("pure persistent HTTP runtime starts without an in-memory Core", async () => {
  FakePool.instances.length = 0;

  const app = await createPersistentHermeneiaHttpRuntime({
    env,
    pgModule: { Pool: FakePool },
    envelopeProtector: {
      protect() {
        return Buffer.from("reviewed-test-boundary").toString("base64");
      },
    },
    clock: {
      now() {
        return "2026-10-04T10:30:00.000Z";
      },
    },
  });

  const base = await listen(app.server);

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const command = await fetch(`${base}/v1/commands/unknown-command`, {
    headers: {
      authorization: "Bearer opaque-session-token",
    },
  });
  assert.equal(command.status, 200);
  assert.deepEqual(await command.json(), {
    command_id: "unknown-command",
    status: "UNKNOWN",
  });

  assert.equal(
    typeof app.runtime.translationRecoveryService.resupplySource,
    "function",
  );

  const recovery = await fetch(
    `${base}/v1/translations/translation-1/source`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer opaque-session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol_version: 1,
      }),
    },
  );
  assert.equal(recovery.status, 400);
  assert.equal((await recovery.json()).code, "INVALID_COMMAND");

  const pool = FakePool.instances[0];
  assert.equal(pool.ended, false);

  await app.close();
  assert.equal(pool.ended, true);

  await app.close();
  assert.equal(pool.ended, true);
});

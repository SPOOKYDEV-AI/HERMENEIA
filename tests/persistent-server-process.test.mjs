import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadSecurityRuntimeModule,
  persistentServerProcessConfigFromEnv,
  startPersistentServerProcess,
} from "../apps/api/start-persistent-server.mjs";

function keyBase64(fill) {
  return Buffer.alloc(32, fill).toString("base64");
}

function runtimeEnv(overrides = {}) {
  return {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/hermeneia",
    SOURCE_FINGERPRINT_HMAC_KEY_VERSION: "k1",
    SOURCE_FINGERPRINT_HMAC_KEY_BASE64: keyBase64(1),
    SOURCE_FINGERPRINT_VERIFICATION_KEYS_JSON: "[]",
    TRANSLATION_WORKER_MODE: "external",
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

    if (/to_regclass\('public\.message_metadata'\)/.test(text)) {
      return {
        rows: [{
          has_message_metadata: true,
          has_tenant_sync: true,
          has_translation_executions: true,
          has_provider_executions: true,
          has_command_fingerprint: true,
          has_source_required_constraint: true,
          has_device_platform: true,
          has_device_material_constraint: true,
        }],
        rowCount: 1,
      };
    }

    return {
      rows: [],
      rowCount: 0,
    };
  }

  release() {
    if (this.released) return;
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

test("persistent process env parser keeps production PORT strict", () => {
  assert.deepEqual(
    persistentServerProcessConfigFromEnv({
      HOST: "127.0.0.1",
      PORT: "4010",
      HERMENEIA_SECURITY_MODULE: "./security.mjs",
    }),
    {
      host: "127.0.0.1",
      port: 4010,
      securityModulePath: "./security.mjs",
    },
  );

  assert.throws(
    () =>
      persistentServerProcessConfigFromEnv({
        PORT: "0",
      }),
    /PORT must be an integer between 1 and 65535/,
  );
});

test("security module loader accepts only a local module exporting reviewed envelope protection", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "hermeneia-security-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(
    path.join(dir, "security.mjs"),
    `export const envelopeProtector = {
      protect() { return "protected"; }
    };
    `,
    "utf8",
  );

  const loaded = await loadSecurityRuntimeModule({
    modulePath: "./security.mjs",
    cwd: dir,
  });

  assert.equal(typeof loaded.envelopeProtector.protect, "function");

  await assert.rejects(
    () =>
      loadSecurityRuntimeModule({
        modulePath: "https://example.com/security.mjs",
        cwd: dir,
      }),
    /local filesystem path/,
  );
});

test("security module requires translation provider and protector as one reviewed pair", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "hermeneia-security-pair-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(
    path.join(dir, "bad-security.mjs"),
    `export const envelopeProtector = {
      protect() { return "protected"; }
    };
    export const translationProvider = {
      providerId: "fake",
      modelId: "fake",
      async translate() { return { ok: true, text: "x" }; }
    };
    `,
    "utf8",
  );

  await assert.rejects(
    () =>
      loadSecurityRuntimeModule({
        modulePath: "./bad-security.mjs",
        cwd: dir,
      }),
    /must be exported together/,
  );
});

test("persistent process starts real HTTP listener and shuts down pool cleanly", async (t) => {
  FakePool.instances.length = 0;

  const processRuntime = await startPersistentServerProcess({
    env: runtimeEnv(),
    pgModule: { Pool: FakePool },
    securityRuntime: {
      envelopeProtector: {
        protect() {
          return "protected";
        },
      },
    },
    host: "127.0.0.1",
    port: 0,
  });
  t.after(() => processRuntime.close());

  assert.equal(processRuntime.server.listening, true);
  assert.equal(processRuntime.host, "127.0.0.1");
  assert.equal(Number.isInteger(processRuntime.port), true);
  assert.equal(processRuntime.port > 0, true);

  const health = await fetch(
    `http://127.0.0.1:${processRuntime.port}/healthz`,
  );
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const ready = await fetch(
    `http://127.0.0.1:${processRuntime.port}/readyz`,
  );
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });

  const rawPool = FakePool.instances[0];
  assert.equal(rawPool.releases, 1);

  await processRuntime.close();
  assert.equal(processRuntime.server.listening, false);
  assert.equal(rawPool.ended, true);

  await processRuntime.close();
  assert.equal(rawPool.ended, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import {
  InMemorySessionCredentialIndex,
  InMemorySessionRegistry,
} from "../.build/packages/auth/src/index.js";
import { InMemoryMessagingCore } from "../.build/packages/core/src/index.js";
import { createHermeneiaHttpServer } from "../apps/api/server.mjs";
import { createBearerAuthenticator } from "../apps/api/session-auth.mjs";
import { sha256CredentialReference } from "../apps/api/session-credential.mjs";

function createRegistry() {
  let now = "2026-10-03T22:00:00.000Z";
  const registry = new InMemorySessionRegistry({
    clock: {
      now() {
        return now;
      },
    },
    credentials: new InMemorySessionCredentialIndex(),
  });

  return {
    registry,
    setNow(value) {
      now = value;
    },
  };
}

function register(registry, {
  sessionId,
  token,
  tenantId = "tenant-1",
  userId,
  deviceId,
  expiresAt = "2026-10-03T23:00:00.000Z",
}) {
  registry.registerSession({
    sessionId,
    tenantId,
    userId,
    deviceId,
    accessCredentialRef: sha256CredentialReference(token),
    status: "ACTIVE",
    issuedAt: "2026-10-03T22:00:00.000Z",
    expiresAt,
  });
}

function createCore() {
  let id = 0;
  const core = new InMemoryMessagingCore({
    ids: {
      next(prefix) {
        id += 1;
        return `${prefix}-${id}`;
      },
    },
    clock: {
      now() {
        return "2026-10-03T22:00:00.000Z";
      },
    },
    fingerprinter: {
      fingerprint(source) {
        return `${source.language_hint ?? ""}\u0000${source.text}`;
      },
    },
    envelopeProtector: {
      protect({ recipientDeviceId, source }) {
        return `TEST_ONLY:${recipientDeviceId}:${source.text}`;
      },
    },
    translationDispatcher: {
      notify() {
        throw new Error("AI unavailable");
      },
    },
  });

  core.registerDevice("user-a", "device-a");
  core.registerDevice("user-b", "device-b");
  core.registerConversation("tenant-1", "conversation-1", ["user-a", "user-b"]);
  return core;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("session credential resolves tenant/user/device without storing bearer plaintext", () => {
  const { registry } = createRegistry();
  const token = "opaque-token-a";
  register(registry, {
    sessionId: "session-a",
    token,
    userId: "user-a",
    deviceId: "device-a",
  });

  assert.deepEqual(registry.authenticateCredential(
    sha256CredentialReference(token),
  ), {
    tenantId: "tenant-1",
    userId: "user-a",
    deviceId: "device-a",
  });

  const record = registry.getSessionRecord("session-a");
  assert.notEqual(record.accessCredentialRef, token);
  assert.equal(record.accessCredentialRef.length, 64);
});

test("expired session is invalidated on authentication", () => {
  const { registry, setNow } = createRegistry();
  register(registry, {
    sessionId: "session-expired",
    token: "token-expired",
    userId: "user-a",
    deviceId: "device-a",
    expiresAt: "2026-10-03T22:10:00.000Z",
  });

  setNow("2026-10-03T22:10:00.000Z");

  assert.equal(
    registry.authenticateCredential(
      sha256CredentialReference("token-expired"),
    ),
    null,
  );
  assert.equal(
    registry.getSessionRecord("session-expired").status,
    "EXPIRED",
  );
});

test("session and device-session revocation remove access immediately", () => {
  const { registry } = createRegistry();

  register(registry, {
    sessionId: "session-1",
    token: "token-1",
    userId: "user-a",
    deviceId: "device-a",
  });
  register(registry, {
    sessionId: "session-2",
    token: "token-2",
    userId: "user-a",
    deviceId: "device-a",
  });

  registry.revokeSession("session-1");
  assert.equal(
    registry.authenticateCredential(sha256CredentialReference("token-1")),
    null,
  );

  assert.equal(registry.revokeDeviceSessions("device-a"), 1);
  assert.equal(
    registry.authenticateCredential(sha256CredentialReference("token-2")),
    null,
  );
});

test("bearer authenticator rejects malformed credentials and ignores spoof identity headers", async () => {
  const { registry } = createRegistry();
  register(registry, {
    sessionId: "session-a",
    token: "real-token-a",
    userId: "user-a",
    deviceId: "device-a",
  });

  const authenticate = createBearerAuthenticator({
    sessionRegistry: registry,
    credentialReference: sha256CredentialReference,
  });

  assert.equal(await authenticate({ headers: {} }), null);
  assert.equal(
    await authenticate({ headers: { authorization: "Basic nope" } }),
    null,
  );

  assert.deepEqual(
    await authenticate({
      headers: {
        authorization: "Bearer real-token-a",
        "x-test-user-id": "user-b",
        "x-test-device-id": "device-b",
      },
    }),
    {
      tenantId: "tenant-1",
      userId: "user-a",
      deviceId: "device-a",
    },
  );
});

test("HTTP API authenticates from bearer session rather than identity headers", async (t) => {
  const { registry } = createRegistry();
  register(registry, {
    sessionId: "session-a",
    token: "bearer-a",
    userId: "user-a",
    deviceId: "device-a",
  });
  register(registry, {
    sessionId: "session-b",
    token: "bearer-b",
    userId: "user-b",
    deviceId: "device-b",
  });

  const core = createCore();
  const server = createHermeneiaHttpServer({
    core,
    authenticate: createBearerAuthenticator({
      sessionRegistry: registry,
      credentialReference: sha256CredentialReference,
    }),
  });
  t.after(() => server.close());

  const base = await listen(server);

  const unauthenticated = await fetch(`${base}/v1/sync`, {
    headers: {
      "x-test-user-id": "user-a",
      "x-test-device-id": "device-a",
    },
  });
  assert.equal(unauthenticated.status, 401);

  const sent = await fetch(
    `${base}/v1/conversations/conversation-1/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer bearer-a",
        "x-test-user-id": "user-b",
        "x-test-device-id": "device-b",
      },
      body: JSON.stringify({
        protocol_version: 1,
        command_id: "cmd-bearer-1",
        client_message_id: "client-bearer-1",
        source: {
          text: "Bearer session owns this send",
          language_hint: "en-US",
        },
      }),
    },
  );

  assert.equal(sent.status, 202);
  const accepted = await sent.json();
  assert.equal(
    core.getMessageMetadata(accepted.message_id).authorUserId,
    "user-a",
  );

  const recipientSync = await fetch(`${base}/v1/sync?cursor=1:0`, {
    headers: {
      authorization: "Bearer bearer-b",
    },
  });
  assert.equal(recipientSync.status, 200);
  const sync = await recipientSync.json();
  assert.equal(sync.events.length, 1);
});

test("revoking the bearer session blocks the next request", async (t) => {
  const { registry } = createRegistry();
  register(registry, {
    sessionId: "session-a",
    token: "revokable-a",
    userId: "user-a",
    deviceId: "device-a",
  });

  const core = createCore();
  const server = createHermeneiaHttpServer({
    core,
    authenticate: createBearerAuthenticator({
      sessionRegistry: registry,
      credentialReference: sha256CredentialReference,
    }),
  });
  t.after(() => server.close());
  const base = await listen(server);

  const before = await fetch(`${base}/v1/sync`, {
    headers: { authorization: "Bearer revokable-a" },
  });
  assert.equal(before.status, 200);

  registry.revokeSession("session-a");

  const after = await fetch(`${base}/v1/sync`, {
    headers: { authorization: "Bearer revokable-a" },
  });
  assert.equal(after.status, 401);
});

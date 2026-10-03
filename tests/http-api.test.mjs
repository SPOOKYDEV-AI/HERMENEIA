import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { InMemoryMessagingCore } from "../.build/packages/core/src/index.js";
import { createHermeneiaHttpServer } from "../apps/api/server.mjs";

function buildFixture() {
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
        return "2026-10-03T20:00:00.000Z";
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
        throw new Error("AI intentionally unavailable");
      },
    },
  });

  core.registerDevice("user-a", "device-a");
  core.registerDevice("user-b", "device-b");
  core.registerConversation("tenant-1", "conversation-1", ["user-a", "user-b"]);

  const server = createHermeneiaHttpServer({
    core,
    authenticate(req) {
      const tenantId = req.headers["x-test-tenant-id"];
      const userId = req.headers["x-test-user-id"];
      const deviceId = req.headers["x-test-device-id"];
      if (
        typeof tenantId !== "string" ||
        typeof userId !== "string" ||
        typeof deviceId !== "string"
      ) {
        return null;
      }
      return { tenantId, userId, deviceId };
    },
  });

  return { core, server };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function authHeaders(userId, deviceId) {
  return {
    "content-type": "application/json",
    "x-test-tenant-id": "tenant-1",
    "x-test-user-id": userId,
    "x-test-device-id": deviceId,
  };
}

function sendBody(text = "Bonjour depuis HTTP") {
  return {
    protocol_version: 1,
    command_id: "cmd-http-1",
    client_message_id: "client-http-1",
    source: {
      text,
      language_hint: "fr-FR",
    },
  };
}

test("HTTP Send retry + recipient sync + ACK works while AI is down", async (t) => {
  const { core, server } = buildFixture();
  t.after(() => server.close());
  const base = await listen(server);

  const firstResponse = await fetch(
    `${base}/v1/conversations/conversation-1/messages`,
    {
      method: "POST",
      headers: authHeaders("user-a", "device-a"),
      body: JSON.stringify(sendBody()),
    },
  );
  assert.equal(firstResponse.status, 202);
  const first = await firstResponse.json();
  assert.equal(first.status, "ACCEPTED");
  assert.equal(first.translation_status, "PENDING");

  // Simulate response uncertainty by repeating the exact logical Send.
  const retryResponse = await fetch(
    `${base}/v1/conversations/conversation-1/messages`,
    {
      method: "POST",
      headers: authHeaders("user-a", "device-a"),
      body: JSON.stringify(sendBody()),
    },
  );
  assert.equal(retryResponse.status, 202);
  assert.deepEqual(await retryResponse.json(), first);
  assert.equal(core.getMessageCount(), 1);

  const syncResponse = await fetch(`${base}/v1/sync?cursor=1:0`, {
    headers: authHeaders("user-b", "device-b"),
  });
  assert.equal(syncResponse.status, 200);
  const sync = await syncResponse.json();
  assert.equal(sync.events.length, 1);
  assert.equal(sync.events[0].type, "message.available");
  assert.equal(sync.next_cursor, "1:1");
  assert.match(sync.events[0].payload.protected_payload, /^TEST_ONLY:/);

  const envelopeId = sync.events[0].payload.envelope_id;
  const ackResponse = await fetch(`${base}/v1/delivery/acks`, {
    method: "POST",
    headers: authHeaders("user-b", "device-b"),
    body: JSON.stringify({
      protocol_version: 1,
      acks: [
        {
          envelope_id: envelopeId,
          persisted_at: "2026-10-03T20:00:01.000Z",
        },
      ],
    }),
  });
  assert.equal(ackResponse.status, 204);
  assert.equal(core.pendingEnvelopes("device-b").length, 0);

  // ACK is idempotent even though the protected relay payload was deleted.
  const secondAck = await fetch(`${base}/v1/delivery/acks`, {
    method: "POST",
    headers: authHeaders("user-b", "device-b"),
    body: JSON.stringify({
      protocol_version: 1,
      acks: [
        {
          envelope_id: envelopeId,
          persisted_at: "2026-10-03T20:00:02.000Z",
        },
      ],
    }),
  });
  assert.equal(secondAck.status, 204);
});

test("HTTP idempotency conflict is a typed 409", async (t) => {
  const { server } = buildFixture();
  t.after(() => server.close());
  const base = await listen(server);

  await fetch(`${base}/v1/conversations/conversation-1/messages`, {
    method: "POST",
    headers: authHeaders("user-a", "device-a"),
    body: JSON.stringify(sendBody("version 1")),
  });

  const conflict = await fetch(
    `${base}/v1/conversations/conversation-1/messages`,
    {
      method: "POST",
      headers: authHeaders("user-a", "device-a"),
      body: JSON.stringify(sendBody("version 2")),
    },
  );

  assert.equal(conflict.status, 409);
  const body = await conflict.json();
  assert.equal(body.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(body.retryable, false);
});

test("sync cursor epoch mismatch requests reset", async (t) => {
  const { server } = buildFixture();
  t.after(() => server.close());
  const base = await listen(server);

  const response = await fetch(`${base}/v1/sync?cursor=99:20`, {
    headers: authHeaders("user-b", "device-b"),
  });

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "SYNC_RESET_REQUIRED");
  assert.equal(body.new_cursor, "1:0");
});

test("missing auth context is rejected before domain access", async (t) => {
  const { server } = buildFixture();
  t.after(() => server.close());
  const base = await listen(server);

  const response = await fetch(`${base}/v1/sync`);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.code, "NOT_AUTHORIZED");
});

test("payload limit rejects oversized Send before core processing", async (t) => {
  const { core, server } = buildFixture();
  t.after(() => server.close());
  const base = await listen(server);

  const response = await fetch(
    `${base}/v1/conversations/conversation-1/messages`,
    {
      method: "POST",
      headers: authHeaders("user-a", "device-a"),
      body: JSON.stringify(sendBody("x".repeat(80 * 1024))),
    },
  );

  assert.equal(response.status, 413);
  assert.equal(core.getMessageCount(), 0);
});


test("HTTP edit is idempotent and command status recovers its result", async (t) => {
  const { core, server } = buildFixture();
  t.after(() => server.close());
  const base = await listen(server);

  const sendResponse = await fetch(
    `${base}/v1/conversations/conversation-1/messages`,
    {
      method: "POST",
      headers: authHeaders("user-a", "device-a"),
      body: JSON.stringify(sendBody("before edit")),
    },
  );
  const accepted = await sendResponse.json();

  const editBody = {
    protocol_version: 1,
    command_id: "cmd-http-edit-1",
    expected_revision: 1,
    source: {
      text: "after edit",
      language_hint: "en-US",
    },
  };

  const editResponse = await fetch(`${base}/v1/messages/${accepted.message_id}`, {
    method: "PATCH",
    headers: authHeaders("user-a", "device-a"),
    body: JSON.stringify(editBody),
  });
  assert.equal(editResponse.status, 200);
  const edited = await editResponse.json();
  assert.equal(edited.revision, 2);

  const retryResponse = await fetch(`${base}/v1/messages/${accepted.message_id}`, {
    method: "PATCH",
    headers: authHeaders("user-a", "device-a"),
    body: JSON.stringify(editBody),
  });
  assert.equal(retryResponse.status, 200);
  assert.deepEqual(await retryResponse.json(), edited);

  const statusResponse = await fetch(`${base}/v1/commands/cmd-http-edit-1`, {
    headers: authHeaders("user-a", "device-a"),
  });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.status, "SUCCEEDED");
  assert.equal(status.result.revision, 2);

  assert.equal(core.getMessageMetadata(accepted.message_id).currentRevision, 2);
});

test("HTTP stale edit returns typed REVISION_CONFLICT", async (t) => {
  const { server } = buildFixture();
  t.after(() => server.close());
  const base = await listen(server);

  const sent = await fetch(`${base}/v1/conversations/conversation-1/messages`, {
    method: "POST",
    headers: authHeaders("user-a", "device-a"),
    body: JSON.stringify(sendBody("v1")),
  });
  const accepted = await sent.json();

  await fetch(`${base}/v1/messages/${accepted.message_id}`, {
    method: "PATCH",
    headers: authHeaders("user-a", "device-a"),
    body: JSON.stringify({
      protocol_version: 1,
      command_id: "cmd-edit-ok",
      expected_revision: 1,
      source: { text: "v2" },
    }),
  });

  const stale = await fetch(`${base}/v1/messages/${accepted.message_id}`, {
    method: "PATCH",
    headers: authHeaders("user-a", "device-a"),
    body: JSON.stringify({
      protocol_version: 1,
      command_id: "cmd-edit-stale",
      expected_revision: 1,
      source: { text: "bad overwrite" },
    }),
  });

  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.code, "REVISION_CONFLICT");
});

test("HTTP delete publishes a content-free delete sync event", async (t) => {
  const { server } = buildFixture();
  t.after(() => server.close());
  const base = await listen(server);

  const sent = await fetch(`${base}/v1/conversations/conversation-1/messages`, {
    method: "POST",
    headers: authHeaders("user-a", "device-a"),
    body: JSON.stringify(sendBody("delete after delivery")),
  });
  const accepted = await sent.json();

  const initialSync = await fetch(`${base}/v1/sync?cursor=1:0`, {
    headers: authHeaders("user-b", "device-b"),
  });
  const first = await initialSync.json();
  const envelopeId = first.events[0].payload.envelope_id;

  await fetch(`${base}/v1/delivery/acks`, {
    method: "POST",
    headers: authHeaders("user-b", "device-b"),
    body: JSON.stringify({
      protocol_version: 1,
      acks: [{ envelope_id: envelopeId, persisted_at: "2026-10-03T20:00:01.000Z" }],
    }),
  });

  const deletedResponse = await fetch(`${base}/v1/messages/${accepted.message_id}`, {
    method: "DELETE",
    headers: authHeaders("user-a", "device-a"),
    body: JSON.stringify({
      protocol_version: 1,
      command_id: "cmd-delete-http-1",
      expected_revision: 1,
    }),
  });
  assert.equal(deletedResponse.status, 200);

  const syncDelete = await fetch(`${base}/v1/sync?cursor=1:1`, {
    headers: authHeaders("user-b", "device-b"),
  });
  const payload = await syncDelete.json();
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].type, "message.deleted");
  assert.equal(payload.events[0].payload.message_id, accepted.message_id);
  assert.equal("protected_payload" in payload.events[0].payload, false);
});

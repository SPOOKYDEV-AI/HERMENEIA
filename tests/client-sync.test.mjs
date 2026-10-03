import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { InMemoryMessagingCore } from "../.build/packages/core/src/index.js";
import {
  ClientMessagingEngine,
  HttpMessagingTransport,
  InMemoryClientStore,
  TransportError,
} from "../.build/packages/client-core/src/index.js";
import { createHermeneiaHttpServer } from "../apps/api/server.mjs";

function deterministicIds() {
  let n = 0;
  return {
    next(prefix) {
      n += 1;
      return `${prefix}-${n}`;
    },
  };
}

function buildServerFixture() {
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
        return "2026-10-03T21:00:00.000Z";
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
        throw new Error("AI unavailable by design");
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

function transport(baseUrl, userId, deviceId) {
  return new HttpMessagingTransport({
    baseUrl,
    headers() {
      return {
        "x-test-tenant-id": "tenant-1",
        "x-test-user-id": userId,
        "x-test-device-id": deviceId,
      };
    },
  });
}

function clientClock() {
  let tick = 0;
  return {
    now() {
      tick += 1;
      return new Date(Date.UTC(2026, 9, 3, 21, 0, tick)).toISOString();
    },
  };
}

test("offline sender keeps local source, then flushes exactly once when network returns", async (t) => {
  const { core, server } = buildServerFixture();
  t.after(() => server.close());
  const base = await listen(server);

  const store = new InMemoryClientStore();
  const engine = new ClientMessagingEngine({
    store,
    transport: transport(base, "user-a", "device-a"),
    ids: deterministicIds(),
    clock: clientClock(),
  });

  const queued = engine.queueMessage("conversation-1", {
    text: "Message conservé localement",
    language_hint: "fr-FR",
  });

  await engine.flushOutbox();
  assert.equal(store.getOutgoing(queued.localId).state, "QUEUED_LOCAL");
  assert.equal(core.getMessageCount(), 0);

  engine.setNetworkState("ONLINE");
  await engine.flushOutbox();

  const accepted = store.getOutgoing(queued.localId);
  assert.equal(accepted.state, "ACCEPTED");
  assert.equal(accepted.source.text, "Message conservé localement");
  assert.equal(accepted.accepted.translation_status, "PENDING");
  assert.equal(core.getMessageCount(), 1);
});

test("lost Send response retries with same ids and does not duplicate server message", async (t) => {
  const { core, server } = buildServerFixture();
  t.after(() => server.close());
  const base = await listen(server);

  const real = transport(base, "user-a", "device-a");
  let firstAttempt = true;
  const flakyTransport = {
    async send(command) {
      const result = await real.send(command);
      if (firstAttempt) {
        firstAttempt = false;
        throw new TransportError(
          "NETWORK_ERROR",
          "response lost after server commit",
          true,
        );
      }
      return result;
    },
    sync(cursor) {
      return real.sync(cursor);
    },
    acknowledge(acks) {
      return real.acknowledge(acks);
    },
  };

  const store = new InMemoryClientStore();
  const ids = deterministicIds();

  let engine = new ClientMessagingEngine({
    store,
    transport: flakyTransport,
    ids,
    clock: clientClock(),
  });
  engine.setNetworkState("ONLINE");

  const queued = engine.queueMessage("conversation-1", {
    text: "Retry me safely",
    language_hint: "en-US",
  });

  await engine.flushOutbox();
  assert.equal(store.getOutgoing(queued.localId).state, "RETRY_WAIT");
  assert.equal(core.getMessageCount(), 1);

  // Simulate app/process recreation using the same durable local store.
  engine = new ClientMessagingEngine({
    store,
    transport: real,
    ids,
    clock: clientClock(),
  });
  engine.setNetworkState("ONLINE");
  await engine.flushOutbox();

  assert.equal(store.getOutgoing(queued.localId).state, "ACCEPTED");
  assert.equal(core.getMessageCount(), 1);
});

test("recipient persists event and cursor before ACK; failed ACK retries after restart without duplicate inbox item", async (t) => {
  const { core, server } = buildServerFixture();
  t.after(() => server.close());
  const base = await listen(server);

  const senderStore = new InMemoryClientStore();
  const sender = new ClientMessagingEngine({
    store: senderStore,
    transport: transport(base, "user-a", "device-a"),
    ids: deterministicIds(),
    clock: clientClock(),
  });
  sender.setNetworkState("ONLINE");
  sender.queueMessage("conversation-1", {
    text: "Bonjour B",
    language_hint: "fr-FR",
  });
  await sender.flushOutbox();

  const realRecipientTransport = transport(base, "user-b", "device-b");
  let failAckOnce = true;
  const flakyAckTransport = {
    send(command) {
      return realRecipientTransport.send(command);
    },
    sync(cursor) {
      return realRecipientTransport.sync(cursor);
    },
    async acknowledge(acks) {
      if (failAckOnce) {
        failAckOnce = false;
        throw new TransportError("NETWORK_ERROR", "ACK response lost", true);
      }
      return realRecipientTransport.acknowledge(acks);
    },
  };

  const recipientStore = new InMemoryClientStore();
  let recipient = new ClientMessagingEngine({
    store: recipientStore,
    transport: flakyAckTransport,
    ids: deterministicIds(),
    clock: clientClock(),
  });
  recipient.setNetworkState("ONLINE");

  await recipient.syncOnce();

  assert.equal(recipientStore.listIncoming().length, 1);
  assert.equal(recipientStore.getSyncCursor(), "1:1");
  assert.equal(recipientStore.listPendingAcks().length, 1);
  assert.equal(core.pendingEnvelopes("device-b").length, 1);

  // Restart: cursor and local envelope survive, so no duplicate event is applied.
  recipient = new ClientMessagingEngine({
    store: recipientStore,
    transport: realRecipientTransport,
    ids: deterministicIds(),
    clock: clientClock(),
  });
  recipient.setNetworkState("ONLINE");

  await recipient.syncOnce();

  assert.equal(recipientStore.listIncoming().length, 1);
  assert.equal(recipientStore.getSyncCursor(), "1:1");
  assert.equal(recipientStore.listPendingAcks().length, 0);
  assert.equal(core.pendingEnvelopes("device-b").length, 0);

  await recipient.syncOnce();
  assert.equal(recipientStore.listIncoming().length, 1);
});

test("offline recipient does not call sync transport", async () => {
  let syncCalls = 0;
  const store = new InMemoryClientStore();
  const engine = new ClientMessagingEngine({
    store,
    transport: {
      async send() {
        throw new Error("not used");
      },
      async sync() {
        syncCalls += 1;
        return { protocol_version: 1, events: [], next_cursor: "1:0" };
      },
      async acknowledge() {},
    },
    ids: deterministicIds(),
    clock: clientClock(),
  });

  await engine.syncOnce();
  assert.equal(syncCalls, 0);
});

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


test("control events advance the local cursor without creating a message envelope", async () => {
  let seenCursor;
  const store = new InMemoryClientStore();
  const engine = new ClientMessagingEngine({
    store,
    transport: {
      async send() {
        throw new Error("not used");
      },
      async sync(cursor) {
        seenCursor = cursor;
        return {
          protocol_version: 1,
          events: [
            {
              protocol_version: 1,
              event_id: "evt-control-1",
              cursor: "1:7",
              type: "preferences.changed",
              server_time: "2026-10-03T21:01:00.000Z",
              tenant_id: "tenant-1",
              conversation_id: null,
              payload: {},
            },
          ],
          next_cursor: "1:7",
        };
      },
      async acknowledge() {},
    },
    ids: deterministicIds(),
    clock: clientClock(),
  });

  engine.setNetworkState("ONLINE");
  await engine.syncOnce();

  assert.equal(seenCursor, undefined);
  assert.equal(store.getSyncCursor(), "1:7");
  assert.equal(store.listIncoming().length, 0);
  assert.equal(store.listPendingAcks().length, 0);
});


test("recipient applies edit as replacement and delete as local removal", async (t) => {
  const { core, server } = buildServerFixture();
  t.after(() => server.close());
  const base = await listen(server);

  const senderTransport = transport(base, "user-a", "device-a");
  const recipientTransport = transport(base, "user-b", "device-b");

  const senderStore = new InMemoryClientStore();
  const sender = new ClientMessagingEngine({
    store: senderStore,
    transport: senderTransport,
    ids: deterministicIds(),
    clock: clientClock(),
  });
  sender.setNetworkState("ONLINE");

  const queued = sender.queueMessage("conversation-1", {
    text: "version one",
    language_hint: "en-US",
  });
  await sender.flushOutbox();
  const accepted = senderStore.getOutgoing(queued.localId).accepted;

  const recipientStore = new InMemoryClientStore();
  const recipient = new ClientMessagingEngine({
    store: recipientStore,
    transport: recipientTransport,
    ids: deterministicIds(),
    clock: clientClock(),
  });
  recipient.setNetworkState("ONLINE");
  await recipient.syncOnce();

  assert.equal(recipientStore.listIncoming().length, 1);
  assert.match(
    recipientStore.listIncoming()[0].protectedPayload,
    /version one$/,
  );

  const edited = await senderTransport.edit({
    protocol_version: 1,
    command_id: "client-edit-1",
    message_id: accepted.message_id,
    expected_revision: 1,
    source: {
      text: "version two",
      language_hint: "en-US",
    },
  });
  assert.equal(edited.revision, 2);

  await recipient.syncOnce();
  assert.equal(recipientStore.listIncoming().length, 1);
  assert.equal(recipientStore.listIncoming()[0].sourceRevision, 2);
  assert.match(
    recipientStore.listIncoming()[0].protectedPayload,
    /version two$/,
  );

  const deleted = await senderTransport.delete({
    protocol_version: 1,
    command_id: "client-delete-1",
    message_id: accepted.message_id,
    expected_revision: 2,
  });
  assert.equal(deleted.status, "DELETED");

  await recipient.syncOnce();
  assert.equal(recipientStore.listIncoming().length, 0);
  assert.equal(core.getMessageMetadata(accepted.message_id).status, "DELETED");
});


function syntheticEvent({
  eventId,
  cursor,
  type = "message.available",
  messageId = "message-rendition-1",
  revision = 1,
}) {
  return {
    protocol_version: 1,
    event_id: eventId,
    cursor,
    type,
    server_time: "2026-10-04T12:00:00.000Z",
    tenant_id: "tenant-1",
    conversation_id: "conversation-1",
    payload: {
      message_id: messageId,
      source_revision: revision,
    },
  };
}

function syntheticEnvelope({
  eventId,
  envelopeId,
  revision = 1,
  renditionType,
  payload,
  messageId = "message-rendition-1",
}) {
  return {
    eventId,
    envelopeId,
    conversationId: "conversation-1",
    messageId,
    sourceRevision: revision,
    renditionType,
    protectedPayload: payload,
    expiresAt: "2026-10-11T12:00:00.000Z",
    persistedAt: "2026-10-04T12:00:01.000Z",
  };
}

test("client keeps ORIGINAL and TRANSLATION renditions while preferring translation for display", () => {
  const store = new InMemoryClientStore();

  store.applyIncomingEventAtomically(
    syntheticEvent({
      eventId: "evt-original",
      cursor: "1:1",
    }),
    syntheticEnvelope({
      eventId: "evt-original",
      envelopeId: "env-original",
      renditionType: "ORIGINAL",
      payload: "protected-original",
    }),
  );

  store.applyIncomingEventAtomically(
    syntheticEvent({
      eventId: "evt-translation",
      cursor: "1:2",
    }),
    syntheticEnvelope({
      eventId: "evt-translation",
      envelopeId: "env-translation",
      renditionType: "TRANSLATION",
      payload: "protected-translation",
    }),
  );

  const visible = store.listIncoming();
  assert.equal(visible.length, 1);
  assert.equal(visible[0].renditionType, "TRANSLATION");
  assert.equal(visible[0].protectedPayload, "protected-translation");

  const renditions = store.listIncomingRenditions(
    "message-rendition-1",
  );
  assert.deepEqual(
    renditions.map((item) => item.renditionType),
    ["ORIGINAL", "TRANSLATION"],
  );
  assert.equal(renditions[0].protectedPayload, "protected-original");
  assert.equal(renditions[1].protectedPayload, "protected-translation");
  assert.equal(store.listPendingAcks().length, 2);
});

test("stale translation is ACKed but cannot regress a newer source revision", () => {
  const store = new InMemoryClientStore();

  store.applyIncomingEventAtomically(
    syntheticEvent({
      eventId: "evt-v1-original",
      cursor: "1:1",
    }),
    syntheticEnvelope({
      eventId: "evt-v1-original",
      envelopeId: "env-v1-original",
      renditionType: "ORIGINAL",
      payload: "original-v1",
    }),
  );

  store.applyIncomingEventAtomically(
    syntheticEvent({
      eventId: "evt-v1-translation",
      cursor: "1:2",
    }),
    syntheticEnvelope({
      eventId: "evt-v1-translation",
      envelopeId: "env-v1-translation",
      renditionType: "TRANSLATION",
      payload: "translation-v1",
    }),
  );

  store.applyIncomingEventAtomically(
    syntheticEvent({
      eventId: "evt-v2-original",
      cursor: "1:3",
      type: "message.edited",
      revision: 2,
    }),
    syntheticEnvelope({
      eventId: "evt-v2-original",
      envelopeId: "env-v2-original",
      revision: 2,
      renditionType: "ORIGINAL",
      payload: "original-v2",
    }),
  );

  store.applyIncomingEventAtomically(
    syntheticEvent({
      eventId: "evt-late-v1-translation",
      cursor: "1:4",
      revision: 1,
    }),
    syntheticEnvelope({
      eventId: "evt-late-v1-translation",
      envelopeId: "env-late-v1-translation",
      revision: 1,
      renditionType: "TRANSLATION",
      payload: "late-translation-v1",
    }),
  );

  assert.equal(store.listIncoming()[0].sourceRevision, 2);
  assert.equal(store.listIncoming()[0].renditionType, "ORIGINAL");
  assert.deepEqual(
    store
      .listIncomingRenditions("message-rendition-1")
      .map((item) => [item.sourceRevision, item.renditionType]),
    [[2, "ORIGINAL"]],
  );
  assert.equal(store.listPendingAcks().length, 4);

  store.applyIncomingEventAtomically(
    syntheticEvent({
      eventId: "evt-v2-translation",
      cursor: "1:5",
      revision: 2,
    }),
    syntheticEnvelope({
      eventId: "evt-v2-translation",
      envelopeId: "env-v2-translation",
      revision: 2,
      renditionType: "TRANSLATION",
      payload: "translation-v2",
    }),
  );

  assert.equal(store.listIncoming()[0].sourceRevision, 2);
  assert.equal(store.listIncoming()[0].renditionType, "TRANSLATION");
  assert.deepEqual(
    store
      .listIncomingRenditions("message-rendition-1")
      .map((item) => item.renditionType),
    ["ORIGINAL", "TRANSLATION"],
  );
});

test("delete removes every local rendition of the message", () => {
  const store = new InMemoryClientStore();

  for (const [index, renditionType] of [
    [1, "ORIGINAL"],
    [2, "TRANSLATION"],
  ]) {
    store.applyIncomingEventAtomically(
      syntheticEvent({
        eventId: `evt-delete-${index}`,
        cursor: `1:${index}`,
      }),
      syntheticEnvelope({
        eventId: `evt-delete-${index}`,
        envelopeId: `env-delete-${index}`,
        renditionType,
        payload: `payload-${index}`,
      }),
    );
  }

  store.applyDeleteEventAtomically(
    syntheticEvent({
      eventId: "evt-delete-control",
      cursor: "1:3",
      type: "message.deleted",
      revision: 2,
    }),
    "message-rendition-1",
  );

  assert.equal(store.listIncoming().length, 0);
  assert.equal(
    store.listIncomingRenditions("message-rendition-1").length,
    0,
  );
});

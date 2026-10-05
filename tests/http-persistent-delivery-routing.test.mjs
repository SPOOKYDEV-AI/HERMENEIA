import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createHermeneiaHttpServer } from "../apps/api/server.mjs";

const actor = {
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-1",
};

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function coreThatMustNotHandleDelivery() {
  return {
    sendMessage() {
      throw new Error("unused");
    },
    getCommandStatus() {
      return { command_id: "unused", status: "UNKNOWN" };
    },
    getDeviceSyncPosition() {
      throw new Error("persistent sync must bypass in-memory core");
    },
    syncDevice() {
      throw new Error("persistent sync must bypass in-memory core");
    },
    getEnvelopeForDevice() {
      throw new Error("persistent sync must bypass in-memory core");
    },
    acknowledgeEnvelope() {
      throw new Error("persistent ACK must bypass in-memory core");
    },
    editMessage() {
      throw new Error("unused");
    },
    deleteMessage() {
      throw new Error("unused");
    },
  };
}

test("HTTP sync is routed to the injected persistent delivery service", async (t) => {
  const calls = [];
  const deliveryService = {
    async sync(receivedActor, input) {
      calls.push({
        type: "sync",
        actor: receivedActor,
        input,
      });
      return {
        kind: "OK",
        response: {
          protocol_version: 1,
          events: [{
            protocol_version: 1,
            event_id: "event-1",
            cursor: "4:9",
            type: "message.deleted",
            server_time: "2026-10-04T09:00:00.000Z",
            tenant_id: "tenant-1",
            conversation_id: "conversation-1",
            payload: {
              message_id: "message-1",
              source_revision: 2,
            },
          }],
          next_cursor: "4:9",
        },
      };
    },
    async acknowledge() {
      throw new Error("unused");
    },
  };

  const server = createHermeneiaHttpServer({
    core: coreThatMustNotHandleDelivery(),
    deliveryService,
    authenticate() {
      return actor;
    },
  });
  t.after(() => server.close());

  const base = await listen(server);
  const response = await fetch(
    `${base}/v1/sync?cursor=4%3A8&limit=50`,
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.next_cursor, "4:9");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: "sync",
    actor,
    input: {
      cursor: "4:8",
      limit: 50,
    },
  });
});

test("HTTP persistent sync maps controlled reset to 409", async (t) => {
  const server = createHermeneiaHttpServer({
    core: coreThatMustNotHandleDelivery(),
    deliveryService: {
      async sync() {
        return {
          kind: "RESET",
          response: {
            protocol_version: 1,
            code: "SYNC_RESET_REQUIRED",
            new_cursor: "4:6",
            events: [],
          },
        };
      },
      async acknowledge() {
        throw new Error("unused");
      },
    },
    authenticate() {
      return actor;
    },
  });
  t.after(() => server.close());

  const base = await listen(server);
  const response = await fetch(`${base}/v1/sync?cursor=4%3A5`);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "SYNC_RESET_REQUIRED");
  assert.equal(body.new_cursor, "4:6");
});

test("HTTP ACK is routed to persistent delivery and preserves client persisted_at only as input", async (t) => {
  const calls = [];
  const deliveryService = {
    async sync() {
      throw new Error("unused");
    },
    async acknowledge(receivedActor, acks) {
      calls.push({
        actor: receivedActor,
        acks: structuredClone(acks),
      });
    },
  };

  const server = createHermeneiaHttpServer({
    core: coreThatMustNotHandleDelivery(),
    deliveryService,
    authenticate() {
      return actor;
    },
  });
  t.after(() => server.close());

  const base = await listen(server);
  const response = await fetch(`${base}/v1/delivery/acks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol_version: 1,
      acks: [{
        envelope_id: "envelope-1",
        persisted_at: "2026-10-04T09:29:00.000Z",
      }],
    }),
  });

  assert.equal(response.status, 204);
  assert.deepEqual(calls, [{
    actor,
    acks: [{
      envelope_id: "envelope-1",
      persisted_at: "2026-10-04T09:29:00.000Z",
    }],
  }]);
});

test("HTTP rejects invalid ACK timestamp before persistent delivery service", async (t) => {
  let called = false;
  const server = createHermeneiaHttpServer({
    core: coreThatMustNotHandleDelivery(),
    deliveryService: {
      async sync() {
        throw new Error("unused");
      },
      async acknowledge() {
        called = true;
      },
    },
    authenticate() {
      return actor;
    },
  });
  t.after(() => server.close());

  const base = await listen(server);
  const response = await fetch(`${base}/v1/delivery/acks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol_version: 1,
      acks: [{
        envelope_id: "envelope-1",
        persisted_at: "not-a-date",
      }],
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(called, false);
});

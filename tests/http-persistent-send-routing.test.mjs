import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createHermeneiaHttpServer } from "../apps/api/server.mjs";

const actor = {
  tenantId: "tenant-1",
  userId: "user-a",
  deviceId: "device-a1",
};

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("HTTP Send is routed to the injected persistent send service", async (t) => {
  const calls = [];
  const accepted = {
    protocol_version: 1,
    status: "ACCEPTED",
    message_id: "message-persistent-1",
    message_seq: 42,
    source_revision: 1,
    accepted_at: "2026-10-04T07:30:00.000Z",
    translation_status: "PENDING",
  };

  const core = {
    sendMessage() {
      throw new Error("HTTP Send must not fall back to the in-memory core");
    },
    getCommandStatus() {
      return { command_id: "unused", status: "UNKNOWN" };
    },
    getDeviceSyncPosition() {
      return { inboxEpoch: 1, nextOffset: 1 };
    },
    syncDevice() {
      return [];
    },
    acknowledgeEnvelope() {},
    editMessage() {
      throw new Error("unused");
    },
    deleteMessage() {
      throw new Error("unused");
    },
    getEnvelopeForDevice() {
      return undefined;
    },
  };

  const sendService = {
    async sendMessage(receivedActor, command) {
      calls.push({ actor: receivedActor, command });
      return accepted;
    },
  };

  const server = createHermeneiaHttpServer({
    core,
    sendService,
    authenticate() {
      return actor;
    },
  });
  t.after(() => server.close());

  const base = await listen(server);
  const response = await fetch(
    `${base}/v1/conversations/conversation-1/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol_version: 1,
        command_id: "command-1",
        client_message_id: "client-message-1",
        source: {
          text: "Bonjour",
          language_hint: "fr-FR",
        },
        client_authored_at: "2026-10-04T07:29:59.000Z",
      }),
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), accepted);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].actor, actor);
  assert.deepEqual(calls[0].command, {
    protocol_version: 1,
    command_id: "command-1",
    client_message_id: "client-message-1",
    conversation_id: "conversation-1",
    source: {
      text: "Bonjour",
      language_hint: "fr-FR",
    },
    client_authored_at: "2026-10-04T07:29:59.000Z",
  });
});

test("HTTP server rejects an invalid explicit send service", () => {
  assert.throws(
    () =>
      createHermeneiaHttpServer({
        core: {},
        sendService: {},
        authenticate() {
          return actor;
        },
      }),
    /sendService\.sendMessage is required/,
  );
});


test("HTTP command status is routed to the injected persistent command service", async (t) => {
  const calls = [];
  const core = {
    sendMessage() { throw new Error("unused"); },
    getCommandStatus() {
      throw new Error("persistent command recovery must bypass in-memory core");
    },
    getDeviceSyncPosition() { return { inboxEpoch: 1, nextOffset: 1 }; },
    syncDevice() { return []; },
    acknowledgeEnvelope() {},
    editMessage() { throw new Error("unused"); },
    deleteMessage() { throw new Error("unused"); },
    getEnvelopeForDevice() { return undefined; },
  };

  const commandService = {
    async getCommandStatus(receivedActor, commandId) {
      calls.push({ actor: receivedActor, commandId });
      return {
        command_id: commandId,
        status: "SUCCEEDED",
        result: { message_id: "message-1", status: "ACCEPTED" },
      };
    },
  };

  const server = createHermeneiaHttpServer({
    core,
    commandService,
    authenticate() {
      return actor;
    },
  });
  t.after(() => server.close());

  const base = await listen(server);
  const response = await fetch(`${base}/v1/commands/command-1`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    command_id: "command-1",
    status: "SUCCEEDED",
    result: { message_id: "message-1", status: "ACCEPTED" },
  });
  assert.deepEqual(calls, [{
    actor,
    commandId: "command-1",
  }]);
});

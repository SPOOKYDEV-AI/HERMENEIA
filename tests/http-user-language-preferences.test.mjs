import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import {
  createHermeneiaHttpServer,
} from "../apps/api/server.mjs";

const ACTOR = {
  tenantId: "40000000-0000-4000-8000-000000000001",
  userId: "40000000-0000-4000-8000-000000000002",
  deviceId: "40000000-0000-4000-8000-000000000003",
};

function fixture() {
  const calls = [];
  const server = createHermeneiaHttpServer({
    authenticate() {
      return ACTOR;
    },
    sendService: {
      async sendMessage() {
        throw new Error("unused");
      },
    },
    commandService: {
      async getCommandStatus() {
        throw new Error("unused");
      },
    },
    mutationService: {
      async editMessage() {
        throw new Error("unused");
      },
      async deleteMessage() {
        throw new Error("unused");
      },
    },
    deliveryService: {
      async sync() {
        return {
          kind: "OK",
          response: {
            protocol_version: 1,
            events: [],
            next_cursor: "1:0",
          },
        };
      },
      async acknowledge() {},
    },
    userLanguagePreferenceService: {
      async update(actor, command) {
        calls.push({
          actor: structuredClone(actor),
          command: structuredClone(command),
        });
        return {
          changed: true,
          preference_version: 2,
          target_profile_updates: 1,
        };
      },
    },
  });
  return { server, calls };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("HTTP language preferences bind actor from authentication and return 204", async (t) => {
  const { server, calls } = fixture();
  t.after(() => server.close());
  const base = await listen(server);

  const response = await fetch(
    `${base}/v1/me/language-preferences`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target_language: "es",
        target_locale: "es-CO",
        preferred_register: "FORMAL",
      }),
    },
  );

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.deepEqual(calls, [{
    actor: ACTOR,
    command: {
      target_language: "es",
      target_locale: "es-CO",
      preferred_register: "FORMAL",
    },
  }]);
});

test("HTTP language preferences reject malformed payload before persistence", async (t) => {
  const { server, calls } = fixture();
  t.after(() => server.close());
  const base = await listen(server);

  const response = await fetch(
    `${base}/v1/me/language-preferences`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target_language: 123,
        preferred_register: ["FORMAL"],
      }),
    },
  );

  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createHermeneiaHttpServer } from "../apps/api/server.mjs";

function dependencies(ready) {
  const service = {
    async sendMessage() { throw new Error("unused"); },
    async getCommandStatus() {
      return { command_id: "unused", status: "UNKNOWN" };
    },
    async editMessage() { throw new Error("unused"); },
    async deleteMessage() { throw new Error("unused"); },
  };
  return {
    sendService: service,
    commandService: service,
    mutationService: service,
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
    readinessService: {
      async check() {
        return ready;
      },
    },
    authenticate() {
      return null;
    },
  };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("readyz returns 503 without requiring authentication when dependency is unavailable", async (t) => {
  const server = createHermeneiaHttpServer(dependencies(false));
  t.after(() => server.close());
  const base = await listen(server);

  const response = await fetch(`${base}/readyz`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "not_ready",
  });
});

test("healthz remains liveness-only when readiness is down", async (t) => {
  const server = createHermeneiaHttpServer(dependencies(false));
  t.after(() => server.close());
  const base = await listen(server);

  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
  });
});

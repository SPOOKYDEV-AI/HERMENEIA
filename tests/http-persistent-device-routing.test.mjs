import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createHermeneiaHttpServer } from "../apps/api/server.mjs";

const actor = {
  tenantId: "tenant-1",
  userId: "user-a",
  deviceId: "device-current",
};

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function baseDependencies(deviceService) {
  const messaging = {
    async sendMessage() { throw new Error("unused"); },
    async getCommandStatus() {
      return { command_id: "unused", status: "UNKNOWN" };
    },
    async editMessage() { throw new Error("unused"); },
    async deleteMessage() { throw new Error("unused"); },
  };

  return {
    sendService: messaging,
    commandService: messaging,
    mutationService: messaging,
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
    deviceService,
    authenticate() {
      return actor;
    },
  };
}

test("HTTP device enrollment list rotation and revocation route to persistent service", async (t) => {
  const calls = [];
  const active = {
    device_id: "device-new",
    status: "ACTIVE",
    credential_version: 1,
    platform: "ANDROID",
    registered_at: "2026-10-04T16:00:00.000Z",
    revoked_at: null,
    last_seen_at: null,
  };

  const deviceService = {
    async enrollDevice(receivedActor, command) {
      calls.push({ type: "enroll", actor: receivedActor, command });
      return active;
    },
    async listDevices(receivedActor) {
      calls.push({ type: "list", actor: receivedActor });
      return [active];
    },
    async rotateMaterial(receivedActor, command) {
      calls.push({ type: "rotate", actor: receivedActor, command });
      return {
        ...active,
        device_id: command.device_id,
        credential_version: 2,
        last_seen_at: "2026-10-04T16:01:00.000Z",
      };
    },
    async revokeDevice(receivedActor, command) {
      calls.push({ type: "revoke", actor: receivedActor, command });
      return {
        ...active,
        device_id: command.device_id,
        status: "REVOKED",
        revoked_at: "2026-10-04T16:02:00.000Z",
      };
    },
  };

  const server = createHermeneiaHttpServer(
    baseDependencies(deviceService),
  );
  t.after(() => server.close());
  const base = await listen(server);

  const enrolledResponse = await fetch(`${base}/v1/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol_version: 1,
      command_id: "enroll-1",
      device_id: "device-new",
      public_material_ref: "public:new",
      platform: "ANDROID",
    }),
  });
  assert.equal(enrolledResponse.status, 201);
  assert.deepEqual(await enrolledResponse.json(), active);

  const listedResponse = await fetch(`${base}/v1/devices`);
  assert.equal(listedResponse.status, 200);
  assert.deepEqual(await listedResponse.json(), [active]);

  const rotatedResponse = await fetch(
    `${base}/v1/devices/device-current/delivery-material`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol_version: 1,
        command_id: "rotate-1",
        expected_credential_version: 1,
        public_material_ref: "public:v2",
      }),
    },
  );
  assert.equal(rotatedResponse.status, 200);
  assert.equal(
    (await rotatedResponse.json()).credential_version,
    2,
  );

  const revokedResponse = await fetch(
    `${base}/v1/devices/device-new/revoke`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol_version: 1,
        command_id: "revoke-1",
      }),
    },
  );
  assert.equal(revokedResponse.status, 200);
  assert.equal((await revokedResponse.json()).status, "REVOKED");

  assert.deepEqual(calls, [
    {
      type: "enroll",
      actor,
      command: {
        protocol_version: 1,
        command_id: "enroll-1",
        device_id: "device-new",
        public_material_ref: "public:new",
        platform: "ANDROID",
      },
    },
    { type: "list", actor },
    {
      type: "rotate",
      actor,
      command: {
        protocol_version: 1,
        command_id: "rotate-1",
        device_id: "device-current",
        expected_credential_version: 1,
        public_material_ref: "public:v2",
      },
    },
    {
      type: "revoke",
      actor,
      command: {
        protocol_version: 1,
        command_id: "revoke-1",
        device_id: "device-new",
      },
    },
  ]);
});

test("HTTP device enrollment ignores client attempts to own credential version", async (t) => {
  const calls = [];
  const deviceService = {
    async enrollDevice(_actor, command) {
      calls.push(command);
      return {
        device_id: command.device_id,
        status: "ACTIVE",
        credential_version: 1,
        platform: "OTHER",
        registered_at: "2026-10-04T16:00:00.000Z",
        revoked_at: null,
        last_seen_at: null,
      };
    },
    async listDevices() { return []; },
    async rotateMaterial() { throw new Error("unused"); },
    async revokeDevice() { throw new Error("unused"); },
  };

  const server = createHermeneiaHttpServer(
    baseDependencies(deviceService),
  );
  t.after(() => server.close());
  const base = await listen(server);

  const response = await fetch(`${base}/v1/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol_version: 1,
      command_id: "enroll-1",
      device_id: "device-new",
      public_material_ref: "public:new",
      credential_version: 999,
    }),
  });

  assert.equal(response.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(
    Object.hasOwn(calls[0], "credential_version"),
    false,
  );
});

test("device routes fail closed when device trust service is unavailable", async (t) => {
  const server = createHermeneiaHttpServer(
    baseDependencies(null),
  );
  t.after(() => server.close());
  const base = await listen(server);

  const response = await fetch(`${base}/v1/devices`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "DEVICE_SERVICE_UNAVAILABLE");
  assert.equal(body.retryable, true);
});

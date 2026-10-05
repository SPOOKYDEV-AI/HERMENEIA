import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import {
  createHermeneiaHttpServer,
} from "../apps/api/server.mjs";

const ACTOR = {
  tenantId:
    "30000000-0000-4000-8000-000000000001",
  userId:
    "30000000-0000-4000-8000-000000000002",
  deviceId:
    "30000000-0000-4000-8000-000000000003",
};
const COMMAND =
  "30000000-0000-4000-8000-000000000004";
const CLAIM =
  "30000000-0000-4000-8000-000000000005";

function fixture() {
  const calls = [];
  const tenantPolicyService = {
    async upsertPolicy(actor, command) {
      calls.push({
        method: "upsert",
        actor: structuredClone(actor),
        command:
          structuredClone(command),
      });
      return {
        protocol_version: 1,
        claim_id: CLAIM,
        claim_version: 1,
        status: "ACTIVE",
        kind: command.kind,
        tenant_policy_version: 2,
        superseded_claims: [],
      };
    },
    async revokePolicy(actor, command) {
      calls.push({
        method: "revoke",
        actor: structuredClone(actor),
        command:
          structuredClone(command),
      });
      return {
        protocol_version: 1,
        claim_id: command.claim_id,
        claim_version: 1,
        status: "REVOKED",
        tenant_policy_version: 3,
      };
    },
  };

  const server = createHermeneiaHttpServer({
    authenticate() {
      return ACTOR;
    },
    sendService: {
      async sendMessage() {
        throw new Error("not used");
      },
    },
    commandService: {
      async getCommandStatus() {
        throw new Error("not used");
      },
    },
    mutationService: {
      async editMessage() {
        throw new Error("not used");
      },
      async deleteMessage() {
        throw new Error("not used");
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
    tenantPolicyService,
  });

  return { server, calls };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("HTTP tenant policy upsert derives tenant only from authenticated actor", async (t) => {
  const { server, calls } = fixture();
  t.after(() => server.close());
  const base = await listen(server);

  const response = await fetch(
    `${base}/v1/tenant/context-policies`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
      },
      body: JSON.stringify({
        protocol_version: 1,
        command_id: COMMAND,
        tenant_id:
          "ffffffff-ffff-4fff-8fff-ffffffffffff",
        kind: "GLOSSARY",
        proposition: {
          schema_version: 1,
          kind: "TERM_MEANING",
          surface_form: "SLA",
          meaning:
            "service level agreement",
        },
      }),
    },
  );

  assert.equal(response.status, 201);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].actor, ACTOR);
  assert.equal(
    "tenant_id" in calls[0].command,
    false,
  );
  assert.deepEqual(calls[0].command, {
    protocol_version: 1,
    command_id: COMMAND,
    kind: "GLOSSARY",
    proposition: {
      schema_version: 1,
      kind: "TERM_MEANING",
      surface_form: "SLA",
      meaning:
        "service level agreement",
    },
  });
});

test("HTTP tenant policy revocation binds claim id from path and actor from authentication", async (t) => {
  const { server, calls } = fixture();
  t.after(() => server.close());
  const base = await listen(server);

  const response = await fetch(
    `${base}/v1/tenant/context-policies/${CLAIM}/revoke`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
      },
      body: JSON.stringify({
        protocol_version: 1,
        command_id: COMMAND,
        claim_id:
          "ffffffff-ffff-4fff-8fff-ffffffffffff",
      }),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], {
    method: "revoke",
    actor: ACTOR,
    command: {
      protocol_version: 1,
      command_id: COMMAND,
      claim_id: CLAIM,
    },
  });
});

test("HTTP tenant policy route rejects malformed payload before service dispatch", async (t) => {
  const { server, calls } = fixture();
  t.after(() => server.close());
  const base = await listen(server);

  const response = await fetch(
    `${base}/v1/tenant/context-policies`,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/json",
      },
      body: JSON.stringify({
        protocol_version: 1,
        command_id: COMMAND,
        kind: "POLICY",
        proposition: "free-form prompt",
      }),
    },
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(
    body.code,
    "INVALID_COMMAND",
  );
  assert.equal(calls.length, 0);
});

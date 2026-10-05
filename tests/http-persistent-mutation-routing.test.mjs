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

function coreThatMustNotMutate() {
  return {
    sendMessage() { throw new Error("unused"); },
    getCommandStatus() {
      return { command_id: "unused", status: "UNKNOWN" };
    },
    editMessage() {
      throw new Error("persistent edit must bypass in-memory core");
    },
    deleteMessage() {
      throw new Error("persistent delete must bypass in-memory core");
    },
    getDeviceSyncPosition() {
      return { inboxEpoch: 1, nextOffset: 1 };
    },
    syncDevice() { return []; },
    acknowledgeEnvelope() {},
    getEnvelopeForDevice() { return undefined; },
  };
}

test("HTTP edit is routed to the injected persistent mutation service", async (t) => {
  const calls = [];
  const mutationService = {
    async editMessage(receivedActor, command) {
      calls.push({ type: "edit", actor: receivedActor, command });
      return {
        message_id: command.message_id,
        revision: 2,
        op_seq: 7,
        status: "ACTIVE",
      };
    },
    async deleteMessage() {
      throw new Error("unused");
    },
  };

  const server = createHermeneiaHttpServer({
    core: coreThatMustNotMutate(),
    mutationService,
    authenticate() {
      return actor;
    },
  });
  t.after(() => server.close());

  const base = await listen(server);
  const response = await fetch(`${base}/v1/messages/message-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol_version: 1,
      command_id: "edit-1",
      expected_revision: 1,
      source: {
        text: "edited source",
        language_hint: "en-US",
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message_id: "message-1",
    revision: 2,
    op_seq: 7,
    status: "ACTIVE",
  });
  assert.deepEqual(calls, [{
    type: "edit",
    actor,
    command: {
      protocol_version: 1,
      command_id: "edit-1",
      message_id: "message-1",
      expected_revision: 1,
      source: {
        text: "edited source",
        language_hint: "en-US",
      },
    },
  }]);
});

test("HTTP delete is routed to the injected persistent mutation service", async (t) => {
  const calls = [];
  const mutationService = {
    async editMessage() {
      throw new Error("unused");
    },
    async deleteMessage(receivedActor, command) {
      calls.push({ type: "delete", actor: receivedActor, command });
      return {
        message_id: command.message_id,
        revision: 3,
        op_seq: 8,
        status: "DELETED",
      };
    },
  };

  const server = createHermeneiaHttpServer({
    core: coreThatMustNotMutate(),
    mutationService,
    authenticate() {
      return actor;
    },
  });
  t.after(() => server.close());

  const base = await listen(server);
  const response = await fetch(`${base}/v1/messages/message-1`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol_version: 1,
      command_id: "delete-1",
      expected_revision: 2,
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message_id: "message-1",
    revision: 3,
    op_seq: 8,
    status: "DELETED",
  });
  assert.deepEqual(calls, [{
    type: "delete",
    actor,
    command: {
      protocol_version: 1,
      command_id: "delete-1",
      message_id: "message-1",
      expected_revision: 2,
    },
  }]);
});


test("HTTP correction is routed to the injected persistent correction service", async (t) => {
  const calls = [];
  const correctionService = {
    async createCorrection(receivedActor, command) {
      calls.push({
        actor: receivedActor,
        command,
      });
      return {
        protocol_version: 1,
        repair_event_id: "repair-1",
        status: "APPLIED",
        requested_scope: "CONVERSATION",
        applied_scope: "CONVERSATION",
        claim_id: "claim-1",
        claim_version: 1,
      };
    },
  };

  const server = createHermeneiaHttpServer({
    core: coreThatMustNotMutate(),
    correctionService,
    authenticate() {
      return actor;
    },
  });
  t.after(() => server.close());

  const base = await listen(server);
  const response = await fetch(
    `${base}/v1/conversations/conversation-1/corrections`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol_version: 1,
        command_id: "correction-1",
        target_message_id: "message-1",
        target_source_revision: 1,
        target_translation_id: "translation-1",
        kind: "TERMINOLOGY",
        requested_scope: "CONVERSATION",
        payload: {
          schema_version: 1,
          kind: "TERM_MEANING",
          surface_form: "CR",
          meaning: "change request",
        },
      }),
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    protocol_version: 1,
    repair_event_id: "repair-1",
    status: "APPLIED",
    requested_scope: "CONVERSATION",
    applied_scope: "CONVERSATION",
    claim_id: "claim-1",
    claim_version: 1,
  });
  assert.deepEqual(calls, [{
    actor,
    command: {
      protocol_version: 1,
      command_id: "correction-1",
      conversation_id: "conversation-1",
      target_message_id: "message-1",
      target_source_revision: 1,
      target_translation_id: "translation-1",
      kind: "TERMINOLOGY",
      requested_scope: "CONVERSATION",
      payload: {
        schema_version: 1,
        kind: "TERM_MEANING",
        surface_form: "CR",
        meaning: "change request",
      },
    },
  }]);
});


test("HTTP translation feedback is routed to the injected persistent feedback service", async (t) => {
  const calls = [];
  const translationFeedbackService = {
    async createFeedback(
      receivedActor,
      command,
    ) {
      calls.push({
        actor: receivedActor,
        command,
      });
      return {
        protocol_version: 1,
        repair_event_id: "repair-feedback-1",
        status: "NEEDS_CONFIRMATION",
      };
    },
  };

  const server = createHermeneiaHttpServer({
    core: coreThatMustNotMutate(),
    translationFeedbackService,
    authenticate() {
      return actor;
    },
  });
  t.after(() => server.close());

  const base = await listen(server);
  const response = await fetch(
    `${base}/v1/translations/translation-1/feedback`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol_version: 1,
        command_id: "feedback-command-1",
        kind: "WRONG_MEANING",
        note: "CR was mistranslated",
      }),
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    protocol_version: 1,
    repair_event_id: "repair-feedback-1",
    status: "NEEDS_CONFIRMATION",
  });
  assert.deepEqual(calls, [{
    actor,
    command: {
      protocol_version: 1,
      command_id: "feedback-command-1",
      translation_id: "translation-1",
      kind: "WRONG_MEANING",
      note: "CR was mistranslated",
    },
  }]);
});


test("HTTP correction revocation is routed to the persistent correction service", async (t) => {
  const calls = [];
  const correctionService = {
    async createCorrection() {
      throw new Error("unused");
    },
    async revokeCorrection(
      receivedActor,
      command,
    ) {
      calls.push({
        actor: receivedActor,
        command,
      });
      return {
        protocol_version: 1,
        repair_event_id:
          "repair-revoke-1",
        claim_id: "claim-1",
        claim_version: 2,
        status: "REVOKED",
      };
    },
  };

  const server = createHermeneiaHttpServer({
    core: coreThatMustNotMutate(),
    correctionService,
    authenticate() {
      return actor;
    },
  });
  t.after(() => server.close());

  const base = await listen(server);
  const response = await fetch(
    `${base}/v1/conversations/conversation-1/corrections/claim-1/revoke`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol_version: 1,
        command_id: "revoke-command-1",
      }),
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    protocol_version: 1,
    repair_event_id: "repair-revoke-1",
    claim_id: "claim-1",
    claim_version: 2,
    status: "REVOKED",
  });
  assert.deepEqual(calls, [{
    actor,
    command: {
      protocol_version: 1,
      command_id: "revoke-command-1",
      conversation_id: "conversation-1",
      claim_id: "claim-1",
    },
  }]);
});


test("HTTP pending repair review is routed to the persistent correction service", async (t) => {
  const calls = [];
  const correctionService = {
    async createCorrection() {
      throw new Error("unused");
    },
    async reviewCorrection(
      receivedActor,
      command,
    ) {
      calls.push({
        actor: receivedActor,
        command,
      });
      return {
        protocol_version: 1,
        repair_event_id: "repair-pending-1",
        review_event_id: "repair-review-1",
        status: "APPLIED",
        claim_id: "claim-reviewed-1",
        claim_version: 1,
      };
    },
  };

  const server = createHermeneiaHttpServer({
    core: coreThatMustNotMutate(),
    correctionService,
    authenticate() {
      return actor;
    },
  });
  t.after(() => server.close());

  const base = await listen(server);
  const response = await fetch(
    `${base}/v1/conversations/conversation-1/repairs/repair-pending-1/review`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol_version: 1,
        command_id: "review-command-1",
        decision: "APPROVE",
      }),
    },
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    protocol_version: 1,
    repair_event_id: "repair-pending-1",
    review_event_id: "repair-review-1",
    status: "APPLIED",
    claim_id: "claim-reviewed-1",
    claim_version: 1,
  });
  assert.deepEqual(calls, [{
    actor,
    command: {
      protocol_version: 1,
      command_id: "review-command-1",
      conversation_id: "conversation-1",
      repair_event_id: "repair-pending-1",
      decision: "APPROVE",
    },
  }]);
});

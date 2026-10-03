import test from "node:test";
import assert from "node:assert/strict";

import {
  DomainError,
} from "../.build/packages/domain/src/index.js";
import {
  InMemoryMessagingCore,
} from "../.build/packages/core/src/index.js";

function createCore({ secondRecipientDevice = false } = {}) {
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
        return "2026-10-03T19:20:00.000Z";
      },
    },
    fingerprinter: {
      fingerprint(source) {
        return `${source.language_hint ?? ""}\u0000${source.text}`;
      },
    },
    envelopeProtector: {
      protect({ recipientDeviceId, source }) {
        // TEST FAKE ONLY. Production envelope protection is deliberately not
        // implemented in this executable skeleton.
        return `TEST_ONLY:${recipientDeviceId}:${source.text}`;
      },
    },
    translationDispatcher: {
      notify() {
        throw new Error("AI/provider subsystem is down");
      },
    },
  });

  core.registerDevice("user-a", "device-a");
  core.registerDevice("user-b", "device-b1");
  if (secondRecipientDevice) {
    core.registerDevice("user-b", "device-b2");
  }
  core.registerConversation("tenant-1", "conversation-1", ["user-a", "user-b"]);

  return core;
}

function command(text = "Bonjour depuis HERMENEIA") {
  return {
    protocol_version: 1,
    command_id: "cmd-1",
    client_message_id: "client-msg-1",
    conversation_id: "conversation-1",
    source: {
      text,
      language_hint: "fr-FR",
    },
  };
}

const actor = {
  tenantId: "tenant-1",
  userId: "user-a",
  deviceId: "device-a",
};

test("lost response after commit + retry produces exactly one logical message while AI is down", async () => {
  const core = createCore();

  const first = await core.sendMessage(actor, command());

  // Simulate the client losing the HTTP response: it retries with exactly the
  // same logical idempotency key.
  const retry = await core.sendMessage(actor, command());

  assert.equal(first.status, "ACCEPTED");
  assert.equal(first.translation_status, "PENDING");
  assert.deepEqual(retry, first);
  assert.equal(core.getMessageCount(), 1);

  // Translation dispatcher failed, but the durable work item remains.
  assert.equal(core.getTranslationJobs().length, 1);

  const events = core.syncDevice("device-b1", 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "message.available");

  const pending = core.pendingEnvelopes("device-b1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].messageId, first.message_id);

  // Device persists locally first, then ACKs.
  core.acknowledgeEnvelope("device-b1", pending[0].envelopeId);
  assert.equal(core.pendingEnvelopes("device-b1").length, 0);
});

test("same client_message_id with different source is rejected", async () => {
  const core = createCore();
  await core.sendMessage(actor, command("première version"));

  await assert.rejects(
    () => core.sendMessage(actor, command("contenu différent")),
    (error) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );

  assert.equal(core.getMessageCount(), 1);
});

test("delivery ACK is isolated per recipient device", async () => {
  const core = createCore({ secondRecipientDevice: true });
  await core.sendMessage(actor, command());

  const firstDeviceEnvelope = core.pendingEnvelopes("device-b1")[0];
  assert.ok(firstDeviceEnvelope);
  assert.equal(core.pendingEnvelopes("device-b2").length, 1);

  core.acknowledgeEnvelope("device-b1", firstDeviceEnvelope.envelopeId);

  assert.equal(core.pendingEnvelopes("device-b1").length, 0);
  assert.equal(core.pendingEnvelopes("device-b2").length, 1);
});

test("revoked actor device cannot send", async () => {
  const core = createCore();
  core.revokeDevice("device-a");

  await assert.rejects(
    () => core.sendMessage(actor, command()),
    (error) => error instanceof DomainError && error.code === "DEVICE_REVOKED",
  );
});

test("non-member cannot send to conversation", async () => {
  const core = createCore();
  core.registerDevice("user-c", "device-c");

  await assert.rejects(
    () =>
      core.sendMessage(
        { tenantId: "tenant-1", userId: "user-c", deviceId: "device-c" },
        command(),
      ),
    (error) => error instanceof DomainError && error.code === "NOT_AUTHORIZED",
  );
});

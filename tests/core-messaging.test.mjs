import test from "node:test";
import assert from "node:assert/strict";

import {
  DomainError,
} from "../.build/packages/domain/src/index.js";
import {
  InMemoryMessagingCore,
} from "../.build/packages/core/src/index.js";

function createCore({
  secondRecipientDevice = false,
  recipientDevice = true,
  senderSecondDevice = false,
} = {}) {
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
  if (senderSecondDevice) {
    core.registerDevice("user-a", "device-a2");
  }
  if (recipientDevice) {
    core.registerDevice("user-b", "device-b1");
  }
  if (recipientDevice && secondRecipientDevice) {
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


test("edit creates a new revision without advancing logical message identity", async () => {
  const core = createCore();
  const accepted = await core.sendMessage(actor, command("version 1"));

  const result = await core.editMessage(actor, {
    protocol_version: 1,
    command_id: "cmd-edit-1",
    message_id: accepted.message_id,
    expected_revision: 1,
    source: {
      text: "version 2",
      language_hint: "fr-FR",
    },
  });

  assert.equal(result.message_id, accepted.message_id);
  assert.equal(result.revision, 2);
  assert.equal(result.op_seq, 2);
  assert.equal(result.status, "ACTIVE");

  const metadata = core.getMessageMetadata(accepted.message_id);
  assert.equal(metadata.messageSeq, 1);
  assert.equal(metadata.currentRevision, 2);

  const jobs = core.getTranslationJobs();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].status, "SUPERSEDED");
  assert.equal(jobs[1].status, "AVAILABLE");
  assert.equal(jobs[1].sourceRevision, 2);
});

test("retrying the same edit command is idempotent", async () => {
  const core = createCore();
  const accepted = await core.sendMessage(actor, command("version 1"));

  const edit = {
    protocol_version: 1,
    command_id: "cmd-edit-retry",
    message_id: accepted.message_id,
    expected_revision: 1,
    source: {
      text: "version 2",
      language_hint: "fr-FR",
    },
  };

  const first = await core.editMessage(actor, edit);
  const retry = await core.editMessage(actor, edit);

  assert.deepEqual(retry, first);
  assert.equal(core.getMessageMetadata(accepted.message_id).currentRevision, 2);
  assert.equal(core.getTranslationJobs().length, 2);
});

test("stale edit revision is rejected", async () => {
  const core = createCore();
  const accepted = await core.sendMessage(actor, command("version 1"));

  await core.editMessage(actor, {
    protocol_version: 1,
    command_id: "cmd-edit-good",
    message_id: accepted.message_id,
    expected_revision: 1,
    source: { text: "version 2" },
  });

  await assert.rejects(
    () =>
      core.editMessage(actor, {
        protocol_version: 1,
        command_id: "cmd-edit-stale",
        message_id: accepted.message_id,
        expected_revision: 1,
        source: { text: "stale overwrite" },
      }),
    (error) => error instanceof DomainError && error.code === "REVISION_CONFLICT",
  );
});

test("delete tombstones message and supersedes outstanding translation work", async () => {
  const core = createCore();
  const accepted = await core.sendMessage(actor, command("delete me"));

  const result = await core.deleteMessage(actor, {
    protocol_version: 1,
    command_id: "cmd-delete-1",
    message_id: accepted.message_id,
    expected_revision: 1,
  });

  assert.equal(result.revision, 2);
  assert.equal(result.status, "DELETED");

  const metadata = core.getMessageMetadata(accepted.message_id);
  assert.equal(metadata.status, "DELETED");
  assert.equal(metadata.currentRevision, 2);
  assert.equal(core.getTranslationJobs()[0].status, "SUPERSEDED");

  const events = core.syncDevice("device-b1", 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "message.deleted");
  assert.equal(events[0].sourceRevision, 2);
  assert.equal(events[0].envelopeId, undefined);
});

test("command status returns durable logical result to the originating device", async () => {
  const core = createCore();
  const accepted = await core.sendMessage(actor, command("recover me"));

  const status = core.getCommandStatus(actor, "cmd-1");
  assert.equal(status.status, "SUCCEEDED");
  assert.equal(status.result.message_id, accepted.message_id);

  const unknown = core.getCommandStatus(actor, "unknown-command");
  assert.equal(unknown.status, "UNKNOWN");
});


test("Send is not ACCEPTED when an external recipient has no deliverable device", async () => {
  const core = createCore({ recipientDevice: false });

  await assert.rejects(
    () => core.sendMessage(actor, command("cannot promise delivery")),
    (error) =>
      error instanceof DomainError &&
      error.code === "RECIPIENT_UNAVAILABLE",
  );

  assert.equal(core.getMessageCount(), 0);
});

test("sender secondary device still receives a delivery envelope", async () => {
  const core = createCore({ senderSecondDevice: true });
  await core.sendMessage(actor, command("sync my second device"));

  assert.equal(core.pendingEnvelopes("device-a2").length, 1);
  assert.equal(core.pendingEnvelopes("device-b1").length, 1);
});


test("failed edit delivery preparation leaves prior revision and pending delivery intact", async () => {
  const core = createCore();
  const accepted = await core.sendMessage(
    actor,
    command("original remains valid"),
  );

  const oldEnvelope = core.pendingEnvelopes("device-b1")[0];
  assert.ok(oldEnvelope);

  core.revokeDevice("device-b1");

  await assert.rejects(
    () =>
      core.editMessage(actor, {
        protocol_version: 1,
        command_id: "cmd-edit-unavailable",
        message_id: accepted.message_id,
        expected_revision: 1,
        source: { text: "edit cannot be delivered" },
      }),
    (error) =>
      error instanceof DomainError &&
      error.code === "RECIPIENT_UNAVAILABLE",
  );

  assert.equal(
    core.getMessageMetadata(accepted.message_id).currentRevision,
    1,
  );
  assert.equal(core.getTranslationJobs().length, 1);
  assert.equal(core.getTranslationJobs()[0].status, "AVAILABLE");
  assert.equal(core.pendingEnvelopes("device-b1").length, 1);
  assert.equal(
    core.pendingEnvelopes("device-b1")[0].envelopeId,
    oldEnvelope.envelopeId,
  );
});

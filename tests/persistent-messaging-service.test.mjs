import test from "node:test";
import assert from "node:assert/strict";

import { DomainError } from "../.build/packages/domain/src/index.js";
import {
  PersistentMessagingService,
} from "../.build/packages/messaging-service/src/index.js";
import {
  InMemoryTransientSourceStore,
} from "../.build/packages/transient-source/src/index.js";

function clone(value) {
  return structuredClone(value);
}

class TransactionalFakeStore {
  constructor() {
    this.state = {
      nextMessageSeq: 1,
      nextOpSeq: 1,
      messages: [],
      revisions: [],
      envelopes: [],
      events: [],
      jobs: [],
      receipts: new Map(),
      existingByClientId: new Map(),
      inboxOffsets: new Map(),
    };
    this.targets = [
      {
        userId: "user-a",
        devices: [
          {
            userId: "user-a",
            deviceId: "device-a2",
            credentialVersion: 1,
            publicMaterialRef: "pub:a2",
          },
        ],
      },
      {
        userId: "user-b",
        devices: [
          {
            userId: "user-b",
            deviceId: "device-b",
            credentialVersion: 1,
            publicMaterialRef: "pub:b",
          },
        ],
      },
    ];
    this.authorized = true;
    this.replyExists = true;
    this.calls = [];
  }

  async withTransaction(work) {
    const snapshot = cloneState(this.state);
    try {
      return await work({ id: "tx" });
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  async findCommandReceipt(_tx, actor, commandId) {
    this.calls.push(["findCommandReceipt", commandId]);
    return clone(this.state.receipts.get(`${actor.tenantId}:${commandId}`));
  }

  async findAcceptedMessageByClientId(_tx, actor, clientMessageId) {
    this.calls.push(["findAcceptedMessageByClientId", clientMessageId]);
    return clone(
      this.state.existingByClientId.get(
        `${actor.tenantId}:${actor.userId}:${clientMessageId}`,
      ),
    );
  }

  async allocateMessageAndOperationSequence(_tx, actor, conversationId) {
    this.calls.push(["allocate", conversationId, actor.deviceId]);
    if (!this.authorized) return undefined;
    const result = {
      messageSeq: this.state.nextMessageSeq,
      opSeq: this.state.nextOpSeq,
      membershipEpoch: 4,
      erasureEpoch: 2,
      policyVersion: 7,
    };
    this.state.nextMessageSeq += 1;
    this.state.nextOpSeq += 1;
    return result;
  }

  async listRecipientDeliveryTargets() {
    this.calls.push(["targets"]);
    return clone(this.targets);
  }

  async replyTargetExists() {
    this.calls.push(["replyTargetExists"]);
    return this.replyExists;
  }

  async insertMessageMetadata(_tx, input) {
    this.state.messages.push(clone(input));
  }

  async insertMessageRevision(_tx, input) {
    this.state.revisions.push(clone(input));
  }

  async insertDeliveryEnvelope(_tx, input) {
    this.state.envelopes.push(clone(input));
  }

  async allocateDeviceInboxOffset(_tx, deviceId) {
    const next = this.state.inboxOffsets.get(deviceId) ?? 1;
    this.state.inboxOffsets.set(deviceId, next + 1);
    return { inboxEpoch: 1, offset: next };
  }

  async insertInboxEvent(_tx, input) {
    this.state.events.push(clone(input));
  }

  async insertOutboxJob(_tx, input) {
    this.state.jobs.push(clone(input));
  }

  async insertCommandReceipt(_tx, input) {
    const receipt = {
      commandType: input.commandType,
      commandFingerprint: input.commandFingerprint,
      status: "SUCCEEDED",
      result: clone(input.result),
    };
    this.state.receipts.set(
      `${input.tenantId}:${input.commandId}`,
      receipt,
    );
  }
}

function cloneState(state) {
  return {
    nextMessageSeq: state.nextMessageSeq,
    nextOpSeq: state.nextOpSeq,
    messages: clone(state.messages),
    revisions: clone(state.revisions),
    envelopes: clone(state.envelopes),
    events: clone(state.events),
    jobs: clone(state.jobs),
    receipts: new Map(
      [...state.receipts.entries()].map(([key, value]) => [
        key,
        clone(value),
      ]),
    ),
    existingByClientId: new Map(
      [...state.existingByClientId.entries()].map(([key, value]) => [
        key,
        clone(value),
      ]),
    ),
    inboxOffsets: new Map(state.inboxOffsets),
  };
}

function ids() {
  let n = 0;
  return {
    next(prefix) {
      n += 1;
      return `${prefix}-${n}`;
    },
  };
}

const actor = {
  tenantId: "tenant-1",
  userId: "user-a",
  deviceId: "device-a",
};

function sendCommand({
  text = "bonjour",
  commandId = "cmd-1",
  clientMessageId = "client-1",
  replyTo = null,
} = {}) {
  return {
    protocol_version: 1,
    command_id: commandId,
    client_message_id: clientMessageId,
    conversation_id: "conversation-1",
    source: {
      text,
      language_hint: "fr-FR",
    },
    reply_to_message_id: replyTo,
  };
}

function createService(store, overrides = {}) {
  const transient =
    overrides.transientSources ??
    new InMemoryTransientSourceStore({
      clock: {
        now() {
          return "2026-10-03T23:00:00.000Z";
        },
      },
      maxEntries: 100,
      maxApproxBytes: 1024 * 1024,
    });

  return {
    transient,
    service: new PersistentMessagingService({
      store,
      ids: ids(),
      clock: {
        now() {
          return "2026-10-03T23:00:00.000Z";
        },
      },
      fingerprinter: {
        fingerprint(source) {
          // TEST fake representing an opaque keyed fingerprint.
          return `FP:${source.language_hint ?? ""}:${source.text}`;
        },
      },
      envelopeProtector: overrides.envelopeProtector ?? {
        protect({ recipientDeviceId, source }) {
          return Buffer.from(
            `TEST_ONLY:${recipientDeviceId}:${source.text}`,
            "utf8",
          ).toString("base64");
        },
      },
      transientSources: transient,
      envelopeTtlSeconds: 3600,
      transientSourceTtlSeconds: 300,
    }),
  };
}

test("persistent Send commits one logical message, sender secondary device, recipient delivery and plaintext-free outbox", async () => {
  const store = new TransactionalFakeStore();
  const { service, transient } = createService(store);

  const accepted = await service.sendMessage(actor, sendCommand());

  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.message_seq, 1);
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.revisions.length, 1);
  assert.equal(store.state.envelopes.length, 2);
  assert.deepEqual(
    store.state.envelopes.map((item) => item.recipientDeviceId).sort(),
    ["device-a2", "device-b"],
  );
  assert.equal(store.state.events.length, 2);
  assert.equal(store.state.jobs.length, 1);
  assert.equal(store.state.jobs[0].payloadRef.source_buffered, true);

  const serializedJob = JSON.stringify(store.state.jobs[0]);
  assert.equal(serializedJob.includes("bonjour"), false);

  const buffered = transient.get({
    tenantId: "tenant-1",
    messageId: accepted.message_id,
    sourceRevision: 1,
  });
  assert.equal(buffered.source.text, "bonjour");
});

test("transient source cache failure never blocks durable messaging acceptance", async () => {
  const store = new TransactionalFakeStore();
  const transientSources = {
    put() {
      throw new Error("transient cache down");
    },
    get() {
      return undefined;
    },
    remove() {},
  };
  const { service } = createService(store, { transientSources });

  const accepted = await service.sendMessage(
    actor,
    sendCommand({ text: "still deliver me" }),
  );

  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.envelopes.length, 2);
  assert.equal(store.state.jobs[0].payloadRef.source_buffered, false);
});

test("recipient without an active deliverable device rolls back the whole transaction", async () => {
  const store = new TransactionalFakeStore();
  store.targets = [
    {
      userId: "user-a",
      devices: [],
    },
    {
      userId: "user-b",
      devices: [],
    },
  ];
  const { service } = createService(store);

  await assert.rejects(
    () => service.sendMessage(actor, sendCommand()),
    (error) =>
      error instanceof DomainError &&
      error.code === "RECIPIENT_UNAVAILABLE",
  );

  assert.equal(store.state.nextMessageSeq, 1);
  assert.equal(store.state.nextOpSeq, 1);
  assert.equal(store.state.messages.length, 0);
  assert.equal(store.state.envelopes.length, 0);
  assert.equal(store.state.jobs.length, 0);
});

test("envelope protection failure rolls back DB effects and removes transient plaintext", async () => {
  const store = new TransactionalFakeStore();
  const { service, transient } = createService(store, {
    envelopeProtector: {
      protect() {
        throw new Error("protector failure");
      },
    },
  });

  await assert.rejects(
    () => service.sendMessage(actor, sendCommand()),
    /protector failure/,
  );

  assert.equal(store.state.nextMessageSeq, 1);
  assert.equal(store.state.messages.length, 0);
  assert.equal(store.state.envelopes.length, 0);
  assert.equal(transient.size, 0);
});

test("same command retry returns stored ACCEPTED result without duplicating writes", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);

  const first = await service.sendMessage(actor, sendCommand());
  const retry = await service.sendMessage(actor, sendCommand());

  assert.deepEqual(retry, first);
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.envelopes.length, 2);
  assert.equal(store.state.jobs.length, 1);
});

test("same command_id with different source is rejected", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);

  await service.sendMessage(actor, sendCommand({ text: "v1" }));

  await assert.rejects(
    () =>
      service.sendMessage(
        actor,
        sendCommand({
          text: "different",
          commandId: "cmd-1",
          clientMessageId: "client-2",
        }),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "IDEMPOTENCY_CONFLICT",
  );

  assert.equal(store.state.messages.length, 1);
});

test("client_message_id dedupe compares the original revision fingerprint even after later edits", async () => {
  const store = new TransactionalFakeStore();
  store.state.existingByClientId.set(
    "tenant-1:user-a:client-original",
    {
      messageId: "existing-message",
      messageSeq: 5,
      currentRevision: 3,
      acceptedAt: "2026-10-03T22:00:00.000Z",
      originalSourceHash: "FP:fr-FR:original",
    },
  );
  const { service } = createService(store);

  const accepted = await service.sendMessage(
    actor,
    sendCommand({
      text: "original",
      commandId: "new-command-after-timeout",
      clientMessageId: "client-original",
    }),
  );

  assert.equal(accepted.message_id, "existing-message");
  assert.equal(accepted.message_seq, 5);
  assert.equal(accepted.source_revision, 1);
  assert.equal(store.state.messages.length, 0);
  assert.equal(store.state.receipts.size, 1);
});

test("invalid reply target aborts before any durable message write", async () => {
  const store = new TransactionalFakeStore();
  store.replyExists = false;
  const { service } = createService(store);

  await assert.rejects(
    () =>
      service.sendMessage(
        actor,
        sendCommand({ replyTo: "missing-message" }),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "INVALID_COMMAND",
  );

  assert.equal(store.state.nextMessageSeq, 1);
  assert.equal(store.state.messages.length, 0);
});

test("bounded transient source store expires data and refuses capacity overflow without eviction", () => {
  let now = "2026-10-03T23:00:00.000Z";
  const store = new InMemoryTransientSourceStore({
    clock: {
      now() {
        return now;
      },
    },
    maxEntries: 1,
    maxApproxBytes: 1024,
  });

  assert.equal(
    store.put({
      tenantId: "tenant-1",
      messageId: "message-1",
      sourceRevision: 1,
      source: { text: "first" },
      createdAt: now,
      expiresAt: "2026-10-03T23:01:00.000Z",
    }),
    true,
  );

  assert.equal(
    store.put({
      tenantId: "tenant-1",
      messageId: "message-2",
      sourceRevision: 1,
      source: { text: "second" },
      createdAt: now,
      expiresAt: "2026-10-03T23:01:00.000Z",
    }),
    false,
  );
  assert.equal(store.size, 1);

  now = "2026-10-03T23:01:00.000Z";
  assert.equal(store.size, 0);
  assert.equal(
    store.get({
      tenantId: "tenant-1",
      messageId: "message-1",
      sourceRevision: 1,
    }),
    undefined,
  );
});

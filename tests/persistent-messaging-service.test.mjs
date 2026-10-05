import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { DomainError } from "../.build/packages/domain/src/index.js";
import {
  PersistentMessagingService,
} from "../.build/packages/messaging-service/src/index.js";
import {
  InMemoryTransientSourceStore,
} from "../.build/packages/transient-source/src/index.js";
import {
  createHmacSourceFingerprinter,
} from "../apps/api/source-fingerprint.mjs";

function clone(value) {
  return structuredClone(value);
}

function cloneState(state) {
  return {
    nextMessageSeq: state.nextMessageSeq,
    nextOpSeq: state.nextOpSeq,
    erasureEpoch: state.erasureEpoch,
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
    locks: clone(state.locks),
  };
}

class TransactionalFakeStore {
  constructor({
    authorized = true,
    targets,
    failAt = null,
    failCommit = false,
  } = {}) {
    this.authorized = authorized;
    this.failAt = failAt;
    this.failCommit = failCommit;
    this.translationSupersedeCalls = [];
    this.targets = targets ?? [
      {
        userId: "user-a",
        devices: [
          {
            userId: "user-a",
            deviceId: "device-a2",
            credentialVersion: 2,
            publicMaterialRef: "pub:a2",
          },
        ],
      },
      {
        userId: "user-b",
        devices: [
          {
            userId: "user-b",
            deviceId: "device-b1",
            credentialVersion: 3,
            publicMaterialRef: "pub:b1",
          },
          {
            userId: "user-b",
            deviceId: "device-b2",
            credentialVersion: 4,
            publicMaterialRef: "pub:b2",
          },
        ],
      },
    ];
    this.replyTargets = new Set(["reply-ok"]);
    this.eventDevices = null;
    this.state = {
      nextMessageSeq: 1,
      nextOpSeq: 1,
      erasureEpoch: 2,
      messages: [],
      revisions: [],
      envelopes: [],
      events: [],
      jobs: [],
      receipts: new Map(),
      existingByClientId: new Map(),
      inboxOffsets: new Map(),
      locks: [],
    };
  }

  maybeFail(name) {
    if (this.failAt === name) {
      throw new Error(`forced store failure at ${name}`);
    }
  }

  async withTransaction(work) {
    const snapshot = cloneState(this.state);
    try {
      const result = await work({ id: "tx" });
      if (this.failCommit) {
        this.state = snapshot;
        throw new Error("forced commit failure");
      }
      return result;
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  async findCommandReceipt(_tx, receivedActor, commandId) {
    this.maybeFail("findCommandReceipt");
    const receipt = this.state.receipts.get(
      `${receivedActor.tenantId}:${commandId}`,
    );
    if (
      !receipt ||
      receipt.actorUserId !== receivedActor.userId ||
      receipt.actorDeviceId !== receivedActor.deviceId
    ) {
      return undefined;
    }
    return clone(receipt);
  }

  async claimCommand(_tx, input) {
    this.maybeFail("claimCommand");
    const key = `${input.actor.tenantId}:${input.commandId}`;
    const existing = this.state.receipts.get(key);
    if (existing) {
      return { claimed: false, existing: clone(existing) };
    }

    this.state.receipts.set(key, {
      actorUserId: input.actor.userId,
      actorDeviceId: input.actor.deviceId,
      commandType: input.commandType,
      commandFingerprint: input.commandFingerprint,
      status: "IN_PROGRESS",
      result: {},
    });
    return { claimed: true };
  }

  async lockClientMessageKey(_tx, actor, clientMessageId) {
    this.maybeFail("lockClientMessageKey");
    this.state.locks.push(
      `${actor.tenantId}:${actor.userId}:${clientMessageId}`,
    );
  }

  async findAcceptedMessageByClientId(_tx, actor, clientMessageId) {
    this.maybeFail("findAcceptedMessageByClientId");
    return clone(
      this.state.existingByClientId.get(
        `${actor.tenantId}:${actor.userId}:${clientMessageId}`,
      ),
    );
  }

  async allocateMessageAndOperationSequence() {
    this.maybeFail("allocateMessageAndOperationSequence");
    if (!this.authorized) return undefined;

    const result = {
      messageSeq: this.state.nextMessageSeq,
      opSeq: this.state.nextOpSeq,
      membershipEpoch: 7,
      erasureEpoch: this.state.erasureEpoch,
      policyVersion: 11,
    };
    this.state.nextMessageSeq += 1;
    this.state.nextOpSeq += 1;
    return result;
  }

  async listRecipientDeliveryTargets() {
    this.maybeFail("listRecipientDeliveryTargets");
    return clone(this.targets);
  }

  async listMessageEditDeliveryTargets(_tx, _receivedActor, messageId) {
    this.maybeFail("listMessageEditDeliveryTargets");

    const exposedDeviceIds = new Set(
      this.state.events
        .filter(
          (event) =>
            event.messageId === messageId &&
            (
              event.eventType === "message.available" ||
              event.eventType === "message.edited"
            ),
        )
        .map((event) => event.deviceId),
    );

    const grouped = new Map();
    for (const target of this.targets) {
      for (const device of target.devices) {
        if (!exposedDeviceIds.has(device.deviceId)) continue;
        const current = grouped.get(target.userId) ?? {
          userId: target.userId,
          devices: [],
        };
        current.devices.push(clone(device));
        grouped.set(target.userId, current);
      }
    }
    return [...grouped.values()];
  }

  async lockMessageForAuthorMutation(_tx, receivedActor, messageId) {
    this.maybeFail("lockMessageForAuthorMutation");
    const message = this.state.messages.find(
      (row) =>
        row.tenantId === receivedActor.tenantId &&
        row.messageId === messageId &&
        row.authorUserId === receivedActor.userId,
    );
    if (!message) return undefined;
    return {
      conversationId: message.conversationId,
      messageSeq: message.messageSeq,
      currentRevision: message.currentRevision,
      status: message.status,
    };
  }

  async allocateOperationSequence() {
    this.maybeFail("allocateOperationSequence");
    if (!this.authorized) return undefined;
    const opSeq = this.state.nextOpSeq;
    this.state.nextOpSeq += 1;
    return {
      opSeq,
      membershipEpoch: 7,
      erasureEpoch: this.state.erasureEpoch,
      policyVersion: 11,
    };
  }

  async bumpConversationErasureEpoch() {
    this.maybeFail("bumpConversationErasureEpoch");
    if (!this.authorized) return undefined;
    this.state.erasureEpoch += 1;
    return this.state.erasureEpoch;
  }

  async updateMessageRevisionPointer(_tx, input) {
    this.maybeFail("updateMessageRevisionPointer");
    const message = this.state.messages.find(
      (row) =>
        row.tenantId === input.tenantId &&
        row.messageId === input.messageId,
    );
    if (!message || message.currentRevision !== input.expectedRevision) {
      throw new Error("Message revision pointer changed despite mutation lock");
    }
    message.currentRevision = input.newRevision;
    message.status = input.status;
    message.deletedAt = input.deletedAt ?? null;
  }

  async revokePendingMessageEnvelopes(_tx, input) {
    this.maybeFail("revokePendingMessageEnvelopes");
    let count = 0;
    for (const envelope of this.state.envelopes) {
      if (
        envelope.tenantId === input.tenantId &&
        envelope.messageId === input.messageId &&
        envelope.sourceRevision <= input.throughRevision &&
        envelope.status === "PENDING"
      ) {
        envelope.status = "REVOKED";
        envelope.protectedPayload = "";
        count += 1;
      }
    }
    return count;
  }

  async supersedeTranslationJobs(_tx, input) {
    this.maybeFail("supersedeTranslationJobs");
    let count = 0;
    for (const job of this.state.jobs) {
      if (
        job.tenantId === input.tenantId &&
        (
          job.jobType === "translation.request" ||
          job.jobType === "translation.execute"
        ) &&
        job.payloadRef.message_id === input.messageId &&
        Number(job.payloadRef.source_revision) <= input.throughRevision &&
        (job.status === "AVAILABLE" || job.status === "LEASED")
      ) {
        job.status = "SUPERSEDED";
        job.completedAt = input.now;
        count += 1;
      }
    }
    return count;
  }

  async cancelStartedProviderAttempts(_tx, input) {
    this.maybeFail("cancelStartedProviderAttempts");
    this.cancelledProviderAttempts ??= [];
    this.cancelledProviderAttempts.push(clone(input));
    return 1;
  }

  async supersedeTranslationExecutions(_tx, input) {
    this.maybeFail("supersedeTranslationExecutions");
    this.translationSupersedeCalls.push(clone(input));
    return 0;
  }

  async listMessageDeletionEventDevices() {
    this.maybeFail("listMessageDeletionEventDevices");
    if (this.eventDevices) {
      return clone(this.eventDevices);
    }
    return this.targets.flatMap((target) =>
      target.devices.map((device) => ({
        userId: target.userId,
        deviceId: device.deviceId,
      })),
    );
  }

  async replyTargetExists(_tx, _tenantId, _conversationId, messageId) {
    this.maybeFail("replyTargetExists");
    return this.replyTargets.has(messageId);
  }

  async insertMessageMetadata(_tx, input) {
    this.maybeFail("insertMessageMetadata");
    this.state.messages.push({
      ...clone(input),
      currentRevision: 1,
      status: "ACTIVE",
      deletedAt: null,
    });
  }

  async insertMessageRevision(_tx, input) {
    this.maybeFail("insertMessageRevision");
    this.state.revisions.push(clone(input));

    if (input.revision === 1) {
      const metadata = this.state.messages.find(
        (row) => row.messageId === input.messageId,
      );
      assert.ok(metadata);
      this.state.existingByClientId.set(
        `${metadata.tenantId}:${metadata.authorUserId}:${metadata.clientMessageId}`,
        {
          messageId: metadata.messageId,
          conversationId: metadata.conversationId,
          replyToMessageId: metadata.replyToMessageId ?? null,
          messageSeq: metadata.messageSeq,
          acceptedAt: metadata.acceptedAt,
          clientAuthoredAt: metadata.clientAuthoredAt ?? null,
          originalSourceHash: input.sourceHash ?? null,
          acceptedResult: null,
        },
      );
    }
  }

  async insertDeliveryEnvelope(_tx, input) {
    this.maybeFail("insertDeliveryEnvelope");
    this.state.envelopes.push({
      ...clone(input),
      status: "PENDING",
    });
  }

  async allocateDeviceInboxOffset(_tx, _tenantId, deviceId) {
    this.maybeFail("allocateDeviceInboxOffset");
    const next = this.state.inboxOffsets.get(deviceId) ?? 1;
    this.state.inboxOffsets.set(deviceId, next + 1);
    return { inboxEpoch: 1, offset: next };
  }

  async insertInboxEvent(_tx, input) {
    this.maybeFail("insertInboxEvent");
    this.state.events.push(clone(input));
  }

  async insertOutboxJob(_tx, input) {
    this.maybeFail("insertOutboxJob");
    this.state.jobs.push({
      ...clone(input),
      status: "AVAILABLE",
      completedAt: null,
    });
  }

  async markCommandSucceeded(_tx, input) {
    this.maybeFail("markCommandSucceeded");
    const key = `${input.tenantId}:${input.commandId}`;
    const receipt = this.state.receipts.get(key);
    if (!receipt) throw new Error("missing claimed receipt");
    if (
      receipt.actorUserId !== input.actorUserId ||
      receipt.actorDeviceId !== input.actorDeviceId ||
      receipt.commandType !== input.commandType ||
      receipt.commandFingerprint !== input.commandFingerprint ||
      receipt.status !== "IN_PROGRESS"
    ) {
      throw new Error("command claim mismatch");
    }

    receipt.status = "SUCCEEDED";
    receipt.result = clone(input.result);

    if (
      input.commandType === "message.send" &&
      typeof input.result.message_id === "string"
    ) {
      for (const existing of this.state.existingByClientId.values()) {
        if (existing.messageId === input.result.message_id) {
          existing.acceptedResult = clone(input.result);
        }
      }
    }
  }
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

function testFingerprinter() {
  function fingerprint(source) {
    const canonical = JSON.stringify({
      text: source.text,
      language_hint: source.language_hint ?? null,
    });
    return `test-sha256:${createHash("sha256")
      .update(canonical)
      .digest("hex")}`;
  }
  return {
    fingerprint,
    matches(source, stored) {
      return fingerprint(source) === stored;
    },
  };
}

function createTransient(clock, options = {}) {
  return new InMemoryTransientSourceStore({
    clock,
    maxEntries: options.maxEntries ?? 100,
    maxApproxBytes: options.maxApproxBytes ?? 1024 * 1024,
  });
}

function createService(store, overrides = {}) {
  let now = overrides.now ?? "2026-10-03T23:00:00.000Z";
  const clock = {
    now() {
      return now;
    },
  };
  const transientSources =
    overrides.transientSources ??
    createTransient(clock);
  const protectorCalls = [];

  const service = new PersistentMessagingService({
    store,
    ids: overrides.ids ?? ids(),
    clock,
    fingerprinter:
      overrides.fingerprinter ?? testFingerprinter(),
    envelopeProtector: overrides.envelopeProtector ?? {
      protect(input) {
        protectorCalls.push(clone(input));
        return Buffer.from(
          `TEST_ONLY:${input.recipientDeviceId}:${input.recipientCredentialVersion}`,
          "utf8",
        ).toString("base64");
      },
    },
    transientSources,
    envelopeTtlSeconds: 3600,
    transientSourceTtlSeconds: 300,
  });

  return {
    service,
    transientSources,
    protectorCalls,
    setNow(value) {
      now = value;
    },
  };
}

const actor = {
  tenantId: "tenant-1",
  userId: "user-a",
  deviceId: "device-a1",
};

function sendCommand(overrides = {}) {
  return {
    protocol_version: 1,
    command_id: "cmd-1",
    client_message_id: "client-1",
    conversation_id: "conversation-1",
    source: {
      text: "Bonjour persistent world",
      language_hint: "fr-FR",
    },
    ...overrides,
  };
}

test("persistent Send commits metadata, device envelopes, inbox events and plaintext-free outbox", async () => {
  const store = new TransactionalFakeStore();
  const { service, transientSources, protectorCalls } =
    createService(store);

  const accepted = await service.sendMessage(actor, sendCommand());

  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.translation_status, "PENDING");
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.revisions.length, 1);
  assert.equal(store.state.envelopes.length, 3);
  assert.equal(store.state.events.length, 3);
  assert.equal(store.state.jobs.length, 1);

  assert.deepEqual(
    store.state.envelopes
      .map((row) => row.recipientDeviceId)
      .sort(),
    ["device-a2", "device-b1", "device-b2"],
  );

  assert.deepEqual(
    protectorCalls
      .map((call) => [
        call.recipientDeviceId,
        call.recipientCredentialVersion,
        call.recipientPublicMaterialRef,
      ])
      .sort(),
    [
      ["device-a2", 2, "pub:a2"],
      ["device-b1", 3, "pub:b1"],
      ["device-b2", 4, "pub:b2"],
    ],
  );

  const buffered = transientSources.get({
    tenantId: actor.tenantId,
    messageId: accepted.message_id,
    sourceRevision: 1,
  });
  assert.ok(buffered);
  assert.equal(buffered.source.text, sendCommand().source.text);
  assert.equal(
    buffered.sourceHash,
    store.state.revisions[0].sourceHash,
  );

  const durable = JSON.stringify({
    messages: store.state.messages,
    revisions: store.state.revisions,
    jobs: store.state.jobs,
    receipts: [...store.state.receipts.values()],
  });
  assert.equal(durable.includes(sendCommand().source.text), false);
});

test("lost response retry with same command_id returns exact original result", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);

  const first = await service.sendMessage(actor, sendCommand());
  const retry = await service.sendMessage(actor, sendCommand());

  assert.deepEqual(retry, first);
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.jobs.length, 1);
});

test("new command_id with same client_message_id returns exact original acceptance", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);

  const first = await service.sendMessage(actor, sendCommand());
  const retry = await service.sendMessage(
    actor,
    sendCommand({ command_id: "cmd-2" }),
  );

  assert.deepEqual(retry, first);
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.receipts.size, 2);
});

test("command_id reuse with different payload is rejected", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);
  await service.sendMessage(actor, sendCommand());

  await assert.rejects(
    () =>
      service.sendMessage(
        actor,
        sendCommand({
          source: {
            text: "different",
            language_hint: "fr-FR",
          },
        }),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(store.state.messages.length, 1);
});

test("client_message_id is bound to conversation reply timestamp and source", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);
  await service.sendMessage(
    actor,
    sendCommand({
      client_authored_at: "2026-10-03T22:59:00.000Z",
    }),
  );

  for (const next of [
    sendCommand({
      command_id: "cmd-conversation",
      conversation_id: "other-conversation",
      client_authored_at: "2026-10-03T22:59:00.000Z",
    }),
    sendCommand({
      command_id: "cmd-reply",
      reply_to_message_id: "reply-ok",
      client_authored_at: "2026-10-03T22:59:00.000Z",
    }),
    sendCommand({
      command_id: "cmd-time",
      client_authored_at: "2026-10-03T22:58:59.000Z",
    }),
    sendCommand({
      command_id: "cmd-source",
      client_authored_at: "2026-10-03T22:59:00.000Z",
      source: {
        text: "different source",
        language_hint: "fr-FR",
      },
    }),
  ]) {
    await assert.rejects(
      () => service.sendMessage(actor, next),
      (error) =>
        error instanceof DomainError &&
        error.code === "IDEMPOTENCY_CONFLICT",
    );
  }
});

test("equivalent client authored timestamps compare by instant, not formatting", async () => {
  const store = new TransactionalFakeStore();
  const fingerprinter = testFingerprinter();
  const source = sendCommand().source;

  store.state.existingByClientId.set(
    "tenant-1:user-a:client-1",
    {
      messageId: "existing-message",
      conversationId: "conversation-1",
      replyToMessageId: null,
      messageSeq: 9,
      acceptedAt: "2026-10-03T23:00:00.000Z",
      clientAuthoredAt: "2026-10-03 22:59:00+00",
      originalSourceHash: fingerprinter.fingerprint(source),
      acceptedResult: {
        protocol_version: 1,
        status: "ACCEPTED",
        message_id: "existing-message",
        message_seq: 9,
        source_revision: 1,
        accepted_at: "2026-10-03T23:00:00.000Z",
        translation_status: "PENDING",
      },
    },
  );

  const { service } = createService(store, { fingerprinter });
  const accepted = await service.sendMessage(
    actor,
    sendCommand({
      command_id: "cmd-format",
      client_authored_at: "2026-10-03T22:59:00.000Z",
    }),
  );

  assert.equal(accepted.message_id, "existing-message");
});

test("recipient without a deliverable device rolls back the whole Send", async () => {
  const store = new TransactionalFakeStore({
    targets: [
      { userId: "user-a", devices: [] },
      { userId: "user-b", devices: [] },
    ],
  });
  const { service, transientSources } = createService(store);

  await assert.rejects(
    () => service.sendMessage(actor, sendCommand()),
    (error) =>
      error instanceof DomainError &&
      error.code === "RECIPIENT_UNAVAILABLE",
  );

  assert.equal(store.state.nextMessageSeq, 1);
  assert.equal(store.state.nextOpSeq, 1);
  assert.equal(store.state.messages.length, 0);
  assert.equal(transientSources.size, 0);
});

test("unauthorised actor fails before reply and target inspection", async () => {
  const store = new TransactionalFakeStore({ authorized: false });
  const { service } = createService(store);

  await assert.rejects(
    () =>
      service.sendMessage(
        actor,
        sendCommand({ reply_to_message_id: "missing" }),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "NOT_AUTHORIZED",
  );

  assert.equal(store.state.receipts.size, 0);
  assert.equal(store.state.messages.length, 0);
});

test("invalid reply rolls back reserved sequence and command claim", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);

  await assert.rejects(
    () =>
      service.sendMessage(
        actor,
        sendCommand({ reply_to_message_id: "missing" }),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "INVALID_COMMAND",
  );

  assert.equal(store.state.nextMessageSeq, 1);
  assert.equal(store.state.nextOpSeq, 1);
  assert.equal(store.state.receipts.size, 0);
});

test("transient source pressure returns SOURCE_REQUIRED without blocking original delivery", async () => {
  const store = new TransactionalFakeStore();
  const clock = {
    now() {
      return "2026-10-03T23:00:00.000Z";
    },
  };
  const transientSources = createTransient(clock, {
    maxEntries: 1,
    maxApproxBytes: 1,
  });
  const { service } = createService(store, { transientSources });

  const first = await service.sendMessage(actor, sendCommand());
  const retry = await service.sendMessage(
    actor,
    sendCommand({ command_id: "cmd-pressure-retry" }),
  );

  assert.equal(first.translation_status, "SOURCE_REQUIRED");
  assert.deepEqual(retry, first);
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.envelopes.length, 3);
  assert.equal(
    JSON.stringify(store.state.jobs[0]).includes(
      sendCommand().source.text,
    ),
    false,
  );
});

test("envelope protection failure rolls back DB effects and transient source", async () => {
  const store = new TransactionalFakeStore();
  const { service, transientSources } = createService(store, {
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

  assert.equal(store.state.messages.length, 0);
  assert.equal(store.state.receipts.size, 0);
  assert.equal(transientSources.size, 0);
});

test("database commit failure removes newly buffered source", async () => {
  const store = new TransactionalFakeStore({ failCommit: true });
  const { service, transientSources } = createService(store);

  await assert.rejects(
    () => service.sendMessage(actor, sendCommand()),
    /forced commit failure/,
  );

  assert.equal(store.state.messages.length, 0);
  assert.equal(store.state.receipts.size, 0);
  assert.equal(transientSources.size, 0);
});

test("same command remains idempotent across HMAC key rotation when old key is retained", async () => {
  const store = new TransactionalFakeStore();
  const oldKey = "old-key-0123456789abcdef0123456789abcdef";
  const newKey = "new-key-0123456789abcdef0123456789abcdef";

  const oldFingerprinter = createHmacSourceFingerprinter({
    key: oldKey,
    keyVersion: "k1",
  });
  const firstService = createService(store, {
    fingerprinter: oldFingerprinter,
  }).service;
  const first = await firstService.sendMessage(actor, sendCommand());

  const rotatedFingerprinter = createHmacSourceFingerprinter({
    key: newKey,
    keyVersion: "k2",
    verificationKeys: [
      { key: oldKey, keyVersion: "k1" },
    ],
  });
  const rotatedService = createService(store, {
    fingerprinter: rotatedFingerprinter,
  }).service;

  const retry = await rotatedService.sendMessage(actor, sendCommand());
  assert.deepEqual(retry, first);
  assert.equal(store.state.messages.length, 1);
});

test("client_message_id retry with a new command also survives HMAC key rotation", async () => {
  const store = new TransactionalFakeStore();
  const oldKey = "old-key-0123456789abcdef0123456789abcdef";
  const newKey = "new-key-0123456789abcdef0123456789abcdef";

  const oldService = createService(store, {
    fingerprinter: createHmacSourceFingerprinter({
      key: oldKey,
      keyVersion: "k1",
    }),
  }).service;
  const first = await oldService.sendMessage(actor, sendCommand());

  const rotatedService = createService(store, {
    fingerprinter: createHmacSourceFingerprinter({
      key: newKey,
      keyVersion: "k2",
      verificationKeys: [
        { key: oldKey, keyVersion: "k1" },
      ],
    }),
  }).service;

  const retry = await rotatedService.sendMessage(
    actor,
    sendCommand({ command_id: "cmd-after-rotation" }),
  );

  assert.deepEqual(retry, first);
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.receipts.size, 2);
});

test("transient store refuses duplicate keys without overwriting admitted source", () => {
  const clock = {
    now() {
      return "2026-10-03T23:00:00.000Z";
    },
  };
  const store = createTransient(clock);

  assert.equal(
    store.put({
      tenantId: "tenant-1",
      messageId: "message-1",
      sourceRevision: 1,
      sourceHash: "hash-1",
      source: { text: "first" },
      createdAt: "2026-10-03T23:00:00.000Z",
      expiresAt: "2026-10-03T23:05:00.000Z",
    }),
    true,
  );

  assert.equal(
    store.put({
      tenantId: "tenant-1",
      messageId: "message-1",
      sourceRevision: 1,
      sourceHash: "hash-2",
      source: { text: "second" },
      createdAt: "2026-10-03T23:00:01.000Z",
      expiresAt: "2026-10-03T23:05:00.000Z",
    }),
    false,
  );

  assert.equal(
    store.get({
      tenantId: "tenant-1",
      messageId: "message-1",
      sourceRevision: 1,
    }).source.text,
    "first",
  );
});


test("persistent command recovery returns exact committed Send result", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);

  const accepted = await service.sendMessage(actor, sendCommand());
  const status = await service.getCommandStatus(actor, "cmd-1");

  assert.deepEqual(status, {
    command_id: "cmd-1",
    status: "SUCCEEDED",
    result: accepted,
  });
});

test("persistent command recovery hides foreign actor receipts and reports unknown", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);
  await service.sendMessage(actor, sendCommand());

  const foreign = {
    tenantId: "tenant-1",
    userId: "user-b",
    deviceId: "device-b1",
  };
  const status = await service.getCommandStatus(foreign, "cmd-1");

  assert.deepEqual(status, {
    command_id: "cmd-1",
    status: "UNKNOWN",
  });
});


test("persistent edit creates revision, revokes old envelopes and supersedes old translation work", async () => {
  const store = new TransactionalFakeStore();
  const { service, transientSources } = createService(store);

  const accepted = await service.sendMessage(actor, sendCommand());
  const edited = await service.editMessage(actor, {
    protocol_version: 1,
    command_id: "edit-1",
    message_id: accepted.message_id,
    expected_revision: 1,
    source: {
      text: "Bonjour version two",
      language_hint: "fr-FR",
    },
  });

  assert.deepEqual(edited, {
    message_id: accepted.message_id,
    revision: 2,
    op_seq: 2,
    status: "ACTIVE",
  });

  const metadata = store.state.messages[0];
  assert.equal(metadata.currentRevision, 2);
  assert.equal(metadata.status, "ACTIVE");
  assert.equal(store.state.erasureEpoch, 3);

  const oldEnvelopes = store.state.envelopes.filter(
    (row) => row.sourceRevision === 1,
  );
  const newEnvelopes = store.state.envelopes.filter(
    (row) => row.sourceRevision === 2,
  );
  assert.equal(oldEnvelopes.length, 3);
  assert.equal(newEnvelopes.length, 3);
  assert.equal(
    oldEnvelopes.every(
      (row) => row.status === "REVOKED" && row.protectedPayload === "",
    ),
    true,
  );
  assert.equal(
    newEnvelopes.every((row) => row.status === "PENDING"),
    true,
  );

  assert.equal(store.state.jobs[0].status, "SUPERSEDED");
  assert.equal(store.cancelledProviderAttempts?.length, 1);
  assert.deepEqual(store.cancelledProviderAttempts?.[0], {
    tenantId: "tenant-1",
    messageId: accepted.message_id,
    throughRevision: 1,
    now: "2026-10-03T23:00:00.000Z",
  });
  assert.equal(store.state.jobs[1].status, "AVAILABLE");
  assert.deepEqual(
    {
      membership_epoch: store.state.jobs[1].payloadRef.membership_epoch,
      erasure_epoch: store.state.jobs[1].payloadRef.erasure_epoch,
      policy_version: store.state.jobs[1].payloadRef.policy_version,
    },
    {
      membership_epoch: 7,
      erasure_epoch: 3,
      policy_version: 11,
    },
  );
  assert.equal(
    store.state.events.filter((row) => row.eventType === "message.edited").length,
    3,
  );

  assert.equal(
    transientSources.get({
      tenantId: actor.tenantId,
      messageId: accepted.message_id,
      sourceRevision: 1,
    }),
    undefined,
  );
  assert.equal(
    transientSources.get({
      tenantId: actor.tenantId,
      messageId: accepted.message_id,
      sourceRevision: 2,
    }).source.text,
    "Bonjour version two",
  );
});

test("persistent edit retry is idempotent and stale new command is rejected", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);
  const accepted = await service.sendMessage(actor, sendCommand());

  const command = {
    protocol_version: 1,
    command_id: "edit-retry",
    message_id: accepted.message_id,
    expected_revision: 1,
    source: { text: "edited", language_hint: "en-US" },
  };
  const first = await service.editMessage(actor, command);
  const retry = await service.editMessage(actor, command);
  assert.deepEqual(retry, first);
  assert.equal(store.state.erasureEpoch, 3);

  await assert.rejects(
    () =>
      service.editMessage(actor, {
        ...command,
        command_id: "edit-stale-new-command",
      }),
    (error) =>
      error instanceof DomainError &&
      error.code === "REVISION_CONFLICT",
  );

  assert.equal(
    store.state.revisions.filter((row) => row.mutationType === "EDITED").length,
    1,
  );
});

test("persistent edit rollback removes the new transient revision", async () => {
  const store = new TransactionalFakeStore();
  const fixture = createService(store);
  const accepted = await fixture.service.sendMessage(actor, sendCommand());

  store.failAt = "insertDeliveryEnvelope";
  await assert.rejects(
    () =>
      fixture.service.editMessage(actor, {
        protocol_version: 1,
        command_id: "edit-fail",
        message_id: accepted.message_id,
        expected_revision: 1,
        source: { text: "will rollback" },
      }),
    /forced store failure/,
  );

  assert.equal(store.state.messages[0].currentRevision, 1);
  assert.equal(store.state.erasureEpoch, 2);
  assert.equal(
    fixture.transientSources.get({
      tenantId: actor.tenantId,
      messageId: accepted.message_id,
      sourceRevision: 2,
    }),
    undefined,
  );
  assert.ok(
    fixture.transientSources.get({
      tenantId: actor.tenantId,
      messageId: accepted.message_id,
      sourceRevision: 1,
    }),
  );
});

test("persistent delete creates tombstone, purges pending delivery and transient source", async () => {
  const store = new TransactionalFakeStore();
  const { service, transientSources } = createService(store);
  const accepted = await service.sendMessage(actor, sendCommand());

  const deleted = await service.deleteMessage(actor, {
    protocol_version: 1,
    command_id: "delete-1",
    message_id: accepted.message_id,
    expected_revision: 1,
  });

  assert.deepEqual(deleted, {
    message_id: accepted.message_id,
    revision: 2,
    op_seq: 2,
    status: "DELETED",
  });

  assert.equal(store.state.messages[0].currentRevision, 2);
  assert.equal(store.state.messages[0].status, "DELETED");
  assert.equal(store.state.erasureEpoch, 3);
  assert.equal(
    store.state.envelopes.every(
      (row) => row.status === "REVOKED" && row.protectedPayload === "",
    ),
    true,
  );
  assert.equal(store.state.jobs[0].status, "SUPERSEDED");
  assert.equal(store.cancelledProviderAttempts?.length, 1);
  assert.deepEqual(store.translationSupersedeCalls.at(-1), {
    tenantId: "tenant-1",
    messageId: accepted.message_id,
    throughRevision: 1,
    now: "2026-10-03T23:00:00.000Z",
  });

  const deleteEvents = store.state.events.filter(
    (row) => row.eventType === "message.deleted",
  );
  assert.equal(deleteEvents.length, 3);
  assert.equal(
    deleteEvents.every((row) => row.envelopeId === null),
    true,
  );
  assert.equal(
    transientSources.get({
      tenantId: actor.tenantId,
      messageId: accepted.message_id,
      sourceRevision: 1,
    }),
    undefined,
  );
});

test("persistent delete rolls back erasure epoch when the transaction fails after the bump", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);
  const accepted = await service.sendMessage(actor, sendCommand());

  store.failAt = "insertMessageRevision";
  await assert.rejects(
    () =>
      service.deleteMessage(actor, {
        protocol_version: 1,
        command_id: "delete-erasure-rollback",
        message_id: accepted.message_id,
        expected_revision: 1,
      }),
    /forced store failure at insertMessageRevision/,
  );

  assert.equal(store.state.erasureEpoch, 2);
  assert.equal(store.state.messages[0].currentRevision, 1);
  assert.equal(store.state.messages[0].status, "ACTIVE");
  assert.equal(
    store.state.revisions.some(
      (row) => row.mutationType === "DELETED",
    ),
    false,
  );
});

test("persistent delete retry is idempotent and a new stale delete conflicts", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);
  const accepted = await service.sendMessage(actor, sendCommand());

  const command = {
    protocol_version: 1,
    command_id: "delete-retry",
    message_id: accepted.message_id,
    expected_revision: 1,
  };
  const first = await service.deleteMessage(actor, command);
  const retry = await service.deleteMessage(actor, command);
  assert.deepEqual(retry, first);
  assert.equal(store.state.erasureEpoch, 3);

  await assert.rejects(
    () =>
      service.deleteMessage(actor, {
        ...command,
        command_id: "delete-stale-new-command",
      }),
    (error) =>
      error instanceof DomainError &&
      error.code === "REVISION_CONFLICT",
  );

  assert.equal(
    store.state.revisions.filter((row) => row.mutationType === "DELETED").length,
    1,
  );
});

test("delete is allowed even when an external recipient currently has no device", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);
  const accepted = await service.sendMessage(actor, sendCommand());

  store.targets = [
    { userId: "user-a", devices: [] },
    { userId: "user-b", devices: [] },
  ];

  const deleted = await service.deleteMessage(actor, {
    protocol_version: 1,
    command_id: "delete-offline-recipient",
    message_id: accepted.message_id,
    expected_revision: 1,
  });

  assert.equal(deleted.status, "DELETED");
  assert.equal(store.state.messages[0].status, "DELETED");
});


test("persistent delete reaches historical recipient devices even after current delivery membership disappears", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);
  const accepted = await service.sendMessage(actor, sendCommand());

  store.targets = [
    { userId: "user-a", devices: [] },
    { userId: "user-b", devices: [] },
  ];
  // Historical delivery recipients are retained independently from current
  // conversation delivery targets/membership.
  store.eventDevices = [
    { userId: "user-a", deviceId: "device-a2" },
    { userId: "user-b", deviceId: "device-b-historical" },
  ];

  const deleted = await service.deleteMessage(actor, {
    protocol_version: 1,
    command_id: "delete-no-key-device",
    message_id: accepted.message_id,
    expected_revision: 1,
  });

  assert.equal(deleted.status, "DELETED");
  const deleteEvents = store.state.events.filter(
    (row) => row.eventType === "message.deleted",
  );
  assert.deepEqual(
    deleteEvents.map((row) => row.deviceId).sort(),
    ["device-a2", "device-b-historical"],
  );
});


test("persistent edit never backfills message content to a device added after original delivery", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);

  const accepted = await service.sendMessage(actor, sendCommand());

  store.targets = store.targets.map((target) =>
    target.userId === "user-b"
      ? {
          ...target,
          devices: [
            ...target.devices,
            {
              userId: "user-b",
              deviceId: "device-b-new",
              credentialVersion: 99,
              publicMaterialRef: "pub:b-new",
            },
          ],
        }
      : target,
  );

  await service.editMessage(actor, {
    protocol_version: 1,
    command_id: "edit-no-history-backfill",
    message_id: accepted.message_id,
    expected_revision: 1,
    source: {
      text: "edited without history leak",
      language_hint: "en-US",
    },
  });

  const editEvents = store.state.events.filter(
    (event) => event.eventType === "message.edited",
  );
  assert.equal(
    editEvents.some((event) => event.deviceId === "device-b-new"),
    false,
  );

  const editedEnvelopes = store.state.envelopes.filter(
    (envelope) => envelope.sourceRevision === 2,
  );
  assert.equal(
    editedEnvelopes.some(
      (envelope) => envelope.recipientDeviceId === "device-b-new",
    ),
    false,
  );
});

test("persistent edit can succeed after a historically exposed recipient device is revoked", async () => {
  const store = new TransactionalFakeStore();
  const { service } = createService(store);

  const accepted = await service.sendMessage(actor, sendCommand());

  store.targets = store.targets.map((target) =>
    target.userId === "user-b"
      ? { ...target, devices: [] }
      : target,
  );

  const edited = await service.editMessage(actor, {
    protocol_version: 1,
    command_id: "edit-after-recipient-device-revoked",
    message_id: accepted.message_id,
    expected_revision: 1,
    source: { text: "edited while recipient has no active device" },
  });

  assert.equal(edited.status, "ACTIVE");
  assert.equal(store.state.messages[0].currentRevision, 2);
  assert.equal(
    store.state.events.filter(
      (event) => event.eventType === "message.edited",
    ).length,
    1,
  );
});


test("persistent edit retry remains idempotent across HMAC key rotation", async () => {
  const store = new TransactionalFakeStore();
  const oldKey = "old-edit-key-0123456789abcdef0123456789abcd";
  const newKey = "new-edit-key-0123456789abcdef0123456789abcd";

  const oldService = createService(store, {
    fingerprinter: createHmacSourceFingerprinter({
      key: oldKey,
      keyVersion: "edit-k1",
    }),
  }).service;

  const accepted = await oldService.sendMessage(actor, sendCommand());
  const command = {
    protocol_version: 1,
    command_id: "edit-across-key-rotation",
    message_id: accepted.message_id,
    expected_revision: 1,
    source: {
      text: "edited across fingerprint rotation",
      language_hint: "en-US",
    },
  };

  const first = await oldService.editMessage(actor, command);

  const rotatedService = createService(store, {
    fingerprinter: createHmacSourceFingerprinter({
      key: newKey,
      keyVersion: "edit-k2",
      verificationKeys: [
        {
          key: oldKey,
          keyVersion: "edit-k1",
        },
      ],
    }),
  }).service;

  const retry = await rotatedService.editMessage(actor, command);
  assert.deepEqual(retry, first);
  assert.equal(store.state.erasureEpoch, 3);
  assert.equal(
    store.state.revisions.filter(
      (row) => row.mutationType === "EDITED",
    ).length,
    1,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { DomainError } from "../.build/packages/domain/src/index.js";
import {
  BoundedTransientSourceStore,
  PersistentSendService,
} from "../.build/packages/messaging-persistent/src/index.js";

function clone(value) {
  return structuredClone(value);
}

class FakePersistentSendRepository {
  constructor({
    authorized = true,
    targets,
    failAt = null,
    failCommit = false,
  } = {}) {
    this.authorized = authorized;
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
    this.failAt = failAt;
    this.failCommit = failCommit;

    this.receipts = new Map();
    this.messagesByClientKey = new Map();
    this.metadata = [];
    this.revisions = [];
    this.envelopes = [];
    this.events = [];
    this.jobs = [];
    this.offsets = new Map();
    this.replyTargets = new Set(["reply-ok"]);
    this.nextMessageSeq = 1;
    this.nextOpSeq = 1;
    this.locks = [];
  }

  snapshot() {
    return {
      receipts: clone(this.receipts),
      messagesByClientKey: clone(this.messagesByClientKey),
      metadata: clone(this.metadata),
      revisions: clone(this.revisions),
      envelopes: clone(this.envelopes),
      events: clone(this.events),
      jobs: clone(this.jobs),
      offsets: clone(this.offsets),
      nextMessageSeq: this.nextMessageSeq,
      nextOpSeq: this.nextOpSeq,
      locks: clone(this.locks),
    };
  }

  restore(s) {
    this.receipts = s.receipts;
    this.messagesByClientKey = s.messagesByClientKey;
    this.metadata = s.metadata;
    this.revisions = s.revisions;
    this.envelopes = s.envelopes;
    this.events = s.events;
    this.jobs = s.jobs;
    this.offsets = s.offsets;
    this.nextMessageSeq = s.nextMessageSeq;
    this.nextOpSeq = s.nextOpSeq;
    this.locks = s.locks;
  }

  maybeFail(name) {
    if (this.failAt === name) {
      throw new Error(`forced repository failure at ${name}`);
    }
  }

  async withTransaction(work) {
    const snapshot = this.snapshot();
    try {
      const result = await work({});
      if (this.failCommit) {
        this.restore(snapshot);
        throw new Error("forced commit failure");
      }
      return result;
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  async claimCommand(_tx, input) {
    this.maybeFail("claimCommand");
    const key = `${input.actor.tenantId}:${input.commandId}`;
    const existing = this.receipts.get(key);
    if (existing) {
      return { claimed: false, existing: clone(existing) };
    }

    this.receipts.set(key, {
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
    this.locks.push(
      `${actor.tenantId}:${actor.userId}:${clientMessageId}`,
    );
  }

  async findAcceptedMessageByClientId(_tx, actor, clientMessageId) {
    this.maybeFail("findAcceptedMessageByClientId");
    return clone(
      this.messagesByClientKey.get(
        `${actor.tenantId}:${actor.userId}:${clientMessageId}`,
      ),
    );
  }

  async allocateMessageAndOperationSequence() {
    this.maybeFail("allocateMessageAndOperationSequence");
    if (!this.authorized) return undefined;

    const result = {
      messageSeq: this.nextMessageSeq,
      opSeq: this.nextOpSeq,
      membershipEpoch: 7,
      erasureEpoch: 2,
      policyVersion: 11,
    };
    this.nextMessageSeq += 1;
    this.nextOpSeq += 1;
    return result;
  }

  async listRecipientDeliveryTargets() {
    this.maybeFail("listRecipientDeliveryTargets");
    return clone(this.targets);
  }

  async replyTargetExists(_tx, _tenantId, _conversationId, messageId) {
    this.maybeFail("replyTargetExists");
    return this.replyTargets.has(messageId);
  }

  async insertMessageMetadata(_tx, input) {
    this.maybeFail("insertMessageMetadata");
    this.metadata.push(clone(input));
  }

  async insertMessageRevision(_tx, input) {
    this.maybeFail("insertMessageRevision");
    this.revisions.push(clone(input));

    if (input.revision === 1) {
      const metadata = this.metadata.find(
        (row) => row.messageId === input.messageId,
      );
      assert.ok(metadata, "metadata must exist before revision");
      this.messagesByClientKey.set(
        `${metadata.tenantId}:${metadata.authorUserId}:${metadata.clientMessageId}`,
        {
          messageId: metadata.messageId,
          conversationId: metadata.conversationId,
          replyToMessageId: metadata.replyToMessageId ?? null,
          messageSeq: metadata.messageSeq,
          acceptedAt: metadata.acceptedAt,
          originalSourceHash: input.sourceHash ?? null,
          acceptedResult: null,
        },
      );
    }
  }

  async insertDeliveryEnvelope(_tx, input) {
    this.maybeFail("insertDeliveryEnvelope");
    this.envelopes.push(clone(input));
  }

  async allocateDeviceInboxOffset(_tx, deviceId) {
    this.maybeFail("allocateDeviceInboxOffset");
    const next = this.offsets.get(deviceId) ?? 1;
    this.offsets.set(deviceId, next + 1);
    return { inboxEpoch: 1, offset: next };
  }

  async insertInboxEvent(_tx, input) {
    this.maybeFail("insertInboxEvent");
    this.events.push(clone(input));
  }

  async insertOutboxJob(_tx, input) {
    this.maybeFail("insertOutboxJob");
    this.jobs.push(clone(input));
  }

  async markCommandSucceeded(_tx, input) {
    this.maybeFail("markCommandSucceeded");
    const key = `${input.tenantId}:${input.commandId}`;
    const receipt = this.receipts.get(key);
    if (!receipt) throw new Error("missing claimed receipt");
    if (
      receipt.commandType !== input.commandType ||
      receipt.commandFingerprint !== input.commandFingerprint ||
      receipt.actorUserId !== input.actorUserId ||
      receipt.actorDeviceId !== input.actorDeviceId
    ) {
      throw new Error("receipt claim mismatch");
    }

    receipt.status = "SUCCEEDED";
    receipt.result = clone(input.result);

    if (
      input.commandType === "message.send" &&
      typeof input.result.message_id === "string"
    ) {
      for (const prior of this.messagesByClientKey.values()) {
        if (prior.messageId === input.result.message_id) {
          prior.acceptedResult = clone(input.result);
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

function digest(source) {
  const canonical = JSON.stringify({
    text: source.text,
    language_hint: source.language_hint ?? null,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function fixture(options = {}) {
  let now = "2026-10-03T22:20:00.000Z";
  const repository = new FakePersistentSendRepository(options);
  const sourceStore =
    options.sourceStore ??
    new BoundedTransientSourceStore({
      clock: { now: () => now },
      maxEntries: 10,
      maxTotalChars: 100_000,
    });
  const protectorCalls = [];

  const service = new PersistentSendService({
    repository,
    clock: {
      now() {
        return now;
      },
    },
    ids: ids(),
    sourceDigester: { digest },
    envelopeProtector: {
      protect(input) {
        protectorCalls.push(clone(input));
        return Buffer.from(
          `TEST_ONLY_PROTECTED:${input.recipientDeviceId}:${input.recipientCredentialVersion}`,
        ).toString("base64");
      },
    },
    transientSources: sourceStore,
  });

  return {
    repository,
    sourceStore,
    service,
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

function command(overrides = {}) {
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

test("persistent Send commits metadata, per-device envelopes, inbox events and source-free outbox work", async () => {
  const {
    repository,
    sourceStore,
    service,
    protectorCalls,
  } = fixture();

  const accepted = await service.sendMessage(actor, command());

  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.message_seq, 1);
  assert.equal(accepted.source_revision, 1);
  assert.equal(accepted.translation_status, "PENDING");

  assert.equal(repository.metadata.length, 1);
  assert.equal(repository.revisions.length, 1);
  assert.equal(repository.envelopes.length, 3);
  assert.equal(repository.events.length, 3);
  assert.equal(repository.jobs.length, 1);

  assert.deepEqual(
    repository.envelopes.map((row) => row.recipientDeviceId).sort(),
    ["device-a2", "device-b1", "device-b2"],
  );

  assert.deepEqual(
    protectorCalls.map((call) => [
      call.recipientDeviceId,
      call.recipientCredentialVersion,
      call.recipientPublicMaterialRef,
    ]).sort(),
    [
      ["device-a2", 2, "pub:a2"],
      ["device-b1", 3, "pub:b1"],
      ["device-b2", 4, "pub:b2"],
    ],
  );

  const buffered = sourceStore.get(accepted.message_id, 1);
  assert.equal(buffered.source.text, command().source.text);

  const durableControl = JSON.stringify({
    metadata: repository.metadata,
    revisions: repository.revisions,
    jobs: repository.jobs,
    receipts: [...repository.receipts.values()],
  });
  assert.equal(durableControl.includes(command().source.text), false);
  assert.equal(
    JSON.stringify(repository.jobs[0].payloadRef).includes(
      command().source.text,
    ),
    false,
  );
});

test("lost response retry with same command_id returns original result without duplicate effects", async () => {
  const { repository, service } = fixture();
  const first = await service.sendMessage(actor, command());
  const retry = await service.sendMessage(actor, command());

  assert.deepEqual(retry, first);
  assert.equal(repository.metadata.length, 1);
  assert.equal(repository.revisions.length, 1);
  assert.equal(repository.envelopes.length, 3);
  assert.equal(repository.jobs.length, 1);
});

test("new command_id with same client_message_id and same logical content returns original Send", async () => {
  const { repository, service } = fixture();
  const first = await service.sendMessage(actor, command());

  const retry = await service.sendMessage(
    actor,
    command({ command_id: "cmd-2" }),
  );

  assert.deepEqual(retry, first);
  assert.equal(repository.metadata.length, 1);
  assert.equal(repository.jobs.length, 1);
  assert.equal(repository.receipts.size, 2);
});

test("command_id reuse with different payload is rejected and first result remains intact", async () => {
  const { repository, service } = fixture();
  const first = await service.sendMessage(actor, command());

  await assert.rejects(
    () =>
      service.sendMessage(
        actor,
        command({
          source: {
            text: "different content",
            language_hint: "fr-FR",
          },
        }),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "IDEMPOTENCY_CONFLICT",
  );

  assert.equal(repository.metadata.length, 1);
  const receipt = repository.receipts.get("tenant-1:cmd-1");
  assert.deepEqual(receipt.result, first);
});

test("client_message_id cannot move to another conversation, reply target or source", async () => {
  const { service } = fixture();
  await service.sendMessage(actor, command());

  for (const next of [
    command({
      command_id: "cmd-conv",
      conversation_id: "conversation-other",
    }),
    command({
      command_id: "cmd-reply",
      reply_to_message_id: "reply-ok",
    }),
    command({
      command_id: "cmd-source",
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

test("recipient without an active device rolls back the entire Send and leaves no transient source", async () => {
  const { repository, sourceStore, service } = fixture({
    targets: [
      {
        userId: "user-a",
        devices: [],
      },
      {
        userId: "user-b",
        devices: [],
      },
    ],
  });

  await assert.rejects(
    () => service.sendMessage(actor, command()),
    (error) =>
      error instanceof DomainError &&
      error.code === "RECIPIENT_UNAVAILABLE",
  );

  assert.equal(repository.metadata.length, 0);
  assert.equal(repository.revisions.length, 0);
  assert.equal(repository.envelopes.length, 0);
  assert.equal(repository.jobs.length, 0);
  assert.equal(repository.receipts.size, 0);
  assert.deepEqual(sourceStore.stats(), { entries: 0, totalChars: 0 });
  assert.equal(repository.nextMessageSeq, 1);
  assert.equal(repository.nextOpSeq, 1);
});

test("repository failure after transient buffering rolls back DB effects and removes buffered source", async () => {
  const { repository, sourceStore, service } = fixture({
    failAt: "insertMessageMetadata",
  });

  await assert.rejects(
    () => service.sendMessage(actor, command()),
    /forced repository failure/,
  );

  assert.equal(repository.receipts.size, 0);
  assert.equal(repository.metadata.length, 0);
  assert.equal(repository.nextMessageSeq, 1);
  assert.deepEqual(sourceStore.stats(), { entries: 0, totalChars: 0 });
});

test("transient source pressure does not block original delivery and preserves exact retry result", async () => {
  const tinyStore = new BoundedTransientSourceStore({
    clock: {
      now() {
        return "2026-10-03T22:20:00.000Z";
      },
    },
    maxEntries: 1,
    maxTotalChars: 3,
  });
  const { repository, service } = fixture({ sourceStore: tinyStore });

  const accepted = await service.sendMessage(actor, command());
  const retry = await service.sendMessage(
    actor,
    command({ command_id: "cmd-source-pressure-retry" }),
  );

  assert.equal(accepted.translation_status, "SOURCE_REQUIRED");
  assert.deepEqual(retry, accepted);
  assert.equal(repository.metadata.length, 1);
  assert.equal(repository.envelopes.length, 3);
  assert.equal(repository.jobs.length, 1);
  assert.equal(
    JSON.stringify(repository.jobs[0]).includes(command().source.text),
    false,
  );
});

test("unauthorised actor fails before reply/recipient inspection and transaction leaves no receipt", async () => {
  const { repository, service } = fixture({ authorized: false });

  await assert.rejects(
    () =>
      service.sendMessage(
        actor,
        command({ reply_to_message_id: "reply-does-not-exist" }),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "NOT_AUTHORIZED",
  );

  assert.equal(repository.receipts.size, 0);
  assert.equal(repository.metadata.length, 0);
});

test("invalid reply rolls back the reserved sequence and command claim", async () => {
  const { repository, service } = fixture();

  await assert.rejects(
    () =>
      service.sendMessage(
        actor,
        command({ reply_to_message_id: "missing-reply" }),
      ),
    (error) =>
      error instanceof DomainError &&
      error.code === "INVALID_COMMAND",
  );

  assert.equal(repository.receipts.size, 0);
  assert.equal(repository.nextMessageSeq, 1);
  assert.equal(repository.nextOpSeq, 1);
});

test("source digester is rejected if it returns plaintext", async () => {
  const repository = new FakePersistentSendRepository();
  const sourceStore = new BoundedTransientSourceStore({
    clock: { now: () => "2026-10-03T22:20:00.000Z" },
  });
  const service = new PersistentSendService({
    repository,
    clock: { now: () => "2026-10-03T22:20:00.000Z" },
    ids: ids(),
    sourceDigester: {
      digest(source) {
        return source.text;
      },
    },
    envelopeProtector: {
      protect() {
        return "protected";
      },
    },
    transientSources: sourceStore,
  });

  await assert.rejects(
    () => service.sendMessage(actor, command()),
    /non-plaintext digest/,
  );
  assert.equal(repository.receipts.size, 0);
});

test("bounded transient source store preserves admitted work under pressure and expires by TTL", () => {
  let now = "2026-10-03T22:20:00.000Z";
  const store = new BoundedTransientSourceStore({
    clock: { now: () => now },
    maxEntries: 2,
    maxTotalChars: 8,
  });

  for (const messageId of ["m1", "m2"]) {
    store.put({
      messageId,
      sourceRevision: 1,
      sourceHash: messageId,
      source: { text: "aaaa" },
      storedAt: now,
      expiresAt: "2026-10-03T22:21:00.000Z",
    });
  }

  assert.throws(
    () =>
      store.put({
        messageId: "m3",
        sourceRevision: 1,
        sourceHash: "h3",
        source: { text: "cccc" },
        storedAt: now,
        expiresAt: "2026-10-03T22:21:00.000Z",
      }),
    /capacity is exhausted/,
  );

  assert.ok(store.get("m1", 1));
  assert.ok(store.get("m2", 1));
  assert.equal(store.get("m3", 1), undefined);

  now = "2026-10-03T22:21:00.000Z";
  assert.deepEqual(store.stats(), { entries: 0, totalChars: 0 });
});


test("failed database commit removes newly buffered source", async () => {
  const { repository, sourceStore, service } = fixture({
    failCommit: true,
  });

  await assert.rejects(
    () => service.sendMessage(actor, command()),
    /forced commit failure/,
  );

  assert.equal(repository.receipts.size, 0);
  assert.equal(repository.metadata.length, 0);
  assert.deepEqual(sourceStore.stats(), { entries: 0, totalChars: 0 });
});

test("short source text is accepted when the digest is cryptographic", async () => {
  const { service } = fixture();
  const accepted = await service.sendMessage(
    actor,
    command({
      source: {
        text: "a",
        language_hint: "fr-FR",
      },
    }),
  );

  assert.equal(accepted.status, "ACCEPTED");
});

test("transient source key collision never overwrites admitted source", () => {
  const store = new BoundedTransientSourceStore({
    clock: {
      now() {
        return "2026-10-03T22:20:00.000Z";
      },
    },
    maxEntries: 10,
    maxTotalChars: 1000,
  });

  store.put({
    messageId: "message-collision",
    sourceRevision: 1,
    sourceHash: "first-hash",
    source: { text: "first source" },
    storedAt: "2026-10-03T22:20:00.000Z",
    expiresAt: "2026-10-03T22:25:00.000Z",
  });

  assert.throws(
    () =>
      store.put({
        messageId: "message-collision",
        sourceRevision: 1,
        sourceHash: "second-hash",
        source: { text: "second source" },
        storedAt: "2026-10-03T22:20:01.000Z",
        expiresAt: "2026-10-03T22:25:00.000Z",
      }),
    /key already exists/,
  );

  assert.equal(
    store.get("message-collision", 1).source.text,
    "first source",
  );
});

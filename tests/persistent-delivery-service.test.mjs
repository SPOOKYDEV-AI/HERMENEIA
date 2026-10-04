import test from "node:test";
import assert from "node:assert/strict";

import { DomainError } from "../.build/packages/domain/src/index.js";
import {
  PersistentDeliveryService,
  evaluateSyncCursor,
} from "../.build/packages/delivery-service/src/index.js";

const actor = {
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-1",
};

function contentEvent(overrides = {}) {
  return {
    inboxEpoch: 4,
    offset: 9,
    eventId: "event-9",
    eventType: "message.available",
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    envelopeId: "envelope-1",
    sourceRevision: 1,
    protectedPayload: "Y2lwaGVydGV4dA==",
    renditionType: "ORIGINAL",
    envelopeStatus: "PENDING",
    expiresAt: "2026-10-05T00:00:00.000Z",
    createdAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

class FakeDeliveryStore {
  constructor({
    state,
    events = [],
    ackResults = [],
  } = {}) {
    this.state = state ?? {
      inboxEpoch: 4,
      nextOffset: 11,
      lastAckedOffset: 0,
    };
    this.events = events;
    this.ackResults = [...ackResults];
    this.calls = [];
    this.transactions = 0;
  }

  async withTransaction(work) {
    this.transactions += 1;
    return work({ id: `tx-${this.transactions}` });
  }

  async getDeviceSyncState(_tx, receivedActor) {
    this.calls.push({
      method: "getDeviceSyncState",
      actor: structuredClone(receivedActor),
    });
    return this.state ? structuredClone(this.state) : undefined;
  }

  async expirePendingDeviceEnvelopes(_tx, input) {
    this.calls.push({
      method: "expirePendingDeviceEnvelopes",
      input: structuredClone(input),
    });
    return 0;
  }

  async listInboxEvents(_tx, input) {
    this.calls.push({
      method: "listInboxEvents",
      input: structuredClone(input),
    });
    return structuredClone(this.events);
  }

  async acknowledgeEnvelope(_tx, input) {
    this.calls.push({
      method: "acknowledgeEnvelope",
      input: structuredClone(input),
    });
    return this.ackResults.shift() ?? "ACKED";
  }
}

function service(store, now = "2026-10-04T09:00:00.000Z") {
  return new PersistentDeliveryService(store, {
    now() {
      return now;
    },
  });
}

test("sync returns tenant-scoped content events and next cursor", async () => {
  const store = new FakeDeliveryStore({
    events: [contentEvent()],
  });

  const result = await service(store).sync(actor, {
    cursor: "4:8",
    limit: 100,
  });

  assert.equal(result.kind, "OK");
  assert.equal(result.response.next_cursor, "4:9");
  assert.deepEqual(result.response.events, [{
    protocol_version: 1,
    event_id: "event-9",
    cursor: "4:9",
    type: "message.available",
    server_time: "2026-10-04T00:00:00.000Z",
    tenant_id: "tenant-1",
    conversation_id: "conversation-1",
    payload: {
      message_id: "message-1",
      envelope_id: "envelope-1",
      source_revision: 1,
      rendition_type: "ORIGINAL",
      protected_payload: "Y2lwaGVydGV4dA==",
      expires_at: "2026-10-05T00:00:00.000Z",
    },
  }]);

  const listCall = store.calls.find(
    (call) => call.method === "listInboxEvents",
  );
  assert.deepEqual(listCall.input, {
    tenantId: "tenant-1",
    deviceId: "device-1",
    inboxEpoch: 4,
    afterOffset: 8,
    limit: 100,
  });
});

test("sync normalizes content-free delete events", async () => {
  const store = new FakeDeliveryStore({
    events: [contentEvent({
      offset: 10,
      eventId: "event-10",
      eventType: "message.deleted",
      envelopeId: null,
      protectedPayload: null,
      renditionType: null,
      envelopeStatus: null,
      expiresAt: null,
      sourceRevision: 2,
    })],
  });

  const result = await service(store).sync(actor, {
    cursor: "4:9",
  });

  assert.equal(result.kind, "OK");
  assert.equal(result.response.next_cursor, "4:10");
  assert.deepEqual(result.response.events[0].payload, {
    message_id: "message-1",
    source_revision: 2,
  });
});

test("sync reset handles wrong epoch future and malformed cursors without using ACK purge watermark as replay floor", async () => {
  const store = new FakeDeliveryStore({
    state: {
      inboxEpoch: 4,
      nextOffset: 11,
      lastAckedOffset: 6,
    },
  });
  const delivery = service(store);

  const wrongEpoch = await delivery.sync(actor, { cursor: "3:6" });
  assert.deepEqual(wrongEpoch, {
    kind: "RESET",
    response: {
      protocol_version: 1,
      code: "SYNC_RESET_REQUIRED",
      new_cursor: "4:0",
      events: [],
    },
  });

  const behindAckWatermark = await delivery.sync(actor, {
    cursor: "4:5",
  });
  assert.equal(behindAckWatermark.kind, "OK");
  assert.equal(behindAckWatermark.response.next_cursor, "4:5");

  const ahead = await delivery.sync(actor, { cursor: "4:11" });
  assert.equal(ahead.kind, "RESET");
  assert.equal(ahead.response.new_cursor, "4:10");

  const malformed = await delivery.sync(actor, { cursor: "bad" });
  assert.equal(malformed.kind, "RESET");
  assert.equal(malformed.response.new_cursor, "4:0");
});

test("content-free delete below ACK watermark remains replayable", async () => {
  const store = new FakeDeliveryStore({
    state: {
      inboxEpoch: 4,
      nextOffset: 10,
      lastAckedOffset: 9,
    },
    events: [contentEvent({
      offset: 8,
      eventId: "event-delete-8",
      eventType: "message.deleted",
      envelopeId: null,
      protectedPayload: null,
      renditionType: null,
      expiresAt: null,
      sourceRevision: 2,
    })],
  });

  const result = await service(store).sync(actor, {
    cursor: "4:7",
  });

  assert.equal(result.kind, "OK");
  assert.equal(result.response.next_cursor, "4:8");
  assert.equal(result.response.events[0].type, "message.deleted");
});

test("future cursor is rejected by the shared cursor decision helper", () => {
  assert.deepEqual(
    evaluateSyncCursor(
      {
        inboxEpoch: 4,
        nextOffset: 11,
        lastAckedOffset: 6,
      },
      {
        inboxEpoch: 4,
        afterOffset: 11,
      },
    ),
    {
      kind: "RESET_AHEAD",
      maximumIssuedOffset: 10,
    },
  );
});

test("sync never exposes a cross-tenant row returned by persistence", async () => {
  const store = new FakeDeliveryStore({
    events: [contentEvent({ tenantId: "tenant-2" })],
  });

  await assert.rejects(
    () =>
      service(store).sync(actor, {
        cursor: "4:8",
      }),
    /cross-tenant inbox event/,
  );
});

test("sync stops before a later unavailable payload instead of skipping earlier deliverable content", async () => {
  const store = new FakeDeliveryStore({
    state: {
      inboxEpoch: 4,
      nextOffset: 11,
      lastAckedOffset: 7,
    },
    events: [
      contentEvent({ offset: 8, eventId: "event-8" }),
      contentEvent({
        offset: 9,
        eventId: "event-9",
        protectedPayload: null,
        renditionType: null,
        expiresAt: null,
      }),
    ],
  });

  const result = await service(store).sync(actor, {
    cursor: "4:7",
  });

  assert.equal(result.kind, "OK");
  assert.equal(result.response.events.length, 1);
  assert.equal(result.response.events[0].event_id, "event-8");
  assert.equal(result.response.next_cursor, "4:8");
});

test("sync resets past an unavailable first payload", async () => {
  const store = new FakeDeliveryStore({
    state: {
      inboxEpoch: 4,
      nextOffset: 11,
      lastAckedOffset: 7,
    },
    events: [contentEvent({
      offset: 8,
      protectedPayload: null,
      renditionType: null,
      expiresAt: null,
    })],
  });

  const result = await service(store).sync(actor, {
    cursor: "4:7",
  });

  assert.equal(result.kind, "RESET");
  assert.equal(result.response.new_cursor, "4:8");
});

test("ACK uses server time and commits the batch in one transaction", async () => {
  const store = new FakeDeliveryStore({
    ackResults: ["ACKED", "ALREADY_ACKED"],
  });
  const delivery = service(
    store,
    "2026-10-04T09:30:00.000Z",
  );

  await delivery.acknowledge(actor, [
    {
      envelope_id: "envelope-1",
      persisted_at: "2026-10-04T09:29:00.000Z",
    },
    {
      envelope_id: "envelope-2",
      persisted_at: "2026-10-04T09:29:30.000Z",
    },
  ]);

  assert.equal(store.transactions, 1);
  const ackCalls = store.calls.filter(
    (call) => call.method === "acknowledgeEnvelope",
  );
  assert.equal(ackCalls.length, 2);
  assert.equal(
    ackCalls[0].input.ackedAt,
    "2026-10-04T09:30:00.000Z",
  );
  assert.equal(
    ackCalls[1].input.ackedAt,
    "2026-10-04T09:30:00.000Z",
  );
});

test("expired and foreign ACKs map to typed domain errors", async () => {
  const expired = new FakeDeliveryStore({
    ackResults: ["EXPIRED"],
  });
  await assert.rejects(
    () =>
      service(expired).acknowledge(actor, [{
        envelope_id: "expired",
        persisted_at: "2026-10-04T09:29:00.000Z",
      }]),
    (error) =>
      error instanceof DomainError &&
      error.code === "DELIVERY_EXPIRED",
  );

  const foreign = new FakeDeliveryStore({
    ackResults: ["NOT_FOUND"],
  });
  await assert.rejects(
    () =>
      service(foreign).acknowledge(actor, [{
        envelope_id: "foreign",
        persisted_at: "2026-10-04T09:29:00.000Z",
      }]),
    (error) =>
      error instanceof DomainError &&
      error.code === "NOT_AUTHORIZED",
  );
});

test("invalid ACK timestamps and batch sizes are rejected before persistence", async () => {
  const store = new FakeDeliveryStore();
  const delivery = service(store);

  await assert.rejects(
    () =>
      delivery.acknowledge(actor, [{
        envelope_id: "envelope-1",
        persisted_at: "not-a-date",
      }]),
    (error) =>
      error instanceof DomainError &&
      error.code === "INVALID_COMMAND",
  );

  assert.equal(
    store.calls.some(
      (call) => call.method === "acknowledgeEnvelope",
    ),
    false,
  );
});


test("sync normalizes translation.source_required control event without an envelope", async () => {
  const store = new FakeDeliveryStore();
  store.events.push({
    inboxEpoch: 1,
    offset: 1,
    eventId: "event-source-required",
    eventType: "translation.source_required",
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    envelopeId: null,
    sourceRevision: 2,
    protectedPayload: null,
    renditionType: null,
    envelopeStatus: null,
    expiresAt: null,
    translationId: "translation-1",
    sourceRef: "hmac-sha256:k1:opaque-ref",
    createdAt: "2026-10-04T12:00:00.000Z",
  });

  const delivery = service(store);
  const result = await delivery.sync(actor, {
    cursor: "1:0",
    limit: 10,
  });

  assert.equal(result.kind, "OK");
  assert.deepEqual(result.response.events, [{
    protocol_version: 1,
    event_id: "event-source-required",
    cursor: "1:1",
    type: "translation.source_required",
    server_time: "2026-10-04T12:00:00.000Z",
    tenant_id: "tenant-1",
    conversation_id: "conversation-1",
    payload: {
      translation_id: "translation-1",
      message_id: "message-1",
      source_revision: 2,
      source_ref: "hmac-sha256:k1:opaque-ref",
    },
  }]);
  assert.equal(result.response.next_cursor, "1:1");
});


test("sync skips ACKED and REVOKED content envelopes while preserving cursor continuity", async () => {
  const store = new FakeDeliveryStore({
    state: {
      inboxEpoch: 4,
      nextOffset: 12,
      lastAckedOffset: 0,
    },
    events: [
      contentEvent({
        offset: 8,
        eventId: "event-acked",
        envelopeStatus: "ACKED",
        protectedPayload: null,
        renditionType: null,
        expiresAt: null,
      }),
      contentEvent({
        offset: 9,
        eventId: "event-revoked",
        envelopeStatus: "REVOKED",
        protectedPayload: null,
        renditionType: null,
        expiresAt: null,
      }),
      contentEvent({
        offset: 10,
        eventId: "event-live",
        envelopeStatus: "PENDING",
      }),
    ],
  });

  const result = await service(store).sync(actor, {
    cursor: "4:7",
  });

  assert.equal(result.kind, "OK");
  assert.equal(result.response.events.length, 1);
  assert.equal(result.response.events[0].event_id, "event-live");
  assert.equal(result.response.next_cursor, "4:10");
});

test("expired content still forces a controlled sync reset", async () => {
  const store = new FakeDeliveryStore({
    state: {
      inboxEpoch: 4,
      nextOffset: 10,
      lastAckedOffset: 0,
    },
    events: [contentEvent({
      offset: 8,
      eventId: "event-expired",
      envelopeStatus: "EXPIRED",
      protectedPayload: null,
      renditionType: null,
      expiresAt: null,
    })],
  });

  const result = await service(store).sync(actor, {
    cursor: "4:7",
  });

  assert.equal(result.kind, "RESET");
  assert.equal(result.response.new_cursor, "4:8");
});


test("ACK racing with edit/delete revocation is terminal and idempotent", async () => {
  const store = new FakeDeliveryStore({
    ackResults: ["REVOKED"],
  });

  await service(store).acknowledge(actor, [{
    envelope_id: "revoked-by-mutation",
    persisted_at: "2026-10-04T09:29:00.000Z",
  }]);

  const ackCalls = store.calls.filter(
    (call) => call.method === "acknowledgeEnvelope",
  );
  assert.equal(ackCalls.length, 1);
});


test("sync opportunistically purges expired payloads before inbox replay", async () => {
  const store = new FakeDeliveryStore({
    events: [contentEvent({
      envelopeStatus: "EXPIRED",
      protectedPayload: null,
      renditionType: null,
      expiresAt: null,
    })],
  });

  const result = await service(
    store,
    "2026-10-04T09:45:00.000Z",
  ).sync(actor, {
    cursor: "4:8",
  });

  const expireCall = store.calls.find(
    (call) => call.method === "expirePendingDeviceEnvelopes",
  );
  const listCall = store.calls.find(
    (call) => call.method === "listInboxEvents",
  );

  assert.deepEqual(expireCall.input, {
    tenantId: "tenant-1",
    deviceId: "device-1",
    now: "2026-10-04T09:45:00.000Z",
  });
  assert.ok(
    store.calls.indexOf(expireCall) <
      store.calls.indexOf(listCall),
  );
  assert.equal(result.kind, "RESET");
});

test("invalid sync clock is rejected before opening persistence work", async () => {
  const store = new FakeDeliveryStore();

  await assert.rejects(
    () => service(store, "not-a-date").sync(actor),
    /Clock returned an invalid timestamp/,
  );

  assert.equal(store.transactions, 0);
});

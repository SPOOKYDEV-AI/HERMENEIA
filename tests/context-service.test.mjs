import test from "node:test";
import assert from "node:assert/strict";

import {
  ContextEngine,
} from "../.build/packages/context-engine/src/index.js";
import {
  ContextPreparationService,
  InMemoryContextPayloadStore,
} from "../.build/packages/context-service/src/index.js";

class FakeSnapshotStore {
  constructor() {
    this.snapshots = new Map();
    this.fail = false;
    this.rejectInsert = false;
  }

  async withTransaction(work) {
    const before = new Map(this.snapshots);
    try {
      return await work({});
    } catch (error) {
      this.snapshots = before;
      throw error;
    }
  }

  async getContextSnapshot(
    _tx,
    tenantId,
    snapshotId,
  ) {
    const value = this.snapshots.get(
      `${tenantId}:${snapshotId}`,
    );
    return value
      ? structuredClone(value)
      : undefined;
  }

  async insertContextSnapshot(
    _tx,
    tenantId,
    snapshot,
  ) {
    if (this.fail) {
      throw new Error("forced snapshot persistence failure");
    }
    if (this.rejectInsert) {
      return false;
    }

    const key = `${tenantId}:${snapshot.snapshotId}`;
    if (this.snapshots.has(key)) return false;

    this.snapshots.set(
      key,
      structuredClone(snapshot),
    );
    return true;
  }
}

function clockFixture() {
  let now = "2026-10-04T20:00:00.000Z";
  return {
    clock: {
      now() {
        return now;
      },
    },
    setNow(value) {
      now = value;
    },
  };
}

function ids() {
  let value = 0;
  return {
    next(prefix) {
      value += 1;
      return `${prefix}-${value}`;
    },
  };
}

const budget = {
  totalTokens: 192,
  systemReserveTokens: 24,
  currentMessageTokens: 24,
  safetyReserveTokens: 16,
  immediateReserveTokens: 64,
  activeEpisodeReserveTokens: 32,
  memoryReserveTokens: 32,
};

function prepareInput(overrides = {}) {
  return {
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    messageId: "message-8",
    sourceRevision: 1,
    recipientUserId: "user-b",
    targetLanguageTag: "fr-FR",
    targetProfileVersion: 3,
    currentMessageSequence: 8,
    currentOperationSequence: 8,
    erasureEpoch: 1,
    policyVersion: 1,
    tenantPolicyVersion: 1,
    strategy: "T2_ADAPTIVE_V1",
    state: {
      conversationId: "conversation-1",
      contextVersion: 2,
      processedPrefixOperationSequence: 7,
      processingGapOperationSequences: [],
      erasureEpoch: 1,
      policyVersion: 1,
      activeEpisodeId: null,
      activeEpisodeVersion: null,
      updatedAt: "2026-10-04T19:59:59.000Z",
    },
    candidates: [
      {
        candidateId: "recent-7",
        candidateType: "IMMEDIATE_MESSAGE",
        content: "private previous message",
        sourceMessageSequence: 7,
        causalThroughOperationSequence: 7,
        sourceRevisionRefs: ["message-7:1"],
        claimRefs: ["claim-7"],
        semanticScore: 0.8,
        temporalScore: 1,
        confidence: 0.9,
        importance: 0.7,
        tokenEstimate: 8,
        privacyScope: "TRANSIENT",
        erasureEpoch: 1,
      },
    ],
    budget,
    ...overrides,
  };
}

function fixture(payloadOptions = {}) {
  const { clock, setNow } = clockFixture();
  const store = new FakeSnapshotStore();
  const payloads = new InMemoryContextPayloadStore({
    clock,
    maxEntries: payloadOptions.maxEntries ?? 10,
    maxTotalChars:
      payloadOptions.maxTotalChars ?? 100_000,
  });

  const service = new ContextPreparationService({
    engine: new ContextEngine(),
    store,
    payloads,
    ids: ids(),
    clock,
    payloadTtlSeconds: 60,
  });

  return {
    service,
    store,
    payloads,
    setNow,
  };
}

test("context preparation persists content-free snapshot and keeps selected context transient", async () => {
  const { service, store, payloads } = fixture();

  const result = await service.prepare(
    prepareInput(),
  );

  assert.equal(
    result.requestedStrategy,
    "T2_ADAPTIVE_V1",
  );
  assert.equal(
    result.effectiveStrategy,
    "T2_ADAPTIVE_V1",
  );
  assert.equal(result.degradedReason, null);

  const snapshot =
    store.snapshots.get(
      `tenant-1:${result.snapshot.snapshotId}`,
    );
  assert.ok(snapshot);
  assert.equal(
    JSON.stringify(snapshot).includes(
      "private previous message",
    ),
    false,
  );
  assert.deepEqual(
    snapshot.selectedSourceRevisionRefs,
    ["message-7:1"],
  );

  const payload = payloads.get({
    tenantId: "tenant-1",
    snapshotId: result.snapshot.snapshotId,
  });
  assert.ok(payload);
  assert.equal(
    payload.selected[0].content,
    "private previous message",
  );
});

test("payload admission pressure degrades requested T2 to durable T0", async () => {
  const { service, store, payloads } = fixture({
    maxTotalChars: 1,
  });

  const result = await service.prepare(
    prepareInput(),
  );

  assert.equal(
    result.requestedStrategy,
    "T2_ADAPTIVE_V1",
  );
  assert.equal(result.effectiveStrategy, "T0");
  assert.equal(
    result.degradedReason,
    "CONTEXT_PAYLOAD_UNAVAILABLE",
  );
  assert.deepEqual(result.selected, []);
  assert.deepEqual(
    result.snapshot.selectedCandidateIds,
    [],
  );

  assert.ok(
    store.snapshots.has(
      `tenant-1:${result.snapshot.snapshotId}`,
    ),
  );
  assert.equal(
    payloads.get({
      tenantId: "tenant-1",
      snapshotId: result.snapshot.snapshotId,
    }),
    undefined,
  );
});

test("snapshot persistence failure removes newly admitted transient context", async () => {
  const { service, store, payloads } = fixture();
  store.fail = true;

  await assert.rejects(
    () => service.prepare(prepareInput()),
    /forced snapshot persistence failure/,
  );

  assert.deepEqual(payloads.stats(), {
    entries: 0,
    totalChars: 0,
  });
});

test("snapshot id collision removes newly admitted payload and fails closed", async () => {
  const { service, store, payloads } = fixture();
  store.rejectInsert = true;

  await assert.rejects(
    () => service.prepare(prepareInput()),
    /snapshot identifier already exists/,
  );

  assert.deepEqual(payloads.stats(), {
    entries: 0,
    totalChars: 0,
  });
});

test("T0 never allocates transient context payload", async () => {
  const { service, payloads } = fixture();

  const result = await service.prepare(
    prepareInput({
      strategy: "T0",
    }),
  );

  assert.equal(result.effectiveStrategy, "T0");
  assert.deepEqual(result.selected, []);
  assert.deepEqual(payloads.stats(), {
    entries: 0,
    totalChars: 0,
  });
});

test("context payload store expires records and never evicts admitted payload to make room", () => {
  const { clock, setNow } = clockFixture();
  const payloads = new InMemoryContextPayloadStore({
    clock,
    maxEntries: 1,
    maxTotalChars: 20,
  });

  const first = {
    tenantId: "tenant-1",
    snapshotId: "snapshot-1",
    selected: [{
      candidateId: "a",
      candidateType: "IMMEDIATE_MESSAGE",
      content: "first",
      tokenEstimate: 2,
      utility: 1,
      selectionReason: "IMMEDIATE_CONTEXT",
    }],
    createdAt: "2026-10-04T20:00:00.000Z",
    expiresAt: "2026-10-04T20:01:00.000Z",
  };

  assert.equal(payloads.put(first), true);
  assert.equal(
    payloads.put({
      ...first,
      snapshotId: "snapshot-2",
      selected: [{
        ...first.selected[0],
        candidateId: "b",
        content: "second",
      }],
    }),
    false,
  );

  assert.equal(
    payloads.get({
      tenantId: "tenant-1",
      snapshotId: "snapshot-1",
    }).selected[0].content,
    "first",
  );

  setNow("2026-10-04T20:01:00.000Z");
  assert.deepEqual(payloads.stats(), {
    entries: 0,
    totalChars: 0,
  });
});

test("context payload key collision never overwrites admitted context", () => {
  const { clock } = clockFixture();
  const payloads = new InMemoryContextPayloadStore({
    clock,
  });

  const record = {
    tenantId: "tenant-1",
    snapshotId: "snapshot-1",
    selected: [{
      candidateId: "a",
      candidateType: "IMMEDIATE_MESSAGE",
      content: "first",
      tokenEstimate: 2,
      utility: 1,
      selectionReason: "IMMEDIATE_CONTEXT",
    }],
    createdAt: "2026-10-04T20:00:00.000Z",
    expiresAt: "2026-10-04T20:01:00.000Z",
  };

  assert.equal(payloads.put(record), true);
  assert.equal(
    payloads.put({
      ...record,
      selected: [{
        ...record.selected[0],
        content: "replacement",
      }],
    }),
    false,
  );

  assert.equal(
    payloads.get({
      tenantId: "tenant-1",
      snapshotId: "snapshot-1",
    }).selected[0].content,
    "first",
  );
});


test("context resolver returns durable snapshot plus matching transient payload", async () => {
  const { service } = fixture();
  const prepared = await service.prepare(
    prepareInput(),
  );

  const resolved = await service.resolveForProvider({
    tenantId: "tenant-1",
    snapshotId: prepared.snapshot.snapshotId,
  });

  assert.equal(resolved.status, "READY");
  assert.deepEqual(
    resolved.snapshot,
    prepared.snapshot,
  );
  assert.equal(
    resolved.selected[0].content,
    "private previous message",
  );
});

test("T0 snapshot resolves READY without transient payload", async () => {
  const { service } = fixture();
  const prepared = await service.prepare(
    prepareInput({
      strategy: "T0",
    }),
  );

  const resolved = await service.resolveForProvider({
    tenantId: "tenant-1",
    snapshotId: prepared.snapshot.snapshotId,
  });

  assert.equal(resolved.status, "READY");
  assert.deepEqual(resolved.selected, []);
});

test("expired context payload never silently resolves as empty context", async () => {
  const { service, setNow } = fixture();
  const prepared = await service.prepare(
    prepareInput(),
  );

  setNow("2026-10-04T20:01:00.000Z");

  const resolved = await service.resolveForProvider({
    tenantId: "tenant-1",
    snapshotId: prepared.snapshot.snapshotId,
  });

  assert.equal(
    resolved.status,
    "PAYLOAD_UNAVAILABLE",
  );
});

test("context resolver detects transient payload integrity mismatch", async () => {
  const { clock } = clockFixture();
  const store = new FakeSnapshotStore();
  const preparedPayloads =
    new InMemoryContextPayloadStore({
      clock,
    });

  const service = new ContextPreparationService({
    engine: new ContextEngine(),
    store,
    payloads: preparedPayloads,
    ids: ids(),
    clock,
    payloadTtlSeconds: 60,
  });

  const prepared = await service.prepare(
    prepareInput(),
  );

  const wrongPayloads = {
    put() {
      return true;
    },
    get() {
      return {
        tenantId: "tenant-1",
        snapshotId: prepared.snapshot.snapshotId,
        selected: [{
          ...prepared.selected[0],
          candidateId: "wrong-candidate",
        }],
        createdAt: "2026-10-04T20:00:00.000Z",
        expiresAt: "2026-10-04T20:01:00.000Z",
      };
    },
    remove() {},
  };

  const resolver = new ContextPreparationService({
    engine: new ContextEngine(),
    store,
    payloads: wrongPayloads,
    ids: ids(),
    clock,
  });

  const resolved = await resolver.resolveForProvider({
    tenantId: "tenant-1",
    snapshotId: prepared.snapshot.snapshotId,
  });

  assert.equal(
    resolved.status,
    "PAYLOAD_INTEGRITY_MISMATCH",
  );
});

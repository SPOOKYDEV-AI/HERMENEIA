import test from "node:test";
import assert from "node:assert/strict";

import {
  TranslationContextPlanner,
} from "../.build/packages/context-planner/src/index.js";
import {
  InMemoryTransientSourceStore,
} from "../.build/packages/transient-source/src/index.js";

function clock() {
  return {
    now() {
      return "2026-10-04T20:00:00.000Z";
    },
  };
}

function request(overrides = {}) {
  return {
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    sourceMessageId: "message-8",
    sourceRevision: 1,
    recipientUserId: "user-b",
    targetLanguageTag: "fr-FR",
    targetProfileVersion: 3,
    ...overrides,
  };
}

function frame(overrides = {}) {
  return {
    currentSequence: 8,
    erasureEpoch: 2,
    recentMessages: [
      {
        messageId: "message-7",
        sourceRevision: 1,
        sequence: 7,
        acceptedAt: "2026-10-04T19:59:58.000Z",
      },
      {
        messageId: "message-6",
        sourceRevision: 2,
        sequence: 6,
        acceptedAt: "2026-10-04T19:59:55.000Z",
      },
      {
        messageId: "message-5",
        sourceRevision: 1,
        sequence: 5,
        acceptedAt: "2026-10-04T19:59:50.000Z",
      },
    ],
    ...overrides,
  };
}

function put(store, messageId, sourceRevision, text) {
  store.put({
    tenantId: "tenant-1",
    messageId,
    sourceRevision,
    sourceHash: `hash:${messageId}:${sourceRevision}`,
    source: {
      text,
      language_hint: "fr-FR",
    },
    createdAt: "2026-10-04T19:59:00.000Z",
    expiresAt: "2026-10-04T20:05:00.000Z",
  });
}

function fixture({
  planningFrame = frame(),
  state = null,
} = {}) {
  const transientSources =
    new InMemoryTransientSourceStore({
      clock: clock(),
      maxEntries: 20,
      maxApproxBytes: 100_000,
    });

  const planner = new TranslationContextPlanner({
    metadata: {
      async load(_input, recentMessageLimit) {
        assert.equal(recentMessageLimit, 6);
        return structuredClone(planningFrame);
      },
    },
    transientSources,
    stateSource: state === undefined
      ? undefined
      : {
          async load() {
            return state
              ? structuredClone(state)
              : null;
          },
        },
  });

  return { planner, transientSources };
}

test("planner chooses T1 from exact recent transient sources without durable state", async () => {
  const { planner, transientSources } = fixture();

  put(transientSources, "message-8", 1, "current source");
  put(transientSources, "message-7", 1, "recent seven");
  put(transientSources, "message-6", 2, "recent six");

  const result = await planner.load(request());

  assert.equal(result.strategy, "T1");
  assert.equal(result.state, null);
  assert.equal(result.currentSequence, 8);
  assert.equal(result.erasureEpoch, 2);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.candidateId),
    ["message:message-7:1", "message:message-6:2"],
  );
  assert.equal(
    result.candidates.every(
      (candidate) =>
        candidate.privacyScope === "TRANSIENT" &&
        candidate.erasureEpoch === 2 &&
        candidate.semanticScore === 0,
    ),
    true,
  );
  assert.equal(result.budget.currentMessageTokens, 4);
});

test("planner chooses T0 when no recent transient source survives", async () => {
  const { planner } = fixture();

  const result = await planner.load(request());

  assert.equal(result.strategy, "T0");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.state, null);
  assert.equal(result.budget.currentMessageTokens, 128);
});

test("planner chooses T2 only with compatible derived ContextState", async () => {
  const compatibleState = {
    conversationId: "conversation-1",
    contextVersion: 4,
    processedPrefixSequence: 7,
    processingGaps: [],
    erasureEpoch: 2,
    activeEpisodeId: "episode-1",
    activeEpisodeVersion: 3,
    updatedAt: "2026-10-04T19:59:59.000Z",
  };
  const { planner, transientSources } = fixture({
    state: compatibleState,
  });

  put(transientSources, "message-7", 1, "recent seven");

  const result = await planner.load(request());

  assert.equal(result.strategy, "T2_ADAPTIVE_V1");
  assert.deepEqual(result.state, compatibleState);
});

test("planner rejects stale derived state by degrading to T1 instead of fabricating compatibility", async () => {
  const { planner, transientSources } = fixture({
    state: {
      conversationId: "conversation-1",
      contextVersion: 9,
      processedPrefixSequence: 7,
      processingGaps: [],
      erasureEpoch: 1,
      activeEpisodeId: null,
      activeEpisodeVersion: null,
      updatedAt: "2026-10-04T19:59:59.000Z",
    },
  });

  put(transientSources, "message-7", 1, "recent seven");

  const result = await planner.load(request());

  assert.equal(result.strategy, "T1");
  assert.equal(result.state, null);
  assert.equal(result.erasureEpoch, 2);
});

test("planner never requires transient content that has expired or failed to load", async () => {
  const planner = new TranslationContextPlanner({
    metadata: {
      async load() {
        return frame();
      },
    },
    transientSources: {
      put() {
        return false;
      },
      get() {
        throw new Error("transient store unavailable");
      },
      remove() {},
    },
  });

  const result = await planner.load(request());

  assert.equal(result.strategy, "T0");
  assert.deepEqual(result.candidates, []);
});

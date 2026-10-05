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
    currentMessageSequence: 8,
    currentOperationSequence: 8,
    currentMessageAcceptedAt: "2026-10-04T20:00:00.000Z",
    currentSourceAuthorUserId: "user-a",
    erasureEpoch: 2,
    recentMessages: [
      {
        messageId: "message-7",
        sourceRevision: 1,
        messageSequence: 7,
        operationSequence: 7,
        acceptedAt: "2026-10-04T19:59:58.000Z",
      },
      {
        messageId: "message-6",
        sourceRevision: 2,
        messageSequence: 6,
        operationSequence: 6,
        acceptedAt: "2026-10-04T19:59:55.000Z",
      },
      {
        messageId: "message-5",
        sourceRevision: 1,
        messageSequence: 5,
        operationSequence: 5,
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
  derivedCandidates = undefined,
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
    derivedCandidates,
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
  assert.equal(result.currentMessageSequence, 8);
  assert.equal(result.currentOperationSequence, 8);
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

test("planner preserves edited prior-message operation sequence separately from message order", async () => {
  const { planner, transientSources } = fixture({
    planningFrame: frame({
      currentMessageSequence: 8,
      currentOperationSequence: 10,
      recentMessages: [
        {
          messageId: "message-7",
          sourceRevision: 2,
          messageSequence: 7,
          operationSequence: 9,
          acceptedAt: "2026-10-04T19:59:58.000Z",
        },
      ],
    }),
  });

  put(transientSources, "message-7", 2, "edited seven");

  const result = await planner.load(request());

  assert.equal(result.currentMessageSequence, 8);
  assert.equal(result.currentOperationSequence, 10);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceMessageSequence, 7);
  assert.equal(
    result.candidates[0].causalThroughOperationSequence,
    9,
  );
});

test("planner chooses T0 when no recent transient source survives", async () => {
  const { planner } = fixture();

  const result = await planner.load(request());

  assert.equal(result.strategy, "T0");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.state, null);
  assert.equal(result.budget.currentMessageTokens, 128);
});

test("compatible state does not falsely upgrade immediate-only context to T2", async () => {
  const compatibleState = {
    conversationId: "conversation-1",
    contextVersion: 4,
    processedPrefixOperationSequence: 7,
    processingGapOperationSequences: [],
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

  assert.equal(result.strategy, "T1");
  assert.deepEqual(result.state, compatibleState);
});

test("planner chooses T2 only when compatible state materialises a derived candidate", async () => {
  const compatibleState = {
    conversationId: "conversation-1",
    contextVersion: 4,
    processedPrefixOperationSequence: 7,
    processingGapOperationSequences: [],
    erasureEpoch: 2,
    activeEpisodeId: "episode-1",
    activeEpisodeVersion: 3,
    updatedAt: "2026-10-04T19:59:59.000Z",
  };

  const { planner, transientSources } = fixture({
    state: compatibleState,
    derivedCandidates: {
      async load(_input, state, planningFrame) {
        assert.equal(state.contextVersion, 4);
        assert.equal(planningFrame.currentOperationSequence, 8);
        return [{
          candidateId: "episode:episode-1:3",
          candidateType: "ACTIVE_EPISODE",
          content: "technical debugging episode",
          sourceMessageSequence: null,
          causalThroughOperationSequence: 7,
          sourceRevisionRefs: [],
          claimRefs: [],
          semanticScore: 0.7,
          temporalScore: 0.9,
          confidence: 0.8,
          importance: 0.7,
          explicitReference: false,
          activeEpisode: true,
          tokenEstimate: 6,
          privacyScope: "CHECKPOINT",
          erasureEpoch: 2,
          validUntil: null,
          correctionTrigger: null,
        }];
      },
    },
  });

  put(transientSources, "message-7", 1, "recent seven");

  const result = await planner.load(request());

  assert.equal(result.strategy, "T2_ADAPTIVE_V1");
  assert.equal(result.candidates.length, 2);
  assert.equal(
    result.candidates[1].candidateId,
    "episode:episode-1:3",
  );
});

test("derived-candidate failure degrades to T1 without blocking translation", async () => {
  const { planner, transientSources } = fixture({
    state: {
      conversationId: "conversation-1",
      contextVersion: 4,
      processedPrefixOperationSequence: 7,
      processingGapOperationSequences: [],
      erasureEpoch: 2,
      activeEpisodeId: "episode-1",
      activeEpisodeVersion: 3,
      updatedAt: "2026-10-04T19:59:59.000Z",
    },
    derivedCandidates: {
      async load() {
        throw new Error("enrichment unavailable");
      },
    },
  });

  put(transientSources, "message-7", 1, "recent seven");

  const result = await planner.load(request());

  assert.equal(result.strategy, "T1");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.candidateId),
    ["message:message-7:1"],
  );
});

test("planner excludes the current operation from historical processing gaps", async () => {
  const { planner, transientSources } = fixture({
    state: {
      conversationId: "conversation-1",
      contextVersion: 5,
      processedPrefixOperationSequence: 6,
      processingGapOperationSequences: [7, 8],
      erasureEpoch: 2,
      activeEpisodeId: null,
      activeEpisodeVersion: null,
      updatedAt: "2026-10-04T19:59:59.000Z",
    },
  });

  put(transientSources, "message-7", 1, "recent seven");

  const result = await planner.load(request());

  assert.deepEqual(
    result.state.processingGapOperationSequences,
    [7],
  );
  assert.equal(result.strategy, "T1");
});

test("planner discards state that has already processed the current operation", async () => {
  const { planner, transientSources } = fixture({
    state: {
      conversationId: "conversation-1",
      contextVersion: 6,
      processedPrefixOperationSequence: 8,
      processingGapOperationSequences: [],
      erasureEpoch: 2,
      activeEpisodeId: "episode-future",
      activeEpisodeVersion: 1,
      updatedAt: "2026-10-04T20:00:01.000Z",
    },
  });

  put(transientSources, "message-7", 1, "recent seven");

  const result = await planner.load(request());

  assert.equal(result.state, null);
  assert.equal(result.strategy, "T1");
});

test("planner rejects stale derived state by degrading to T1 instead of fabricating compatibility", async () => {
  const { planner, transientSources } = fixture({
    state: {
      conversationId: "conversation-1",
      contextVersion: 9,
      processedPrefixOperationSequence: 7,
      processingGapOperationSequences: [],
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

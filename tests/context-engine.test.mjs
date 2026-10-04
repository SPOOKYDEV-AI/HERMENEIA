import test from "node:test";
import assert from "node:assert/strict";

import {
  ContextEngine,
} from "../.build/packages/context-engine/src/index.js";

const budget = {
  totalTokens: 256,
  systemReserveTokens: 32,
  currentMessageTokens: 24,
  safetyReserveTokens: 16,
  immediateReserveTokens: 80,
  activeEpisodeReserveTokens: 48,
  memoryReserveTokens: 56,
};

function state(overrides = {}) {
  return {
    conversationId: "conversation-1",
    contextVersion: 3,
    processedPrefixSequence: 7,
    processingGaps: [],
    erasureEpoch: 2,
    activeEpisodeId: "episode-1",
    activeEpisodeVersion: 4,
    updatedAt: "2026-10-04T20:00:00.000Z",
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    candidateId: "candidate-1",
    candidateType: "IMMEDIATE_MESSAGE",
    content: "context",
    sourceSequence: 7,
    sourceRevisionRefs: ["message-7:1"],
    claimRefs: [],
    semanticScore: 0.8,
    temporalScore: 0.9,
    confidence: 0.9,
    importance: 0.7,
    explicitReference: false,
    activeEpisode: false,
    tokenEstimate: 8,
    privacyScope: "TRANSIENT",
    erasureEpoch: 2,
    validUntil: null,
    correctionTrigger: null,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    snapshotId: "snapshot-1",
    conversationId: "conversation-1",
    messageId: "message-8",
    currentSequence: 8,
    now: "2026-10-04T20:00:00.000Z",
    strategy: "T2_ADAPTIVE_V1",
    state: state(),
    candidates: [candidate()],
    budget,
    ...overrides,
  };
}

test("T0 emits no prior context and keeps snapshot content-free", () => {
  const engine = new ContextEngine();

  const result = engine.build(input({
    strategy: "T0",
    candidates: [
      candidate({ content: "TOP SECRET SOURCE BODY" }),
    ],
  }));

  assert.deepEqual(result.selected, []);
  assert.equal(result.snapshot.tokenEstimate, 0);
  assert.equal(
    JSON.stringify(result.snapshot).includes(
      "TOP SECRET SOURCE BODY",
    ),
    false,
  );
  assert.equal(result.metrics.candidatesSelected, 0);
});

test("T1 selects the most recent causal window in chronological payload order", () => {
  const engine = new ContextEngine({
    t1WindowSize: 3,
  });

  const result = engine.build(input({
    strategy: "T1",
    currentSequence: 10,
    messageId: "message-10",
    state: state({
      processedPrefixSequence: 9,
    }),
    candidates: [
      candidate({
        candidateId: "m5",
        sourceSequence: 5,
        content: "five",
      }),
      candidate({
        candidateId: "m7",
        sourceSequence: 7,
        content: "seven",
      }),
      candidate({
        candidateId: "m8",
        sourceSequence: 8,
        content: "eight",
      }),
      candidate({
        candidateId: "m9",
        sourceSequence: 9,
        content: "nine",
      }),
      candidate({
        candidateId: "future",
        sourceSequence: 10,
        content: "future must not leak",
      }),
    ],
  }));

  assert.deepEqual(
    result.selected.map((item) => item.candidateId),
    ["m7", "m8", "m9"],
  );
  assert.equal(
    result.selected.some((item) => item.candidateId === "future"),
    false,
  );
});

test("T2 reconciles causal gaps even when their utility is low", () => {
  const engine = new ContextEngine({
    minAdaptiveUtility: 0.95,
  });

  const result = engine.build(input({
    currentSequence: 11,
    messageId: "message-11",
    state: state({
      processedPrefixSequence: 8,
      processingGaps: [9, 10],
    }),
    candidates: [
      candidate({
        candidateId: "gap-9",
        sourceSequence: 9,
        content: "gap nine",
        semanticScore: 0,
        temporalScore: 0,
        confidence: 0,
        importance: 0,
      }),
      candidate({
        candidateId: "gap-10",
        sourceSequence: 10,
        content: "gap ten",
        semanticScore: 0,
        temporalScore: 0,
        confidence: 0,
        importance: 0,
      }),
    ],
  }));

  assert.deepEqual(
    result.selected.map((item) => item.candidateId),
    ["gap-9", "gap-10"],
  );
  assert.equal(
    result.selected.every(
      (item) =>
        item.selectionReason ===
        "FRESHNESS_RECONCILIATION",
    ),
    true,
  );
  assert.equal(result.snapshot.recoveryMode, "PARTIAL");
  assert.deepEqual(
    result.snapshot.processingGapRefs,
    [9, 10],
  );
  assert.equal(result.metrics.contextFreshnessGap, 2);
});

test("future source sequences are never eligible for context", () => {
  const engine = new ContextEngine();

  const result = engine.build(input({
    candidates: [
      candidate({
        candidateId: "future",
        sourceSequence: 8,
        content: "future",
        explicitReference: true,
      }),
    ],
  }));

  assert.equal(result.metrics.candidatesEligible, 0);
  assert.deepEqual(result.selected, []);
});

test("cold state can use a sanitised recovery checkpoint without fabricating history", () => {
  const engine = new ContextEngine();

  const result = engine.build(input({
    state: null,
    candidates: [
      candidate({
        candidateId: "checkpoint",
        candidateType: "RECOVERY_CHECKPOINT",
        sourceSequence: null,
        causalThroughSequence: 7,
        content: "validated terminology handles only",
        privacyScope: "CHECKPOINT",
        erasureEpoch: 0,
        semanticScore: 0.7,
        temporalScore: 0.8,
        confidence: 0.95,
        importance: 0.8,
        tokenEstimate: 12,
      }),
    ],
  }));

  assert.equal(result.snapshot.recoveryMode, "DEGRADED");
  assert.deepEqual(
    result.selected.map((item) => item.candidateId),
    ["checkpoint"],
  );
  assert.equal(
    result.selected[0].selectionReason,
    "RECOVERY_CHECKPOINT",
  );
});

test("explicit old-topic reference bypasses adaptive utility threshold", () => {
  const engine = new ContextEngine({
    minAdaptiveUtility: 0.99,
  });

  const result = engine.build(input({
    currentSequence: 100,
    messageId: "message-100",
    state: state({
      processedPrefixSequence: 99,
    }),
    candidates: [
      candidate({
        candidateId: "old-topic",
        candidateType: "ACTIVE_EPISODE",
        sourceSequence: 12,
        causalThroughSequence: 12,
        content: "old topic handle",
        semanticScore: 0.1,
        temporalScore: 0.01,
        confidence: 0.4,
        importance: 0.2,
        explicitReference: true,
        activeEpisode: false,
      }),
    ],
  }));

  assert.deepEqual(
    result.selected.map((item) => item.candidateId),
    ["old-topic"],
  );
  assert.equal(
    result.selected[0].selectionReason,
    "EXPLICIT_REFERENCE",
  );
});

test("stale memory loses to fresher context under a one-item budget", () => {
  const engine = new ContextEngine({
    minAdaptiveUtility: 0,
  });

  const tinyBudget = {
    ...budget,
    totalTokens: 88,
    systemReserveTokens: 32,
    currentMessageTokens: 24,
    safetyReserveTokens: 16,
    immediateReserveTokens: 16,
    activeEpisodeReserveTokens: 0,
    memoryReserveTokens: 0,
  };

  const result = engine.build(input({
    budget: tinyBudget,
    candidates: [
      candidate({
        candidateId: "stale",
        sourceSequence: 6,
        content: "stale",
        tokenEstimate: 16,
        semanticScore: 1,
        temporalScore: 0,
        confidence: 0.8,
        importance: 0.5,
      }),
      candidate({
        candidateId: "fresh",
        sourceSequence: 7,
        content: "fresh",
        tokenEstimate: 16,
        semanticScore: 0.85,
        temporalScore: 1,
        confidence: 0.8,
        importance: 0.5,
      }),
    ],
  }));

  assert.deepEqual(
    result.selected.map((item) => item.candidateId),
    ["fresh"],
  );
});

test("erasure epoch mismatch makes candidate ineligible", () => {
  const engine = new ContextEngine();

  const result = engine.build(input({
    candidates: [
      candidate({
        candidateId: "pre-erasure",
        erasureEpoch: 1,
        explicitReference: true,
      }),
    ],
  }));

  assert.equal(result.metrics.candidatesEligible, 0);
  assert.deepEqual(result.selected, []);
});

test("expired candidate is not selected", () => {
  const engine = new ContextEngine();

  const result = engine.build(input({
    candidates: [
      candidate({
        candidateId: "expired",
        validUntil: "2026-10-04T19:59:59.000Z",
        explicitReference: true,
      }),
    ],
  }));

  assert.deepEqual(result.selected, []);
});

test("durable correction memory requires an explicit correction trigger", () => {
  const engine = new ContextEngine();

  assert.throws(
    () =>
      engine.build(input({
        candidates: [
          candidate({
            candidateId: "bad-memory",
            candidateType: "CORRECTION_MEMORY",
            sourceSequence: null,
            causalThroughSequence: 7,
            privacyScope: "CORRECTION",
            correctionTrigger: null,
          }),
        ],
      })),
    /requires an explicit correction trigger/,
  );
});

test("explicit correction memory is admissible at bounded scope", () => {
  const engine = new ContextEngine();

  const result = engine.build(input({
    candidates: [
      candidate({
        candidateId: "correction",
        candidateType: "CORRECTION_MEMORY",
        sourceSequence: null,
        causalThroughSequence: 7,
        content: "CR means change request in this conversation",
        privacyScope: "CORRECTION",
        correctionTrigger: "EXPLICIT_REPAIR",
        semanticScore: 0.8,
        temporalScore: 0.9,
        confidence: 1,
        importance: 1,
      }),
    ],
  }));

  assert.deepEqual(
    result.selected.map((item) => item.candidateId),
    ["correction"],
  );
  assert.equal(
    result.selected[0].selectionReason,
    "CORRECTION_OR_POLICY",
  );
});

test("snapshot stores provenance refs but never candidate plaintext", () => {
  const engine = new ContextEngine();
  const secret = "private raw source must stay transient";

  const result = engine.build(input({
    candidates: [
      candidate({
        content: secret,
        sourceRevisionRefs: ["message-7:1"],
        claimRefs: ["claim-42"],
      }),
    ],
  }));

  assert.deepEqual(
    result.snapshot.selectedSourceRevisionRefs,
    ["message-7:1"],
  );
  assert.deepEqual(
    result.snapshot.selectedClaimRefs,
    ["claim-42"],
  );
  assert.equal(
    JSON.stringify(result.snapshot).includes(secret),
    false,
  );
});

test("same input produces deterministic selection and snapshot metadata", () => {
  const engine = new ContextEngine();
  const buildInput = input({
    candidates: [
      candidate({
        candidateId: "b",
        content: "B",
      }),
      candidate({
        candidateId: "a",
        content: "A",
      }),
    ],
  });

  const first = engine.build(buildInput);
  const second = engine.build(buildInput);

  assert.deepEqual(second, first);
});

test("crossing midnight does not reset context by itself", () => {
  const engine = new ContextEngine();

  const result = engine.build(input({
    now: "2026-10-05T00:00:02.000Z",
    state: state({
      updatedAt: "2026-10-04T23:59:58.000Z",
    }),
    candidates: [
      candidate({
        content: "still same episode",
      }),
    ],
  }));

  assert.equal(result.snapshot.recoveryMode, "FAST");
  assert.deepEqual(
    result.selected.map((item) => item.candidateId),
    ["candidate-1"],
  );
});

test("invalid fixed reserves are rejected before selection", () => {
  const engine = new ContextEngine();

  assert.throws(
    () =>
      engine.build(input({
        budget: {
          ...budget,
          totalTokens: 50,
          systemReserveTokens: 30,
          currentMessageTokens: 20,
          safetyReserveTokens: 10,
        },
      })),
    /Fixed context reserves exceed totalTokens/,
  );
});


test("derived checkpoint from the future is never eligible", () => {
  const engine = new ContextEngine();

  const result = engine.build(input({
    candidates: [
      candidate({
        candidateId: "future-checkpoint",
        candidateType: "RECOVERY_CHECKPOINT",
        sourceSequence: null,
        causalThroughSequence: 8,
        content: "must not leak from future state",
        privacyScope: "CHECKPOINT",
      }),
    ],
  }));

  assert.equal(result.metrics.candidatesEligible, 0);
  assert.deepEqual(result.selected, []);
});

test("derived episode from the future is never eligible", () => {
  const engine = new ContextEngine();

  const result = engine.build(input({
    currentSequence: 20,
    messageId: "message-20",
    state: state({
      processedPrefixSequence: 19,
    }),
    candidates: [
      candidate({
        candidateId: "future-episode",
        candidateType: "ACTIVE_EPISODE",
        sourceSequence: null,
        causalThroughSequence: 20,
        content: "future episode projection",
        activeEpisode: true,
      }),
    ],
  }));

  assert.deepEqual(result.selected, []);
});

test("derived episode and checkpoint candidates require a causal frontier", () => {
  const engine = new ContextEngine();

  for (const candidateType of [
    "ACTIVE_EPISODE",
    "RECOVERY_CHECKPOINT",
  ]) {
    assert.throws(
      () =>
        engine.build(input({
          candidates: [
            candidate({
              candidateId: `missing-frontier-${candidateType}`,
              candidateType,
              sourceSequence: null,
              causalThroughSequence: undefined,
            }),
          ],
        })),
      /require causalThroughSequence/,
    );
  }
});

test("correction memory requires a causal frontier in addition to a trigger", () => {
  const engine = new ContextEngine();

  assert.throws(
    () =>
      engine.build(input({
        candidates: [
          candidate({
            candidateId: "correction-without-frontier",
            candidateType: "CORRECTION_MEMORY",
            sourceSequence: null,
            causalThroughSequence: null,
            privacyScope: "CORRECTION",
            correctionTrigger: "EXPLICIT_REPAIR",
          }),
        ],
      })),
    /Correction memory requires causalThroughSequence/,
  );
});

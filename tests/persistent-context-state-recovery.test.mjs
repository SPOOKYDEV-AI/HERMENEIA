import test from "node:test";
import assert from "node:assert/strict";

import {
  createPostgresContextOperationRecorder,
} from "../.build/packages/runtime/src/persistent-context-state.js";

const TENANT =
  "10000000-0000-4000-8000-000000000001";
const CONVERSATION =
  "10000000-0000-4000-8000-000000000002";
const CLAIM =
  "10000000-0000-4000-8000-000000000003";
const EPISODE =
  "10000000-0000-4000-8000-000000000004";

function checkpoint(overrides = {}) {
  return {
    tenantId: TENANT,
    conversationId: CONVERSATION,
    checkpointVersion: 7,
    schemaVersion: 1,
    contextStrategyVersion:
      "context-state-v1",
    baseContextStateVersion: 7,
    processedPrefixOpSeq: 5,
    membershipEpoch: 2,
    erasureEpoch: 3,
    policyVersion: 4,
    tenantPolicyVersion: 5,
    payload: {
      schemaVersion: 1,
      activeEpisode: {
        episodeId: EPISODE,
        episodeVersion: 2,
        continuityConfidence: 0.9,
        startOperationSequence: 2,
        lastOperationSequence: 5,
        startedAt:
          "2026-10-05T19:00:00.000Z",
        lastActivityAt:
          "2026-10-05T19:50:00.000Z",
      },
      terminologyClaimRefs: [],
      lexicalClaimRefs: [],
      correctionClaimRefs: [CLAIM],
    },
    status: "ACTIVE",
    createdAt:
      "2026-10-05T19:55:00.000Z",
    expiresAt:
      "2026-10-06T19:55:00.000Z",
    ...overrides,
  };
}

function fixture({
  restoredCheckpoint =
    checkpoint(),
} = {}) {
  let state;
  const restoreCalls = [];

  const repository = {
    async loadState() {
      return state
        ? structuredClone(state)
        : undefined;
    },
    async insertState(_tx, value) {
      if (state) return false;
      state = structuredClone(value);
      return true;
    },
    async updateState() {
      throw new Error(
        "unexpected updateState",
      );
    },
  };

  const recoveryCheckpoints = {
    async loadValidForRestore(
      _tx,
      input,
    ) {
      restoreCalls.push(
        structuredClone(input),
      );
      return restoredCheckpoint
        ? structuredClone(
            restoredCheckpoint,
          )
        : undefined;
    },
  };

  const recorder =
    createPostgresContextOperationRecorder({
      repository,
      recoveryCheckpoints,
      strategyVersion:
        "context-state-v1",
    });

  return {
    recorder,
    state: () =>
      structuredClone(state),
    restoreCalls,
  };
}

const operation = {
  tenantId: TENANT,
  conversationId: CONVERSATION,
  operationId:
    "10000000-0000-4000-8000-000000000005",
  opSeq: 6,
  kind: "MESSAGE_CREATED",
  messageId:
    "10000000-0000-4000-8000-000000000006",
  sourceRevision: 1,
  membershipEpoch: 2,
  erasureEpoch: 3,
  policyVersion: 4,
  registeredAt:
    "2026-10-05T20:00:00.000Z",
};

test("missing ConversationState restores exact predecessor checkpoint before registering new operation", async () => {
  const f = fixture();

  await f.recorder.register(
    { id: "tx" },
    operation,
  );

  assert.equal(
    f.restoreCalls.length,
    1,
  );
  assert.deepEqual(
    f.restoreCalls[0],
    {
      tenantId: TENANT,
      conversationId: CONVERSATION,
      requiredProcessedPrefixOpSeq: 5,
      strategyVersion:
        "context-state-v1",
      now:
        "2026-10-05T20:00:00.000Z",
    },
  );

  const state = f.state();
  assert.equal(state.status, "ACTIVE");
  assert.equal(
    state.recoveryMode,
    "FULL",
  );
  assert.equal(
    state.processedPrefixOpSeq,
    5,
  );
  assert.deepEqual(
    state.correctionClaimRefs,
    [CLAIM],
  );
  assert.equal(
    state.activeEpisode.episodeId,
    EPISODE,
  );
  assert.deepEqual(
    state.pendingOperations.map(
      (item) => item.opSeq,
    ),
    [6],
  );
});

test("missing or unusable checkpoint keeps existing degraded-baseline fallback", async () => {
  for (const restoredCheckpoint of [
    undefined,
    checkpoint({
      processedPrefixOpSeq: 4,
    }),
  ]) {
    const f = fixture({
      restoredCheckpoint,
    });

    await f.recorder.register(
      { id: "tx" },
      operation,
    );

    const state = f.state();
    assert.equal(
      state.status,
      "DEGRADED",
    );
    assert.equal(
      state.recoveryMode,
      "DEGRADED_BASELINE",
    );
    assert.equal(
      state.causalFloorOpSeq,
      5,
    );
    assert.deepEqual(
      state.correctionClaimRefs,
      [],
    );
    assert.deepEqual(
      state.pendingOperations.map(
        (item) => item.opSeq,
      ),
      [6],
    );
  }
});

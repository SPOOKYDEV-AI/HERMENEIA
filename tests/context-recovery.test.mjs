import test from "node:test";
import assert from "node:assert/strict";

import {
  createInitialContextState,
} from "../.build/packages/context-state/src/index.js";
import {
  buildSanitisedRecoverySeed,
  restoreContextStateFromCheckpoint,
} from "../.build/packages/context-recovery/src/index.js";

const TENANT =
  "10000000-0000-4000-8000-000000000001";
const CONVERSATION =
  "10000000-0000-4000-8000-000000000002";
const EPISODE =
  "10000000-0000-4000-8000-000000000003";
const CLAIM_A =
  "10000000-0000-4000-8000-000000000004";
const CLAIM_B =
  "10000000-0000-4000-8000-000000000005";
const NOW = "2026-10-05T20:00:00.000Z";

function fullState() {
  const state = createInitialContextState({
    tenantId: TENANT,
    conversationId: CONVERSATION,
    membershipEpoch: 2,
    erasureEpoch: 3,
    policyVersion: 4,
    strategyVersion: "context-state-v1",
    now: NOW,
  });
  state.stateVersion = 7;
  state.processedPrefixOpSeq = 5;
  state.activeEpisode = {
    episodeId: EPISODE,
    episodeVersion: 2,
    continuityConfidence: 0.91,
    startOperationSequence: 2,
    lastOperationSequence: 5,
    startedAt: "2026-10-05T19:40:00.000Z",
    lastActivityAt: "2026-10-05T19:59:00.000Z",
  };
  state.terminologyClaimRefs = [CLAIM_A];
  state.correctionClaimRefs = [CLAIM_B];

  state.styleState = {
    profiles: [{
      speakerUserId:
        "10000000-0000-4000-8000-000000000006",
      preferredRegister: "FORMAL",
      sourceRepairEventId:
        "10000000-0000-4000-8000-000000000007",
      confidence: 1,
      updatedAt: NOW,
    }],
  };
  state.entityHandles = ["person:private"];
  state.unresolvedReferenceHandles = [
    "weak:maybe",
  ];
  state.pragmaticState = {
    stance: "WARM",
    confidence: 0.6,
  };
  return state;
}

test("sanitised recovery seed keeps only structural episode and authoritative claim refs", () => {
  const seed =
    buildSanitisedRecoverySeed(
      fullState(),
    );

  assert.ok(seed);
  assert.equal(
    seed.baseContextStateVersion,
    7,
  );
  assert.equal(seed.processedPrefixOpSeq, 5);
  assert.deepEqual(
    seed.payload.terminologyClaimRefs,
    [CLAIM_A],
  );
  assert.deepEqual(
    seed.payload.correctionClaimRefs,
    [CLAIM_B],
  );
  assert.equal(
    seed.payload.activeEpisode?.episodeId,
    EPISODE,
  );
  assert.equal(
    "styleState" in seed.payload,
    false,
  );
  assert.equal(
    "entityHandles" in seed.payload,
    false,
  );
  assert.equal(
    "pragmaticState" in seed.payload,
    false,
  );
});

test("checkpoint seed is withheld for degraded or causally dirty state", () => {
  const degraded = fullState();
  degraded.status = "DEGRADED";
  degraded.recoveryMode =
    "DEGRADED_BASELINE";

  assert.equal(
    buildSanitisedRecoverySeed(degraded),
    null,
  );

  const dirty = fullState();
  dirty.pendingOperations.push({
    opSeq: 6,
    operationId:
      "10000000-0000-4000-8000-000000000008",
    kind: "MESSAGE_CREATED",
    messageId:
      "10000000-0000-4000-8000-000000000009",
    sourceRevision: 1,
    status: "PENDING",
    registeredAt: NOW,
  });
  assert.equal(
    buildSanitisedRecoverySeed(dirty),
    null,
  );
});

test("restore requires exact causal predecessor and strips non-checkpointed working state", () => {
  const seed =
    buildSanitisedRecoverySeed(
      fullState(),
    );
  assert.ok(seed);

  const checkpoint = {
    tenantId: TENANT,
    conversationId: CONVERSATION,
    checkpointVersion: 7,
    schemaVersion: 1,
    contextStrategyVersion:
      seed.contextStrategyVersion,
    baseContextStateVersion:
      seed.baseContextStateVersion,
    processedPrefixOpSeq:
      seed.processedPrefixOpSeq,
    membershipEpoch:
      seed.membershipEpoch,
    erasureEpoch: seed.erasureEpoch,
    policyVersion: seed.policyVersion,
    tenantPolicyVersion: 6,
    payload: seed.payload,
    status: "ACTIVE",
    createdAt: NOW,
    expiresAt:
      "2026-10-06T20:00:00.000Z",
  };

  const restored =
    restoreContextStateFromCheckpoint(
      checkpoint,
      {
        tenantId: TENANT,
        conversationId: CONVERSATION,
        requiredProcessedPrefixOpSeq: 5,
        strategyVersion:
          "context-state-v1",
        now: "2026-10-05T20:05:00.000Z",
      },
    );

  assert.ok(restored);
  assert.equal(restored.status, "ACTIVE");
  assert.equal(
    restored.recoveryMode,
    "FULL",
  );
  assert.equal(
    restored.processedPrefixOpSeq,
    5,
  );
  assert.deepEqual(
    restored.terminologyClaimRefs,
    [CLAIM_A],
  );
  assert.deepEqual(
    restored.correctionClaimRefs,
    [CLAIM_B],
  );
  assert.deepEqual(
    restored.styleState,
    {},
  );
  assert.deepEqual(
    restored.entityHandles,
    [],
  );
  assert.deepEqual(
    restored.pragmaticState,
    {},
  );

  assert.equal(
    restoreContextStateFromCheckpoint(
      checkpoint,
      {
        tenantId: TENANT,
        conversationId: CONVERSATION,
        requiredProcessedPrefixOpSeq: 4,
        strategyVersion:
          "context-state-v1",
        now: "2026-10-05T20:05:00.000Z",
      },
    ),
    null,
  );
});

test("expired or strategy-mismatched checkpoint fails closed", () => {
  const seed =
    buildSanitisedRecoverySeed(
      fullState(),
    );
  assert.ok(seed);

  const checkpoint = {
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
    tenantPolicyVersion: 6,
    payload: seed.payload,
    status: "ACTIVE",
    createdAt: NOW,
    expiresAt:
      "2026-10-05T20:01:00.000Z",
  };

  assert.equal(
    restoreContextStateFromCheckpoint(
      checkpoint,
      {
        tenantId: TENANT,
        conversationId: CONVERSATION,
        requiredProcessedPrefixOpSeq: 5,
        strategyVersion:
          "context-state-v1",
        now: "2026-10-05T20:02:00.000Z",
      },
    ),
    null,
  );

  assert.equal(
    restoreContextStateFromCheckpoint(
      {
        ...checkpoint,
        expiresAt:
          "2026-10-06T20:00:00.000Z",
      },
      {
        tenantId: TENANT,
        conversationId: CONVERSATION,
        requiredProcessedPrefixOpSeq: 5,
        strategyVersion:
          "context-state-v2",
        now: "2026-10-05T20:02:00.000Z",
      },
    ),
    null,
  );
});

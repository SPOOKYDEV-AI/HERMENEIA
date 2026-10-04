import test from "node:test";
import assert from "node:assert/strict";

import {
  ContextStateConflictError,
  applyContextDerivation,
  completedTailRefs,
  createDegradedContextStateFromFloor,
  createInitialContextState,
  decideDurableCorrection,
  processingGapRefs,
  registerContextOperation,
} from "../.build/packages/context-state/src/index.js";

function initial() {
  return createInitialContextState({
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    processedPrefixOpSeq: 10,
    membershipEpoch: 2,
    erasureEpoch: 3,
    policyVersion: 4,
    strategyVersion: "context-v1",
    now: "2026-10-04T18:00:00.000Z",
  });
}

function operation(opSeq, operationId, overrides = {}) {
  return {
    opSeq,
    operationId,
    kind: "MESSAGE_CREATED",
    messageId: `message-${opSeq}`,
    sourceRevision: 1,
    registeredAt: "2026-10-04T18:00:01.000Z",
    ...overrides,
  };
}

function result(state, opSeq, operationId, overrides = {}) {
  return {
    conversationId: state.conversationId,
    operationId,
    opSeq,
    baseStateVersion: state.stateVersion,
    membershipEpoch: state.membershipEpoch,
    erasureEpoch: state.erasureEpoch,
    policyVersion: state.policyVersion,
    strategyVersion: state.strategyVersion,
    outcome: "PROCESSED",
    completedAt: "2026-10-04T18:00:02.000Z",
    ...overrides,
  };
}

test("out-of-order completion never advances the causal prefix through a gap", () => {
  let state = initial();
  state = registerContextOperation(state, operation(11, "op-11"));
  state = registerContextOperation(state, operation(12, "op-12"));

  state = applyContextDerivation(
    state,
    result(state, 12, "op-12", {
      patch: {
        entityHandles: ["entity:bug-cache"],
      },
    }),
  );

  assert.equal(state.processedPrefixOpSeq, 10);
  assert.deepEqual(
    processingGapRefs(state).map((item) => item.opSeq),
    [11],
  );
  assert.deepEqual(
    completedTailRefs(state).map((item) => item.opSeq),
    [12],
  );
  assert.deepEqual(
    state.entityHandles,
    [],
    "future op12 patch must stay invisible while op11 is unresolved",
  );

  state = applyContextDerivation(
    state,
    result(state, 11, "op-11"),
  );

  assert.equal(state.processedPrefixOpSeq, 12);
  assert.deepEqual(state.pendingOperations, []);
  assert.deepEqual(state.entityHandles, ["entity:bug-cache"]);
});

test("stale worker output cannot overwrite a newer Context State version", () => {
  let state = initial();
  state = registerContextOperation(state, operation(11, "op-11"));

  const staleBaseVersion = state.stateVersion;
  state = registerContextOperation(state, operation(12, "op-12"));

  assert.throws(
    () =>
      applyContextDerivation(state, {
        ...result(state, 11, "op-11"),
        baseStateVersion: staleBaseVersion,
      }),
    (error) =>
      error instanceof ContextStateConflictError &&
      error.code === "STALE_STATE_VERSION",
  );

  assert.equal(state.processedPrefixOpSeq, 10);
});

test("SOURCE_REQUIRED blocks the prefix and enters degraded state until resolved", () => {
  let state = initial();
  state = registerContextOperation(state, operation(11, "op-11"));

  state = applyContextDerivation(
    state,
    result(state, 11, "op-11", {
      outcome: "SOURCE_REQUIRED",
    }),
  );

  assert.equal(state.status, "DEGRADED");
  assert.equal(state.processedPrefixOpSeq, 10);
  assert.equal(state.pendingOperations[0].status, "SOURCE_REQUIRED");

  state = applyContextDerivation(
    state,
    result(state, 11, "op-11", {
      outcome: "PROCESSED",
      patch: {
        correctionClaimRefs: ["claim:correction-1"],
      },
      completedAt: "2026-10-04T18:00:03.000Z",
    }),
  );

  assert.equal(state.status, "ACTIVE");
  assert.equal(state.processedPrefixOpSeq, 11);
  assert.deepEqual(state.correctionClaimRefs, ["claim:correction-1"]);
});

test("edit/delete invalidation patch removes derived claims without replaying raw history", () => {
  let state = initial();
  state = registerContextOperation(
    state,
    operation(11, "op-create", {
      kind: "MESSAGE_CREATED",
    }),
  );
  state = applyContextDerivation(
    state,
    result(state, 11, "op-create", {
      patch: {
        activeEpisode: {
          episodeId: "episode:1",
          episodeVersion: 1,
          continuityConfidence: 0.9,
        },
        terminologyClaimRefs: ["claim:term-1", "claim:term-2"],
        lexicalClaimRefs: ["claim:lex-1"],
        correctionClaimRefs: ["claim:correction-1"],
      },
    }),
  );

  state = registerContextOperation(
    state,
    operation(12, "op-edit", {
      kind: "MESSAGE_EDITED",
      messageId: "message-11",
      sourceRevision: 2,
      registeredAt: "2026-10-04T18:00:04.000Z",
    }),
  );

  state = applyContextDerivation(
    state,
    result(state, 12, "op-edit", {
      patch: {
        removeClaimRefs: ["claim:term-1", "claim:lex-1"],
        clearActiveEpisode: true,
      },
      completedAt: "2026-10-04T18:00:05.000Z",
    }),
  );

  assert.deepEqual(state.terminologyClaimRefs, ["claim:term-2"]);
  assert.deepEqual(state.lexicalClaimRefs, []);
  assert.equal(state.activeEpisode, undefined);
  assert.equal(state.processedPrefixOpSeq, 12);
});

test("state patch accepts opaque handles only and rejects transcript-like free text", () => {
  let state = initial();
  state = registerContextOperation(state, operation(11, "op-11"));

  assert.throws(
    () =>
      applyContextDerivation(
        state,
        result(state, 11, "op-11", {
          patch: {
            entityHandles: [
              "This is a complete sentence copied from the conversation",
            ],
          },
        }),
      ),
    (error) =>
      error instanceof ContextStateConflictError &&
      error.code === "INVALID_STATE",
  );
});

test("registering the same operation is idempotent but op_seq ownership cannot change", () => {
  let state = initial();
  state = registerContextOperation(state, operation(11, "op-11"));
  const version = state.stateVersion;

  const retry = registerContextOperation(
    state,
    operation(11, "op-11"),
  );
  assert.deepEqual(retry, state);
  assert.equal(retry.stateVersion, version);

  assert.throws(
    () =>
      registerContextOperation(
        state,
        operation(11, "different-op"),
      ),
    (error) =>
      error instanceof ContextStateConflictError &&
      error.code === "OPERATION_CONFLICT",
  );
});

test("vague translation complaint marks context suspect but creates no durable semantic memory", () => {
  const decision = decideDurableCorrection({
    repairEventId: "repair-1",
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    actorUserId: "user-a",
    kind: "PROBLEM_REPORT",
    targetMessageId: "message-1",
    targetSourceRevision: 1,
    createdAt: "2026-10-04T18:10:00.000Z",
  });

  assert.deepEqual(decision, {
    action: "MARK_SUSPECT",
    durableClaim: null,
  });
});

test("explicit textual correction creates only conversation-scoped durable memory", () => {
  const decision = decideDurableCorrection({
    repairEventId: "repair-2",
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    actorUserId: "user-a",
    kind: "TERMINOLOGY_CORRECTION",
    trigger: "EXPLICIT_TEXTUAL_CORRECTION",
    targetMessageId: "message-1",
    targetSourceRevision: 1,
    conceptType: "TERMINOLOGY",
    surfaceForm: "CR",
    correctedMeaning: "compte rendu",
    scopeKind: "CONVERSATION",
    sensitivityClass: "NORMAL",
    createdAt: "2026-10-04T18:11:00.000Z",
  });

  assert.equal(decision.action, "CREATE_CORRECTION");
  assert.equal(
    decision.durableClaim?.retentionClass,
    "CORRECTIVE_DURABLE",
  );
  assert.equal(
    decision.durableClaim?.scopeConversationId,
    "conversation-1",
  );
  assert.equal(
    decision.durableClaim?.correctedMeaning,
    "compte rendu",
  );
});

test("ordinary chat correction cannot silently create tenant-wide policy", () => {
  const decision = decideDurableCorrection({
    repairEventId: "repair-3",
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    actorUserId: "user-a",
    kind: "TERMINOLOGY_CORRECTION",
    trigger: "EXPLICIT_TEXTUAL_CORRECTION",
    conceptType: "TERMINOLOGY",
    surfaceForm: "CR",
    correctedMeaning: "change request",
    scopeKind: "TENANT",
    createdAt: "2026-10-04T18:12:00.000Z",
  });

  assert.deepEqual(decision, {
    action: "NEEDS_CONFIRMATION",
    durableClaim: null,
  });
});

test("approved glossary action may create tenant-scoped correction memory", () => {
  const decision = decideDurableCorrection({
    repairEventId: "repair-4",
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    actorUserId: "admin-1",
    kind: "TERMINOLOGY_CORRECTION",
    trigger: "APPROVED_GLOSSARY_CHANGE",
    conceptType: "TERMINOLOGY",
    surfaceForm: "CR",
    correctedMeaning: "change request",
    scopeKind: "TENANT",
    sensitivityClass: "NORMAL",
    createdAt: "2026-10-04T18:13:00.000Z",
  });

  assert.equal(decision.action, "CREATE_CORRECTION");
  assert.equal(decision.durableClaim?.scopeKind, "TENANT");
  assert.equal(decision.durableClaim?.scopeConversationId, null);
});

test("restricted textual correction requires stronger confirmation before durable retention", () => {
  const decision = decideDurableCorrection({
    repairEventId: "repair-5",
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    actorUserId: "user-a",
    kind: "MEANING_CORRECTION",
    trigger: "EXPLICIT_TEXTUAL_CORRECTION",
    conceptType: "MEANING",
    correctedMeaning: "restricted semantic fact",
    scopeKind: "CONVERSATION",
    sensitivityClass: "RESTRICTED",
    createdAt: "2026-10-04T18:14:00.000Z",
  });

  assert.deepEqual(decision, {
    action: "NEEDS_CONFIRMATION",
    durableClaim: null,
  });
});


test("cold recovery starts at an explicit causal floor and stays degraded", () => {
  let state = createDegradedContextStateFromFloor({
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    causalFloorOpSeq: 250,
    membershipEpoch: 4,
    erasureEpoch: 2,
    policyVersion: 7,
    strategyVersion: "context-v1",
    now: "2026-10-04T19:00:00.000Z",
  });

  assert.equal(state.causalFloorOpSeq, 250);
  assert.equal(state.processedPrefixOpSeq, 250);
  assert.equal(state.recoveryMode, "DEGRADED_BASELINE");
  assert.equal(state.status, "DEGRADED");

  state = registerContextOperation(
    state,
    operation(251, "op-251", {
      registeredAt: "2026-10-04T19:00:01.000Z",
    }),
  );
  state = applyContextDerivation(
    state,
    result(state, 251, "op-251", {
      membershipEpoch: 4,
      erasureEpoch: 2,
      policyVersion: 7,
      completedAt: "2026-10-04T19:00:02.000Z",
    }),
  );

  assert.equal(state.processedPrefixOpSeq, 251);
  assert.equal(
    state.status,
    "DEGRADED",
    "new traffic cannot pretend missing pre-floor history was recovered",
  );
});

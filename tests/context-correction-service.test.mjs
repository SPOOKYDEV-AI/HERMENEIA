import test from "node:test";
import assert from "node:assert/strict";

import {
  ContextCorrectionService,
} from "../.build/packages/context-correction-service/src/index.js";
import {
  createInitialContextState,
} from "../.build/packages/context-state/src/index.js";

const TENANT =
  "10000000-0000-4000-8000-000000000001";
const USER =
  "10000000-0000-4000-8000-000000000002";
const DEVICE =
  "10000000-0000-4000-8000-000000000003";
const CONVERSATION =
  "10000000-0000-4000-8000-000000000004";
const COMMAND =
  "10000000-0000-4000-8000-000000000005";
const MESSAGE =
  "10000000-0000-4000-8000-000000000006";
const TRANSLATION =
  "10000000-0000-4000-8000-000000000007";
const OTHER_USER =
  "10000000-0000-4000-8000-000000000008";
const CLAIM =
  "10000000-0000-4000-8000-000000000009";
const OTHER_CLAIM =
  "10000000-0000-4000-8000-000000000010";
const PENDING_REPAIR =
  "10000000-0000-4000-8000-000000000011";
const NOW = "2026-10-05T11:00:00.000Z";

const actor = {
  tenantId: TENANT,
  userId: USER,
  deviceId: DEVICE,
};

function command(overrides = {}) {
  return {
    protocol_version: 1,
    command_id: COMMAND,
    conversation_id: CONVERSATION,
    kind: "TERMINOLOGY",
    requested_scope: "CONVERSATION",
    payload: {
      schema_version: 1,
      kind: "TERM_MEANING",
      surface_form: " CR ",
      meaning: " change request ",
      source_language_tag: "fr-FR",
    },
    ...overrides,
  };
}

function fixture({
  tenantRole = "MEMBER",
  conversationRole = "MODERATOR",
  authority = true,
  state = createInitialContextState({
    tenantId: TENANT,
    conversationId: CONVERSATION,
    membershipEpoch: 0,
    erasureEpoch: 0,
    policyVersion: 1,
    strategyVersion: "context-state-v1",
    now: NOW,
  }),
  translationTarget = {
    messageId: MESSAGE,
    sourceRevision: 1,
    authorUserId: OTHER_USER,
  },
  messageAuthorUserId = OTHER_USER,
  nextOperationSequence = 1,
  supersededClaims = [],
  revocableClaim = {
    claimId: CLAIM,
    claimVersion: 1,
    subjectUserId: USER,
  },
  reviewableRepair = {
    repairEventId: PENDING_REPAIR,
    actorUserId: OTHER_USER,
    targetMessageId: MESSAGE,
    targetSourceRevision: 1,
    kind: "TERMINOLOGY_CORRECTION",
    structuredPayload: {
      schema_version: 1,
      kind: "TERM_MEANING",
      surface_form: "CR",
      meaning: "change request",
      source_language_tag: "fr-FR",
    },
    originalCommandId:
      "12000000-0000-4000-8000-000000000001",
    commandType: "context.correction",
    commandFingerprint: JSON.stringify({
      v: 1,
      type: "context.correction",
      conversation_id: CONVERSATION,
      target_message_id: MESSAGE,
      target_source_revision: 1,
      target_translation_id: null,
      kind: "TERMINOLOGY",
      requested_scope: "CONVERSATION",
      payload: {
        schema_version: 1,
        kind: "TERM_MEANING",
        surface_form: "CR",
        meaning: "change request",
        source_language_tag: "fr-FR",
      },
    }),
  },
} = {}) {
  const receipts = new Map();
  const events = [];
  const claims = [];
  const provenance = [];
  const overrideProvenance = [];
  const invalidationProvenance = [];
  const revocations = [];
  const reviewTransitions = [];
  let currentState = state
    ? structuredClone(state)
    : undefined;
  let idCounter = 100;

  const transactions = {
    async withTransaction(work) {
      return work({});
    },
  };

  const commands = {
    async claimCommand(_tx, input) {
      const existing = receipts.get(input.commandId);
      if (existing) {
        return {
          claimed: false,
          existing: structuredClone(existing),
        };
      }
      receipts.set(input.commandId, {
        actorUserId: input.actor.userId,
        actorDeviceId: input.actor.deviceId,
        commandType: input.commandType,
        commandFingerprint: input.commandFingerprint,
        status: "IN_PROGRESS",
        result: {},
      });
      return { claimed: true };
    },

    async markCommandSucceeded(_tx, input) {
      receipts.set(input.commandId, {
        actorUserId: input.actorUserId,
        actorDeviceId: input.actorDeviceId,
        commandType: input.commandType,
        commandFingerprint: input.commandFingerprint,
        status: "SUCCEEDED",
        result: structuredClone(input.result),
      });
    },
  };

  const corrections = {
    async loadAuthority() {
      return authority
        ? {
            tenantRole,
            conversationRole,
            membershipEpoch: 0,
            erasureEpoch: 0,
            policyVersion: 1,
            nextOperationSequence,
          }
        : undefined;
    },

    async loadMessageRevisionTarget(_tx, input) {
      return (
        input.messageId === MESSAGE &&
        input.sourceRevision === 1
      )
        ? {
            messageId: MESSAGE,
            sourceRevision: 1,
            authorUserId:
              messageAuthorUserId,
          }
        : undefined;
    },

    async loadVisibleTranslationTarget() {
      return translationTarget
        ? structuredClone(translationTarget)
        : undefined;
    },

    async insertRepairEvent(_tx, input) {
      events.push(structuredClone(input));
    },

    async loadReviewableRepairEvent(
      _tx,
      input,
    ) {
      return (
        reviewableRepair &&
        input.repairEventId ===
          reviewableRepair.repairEventId
      )
        ? structuredClone(reviewableRepair)
        : undefined;
    },

    async updateRepairReviewStatus(
      _tx,
      input,
    ) {
      reviewTransitions.push(
        structuredClone(input),
      );
      return true;
    },

    async loadRevocableCorrectionClaim(
      _tx,
      input,
    ) {
      return (
        revocableClaim &&
        input.claimId === revocableClaim.claimId
      )
        ? structuredClone(revocableClaim)
        : undefined;
    },

    async revokeCorrectionClaim(_tx, input) {
      revocations.push(structuredClone(input));
      return true;
    },

    async invalidateSupersededCorrectionClaims() {
      return structuredClone(
        supersededClaims,
      );
    },

    async insertConfirmedClaim(_tx, input) {
      claims.push(structuredClone(input));
    },

    async insertClaimOverrideProvenance(
      _tx,
      input,
    ) {
      overrideProvenance.push(
        structuredClone(input),
      );
    },

    async insertClaimInvalidationProvenance(
      _tx,
      input,
    ) {
      invalidationProvenance.push(
        structuredClone(input),
      );
    },

    async insertRepairProvenance(_tx, input) {
      provenance.push(structuredClone(input));
    },
  };

  const stateStore = {
    async loadState() {
      return currentState
        ? structuredClone(currentState)
        : undefined;
    },

    async insertState(_tx, next) {
      if (currentState) return false;
      currentState = structuredClone(next);
      return true;
    },

    async updateState(_tx, input) {
      if (
        !currentState ||
        currentState.stateVersion !==
          input.expectedStateVersion
      ) {
        return false;
      }
      currentState = structuredClone(input.state);
      return true;
    },
  };

  const service = new ContextCorrectionService({
    transactions,
    commands,
    corrections,
    state: stateStore,
    ids: {
      next() {
        idCounter += 1;
        return (
          "20000000-0000-4000-8000-" +
          String(idCounter).padStart(12, "0")
        );
      },
    },
    clock: {
      now() {
        return NOW;
      },
    },
    strategyVersion: "context-state-v1",
  });

  return {
    service,
    receipts,
    events,
    claims,
    provenance,
    overrideProvenance,
    invalidationProvenance,
    revocations,
    reviewTransitions,
    state: () =>
      currentState
        ? structuredClone(currentState)
        : undefined,
  };
}

test("moderator conversation correction is atomically promoted into T2 state", async () => {
  const f = fixture();

  const result = await f.service.createCorrection(
    actor,
    command(),
  );

  assert.equal(result.status, "APPLIED");
  assert.equal(
    result.applied_scope,
    "CONVERSATION",
  );
  assert.match(
    result.repair_event_id,
    /^[0-9a-f-]{36}$/i,
  );
  assert.ok(result.claim_id);
  assert.equal(result.claim_version, 1);

  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].status, "APPLIED");
  assert.deepEqual(
    f.events[0].structuredPayload,
    {
      schema_version: 1,
      kind: "TERM_MEANING",
      surface_form: "CR",
      meaning: "change request",
      source_language_tag: "fr-FR",
    },
  );

  assert.equal(f.claims.length, 1);
  assert.equal(
    f.claims[0].scopeKind,
    "CONVERSATION",
  );
  assert.equal(
    f.claims[0].scopeConversationId,
    CONVERSATION,
  );
  assert.equal(
    f.claims[0].subjectUserId,
    null,
  );
  assert.equal(f.provenance.length, 1);
  assert.equal(
    f.provenance[0].repairEventId,
    result.repair_event_id,
  );

  assert.deepEqual(
    f.state().correctionClaimRefs,
    [result.claim_id],
  );
});

test("ordinary member cannot promote an unanchored shared correction", async () => {
  const f = fixture({
    conversationRole: "MEMBER",
  });

  const result = await f.service.createCorrection(
    actor,
    command(),
  );

  assert.deepEqual(
    {
      status: result.status,
      applied_scope: result.applied_scope,
      claim_id: result.claim_id,
    },
    {
      status: "NEEDS_CONFIRMATION",
      applied_scope: null,
      claim_id: null,
    },
  );
  assert.equal(f.events.length, 1);
  assert.equal(f.claims.length, 0);
  assert.equal(f.provenance.length, 0);
  assert.deepEqual(
    f.state().correctionClaimRefs,
    [],
  );
});

test("ordinary member can promote a conversation correction anchored to their own source message", async () => {
  const f = fixture({
    conversationRole: "MEMBER",
    messageAuthorUserId: USER,
  });

  const result = await f.service.createCorrection(
    actor,
    command({
      target_message_id: MESSAGE,
      target_source_revision: 1,
    }),
  );

  assert.equal(result.status, "APPLIED");
  assert.equal(
    result.applied_scope,
    "CONVERSATION",
  );
  assert.ok(result.claim_id);
  assert.equal(f.claims.length, 1);
  assert.equal(
    f.claims[0].subjectUserId,
    USER,
  );
  assert.deepEqual(
    f.state().correctionClaimRefs,
    [result.claim_id],
  );
});

test("ordinary member cannot promote a correction anchored to another speaker", async () => {
  const f = fixture({
    conversationRole: "MEMBER",
    messageAuthorUserId: OTHER_USER,
  });

  const result = await f.service.createCorrection(
    actor,
    command({
      target_message_id: MESSAGE,
      target_source_revision: 1,
    }),
  );

  assert.equal(
    result.status,
    "NEEDS_CONFIRMATION",
  );
  assert.equal(result.claim_id, null);
  assert.equal(f.claims.length, 0);
  assert.deepEqual(
    f.state().correctionClaimRefs,
    [],
  );
});

test("message-scoped correction remains a repair event and never leaks into conversation memory", async () => {
  const f = fixture();

  const result = await f.service.createCorrection(
    actor,
    command({
      requested_scope: "MESSAGE",
      target_message_id: MESSAGE,
      target_source_revision: 1,
    }),
  );

  assert.equal(result.status, "RECORDED");
  assert.equal(result.applied_scope, null);
  assert.equal(result.claim_id, null);
  assert.equal(f.claims.length, 0);
  assert.equal(f.events[0].targetMessageId, MESSAGE);
  assert.equal(f.events[0].targetSourceRevision, 1);
});

test("tone correction is retained for confirmation until style-memory semantics exist", async () => {
  const f = fixture();

  const result = await f.service.createCorrection(
    actor,
    command({
      kind: "TONE",
      payload: {
        schema_version: 1,
        kind: "TONE",
        preferred_register: "FORMAL",
      },
    }),
  );

  assert.equal(
    result.status,
    "NEEDS_CONFIRMATION",
  );
  assert.equal(result.claim_id, null);
  assert.equal(f.claims.length, 0);
  assert.equal(
    f.events[0].kind,
    "TONE_CORRECTION",
  );
});

test("tenant correction remains pending until tenant-wide claim distribution exists", async () => {
  for (const tenantRole of [
    "MEMBER",
    "ADMIN",
    "OWNER",
  ]) {
    const f = fixture({
      conversationRole: "MODERATOR",
      tenantRole,
    });

    const result =
      await f.service.createCorrection(
        actor,
        command({
          requested_scope: "TENANT",
        }),
      );

    assert.equal(
      result.status,
      "NEEDS_CONFIRMATION",
    );
    assert.equal(
      result.applied_scope,
      null,
    );
    assert.equal(result.claim_id, null);
    assert.equal(f.claims.length, 0);
    assert.equal(f.provenance.length, 0);
  }
});

test("correction command replay is idempotent and does not duplicate repair or claim state", async () => {
  const f = fixture();

  const first = await f.service.createCorrection(
    actor,
    command(),
  );
  const replay = await f.service.createCorrection(
    actor,
    command(),
  );

  assert.deepEqual(replay, first);
  assert.equal(f.events.length, 1);
  assert.equal(f.claims.length, 1);
  assert.equal(f.provenance.length, 1);
  assert.deepEqual(
    f.state().correctionClaimRefs,
    [first.claim_id],
  );
});

test("reusing a correction command id with different payload is rejected", async () => {
  const f = fixture();
  await f.service.createCorrection(
    actor,
    command(),
  );

  await assert.rejects(
    () =>
      f.service.createCorrection(
        actor,
        command({
          payload: {
            schema_version: 1,
            kind: "TERM_MEANING",
            surface_form: "CR",
            meaning: "compte rendu",
          },
        }),
      ),
    (error) =>
      error?.code ===
      "IDEMPOTENCY_CONFLICT",
  );
});

test("translation and message targets must resolve to the same source revision", async () => {
  const f = fixture({
    translationTarget: {
      messageId:
        "30000000-0000-4000-8000-000000000001",
      sourceRevision: 2,
      authorUserId: OTHER_USER,
    },
  });

  await assert.rejects(
    () =>
      f.service.createCorrection(
        actor,
        command({
          target_message_id: MESSAGE,
          target_source_revision: 1,
          target_translation_id: TRANSLATION,
        }),
      ),
    (error) =>
      error?.code === "INVALID_COMMAND",
  );
});

test("authorised correction creates missing ConversationState at the existing causal floor", async () => {
  const f = fixture({
    state: null,
    nextOperationSequence: 8,
  });

  const result = await f.service.createCorrection(
    actor,
    command(),
  );

  assert.equal(result.status, "APPLIED");
  assert.equal(f.state().membershipEpoch, 0);
  assert.equal(f.state().erasureEpoch, 0);
  assert.equal(f.state().policyVersion, 1);
  assert.equal(
    f.state().processedPrefixOpSeq,
    7,
  );
  assert.equal(
    f.state().causalFloorOpSeq,
    7,
  );
  assert.equal(
    f.state().recoveryMode,
    "DEGRADED_BASELINE",
  );
  assert.deepEqual(
    f.state().correctionClaimRefs,
    [result.claim_id],
  );
});

test("message-scoped correction requires a concrete target", async () => {
  const f = fixture();

  await assert.rejects(
    () =>
      f.service.createCorrection(
        actor,
        command({
          requested_scope: "MESSAGE",
        }),
      ),
    (error) =>
      error?.code === "INVALID_COMMAND",
  );
});


test("new self-correction supersedes prior same-key claim and replaces its ConversationState ref", async () => {
  const existingState = createInitialContextState({
    tenantId: TENANT,
    conversationId: CONVERSATION,
    membershipEpoch: 0,
    erasureEpoch: 0,
    policyVersion: 1,
    strategyVersion: "context-state-v1",
    now: NOW,
  });
  existingState.correctionClaimRefs = [
    "old-claim",
  ];

  const f = fixture({
    conversationRole: "MEMBER",
    messageAuthorUserId: USER,
    state: existingState,
    supersededClaims: [{
      claimId: "old-claim",
      claimVersion: 2,
    }],
  });

  const result = await f.service.createCorrection(
    actor,
    command({
      target_message_id: MESSAGE,
      target_source_revision: 1,
    }),
  );

  assert.equal(result.status, "APPLIED");
  assert.ok(result.claim_id);
  assert.equal(f.overrideProvenance.length, 1);
  assert.deepEqual(
    {
      oldId:
        f.overrideProvenance[0].overriddenClaimId,
      oldVersion:
        f.overrideProvenance[0].overriddenClaimVersion,
      replacement:
        f.overrideProvenance[0].replacementClaimId,
    },
    {
      oldId: "old-claim",
      oldVersion: 2,
      replacement: result.claim_id,
    },
  );
  assert.deepEqual(
    f.state().correctionClaimRefs,
    [result.claim_id],
  );
});


function revokeCommand(overrides = {}) {
  return {
    protocol_version: 1,
    command_id:
      "11000000-0000-4000-8000-000000000001",
    conversation_id: CONVERSATION,
    claim_id: CLAIM,
    ...overrides,
  };
}

test("member can revoke their own speaker-scoped correction and remove it from working state", async () => {
  const existingState = createInitialContextState({
    tenantId: TENANT,
    conversationId: CONVERSATION,
    membershipEpoch: 0,
    erasureEpoch: 0,
    policyVersion: 1,
    strategyVersion: "context-state-v1",
    now: NOW,
  });
  existingState.correctionClaimRefs = [CLAIM];

  const f = fixture({
    conversationRole: "MEMBER",
    state: existingState,
    revocableClaim: {
      claimId: CLAIM,
      claimVersion: 2,
      subjectUserId: USER,
    },
  });

  const result = await f.service.revokeCorrection(
    actor,
    revokeCommand(),
  );

  assert.deepEqual(result, {
    protocol_version: 1,
    repair_event_id: result.repair_event_id,
    claim_id: CLAIM,
    claim_version: 2,
    status: "REVOKED",
  });
  assert.equal(f.events.length, 1);
  assert.equal(
    f.events[0].kind,
    "EXPLICIT_CORRECTION",
  );
  assert.equal(f.events[0].status, "APPLIED");
  assert.deepEqual(
    f.events[0].structuredPayload,
    {
      schema_version: 1,
      action: "REVOKE_CORRECTION",
      claim_id: CLAIM,
      claim_version: 2,
    },
  );
  assert.equal(f.revocations.length, 1);
  assert.equal(
    f.revocations[0].claimId,
    CLAIM,
  );
  assert.equal(
    f.invalidationProvenance.length,
    1,
  );
  assert.equal(
    f.invalidationProvenance[0].repairEventId,
    result.repair_event_id,
  );
  assert.deepEqual(
    f.state().correctionClaimRefs,
    [],
  );
});

test("moderator or tenant owner cannot revoke another speaker's explicit meaning correction", async () => {
  const f = fixture({
    tenantRole: "OWNER",
    conversationRole: "MODERATOR",
    revocableClaim: {
      claimId: CLAIM,
      claimVersion: 1,
      subjectUserId: OTHER_USER,
    },
  });

  await assert.rejects(
    () =>
      f.service.revokeCorrection(
        actor,
        revokeCommand(),
      ),
    (error) =>
      error?.code === "NOT_AUTHORIZED",
  );

  assert.equal(f.revocations.length, 0);
  assert.equal(f.events.length, 0);
});

test("ordinary member cannot revoke a generic correction", async () => {
  const f = fixture({
    tenantRole: "MEMBER",
    conversationRole: "MEMBER",
    revocableClaim: {
      claimId: CLAIM,
      claimVersion: 1,
      subjectUserId: null,
    },
  });

  await assert.rejects(
    () =>
      f.service.revokeCorrection(
        actor,
        revokeCommand(),
      ),
    (error) =>
      error?.code === "NOT_AUTHORIZED",
  );
  assert.equal(f.revocations.length, 0);
});

test("moderator can revoke a generic correction", async () => {
  const existingState = createInitialContextState({
    tenantId: TENANT,
    conversationId: CONVERSATION,
    membershipEpoch: 0,
    erasureEpoch: 0,
    policyVersion: 1,
    strategyVersion: "context-state-v1",
    now: NOW,
  });
  existingState.correctionClaimRefs = [CLAIM];

  const f = fixture({
    tenantRole: "MEMBER",
    conversationRole: "MODERATOR",
    state: existingState,
    revocableClaim: {
      claimId: CLAIM,
      claimVersion: 1,
      subjectUserId: null,
    },
  });

  const result = await f.service.revokeCorrection(
    actor,
    revokeCommand(),
  );

  assert.equal(result.status, "REVOKED");
  assert.equal(f.revocations.length, 1);
  assert.deepEqual(
    f.state().correctionClaimRefs,
    [],
  );
});

test("tenant admin can revoke a generic correction without moderator role", async () => {
  const f = fixture({
    tenantRole: "ADMIN",
    conversationRole: "MEMBER",
    revocableClaim: {
      claimId: CLAIM,
      claimVersion: 1,
      subjectUserId: null,
    },
  });

  const result = await f.service.revokeCorrection(
    actor,
    revokeCommand(),
  );
  assert.equal(result.status, "REVOKED");
});

test("correction revocation replay is idempotent and command-id reuse is fenced", async () => {
  const f = fixture();

  const first = await f.service.revokeCorrection(
    actor,
    revokeCommand(),
  );
  const replay = await f.service.revokeCorrection(
    actor,
    revokeCommand(),
  );

  assert.deepEqual(replay, first);
  assert.equal(f.events.length, 1);
  assert.equal(f.revocations.length, 1);
  assert.equal(
    f.invalidationProvenance.length,
    1,
  );

  await assert.rejects(
    () =>
      f.service.revokeCorrection(
        actor,
        revokeCommand({
          claim_id: OTHER_CLAIM,
        }),
      ),
    (error) =>
      error?.code ===
      "IDEMPOTENCY_CONFLICT",
  );
});

test("inactive or unavailable correction claim fails closed without revealing its state", async () => {
  const f = fixture({
    revocableClaim: null,
  });

  await assert.rejects(
    () =>
      f.service.revokeCorrection(
        actor,
        revokeCommand(),
      ),
    (error) =>
      error?.code === "NOT_AUTHORIZED",
  );

  assert.equal(f.events.length, 0);
  assert.equal(f.revocations.length, 0);
});


function reviewCommand(overrides = {}) {
  return {
    protocol_version: 1,
    command_id:
      "13000000-0000-4000-8000-000000000001",
    conversation_id: CONVERSATION,
    repair_event_id: PENDING_REPAIR,
    decision: "APPROVE",
    ...overrides,
  };
}

test("ordinary member cannot review pending correction signals", async () => {
  const f = fixture({
    tenantRole: "MEMBER",
    conversationRole: "MEMBER",
  });

  await assert.rejects(
    () =>
      f.service.reviewCorrection(
        actor,
        reviewCommand(),
      ),
    (error) =>
      error?.code === "NOT_AUTHORIZED",
  );

  assert.equal(f.events.length, 0);
  assert.equal(f.claims.length, 0);
});

test("moderator approval promotes the original structured proposal as generic conversation correction", async () => {
  const f = fixture({
    tenantRole: "MEMBER",
    conversationRole: "MODERATOR",
  });

  const result = await f.service.reviewCorrection(
    actor,
    reviewCommand(),
  );

  assert.equal(result.status, "APPLIED");
  assert.ok(result.claim_id);
  assert.equal(result.claim_version, 1);
  assert.equal(f.reviewTransitions.length, 1);
  assert.deepEqual(
    f.reviewTransitions[0],
    {
      tenantId: TENANT,
      repairEventId: PENDING_REPAIR,
      status: "APPLIED",
    },
  );

  const reviewEvent = f.events.at(-1);
  assert.equal(
    reviewEvent.kind,
    "EXPLICIT_CORRECTION",
  );
  assert.equal(reviewEvent.status, "APPLIED");
  assert.deepEqual(
    reviewEvent.structuredPayload,
    {
      schema_version: 1,
      action:
        "APPROVE_PENDING_CORRECTION",
      source_repair_event_id:
        PENDING_REPAIR,
      proposal_actor_user_id:
        OTHER_USER,
    },
  );

  assert.equal(f.claims.length, 1);
  assert.equal(
    f.claims[0].subjectUserId,
    null,
  );
  assert.equal(
    f.claims[0].scopeKind,
    "CONVERSATION",
  );
  assert.deepEqual(
    f.claims[0].propositionRef,
    {
      schema_version: 1,
      kind: "TERM_MEANING",
      surface_form: "CR",
      meaning: "change request",
      source_language_tag: "fr-FR",
    },
  );
  assert.equal(f.provenance.length, 1);
  assert.equal(
    f.provenance[0].repairEventId,
    result.review_event_id,
  );
  assert.deepEqual(
    f.state().correctionClaimRefs,
    [result.claim_id],
  );
});

test("vague feedback cannot be approved as semantic correction memory", async () => {
  const f = fixture({
    reviewableRepair: {
      repairEventId: PENDING_REPAIR,
      actorUserId: OTHER_USER,
      targetMessageId: MESSAGE,
      targetSourceRevision: 1,
      kind: "MEANING_CORRECTION",
      structuredPayload: {
        schema_version: 1,
        feedback_kind: "WRONG_MEANING",
        note_present: true,
        note_length: 12,
      },
      originalCommandId:
        "12000000-0000-4000-8000-000000000002",
      commandType: "translation.feedback",
      commandFingerprint:
        JSON.stringify({
          v: 1,
          type: "translation.feedback",
        }),
    },
  });

  await assert.rejects(
    () =>
      f.service.reviewCorrection(
        actor,
        reviewCommand(),
      ),
    (error) =>
      error?.code === "INVALID_COMMAND",
  );
  assert.equal(f.claims.length, 0);
  assert.equal(f.events.length, 0);
});

test("moderator may reject a vague pending feedback without creating memory", async () => {
  const f = fixture({
    reviewableRepair: {
      repairEventId: PENDING_REPAIR,
      actorUserId: OTHER_USER,
      targetMessageId: MESSAGE,
      targetSourceRevision: 1,
      kind: "MEANING_CORRECTION",
      structuredPayload: {
        schema_version: 1,
        feedback_kind: "WRONG_MEANING",
        note_present: false,
        note_length: 0,
      },
      originalCommandId:
        "12000000-0000-4000-8000-000000000003",
      commandType: "translation.feedback",
      commandFingerprint: null,
    },
  });

  const result = await f.service.reviewCorrection(
    actor,
    reviewCommand({
      decision: "REJECT",
    }),
  );

  assert.equal(result.status, "REJECTED");
  assert.equal(result.claim_id, null);
  assert.equal(result.claim_version, null);
  assert.equal(f.claims.length, 0);
  assert.deepEqual(
    f.reviewTransitions,
    [{
      tenantId: TENANT,
      repairEventId: PENDING_REPAIR,
      status: "REJECTED",
    }],
  );
  assert.equal(
    f.events.at(-1).structuredPayload.action,
    "REJECT_PENDING_REPAIR",
  );
});

test("pending tenant-wide correction cannot be approved through conversation review", async () => {
  const f = fixture({
    tenantRole: "OWNER",
    conversationRole: "MODERATOR",
    reviewableRepair: {
      repairEventId: PENDING_REPAIR,
      actorUserId: OTHER_USER,
      targetMessageId: null,
      targetSourceRevision: null,
      kind: "TERMINOLOGY_CORRECTION",
      structuredPayload: {
        schema_version: 1,
        kind: "TERM_MEANING",
        surface_form: "CR",
        meaning: "change request",
      },
      originalCommandId:
        "12000000-0000-4000-8000-000000000004",
      commandType: "context.correction",
      commandFingerprint:
        JSON.stringify({
          v: 1,
          type: "context.correction",
          conversation_id: CONVERSATION,
          target_message_id: null,
          target_source_revision: null,
          target_translation_id: null,
          kind: "TERMINOLOGY",
          requested_scope: "TENANT",
          payload: {
            schema_version: 1,
            kind: "TERM_MEANING",
            surface_form: "CR",
            meaning: "change request",
          },
        }),
    },
  });

  await assert.rejects(
    () =>
      f.service.reviewCorrection(
        actor,
        reviewCommand(),
      ),
    (error) =>
      error?.code === "INVALID_COMMAND",
  );
  assert.equal(f.claims.length, 0);
});

test("pending correction review is idempotent and decision changes conflict", async () => {
  const f = fixture();

  const first = await f.service.reviewCorrection(
    actor,
    reviewCommand(),
  );
  const replay = await f.service.reviewCorrection(
    actor,
    reviewCommand(),
  );

  assert.deepEqual(replay, first);
  assert.equal(f.reviewTransitions.length, 1);
  assert.equal(f.claims.length, 1);

  await assert.rejects(
    () =>
      f.service.reviewCorrection(
        actor,
        reviewCommand({
          decision: "REJECT",
        }),
      ),
    (error) =>
      error?.code ===
      "IDEMPOTENCY_CONFLICT",
  );
});

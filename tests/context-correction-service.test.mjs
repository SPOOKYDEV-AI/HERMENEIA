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
} = {}) {
  const receipts = new Map();
  const events = [];
  const claims = [];
  const provenance = [];
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

    async insertConfirmedClaim(_tx, input) {
      claims.push(structuredClone(input));
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

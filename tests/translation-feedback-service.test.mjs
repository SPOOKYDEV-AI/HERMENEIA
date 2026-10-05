import test from "node:test";
import assert from "node:assert/strict";

import {
  TranslationFeedbackService,
} from "../.build/packages/translation-feedback-service/src/index.js";
import {
  createHmacSourceFingerprinter,
} from "../apps/api/source-fingerprint.mjs";

const TENANT =
  "40000000-0000-4000-8000-000000000001";
const USER =
  "40000000-0000-4000-8000-000000000002";
const DEVICE =
  "40000000-0000-4000-8000-000000000003";
const TRANSLATION =
  "40000000-0000-4000-8000-000000000004";
const COMMAND =
  "40000000-0000-4000-8000-000000000005";
const CONVERSATION =
  "40000000-0000-4000-8000-000000000006";
const MESSAGE =
  "40000000-0000-4000-8000-000000000007";
const NOW = "2026-10-05T12:00:00.000Z";

const actor = {
  tenantId: TENANT,
  userId: USER,
  deviceId: DEVICE,
};

function makeFingerprinter({
  version = "v1",
  keyByte = 1,
  verificationKeys = [],
} = {}) {
  return createHmacSourceFingerprinter({
    key: Buffer.alloc(32, keyByte),
    keyVersion: version,
    verificationKeys,
  });
}

function fixture({
  eligible = true,
  receipts = new Map(),
  repairs = [],
  fingerprinter = makeFingerprinter(),
} = {}) {
  let idCounter = 100;

  const service = new TranslationFeedbackService({
    transactions: {
      async withTransaction(work) {
        return work({});
      },
    },
    commands: {
      async claimCommand(_tx, input) {
        const existing =
          receipts.get(input.commandId);
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
          commandFingerprint:
            input.commandFingerprint,
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
          commandFingerprint:
            input.commandFingerprint,
          status: "SUCCEEDED",
          result: structuredClone(input.result),
        });
      },
    },
    feedbacks: {
      async loadEligibleTranslation() {
        return eligible
          ? {
              conversationId: CONVERSATION,
              messageId: MESSAGE,
              sourceRevision: 2,
            }
          : undefined;
      },

      async insertFeedbackRepairEvent(
        _tx,
        input,
      ) {
        repairs.push(structuredClone(input));
      },
    },
    ids: {
      next() {
        idCounter += 1;
        return (
          "50000000-0000-4000-8000-" +
          String(idCounter).padStart(12, "0")
        );
      },
    },
    clock: {
      now() {
        return NOW;
      },
    },
    noteFingerprinter: fingerprinter,
  });

  return {
    service,
    receipts,
    repairs,
  };
}

function command(overrides = {}) {
  return {
    protocol_version: 1,
    command_id: COMMAND,
    translation_id: TRANSLATION,
    kind: "PROBLEM",
    ...overrides,
  };
}

test("problem feedback is recorded without persisting plaintext note", async () => {
  const f = fixture();
  const secret =
    "private transcript fragment should not persist";

  const result = await f.service.createFeedback(
    actor,
    command({
      note: `  ${secret}  `,
    }),
  );

  assert.equal(result.status, "RECORDED");
  assert.equal(f.repairs.length, 1);
  assert.deepEqual(
    f.repairs[0].structuredPayload,
    {
      schema_version: 1,
      feedback_kind: "PROBLEM",
      note_present: true,
      note_length: secret.length,
    },
  );

  const durable = JSON.stringify({
    receipt:
      f.receipts.get(COMMAND),
    repair: f.repairs[0],
  });

  assert.equal(
    durable.includes(secret),
    false,
  );
  assert.match(
    f.receipts.get(COMMAND).commandFingerprint,
    /hmac-sha256:v1:/,
  );
});

test("semantic feedback categories require confirmation and never create correction memory directly", async () => {
  for (const kind of [
    "WRONG_MEANING",
    "WRONG_TONE",
    "TERMINOLOGY",
  ]) {
    const f = fixture();
    const result =
      await f.service.createFeedback(
        actor,
        command({
          command_id:
            kind === "WRONG_MEANING"
              ? "41000000-0000-4000-8000-000000000001"
              : kind === "WRONG_TONE"
                ? "41000000-0000-4000-8000-000000000002"
                : "41000000-0000-4000-8000-000000000003",
          kind,
        }),
      );

    assert.equal(
      result.status,
      "NEEDS_CONFIRMATION",
    );
    assert.equal(
      f.repairs[0].status,
      "NEEDS_CONFIRMATION",
    );
  }
});

test("feedback command replay is idempotent", async () => {
  const f = fixture();
  const first =
    await f.service.createFeedback(
      actor,
      command({
        note: "bad acronym",
      }),
    );
  const replay =
    await f.service.createFeedback(
      actor,
      command({
        note: "bad acronym",
      }),
    );

  assert.deepEqual(replay, first);
  assert.equal(f.repairs.length, 1);
});

test("feedback replay remains valid after HMAC key rotation with verification key", async () => {
  const receipts = new Map();
  const repairs = [];
  const v1Key = Buffer.alloc(32, 7);

  const first = fixture({
    receipts,
    repairs,
    fingerprinter:
      createHmacSourceFingerprinter({
        key: v1Key,
        keyVersion: "v1",
      }),
  });

  const expected =
    await first.service.createFeedback(
      actor,
      command({
        note: "wrong wording",
      }),
    );

  const second = fixture({
    receipts,
    repairs,
    fingerprinter:
      createHmacSourceFingerprinter({
        key: Buffer.alloc(32, 8),
        keyVersion: "v2",
        verificationKeys: [{
          key: v1Key,
          keyVersion: "v1",
        }],
      }),
  });

  const replay =
    await second.service.createFeedback(
      actor,
      command({
        note: "wrong wording",
      }),
    );

  assert.deepEqual(replay, expected);
  assert.equal(repairs.length, 1);
});

test("same feedback command id with different note is rejected", async () => {
  const f = fixture();

  await f.service.createFeedback(
    actor,
    command({ note: "first" }),
  );

  await assert.rejects(
    () =>
      f.service.createFeedback(
        actor,
        command({ note: "second" }),
      ),
    (error) =>
      error?.code ===
      "IDEMPOTENCY_CONFLICT",
  );
});

test("feedback is denied when translation is not eligible for this actor", async () => {
  const f = fixture({
    eligible: false,
  });

  await assert.rejects(
    () =>
      f.service.createFeedback(
        actor,
        command(),
      ),
    (error) =>
      error?.code === "NOT_AUTHORIZED",
  );
  assert.equal(f.repairs.length, 0);
});

test("feedback rejects oversized note before persistence", async () => {
  const f = fixture();

  await assert.rejects(
    () =>
      f.service.createFeedback(
        actor,
        command({
          note: "x".repeat(2049),
        }),
      ),
    (error) =>
      error?.code === "INVALID_COMMAND",
  );

  assert.equal(f.repairs.length, 0);
  assert.equal(f.receipts.size, 0);
});

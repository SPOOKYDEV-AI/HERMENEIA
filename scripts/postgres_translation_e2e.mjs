import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  createPersistentSendRuntime,
} from "../apps/api/persistent-send-runtime.mjs";
import {
  createHpkeP256EnvelopeCodec,
  createHpkeP256OriginalEnvelopeProtector,
  createHpkeP256TranslationEnvelopeProtector,
  generateHpkeP256DeviceKeyPair,
} from "../.build/packages/envelope-crypto/src/index.js";

const databaseUrl =
  process.env.HERMENEIA_TEST_DATABASE_URL ||
  process.env.DATABASE_URL;

const requiredEnv = [
  ["DATABASE_URL", databaseUrl],
  [
    "SOURCE_FINGERPRINT_HMAC_KEY_VERSION",
    process.env.SOURCE_FINGERPRINT_HMAC_KEY_VERSION,
  ],
  [
    "SOURCE_FINGERPRINT_HMAC_KEY_BASE64",
    process.env.SOURCE_FINGERPRINT_HMAC_KEY_BASE64,
  ],
];

for (const [name, value] of requiredEnv) {
  if (!value) {
    process.stdout.write(
      `POSTGRES_TRANSLATION_E2E=SKIP missing=${name}\n`,
    );
    process.exit(0);
  }
}

const NOW = "2026-10-05T08:00:00.000Z";
let runtimeNow = NOW;
const SOURCE_TEXT = "Bonjour monde 👋";
const T2_SOURCE_TEXT = "On fait le CR demain.";
const POST_REVOKE_SOURCE_TEXT =
  "On fait le CR vendredi.";
const TENANT_POLICY_SOURCE_TEXT =
  "Le SLA est important.";
const STYLE_SOURCE_TEXT =
  "Peux-tu me confirmer le SLA ?";
const POST_STYLE_RESET_SOURCE_TEXT =
  "Le SLA reste important après reset.";
const EPISODE_SOURCE_TEXTS = [
  "On prépare la démo client.",
  "Il faut vérifier le parcours mobile.",
  "Le bouton principal doit rester visible.",
  "On garde la traduction instantanée.",
  "Le contexte doit suivre la discussion.",
  "On valide les derniers détails.",
  "Tu peux résumer ce qu'on vient de décider ?",
];
const FEEDBACK_NOTE =
  "private feedback detail that must not persist";
const TRANSLATED_TEXT = "Hola mundo 👋";
const TARGET_LANGUAGE = "es-CO";

const ids = {
  tenantId: randomUUID(),
  senderUserId: randomUUID(),
  recipientUserId: randomUUID(),
  tenantAdminUserId: randomUUID(),
  senderDeviceId: randomUUID(),
  recipientDeviceId: randomUUID(),
  tenantAdminDeviceId: randomUUID(),
  conversationId: randomUUID(),
  commandId: randomUUID(),
  clientMessageId: randomUUID(),
  t2CommandId: randomUUID(),
  t2ClientMessageId: randomUUID(),
  feedbackCommandId: randomUUID(),
  correctionCommandId: randomUUID(),
  correctionOverrideCommandId: randomUUID(),
  correctionRevokeCommandId: randomUUID(),
  pendingReviewCorrectionCommandId: randomUUID(),
  pendingReviewCommandId: randomUUID(),
  reviewedClaimRevokeCommandId: randomUUID(),
  postRevokeCommandId: randomUUID(),
  postRevokeClientMessageId: randomUUID(),
  tenantPolicyMutationCommandId: randomUUID(),
  tenantPolicyUpdateCommandId: randomUUID(),
  tenantPolicyRevokeCommandId: randomUUID(),
  tenantPolicyCommandId: randomUUID(),
  tenantPolicyClientMessageId: randomUUID(),
  toneStyleCommandId: randomUUID(),
  styleMessageCommandId: randomUUID(),
  styleClientMessageId: randomUUID(),
  toneResetCommandId: randomUUID(),
  postStyleResetCommandId: randomUUID(),
  postStyleResetClientMessageId: randomUUID(),
  episodeCommandIds:
    Array.from({ length: 7 }, () => randomUUID()),
  episodeClientMessageIds:
    Array.from({ length: 7 }, () => randomUUID()),
  stalePolicyCommandId: randomUUID(),
  stalePolicyClientMessageId: randomUUID(),
  staleContextCommandId: randomUUID(),
  staleContextClientMessageId: randomUUID(),
};

const senderKeys = await generateHpkeP256DeviceKeyPair();
const recipientKeys = await generateHpkeP256DeviceKeyPair();
const tenantAdminKeys = await generateHpkeP256DeviceKeyPair();
const codec = createHpkeP256EnvelopeCodec();

let providerCalls = 0;
let episodeProviderObservation = null;
const translationProvider = {
  providerId: "ci-deterministic",
  modelId: "ci-translation-v1",
  providerRegion: "ci",
  async translate(input) {
    providerCalls += 1;
    assert.match(
      input.requestId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.equal(input.source.language_hint, "fr-FR");
    assert.equal(input.targetLanguageTag, TARGET_LANGUAGE);
    assert.equal(input.targetProfileVersion, 1);
    assert.equal(
      input.strategyVersion,
      "adaptive-context-v1",
    );
    assert.match(
      input.contextSnapshotId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    if (providerCalls === 1) {
      assert.equal(input.source.text, SOURCE_TEXT);
      assert.deepEqual(input.contextItems, []);
    } else if (providerCalls === 2) {
      assert.equal(input.source.text, T2_SOURCE_TEXT);
      const correctionItem = input.contextItems.find(
        (item) =>
          item.candidateType === "CORRECTION_MEMORY",
      );
      assert.ok(correctionItem);
      assert.equal(
        correctionItem.selectionReason,
        "CORRECTION_OR_POLICY",
      );
      assert.deepEqual(
        JSON.parse(correctionItem.content),
        {
          kind: "trusted_term_meaning",
          surface_form: "CR",
          meaning: "compte rendu",
          source_language_tag: "fr-FR",
        },
      );
    } else if (providerCalls === 3) {
      assert.equal(
        input.source.text,
        POST_REVOKE_SOURCE_TEXT,
      );
      assert.equal(
        input.contextItems.some(
          (item) =>
            item.candidateType ===
              "CORRECTION_MEMORY",
        ),
        false,
      );
    } else if (providerCalls === 4) {
      assert.equal(
        input.source.text,
        TENANT_POLICY_SOURCE_TEXT,
      );
      assert.equal(
        input.contextItems.some(
          (item) =>
            item.candidateType ===
              "CORRECTION_MEMORY",
        ),
        false,
      );
      const policyItem = input.contextItems.find(
        (item) =>
          item.candidateType ===
            "APPROVED_POLICY",
      );
      assert.ok(policyItem);
      assert.equal(
        policyItem.selectionReason,
        "CORRECTION_OR_POLICY",
      );
      assert.deepEqual(
        JSON.parse(policyItem.content),
        {
          kind: "trusted_term_meaning",
          surface_form: "SLA",
          meaning: "service level agreement",
          source_language_tag: "fr-FR",
          target_language_tag: TARGET_LANGUAGE,
        },
      );
    } else if (providerCalls === 5) {
      assert.equal(
        input.source.text,
        STYLE_SOURCE_TEXT,
      );
      const styleItem = input.contextItems.find(
        (item) =>
          item.candidateType ===
            "STYLE_PROFILE",
      );
      assert.ok(styleItem);
      assert.equal(
        styleItem.selectionReason,
        "STYLE_PROFILE",
      );
      assert.deepEqual(
        JSON.parse(styleItem.content),
        {
          kind: "trusted_conversation_style",
          preferred_register: "FORMAL",
        },
      );
      assert.equal(
        styleItem.content.includes(
          ids.senderUserId,
        ),
        false,
      );
    } else if (providerCalls === 6) {
      assert.equal(
        input.source.text,
        POST_STYLE_RESET_SOURCE_TEXT,
      );
      assert.equal(
        input.contextItems.some(
          (item) =>
            item.candidateType ===
              "STYLE_PROFILE",
        ),
        false,
      );
    } else if (
      providerCalls >= 7 &&
      providerCalls <= 12
    ) {
      const episodeIndex =
        providerCalls - 7;
      assert.equal(
        input.source.text,
        EPISODE_SOURCE_TEXTS[episodeIndex],
      );

      if (providerCalls === 7) {
        assert.equal(
          input.contextItems.some(
            (item) =>
              item.candidateType ===
                "ACTIVE_EPISODE",
          ),
          false,
          "episode older than continuity gap must not leak before reducer starts the new episode",
        );
      }
    } else if (providerCalls === 13) {
      episodeProviderObservation = {
        sourceText: input.source.text,
        contextItems: structuredClone(
          input.contextItems,
        ),
      };
    } else {
      assert.fail(
        `Unexpected provider call #${providerCalls}`,
      );
    }

    return {
      ok: true,
      text: TRANSLATED_TEXT,
      inputTokens: 3,
      outputTokens: 3,
      billedCostMicrounits: 0,
      latencyMs: 5,
    };
  },
};

const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  HERMENEIA_TEST_DATABASE_URL: databaseUrl,
  TRANSLATION_STRATEGY_VERSION: "t0-v1",
};

let runtime = null;
let seeded = false;
let failure = null;

function combineFailure(current, next) {
  if (!current) return next;
  return new AggregateError(
    [current, next],
    "PostgreSQL translation E2E and cleanup both failed",
  );
}

async function withConnection(work) {
  const connection = await runtime.sqlPool.connect();
  try {
    return await work(connection);
  } finally {
    connection.release();
  }
}

async function seed() {
  await withConnection(async (db) => {
    await db.query("BEGIN");
    try {
      await db.query(
        `INSERT INTO users(user_id, status, default_language_tag)
         VALUES
           ($1,'ACTIVE','fr-FR'),
           ($2,'ACTIVE','es-CO'),
           ($3,'ACTIVE','en')`,
        [
          ids.senderUserId,
          ids.recipientUserId,
          ids.tenantAdminUserId,
        ],
      );

      await db.query(
        `INSERT INTO tenants(
           tenant_id, kind, status, home_region
         ) VALUES ($1,'CONSUMER_SHARED','ACTIVE','eu')`,
        [ids.tenantId],
      );

      await db.query(
        `INSERT INTO tenant_memberships(
           tenant_id, user_id, role, status
         ) VALUES
           ($1,$2,'MEMBER','ACTIVE'),
           ($1,$3,'MEMBER','ACTIVE'),
           ($1,$4,'ADMIN','ACTIVE')`,
        [
          ids.tenantId,
          ids.senderUserId,
          ids.recipientUserId,
          ids.tenantAdminUserId,
        ],
      );

      await db.query(
        `INSERT INTO devices(
           device_id, user_id, status, credential_version,
           public_material_ref, revocation_epoch, platform
         ) VALUES
           ($1,$2,'ACTIVE',1,$3,0,'DESKTOP'),
           ($4,$5,'ACTIVE',1,$6,0,'DESKTOP'),
           ($7,$8,'ACTIVE',1,$9,0,'DESKTOP')`,
        [
          ids.senderDeviceId,
          ids.senderUserId,
          senderKeys.publicMaterialRef,
          ids.recipientDeviceId,
          ids.recipientUserId,
          recipientKeys.publicMaterialRef,
          ids.tenantAdminDeviceId,
          ids.tenantAdminUserId,
          tenantAdminKeys.publicMaterialRef,
        ],
      );

      await db.query(
        `INSERT INTO conversations(
           tenant_id, conversation_id, kind, status, home_region
         ) VALUES ($1,$2,'DIRECT','ACTIVE','eu')`,
        [ids.tenantId, ids.conversationId],
      );

      await db.query(
        `INSERT INTO conversation_members(
           tenant_id, conversation_id, user_id, role, status,
           target_language_tag, target_locale_override,
           membership_version
         ) VALUES
           ($1,$2,$3,'MEMBER','ACTIVE','fr-FR',NULL,1),
           ($1,$2,$4,'MEMBER','ACTIVE','es-CO',NULL,1)`,
        [
          ids.tenantId,
          ids.conversationId,
          ids.senderUserId,
          ids.recipientUserId,
        ],
      );

      await db.query("COMMIT");
      seeded = true;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  });
}

async function cleanup() {
  if (!runtime || !seeded) return;

  await withConnection(async (db) => {
    await db.query("BEGIN");
    try {
      const tenant = [ids.tenantId];
      await db.query(
        "DELETE FROM device_inbox_events WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM delivery_envelopes WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM provider_executions WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM outbox_jobs WHERE tenant_id = $1",
        tenant,
      );
      // Delete provenance before either side of its foreign keys.
      await db.query(
        "DELETE FROM provenance_edges WHERE tenant_id = $1",
        tenant,
      );
      // Repair events may point at translation executions.
      await db.query(
        "DELETE FROM translation_repair_events WHERE tenant_id = $1",
        tenant,
      );
      // Translation executions may point at context snapshots.
      await db.query(
        "DELETE FROM translation_executions WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM context_snapshots WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM context_claims WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM conversation_context_states WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM command_receipts WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM message_revisions WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM message_metadata WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM tenant_device_sync_states WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        `DELETE FROM sessions
          WHERE user_id IN ($1,$2,$3)`,
        [
          ids.senderUserId,
          ids.recipientUserId,
          ids.tenantAdminUserId,
        ],
      );
      await db.query(
        `DELETE FROM device_sync_states
          WHERE device_id IN ($1,$2,$3)`,
        [
          ids.senderDeviceId,
          ids.recipientDeviceId,
          ids.tenantAdminDeviceId,
        ],
      );
      await db.query(
        "DELETE FROM conversation_members WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM conversations WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM devices WHERE user_id IN ($1,$2,$3)",
        [
          ids.senderUserId,
          ids.recipientUserId,
          ids.tenantAdminUserId,
        ],
      );
      await db.query(
        "DELETE FROM tenant_memberships WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM tenants WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM users WHERE user_id IN ($1,$2,$3)",
        [
          ids.senderUserId,
          ids.recipientUserId,
          ids.tenantAdminUserId,
        ],
      );
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  });
}

try {
  runtime = await createPersistentSendRuntime({
    env,
    envelopeProtector:
      createHpkeP256OriginalEnvelopeProtector(),
    translationProvider,
    translationEnvelopeProtector:
      createHpkeP256TranslationEnvelopeProtector(),
    clock: {
      now() {
        return runtimeNow;
      },
    },
  });

  await seed();

  const sender = {
    tenantId: ids.tenantId,
    userId: ids.senderUserId,
    deviceId: ids.senderDeviceId,
  };
  const recipient = {
    tenantId: ids.tenantId,
    userId: ids.recipientUserId,
    deviceId: ids.recipientDeviceId,
  };
  const tenantAdmin = {
    tenantId: ids.tenantId,
    userId: ids.tenantAdminUserId,
    deviceId: ids.tenantAdminDeviceId,
  };

  const accepted = await runtime.sendService.sendMessage(
    sender,
    {
      protocol_version: 1,
      command_id: ids.commandId,
      client_message_id: ids.clientMessageId,
      conversation_id: ids.conversationId,
      source: {
        text: SOURCE_TEXT,
        language_hint: "fr-FR",
      },
      client_authored_at: NOW,
    },
  );

  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.translation_status, "PENDING");
  assert.equal(accepted.source_revision, 1);

  assert.equal(
    await runtime.translationWorker.runFanoutOnce(),
    "FANOUT_DONE",
  );
  assert.equal(
    await runtime.contextStateWorker.runOnce(),
    "REDUCED",
  );
  assert.equal(
    await runtime.translationWorker.runExecuteOnce(),
    "EXECUTION_DONE",
  );
  assert.equal(providerCalls, 1);

  const durable = await withConnection(async (db) => {
    const translation = await db.query(
      `SELECT translation_id,
              status,
              target_language_tag,
              target_profile_version
         FROM translation_executions
        WHERE tenant_id = $1
          AND source_message_id = $2
          AND recipient_user_id = $3`,
      [
        ids.tenantId,
        accepted.message_id,
        ids.recipientUserId,
      ],
    );
    assert.equal(translation.rowCount, 1);
    assert.equal(translation.rows[0].status, "READY");
    assert.equal(
      translation.rows[0].target_language_tag,
      TARGET_LANGUAGE,
    );
    assert.equal(
      Number(translation.rows[0].target_profile_version),
      1,
    );

    const snapshots = await db.query(
      `SELECT strategy,
              strategy_version,
              selected_candidate_ids,
              token_estimate
         FROM context_snapshots
        WHERE tenant_id = $1
          AND message_id = $2
          AND recipient_user_id = $3`,
      [
        ids.tenantId,
        accepted.message_id,
        ids.recipientUserId,
      ],
    );
    assert.equal(snapshots.rowCount, 1);
    assert.deepEqual(
      {
        strategy: snapshots.rows[0].strategy,
        strategyVersion:
          snapshots.rows[0].strategy_version,
        selectedCandidateIds:
          snapshots.rows[0].selected_candidate_ids,
        tokenEstimate:
          Number(snapshots.rows[0].token_estimate),
      },
      {
        strategy: "T0",
        strategyVersion: "adaptive-context-v1",
        selectedCandidateIds: [],
        tokenEstimate: 0,
      },
    );

    const attempts = await db.query(
      `SELECT status,
              provider_id,
              model_id,
              input_tokens,
              output_tokens,
              latency_ms
         FROM provider_executions
        WHERE tenant_id = $1
          AND translation_id = $2`,
      [ids.tenantId, translation.rows[0].translation_id],
    );
    assert.equal(attempts.rowCount, 1);
    assert.deepEqual(
      {
        status: attempts.rows[0].status,
        providerId: attempts.rows[0].provider_id,
        modelId: attempts.rows[0].model_id,
        inputTokens: Number(attempts.rows[0].input_tokens),
        outputTokens: Number(attempts.rows[0].output_tokens),
        latencyMs: Number(attempts.rows[0].latency_ms),
      },
      {
        status: "SUCCEEDED",
        providerId: "ci-deterministic",
        modelId: "ci-translation-v1",
        inputTokens: 3,
        outputTokens: 3,
        latencyMs: 5,
      },
    );

    const contextState = await db.query(
      `SELECT processed_prefix_sequence,
              pending_operations
         FROM conversation_context_states
        WHERE tenant_id = $1
          AND conversation_id = $2`,
      [ids.tenantId, ids.conversationId],
    );
    assert.equal(contextState.rowCount, 1);
    assert.equal(
      Number(contextState.rows[0].processed_prefix_sequence),
      1,
    );
    assert.deepEqual(
      contextState.rows[0].pending_operations,
      [],
    );

    const jobs = await db.query(
      `SELECT job_type, status
         FROM outbox_jobs
        WHERE tenant_id = $1
        ORDER BY job_type`,
      [ids.tenantId],
    );
    assert.deepEqual(
      jobs.rows.map((row) => [row.job_type, row.status]),
      [
        ["context.reduce", "DONE"],
        ["translation.execute", "DONE"],
        ["translation.request", "DONE"],
      ],
    );

    return {
      translationId: translation.rows[0].translation_id,
    };
  });

  const sync = await runtime.deliveryService.sync(
    recipient,
    {
      cursor: "1:0",
      limit: 10,
    },
  );

  assert.equal(sync.kind, "OK");
  assert.equal(sync.response.events.length, 2);

  const originalEvent = sync.response.events.find(
    (event) =>
      event.type === "message.available" &&
      event.payload.rendition_type === "ORIGINAL",
  );
  const translationEvent = sync.response.events.find(
    (event) =>
      event.type === "message.available" &&
      event.payload.rendition_type === "TRANSLATION",
  );
  assert.ok(originalEvent);
  assert.ok(translationEvent);

  const openedOriginal = await codec.open({
    binding: {
      envelopeId: originalEvent.payload.envelope_id,
      tenantId: ids.tenantId,
      conversationId: ids.conversationId,
      messageId: accepted.message_id,
      sourceRevision: 1,
      recipientUserId: ids.recipientUserId,
      recipientDeviceId: ids.recipientDeviceId,
      recipientCredentialVersion: 1,
      renditionType: "ORIGINAL",
    },
    recipientPrivateKey: recipientKeys.keyPair.privateKey,
    protectedPayload: originalEvent.payload.protected_payload,
  });
  assert.deepEqual(openedOriginal, {
    v: 1,
    kind: "ORIGINAL",
    text: SOURCE_TEXT,
    language_hint: "fr-FR",
  });

  const openedTranslation = await codec.open({
    binding: {
      envelopeId: translationEvent.payload.envelope_id,
      tenantId: ids.tenantId,
      conversationId: ids.conversationId,
      messageId: accepted.message_id,
      sourceRevision: 1,
      recipientUserId: ids.recipientUserId,
      recipientDeviceId: ids.recipientDeviceId,
      recipientCredentialVersion: 1,
      renditionType: "TRANSLATION",
      translationId: durable.translationId,
      targetLanguageTag: TARGET_LANGUAGE,
    },
    recipientPrivateKey: recipientKeys.keyPair.privateKey,
    protectedPayload:
      translationEvent.payload.protected_payload,
  });
  assert.deepEqual(openedTranslation, {
    v: 1,
    kind: "TRANSLATION",
    text: TRANSLATED_TEXT,
    target_language_tag: TARGET_LANGUAGE,
  });

  await runtime.deliveryService.acknowledge(
    recipient,
    sync.response.events.map((event) => ({
      envelope_id: event.payload.envelope_id,
      persisted_at: event.server_time,
    })),
  );

  await withConnection(async (db) => {
    const envelopes = await db.query(
      `SELECT rendition_type,
              status,
              octet_length(protected_payload) AS payload_bytes
         FROM delivery_envelopes
        WHERE tenant_id = $1
          AND message_id = $2
          AND recipient_device_id = $3
        ORDER BY rendition_type`,
      [
        ids.tenantId,
        accepted.message_id,
        ids.recipientDeviceId,
      ],
    );
    assert.equal(envelopes.rowCount, 2);
    assert.deepEqual(
      envelopes.rows.map((row) => [
        row.rendition_type,
        row.status,
        Number(row.payload_bytes),
      ]),
      [
        ["ORIGINAL", "ACKED", 0],
        ["TRANSLATION", "ACKED", 0],
      ],
    );

    const state = await db.query(
      `SELECT inbox_epoch,
              next_offset,
              last_acked_offset
         FROM tenant_device_sync_states
        WHERE tenant_id = $1
          AND device_id = $2`,
      [ids.tenantId, ids.recipientDeviceId],
    );
    assert.equal(state.rowCount, 1);
    assert.equal(Number(state.rows[0].inbox_epoch), 1);
    assert.equal(Number(state.rows[0].next_offset), 3);
    assert.equal(Number(state.rows[0].last_acked_offset), 2);
  });

  const feedback =
    await runtime.translationFeedbackService.createFeedback(
      recipient,
      {
        protocol_version: 1,
        command_id: ids.feedbackCommandId,
        translation_id: durable.translationId,
        kind: "WRONG_MEANING",
        note: FEEDBACK_NOTE,
      },
    );

  assert.equal(
    feedback.status,
    "NEEDS_CONFIRMATION",
  );

  await withConnection(async (db) => {
    const repair = await db.query(
      `SELECT kind,
              status,
              target_translation_id,
              target_message_id,
              target_source_revision,
              structured_payload::text AS structured_payload_text
         FROM translation_repair_events
        WHERE tenant_id = $1
          AND repair_event_id = $2`,
      [
        ids.tenantId,
        feedback.repair_event_id,
      ],
    );

    assert.equal(repair.rowCount, 1);
    assert.equal(
      repair.rows[0].kind,
      "MEANING_CORRECTION",
    );
    assert.equal(
      repair.rows[0].status,
      "NEEDS_CONFIRMATION",
    );
    assert.equal(
      repair.rows[0].target_translation_id,
      durable.translationId,
    );
    assert.equal(
      repair.rows[0].target_message_id,
      accepted.message_id,
    );
    assert.equal(
      Number(repair.rows[0].target_source_revision),
      1,
    );
    assert.equal(
      repair.rows[0].structured_payload_text.includes(
        FEEDBACK_NOTE,
      ),
      false,
    );

    const receipt = await db.query(
      `SELECT command_fingerprint
         FROM command_receipts
        WHERE tenant_id = $1
          AND command_id = $2`,
      [
        ids.tenantId,
        ids.feedbackCommandId,
      ],
    );
    assert.equal(receipt.rowCount, 1);
    assert.equal(
      receipt.rows[0].command_fingerprint.includes(
        FEEDBACK_NOTE,
      ),
      false,
    );
    assert.match(
      receipt.rows[0].command_fingerprint,
      /hmac-sha256:/,
    );

    const claims = await db.query(
      `SELECT count(*)::int AS count
         FROM context_claims
        WHERE tenant_id = $1`,
      [ids.tenantId],
    );
    assert.equal(
      Number(claims.rows[0].count),
      0,
    );
  });

  const correction =
    await runtime.correctionService.createCorrection(
      sender,
      {
        protocol_version: 1,
        command_id: ids.correctionCommandId,
        conversation_id: ids.conversationId,
        target_message_id: accepted.message_id,
        target_source_revision: 1,
        kind: "TERMINOLOGY",
        requested_scope: "CONVERSATION",
        payload: {
          schema_version: 1,
          kind: "TERM_MEANING",
          surface_form: "CR",
          meaning: "change request",
          source_language_tag: "fr-FR",
        },
      },
    );

  assert.equal(correction.status, "APPLIED");
  assert.equal(
    correction.applied_scope,
    "CONVERSATION",
  );
  assert.ok(correction.claim_id);
  assert.equal(correction.claim_version, 1);
  const firstCorrectionClaimId = correction.claim_id;

  await withConnection(async (db) => {
    const repair = await db.query(
      `SELECT status,
              target_translation_id,
              target_message_id,
              target_source_revision
         FROM translation_repair_events
        WHERE tenant_id = $1
          AND repair_event_id = $2`,
      [
        ids.tenantId,
        correction.repair_event_id,
      ],
    );
    assert.equal(repair.rowCount, 1);
    assert.equal(repair.rows[0].status, "APPLIED");
    assert.equal(
      repair.rows[0].target_translation_id,
      null,
    );
    assert.equal(
      repair.rows[0].target_message_id,
      accepted.message_id,
    );
    assert.equal(
      Number(repair.rows[0].target_source_revision),
      1,
    );

    const claim = await db.query(
      `SELECT authority_class,
              retention_class,
              subject_user_id,
              scope_kind,
              scope_conversation_id,
              trigger_kind,
              proposition_ref
         FROM context_claims
        WHERE tenant_id = $1
          AND claim_id = $2
          AND claim_version = 1`,
      [ids.tenantId, firstCorrectionClaimId],
    );
    assert.equal(claim.rowCount, 1);
    assert.equal(
      claim.rows[0].authority_class,
      "CONFIRMED_CORRECTION",
    );
    assert.equal(
      claim.rows[0].retention_class,
      "CORRECTIVE_DURABLE",
    );
    assert.equal(
      claim.rows[0].subject_user_id,
      ids.senderUserId,
    );
    assert.equal(
      claim.rows[0].scope_kind,
      "CONVERSATION",
    );
    assert.equal(
      claim.rows[0].scope_conversation_id,
      ids.conversationId,
    );
    assert.equal(
      claim.rows[0].trigger_kind,
      "EXPLICIT_UI_CORRECTION",
    );
    assert.deepEqual(
      claim.rows[0].proposition_ref,
      {
        schema_version: 1,
        kind: "TERM_MEANING",
        surface_form: "CR",
        meaning: "change request",
        source_language_tag: "fr-FR",
      },
    );

    const provenance = await db.query(
      `SELECT relation,
              source_repair_event_id
         FROM provenance_edges
        WHERE tenant_id = $1
          AND derived_claim_id = $2
          AND derived_claim_version = 1`,
      [ids.tenantId, firstCorrectionClaimId],
    );
    assert.equal(provenance.rowCount, 1);
    assert.equal(
      provenance.rows[0].relation,
      "CORRECTED_BY",
    );
    assert.equal(
      provenance.rows[0].source_repair_event_id,
      correction.repair_event_id,
    );

    const state = await db.query(
      `SELECT processed_prefix_sequence,
              correction_claim_refs
         FROM conversation_context_states
        WHERE tenant_id = $1
          AND conversation_id = $2`,
      [ids.tenantId, ids.conversationId],
    );
    assert.equal(state.rowCount, 1);
    assert.equal(
      Number(state.rows[0].processed_prefix_sequence),
      1,
    );
    assert.ok(
      state.rows[0].correction_claim_refs.includes(
        firstCorrectionClaimId,
      ),
    );
  });

  const replacementCorrection =
    await runtime.correctionService.createCorrection(
      sender,
      {
        protocol_version: 1,
        command_id:
          ids.correctionOverrideCommandId,
        conversation_id: ids.conversationId,
        target_message_id: accepted.message_id,
        target_source_revision: 1,
        kind: "TERMINOLOGY",
        requested_scope: "CONVERSATION",
        payload: {
          schema_version: 1,
          kind: "TERM_MEANING",
          surface_form: "CR",
          meaning: "compte rendu",
          source_language_tag: "fr-FR",
        },
      },
    );

  assert.equal(
    replacementCorrection.status,
    "APPLIED",
  );
  assert.ok(replacementCorrection.claim_id);
  assert.notEqual(
    replacementCorrection.claim_id,
    firstCorrectionClaimId,
  );
  const correctionClaimId =
    replacementCorrection.claim_id;

  await withConnection(async (db) => {
    const oldClaim = await db.query(
      `SELECT status,
              valid_until
         FROM context_claims
        WHERE tenant_id = $1
          AND claim_id = $2
          AND claim_version = 1`,
      [
        ids.tenantId,
        firstCorrectionClaimId,
      ],
    );
    assert.equal(oldClaim.rowCount, 1);
    assert.equal(
      oldClaim.rows[0].status,
      "INVALIDATED",
    );
    assert.ok(oldClaim.rows[0].valid_until);

    const replacement = await db.query(
      `SELECT status,
              subject_user_id,
              proposition_ref
         FROM context_claims
        WHERE tenant_id = $1
          AND claim_id = $2
          AND claim_version = 1`,
      [ids.tenantId, correctionClaimId],
    );
    assert.equal(replacement.rowCount, 1);
    assert.equal(
      replacement.rows[0].status,
      "ACTIVE",
    );
    assert.equal(
      replacement.rows[0].subject_user_id,
      ids.senderUserId,
    );
    assert.deepEqual(
      replacement.rows[0].proposition_ref,
      {
        schema_version: 1,
        kind: "TERM_MEANING",
        surface_form: "CR",
        meaning: "compte rendu",
        source_language_tag: "fr-FR",
      },
    );

    const override = await db.query(
      `SELECT relation,
              source_claim_id,
              source_claim_version
         FROM provenance_edges
        WHERE tenant_id = $1
          AND derived_claim_id = $2
          AND derived_claim_version = 1
          AND relation = 'OVERRIDDEN_BY'`,
      [
        ids.tenantId,
        firstCorrectionClaimId,
      ],
    );
    assert.equal(override.rowCount, 1);
    assert.equal(
      override.rows[0].source_claim_id,
      correctionClaimId,
    );
    assert.equal(
      Number(override.rows[0].source_claim_version),
      1,
    );

    const state = await db.query(
      `SELECT correction_claim_refs
         FROM conversation_context_states
        WHERE tenant_id = $1
          AND conversation_id = $2`,
      [ids.tenantId, ids.conversationId],
    );
    assert.equal(state.rowCount, 1);
    assert.deepEqual(
      state.rows[0].correction_claim_refs,
      [correctionClaimId],
    );
  });

  // A correction created after a message was already accepted must not
  // influence that message. Advance the server clock before accepting the
  // next message so the claim is strictly causal to this new translation.
  runtimeNow = "2026-10-05T08:00:01.000Z";

  const t2Accepted = await runtime.sendService.sendMessage(
    sender,
    {
      protocol_version: 1,
      command_id: ids.t2CommandId,
      client_message_id: ids.t2ClientMessageId,
      conversation_id: ids.conversationId,
      source: {
        text: T2_SOURCE_TEXT,
        language_hint: "fr-FR",
      },
      client_authored_at: NOW,
    },
  );

  assert.equal(t2Accepted.status, "ACCEPTED");
  assert.equal(
    await runtime.translationWorker.runFanoutOnce(),
    "FANOUT_DONE",
  );

  const t2Snapshot = await withConnection(async (db) => {
    const snapshot = await db.query(
      `SELECT strategy,
              selected_candidate_ids,
              selected_claim_refs,
              processed_prefix_sequence
         FROM context_snapshots
        WHERE tenant_id = $1
          AND message_id = $2
          AND recipient_user_id = $3`,
      [
        ids.tenantId,
        t2Accepted.message_id,
        ids.recipientUserId,
      ],
    );
    assert.equal(snapshot.rowCount, 1);
    assert.equal(
      snapshot.rows[0].strategy,
      "T2_ADAPTIVE_V1",
    );
    assert.ok(
      snapshot.rows[0].selected_candidate_ids.includes(
        `claim:${correctionClaimId}:1`,
      ),
    );
    assert.ok(
      snapshot.rows[0].selected_claim_refs.includes(
        `${correctionClaimId}:1`,
      ),
    );
    assert.equal(
      Number(snapshot.rows[0].processed_prefix_sequence),
      1,
    );
    return snapshot.rows[0];
  });

  assert.ok(t2Snapshot);

  assert.equal(
    await runtime.contextStateWorker.runOnce(),
    "REDUCED",
  );
  assert.equal(
    await runtime.translationWorker.runExecuteOnce(),
    "EXECUTION_DONE",
  );
  assert.equal(providerCalls, 2);

  await withConnection(async (db) => {
    const execution = await db.query(
      `SELECT status
         FROM translation_executions
        WHERE tenant_id = $1
          AND source_message_id = $2
          AND recipient_user_id = $3`,
      [
        ids.tenantId,
        t2Accepted.message_id,
        ids.recipientUserId,
      ],
    );
    assert.equal(execution.rowCount, 1);
    assert.equal(execution.rows[0].status, "READY");

    const state = await db.query(
      `SELECT processed_prefix_sequence
         FROM conversation_context_states
        WHERE tenant_id = $1
          AND conversation_id = $2`,
      [ids.tenantId, ids.conversationId],
    );
    assert.equal(state.rowCount, 1);
    assert.equal(
      Number(state.rows[0].processed_prefix_sequence),
      2,
    );
  });

  runtimeNow = "2026-10-05T08:00:02.000Z";

  const pendingReviewCorrection =
    await runtime.correctionService.createCorrection(
      recipient,
      {
        protocol_version: 1,
        command_id:
          ids.pendingReviewCorrectionCommandId,
        conversation_id: ids.conversationId,
        target_message_id: accepted.message_id,
        target_source_revision: 1,
        kind: "TERMINOLOGY",
        requested_scope: "CONVERSATION",
        payload: {
          schema_version: 1,
          kind: "TERM_MEANING",
          surface_form: "BR",
          meaning: "business requirement",
          source_language_tag: "fr-FR",
        },
      },
    );

  assert.equal(
    pendingReviewCorrection.status,
    "NEEDS_CONFIRMATION",
  );
  assert.equal(
    pendingReviewCorrection.claim_id,
    null,
  );

  await withConnection(async (db) => {
    const promoted = await db.query(
      `UPDATE conversation_members
          SET role = 'MODERATOR'
        WHERE tenant_id = $1
          AND conversation_id = $2
          AND user_id = $3
      RETURNING role`,
      [
        ids.tenantId,
        ids.conversationId,
        ids.recipientUserId,
      ],
    );
    assert.equal(promoted.rowCount, 1);
    assert.equal(
      promoted.rows[0].role,
      "MODERATOR",
    );
  });

  const review =
    await runtime.correctionService.reviewCorrection(
      recipient,
      {
        protocol_version: 1,
        command_id: ids.pendingReviewCommandId,
        conversation_id: ids.conversationId,
        repair_event_id:
          pendingReviewCorrection.repair_event_id,
        decision: "APPROVE",
      },
    );

  assert.equal(review.status, "APPLIED");
  assert.ok(review.claim_id);
  assert.equal(review.claim_version, 1);
  const reviewedClaimId = review.claim_id;

  await withConnection(async (db) => {
    const proposal = await db.query(
      `SELECT status
         FROM translation_repair_events
        WHERE tenant_id = $1
          AND repair_event_id = $2`,
      [
        ids.tenantId,
        pendingReviewCorrection.repair_event_id,
      ],
    );
    assert.equal(proposal.rowCount, 1);
    assert.equal(
      proposal.rows[0].status,
      "APPLIED",
    );

    const reviewEvent = await db.query(
      `SELECT actor_user_id,
              kind,
              status,
              structured_payload
         FROM translation_repair_events
        WHERE tenant_id = $1
          AND repair_event_id = $2`,
      [
        ids.tenantId,
        review.review_event_id,
      ],
    );
    assert.equal(reviewEvent.rowCount, 1);
    assert.equal(
      reviewEvent.rows[0].actor_user_id,
      ids.recipientUserId,
    );
    assert.equal(
      reviewEvent.rows[0].kind,
      "EXPLICIT_CORRECTION",
    );
    assert.equal(
      reviewEvent.rows[0].status,
      "APPLIED",
    );
    assert.equal(
      reviewEvent.rows[0].structured_payload.action,
      "APPROVE_PENDING_CORRECTION",
    );
    assert.equal(
      reviewEvent.rows[0].structured_payload
        .source_repair_event_id,
      pendingReviewCorrection.repair_event_id,
    );

    const claim = await db.query(
      `SELECT status,
              subject_user_id,
              proposition_ref
         FROM context_claims
        WHERE tenant_id = $1
          AND claim_id = $2
          AND claim_version = 1`,
      [ids.tenantId, reviewedClaimId],
    );
    assert.equal(claim.rowCount, 1);
    assert.equal(
      claim.rows[0].status,
      "ACTIVE",
    );
    assert.equal(
      claim.rows[0].subject_user_id,
      null,
    );
    assert.deepEqual(
      claim.rows[0].proposition_ref,
      {
        schema_version: 1,
        kind: "TERM_MEANING",
        surface_form: "BR",
        meaning: "business requirement",
        source_language_tag: "fr-FR",
      },
    );

    const provenance = await db.query(
      `SELECT relation,
              source_repair_event_id
         FROM provenance_edges
        WHERE tenant_id = $1
          AND derived_claim_id = $2
          AND derived_claim_version = 1
          AND relation = 'CORRECTED_BY'`,
      [ids.tenantId, reviewedClaimId],
    );
    assert.equal(provenance.rowCount, 1);
    assert.equal(
      provenance.rows[0].source_repair_event_id,
      review.review_event_id,
    );

    const state = await db.query(
      `SELECT correction_claim_refs
         FROM conversation_context_states
        WHERE tenant_id = $1
          AND conversation_id = $2`,
      [ids.tenantId, ids.conversationId],
    );
    assert.equal(state.rowCount, 1);
    assert.ok(
      state.rows[0].correction_claim_refs.includes(
        correctionClaimId,
      ),
    );
    assert.ok(
      state.rows[0].correction_claim_refs.includes(
        reviewedClaimId,
      ),
    );
  });

  runtimeNow = "2026-10-05T08:00:03.000Z";

  const reviewedClaimRevocation =
    await runtime.correctionService.revokeCorrection(
      recipient,
      {
        protocol_version: 1,
        command_id:
          ids.reviewedClaimRevokeCommandId,
        conversation_id: ids.conversationId,
        claim_id: reviewedClaimId,
      },
    );
  assert.equal(
    reviewedClaimRevocation.status,
    "REVOKED",
  );

  await withConnection(async (db) => {
    const restored = await db.query(
      `UPDATE conversation_members
          SET role = 'MEMBER'
        WHERE tenant_id = $1
          AND conversation_id = $2
          AND user_id = $3
      RETURNING role`,
      [
        ids.tenantId,
        ids.conversationId,
        ids.recipientUserId,
      ],
    );
    assert.equal(restored.rowCount, 1);
    assert.equal(restored.rows[0].role, "MEMBER");
  });

  runtimeNow = "2026-10-05T08:00:04.000Z";

  const revocation =
    await runtime.correctionService.revokeCorrection(
      sender,
      {
        protocol_version: 1,
        command_id:
          ids.correctionRevokeCommandId,
        conversation_id: ids.conversationId,
        claim_id: correctionClaimId,
      },
    );

  assert.equal(revocation.status, "REVOKED");
  assert.equal(
    revocation.claim_id,
    correctionClaimId,
  );
  assert.equal(revocation.claim_version, 1);

  await withConnection(async (db) => {
    const claim = await db.query(
      `SELECT status,
              valid_until
         FROM context_claims
        WHERE tenant_id = $1
          AND claim_id = $2
          AND claim_version = 1`,
      [ids.tenantId, correctionClaimId],
    );
    assert.equal(claim.rowCount, 1);
    assert.equal(
      claim.rows[0].status,
      "REVOKED",
    );
    assert.ok(claim.rows[0].valid_until);

    const invalidation = await db.query(
      `SELECT relation,
              source_repair_event_id
         FROM provenance_edges
        WHERE tenant_id = $1
          AND derived_claim_id = $2
          AND derived_claim_version = 1
          AND relation = 'INVALIDATED_BY'`,
      [ids.tenantId, correctionClaimId],
    );
    assert.equal(invalidation.rowCount, 1);
    assert.equal(
      invalidation.rows[0].source_repair_event_id,
      revocation.repair_event_id,
    );

    const repair = await db.query(
      `SELECT kind,
              status,
              structured_payload
         FROM translation_repair_events
        WHERE tenant_id = $1
          AND repair_event_id = $2`,
      [
        ids.tenantId,
        revocation.repair_event_id,
      ],
    );
    assert.equal(repair.rowCount, 1);
    assert.equal(
      repair.rows[0].kind,
      "EXPLICIT_CORRECTION",
    );
    assert.equal(
      repair.rows[0].status,
      "APPLIED",
    );
    assert.deepEqual(
      repair.rows[0].structured_payload,
      {
        schema_version: 1,
        action: "REVOKE_CORRECTION",
        claim_id: correctionClaimId,
        claim_version: 1,
      },
    );

    const state = await db.query(
      `SELECT correction_claim_refs
         FROM conversation_context_states
        WHERE tenant_id = $1
          AND conversation_id = $2`,
      [ids.tenantId, ids.conversationId],
    );
    assert.equal(state.rowCount, 1);
    assert.deepEqual(
      state.rows[0].correction_claim_refs,
      [],
    );
  });

  runtimeNow = "2026-10-05T08:00:05.000Z";

  const postRevokeAccepted =
    await runtime.sendService.sendMessage(
      sender,
      {
        protocol_version: 1,
        command_id:
          ids.postRevokeCommandId,
        client_message_id:
          ids.postRevokeClientMessageId,
        conversation_id: ids.conversationId,
        source: {
          text: POST_REVOKE_SOURCE_TEXT,
          language_hint: "fr-FR",
        },
        client_authored_at: NOW,
      },
    );

  assert.equal(
    postRevokeAccepted.status,
    "ACCEPTED",
  );
  assert.equal(
    await runtime.translationWorker.runFanoutOnce(),
    "FANOUT_DONE",
  );

  await withConnection(async (db) => {
    const snapshot = await db.query(
      `SELECT strategy,
              selected_claim_refs,
              selected_candidate_ids
         FROM context_snapshots
        WHERE tenant_id = $1
          AND message_id = $2
          AND recipient_user_id = $3`,
      [
        ids.tenantId,
        postRevokeAccepted.message_id,
        ids.recipientUserId,
      ],
    );
    assert.equal(snapshot.rowCount, 1);
    assert.equal(
      snapshot.rows[0].strategy,
      "T1",
    );
    assert.deepEqual(
      snapshot.rows[0].selected_claim_refs,
      [],
    );
    assert.equal(
      snapshot.rows[0].selected_candidate_ids.some(
        (id) =>
          id.startsWith(
            `claim:${correctionClaimId}:`,
          ),
      ),
      false,
    );
  });

  assert.equal(
    await runtime.contextStateWorker.runOnce(),
    "REDUCED",
  );
  assert.equal(
    await runtime.translationWorker.runExecuteOnce(),
    "EXECUTION_DONE",
  );
  assert.equal(providerCalls, 3);

  runtimeNow = "2026-10-05T08:00:05.100Z";

  const tenantPolicyCreated =
    await runtime.tenantPolicyService.upsertPolicy(
      tenantAdmin,
      {
        protocol_version: 1,
        command_id:
          ids.tenantPolicyMutationCommandId,
        kind: "GLOSSARY",
        proposition: {
          schema_version: 1,
          kind: "TERM_MEANING",
          surface_form: "SLA",
          meaning: "service level accord",
          source_language_tag: "fr-FR",
          target_language_tag: TARGET_LANGUAGE,
        },
      },
    );

  assert.equal(
    tenantPolicyCreated.status,
    "ACTIVE",
  );
  assert.equal(
    tenantPolicyCreated.kind,
    "GLOSSARY",
  );
  assert.equal(
    tenantPolicyCreated.claim_version,
    1,
  );
  assert.equal(
    tenantPolicyCreated.tenant_policy_version,
    2,
  );
  assert.deepEqual(
    tenantPolicyCreated.superseded_claims,
    [],
  );
  const supersededTenantPolicyClaimId =
    tenantPolicyCreated.claim_id;

  runtimeNow = "2026-10-05T08:00:05.200Z";

  const tenantPolicyUpdated =
    await runtime.tenantPolicyService.upsertPolicy(
      tenantAdmin,
      {
        protocol_version: 1,
        command_id:
          ids.tenantPolicyUpdateCommandId,
        kind: "GLOSSARY",
        proposition: {
          schema_version: 1,
          kind: "TERM_MEANING",
          surface_form: "SLA",
          meaning: "service level agreement",
          source_language_tag: "fr-FR",
          target_language_tag: TARGET_LANGUAGE,
        },
      },
    );

  assert.equal(
    tenantPolicyUpdated.status,
    "ACTIVE",
  );
  assert.equal(
    tenantPolicyUpdated.kind,
    "GLOSSARY",
  );
  assert.equal(
    tenantPolicyUpdated.claim_version,
    1,
  );
  assert.equal(
    tenantPolicyUpdated.tenant_policy_version,
    3,
  );
  assert.deepEqual(
    tenantPolicyUpdated.superseded_claims,
    [{
      claim_id:
        supersededTenantPolicyClaimId,
      claim_version: 1,
    }],
  );
  const tenantPolicyClaimId =
    tenantPolicyUpdated.claim_id;
  assert.notEqual(
    tenantPolicyClaimId,
    supersededTenantPolicyClaimId,
  );

  await withConnection(async (db) => {
    const adminConversationMembership =
      await db.query(
        `SELECT COUNT(*)::integer AS count
           FROM conversation_members
          WHERE tenant_id = $1
            AND conversation_id = $2
            AND user_id = $3`,
        [
          ids.tenantId,
          ids.conversationId,
          ids.tenantAdminUserId,
        ],
      );
    assert.equal(
      Number(
        adminConversationMembership.rows[0].count,
      ),
      0,
    );

    const supersededClaim = await db.query(
      `SELECT status,
              proposition_ref
         FROM context_claims
        WHERE tenant_id = $1
          AND claim_id = $2
          AND claim_version = 1`,
      [
        ids.tenantId,
        supersededTenantPolicyClaimId,
      ],
    );
    assert.equal(
      supersededClaim.rowCount,
      1,
    );
    assert.equal(
      supersededClaim.rows[0].status,
      "INVALIDATED",
    );
    assert.equal(
      supersededClaim.rows[0].proposition_ref.meaning,
      "service level accord",
    );

    const overrideProvenance =
      await db.query(
        `SELECT relation,
                derived_claim_id,
                source_claim_id
           FROM provenance_edges
          WHERE tenant_id = $1
            AND derived_claim_id = $2
            AND derived_claim_version = 1
            AND source_claim_id = $3
            AND source_claim_version = 1`,
        [
          ids.tenantId,
          supersededTenantPolicyClaimId,
          tenantPolicyClaimId,
        ],
      );
    assert.equal(
      overrideProvenance.rowCount,
      1,
    );
    assert.equal(
      overrideProvenance.rows[0].relation,
      "OVERRIDDEN_BY",
    );

    const claim = await db.query(
      `SELECT authority_class,
              retention_class,
              scope_kind,
              conversation_id,
              subject_user_id,
              trigger_kind,
              proposition_ref,
              status
         FROM context_claims
        WHERE tenant_id = $1
          AND claim_id = $2
          AND claim_version = 1`,
      [ids.tenantId, tenantPolicyClaimId],
    );
    assert.equal(claim.rowCount, 1);
    assert.equal(
      claim.rows[0].authority_class,
      "APPROVED_GLOSSARY",
    );
    assert.equal(
      claim.rows[0].retention_class,
      "POLICY_REFERENCE",
    );
    assert.equal(
      claim.rows[0].scope_kind,
      "TENANT",
    );
    assert.equal(
      claim.rows[0].conversation_id,
      null,
    );
    assert.equal(
      claim.rows[0].subject_user_id,
      null,
    );
    assert.equal(
      claim.rows[0].trigger_kind,
      "APPROVED_GLOSSARY_CHANGE",
    );
    assert.equal(
      claim.rows[0].status,
      "ACTIVE",
    );
    assert.deepEqual(
      claim.rows[0].proposition_ref,
      {
        schema_version: 1,
        kind: "TERM_MEANING",
        surface_form: "SLA",
        meaning: "service level agreement",
        source_language_tag: "fr-FR",
        target_language_tag: TARGET_LANGUAGE,
      },
    );

    const state = await db.query(
      `SELECT terminology_claim_refs,
              lexical_claim_refs,
              correction_claim_refs
         FROM conversation_context_states
        WHERE tenant_id = $1
          AND conversation_id = $2`,
      [ids.tenantId, ids.conversationId],
    );
    assert.equal(state.rowCount, 1);
    assert.equal(
      state.rows[0].terminology_claim_refs.includes(
        tenantPolicyClaimId,
      ),
      false,
    );
    assert.equal(
      state.rows[0].lexical_claim_refs.includes(
        tenantPolicyClaimId,
      ),
      false,
    );
    assert.equal(
      state.rows[0].correction_claim_refs.includes(
        tenantPolicyClaimId,
      ),
      false,
    );
  });

  // Claims are admissible strictly before the source revision timestamp,
  // so the message must be causally later than the replacement policy claim.
  runtimeNow = "2026-10-05T08:00:05.201Z";

  const tenantPolicyAccepted =
    await runtime.sendService.sendMessage(
      sender,
      {
        protocol_version: 1,
        command_id:
          ids.tenantPolicyCommandId,
        client_message_id:
          ids.tenantPolicyClientMessageId,
        conversation_id: ids.conversationId,
        source: {
          text: TENANT_POLICY_SOURCE_TEXT,
          language_hint: "fr-FR",
        },
        client_authored_at: NOW,
      },
    );

  assert.equal(
    tenantPolicyAccepted.status,
    "ACCEPTED",
  );
  assert.equal(
    await runtime.translationWorker.runFanoutOnce(),
    "FANOUT_DONE",
  );

  await withConnection(async (db) => {
    const snapshot = await db.query(
      `SELECT strategy,
              selected_claim_refs,
              selected_candidate_ids
         FROM context_snapshots
        WHERE tenant_id = $1
          AND message_id = $2
          AND recipient_user_id = $3`,
      [
        ids.tenantId,
        tenantPolicyAccepted.message_id,
        ids.recipientUserId,
      ],
    );
    assert.equal(snapshot.rowCount, 1);
    assert.equal(
      snapshot.rows[0].strategy,
      "T2_ADAPTIVE_V1",
    );
    assert.ok(
      snapshot.rows[0].selected_claim_refs.includes(
        `${tenantPolicyClaimId}:1`,
      ),
    );
    assert.ok(
      snapshot.rows[0].selected_candidate_ids.includes(
        `claim:${tenantPolicyClaimId}:1`,
      ),
    );
  });

  assert.equal(
    await runtime.contextStateWorker.runOnce(),
    "REDUCED",
  );
  assert.equal(
    await runtime.translationWorker.runExecuteOnce(),
    "EXECUTION_DONE",
  );
  assert.equal(providerCalls, 4);

  runtimeNow = "2026-10-05T08:00:05.300Z";

  const toneStyle =
    await runtime.correctionService.createCorrection(
      sender,
      {
        protocol_version: 1,
        command_id: ids.toneStyleCommandId,
        conversation_id: ids.conversationId,
        kind: "TONE",
        requested_scope: "CONVERSATION",
        payload: {
          schema_version: 1,
          kind: "TONE",
          preferred_register: "FORMAL",
        },
      },
    );

  assert.equal(toneStyle.status, "APPLIED");
  assert.equal(
    toneStyle.applied_scope,
    "CONVERSATION",
  );
  assert.equal(toneStyle.claim_id, null);

  await withConnection(async (db) => {
    const repair = await db.query(
      `SELECT kind,
              status,
              structured_payload
         FROM translation_repair_events
        WHERE tenant_id = $1
          AND repair_event_id = $2`,
      [ids.tenantId, toneStyle.repair_event_id],
    );
    assert.equal(repair.rowCount, 1);
    assert.equal(
      repair.rows[0].kind,
      "TONE_CORRECTION",
    );
    assert.equal(
      repair.rows[0].status,
      "APPLIED",
    );
    assert.deepEqual(
      repair.rows[0].structured_payload,
      {
        schema_version: 1,
        kind: "TONE",
        preferred_register: "FORMAL",
      },
    );

    const state = await db.query(
      `SELECT style_state
         FROM conversation_context_states
        WHERE tenant_id = $1
          AND conversation_id = $2`,
      [ids.tenantId, ids.conversationId],
    );
    assert.equal(state.rowCount, 1);
    assert.deepEqual(
      state.rows[0].style_state,
      {
        profiles: [{
          speakerUserId: ids.senderUserId,
          preferredRegister: "FORMAL",
          sourceRepairEventId:
            toneStyle.repair_event_id,
          confidence: 1,
          updatedAt: runtimeNow,
        }],
      },
    );
  });

  runtimeNow = "2026-10-05T08:00:05.301Z";

  const styleAccepted =
    await runtime.sendService.sendMessage(
      sender,
      {
        protocol_version: 1,
        command_id:
          ids.styleMessageCommandId,
        client_message_id:
          ids.styleClientMessageId,
        conversation_id: ids.conversationId,
        source: {
          text: STYLE_SOURCE_TEXT,
          language_hint: "fr-FR",
        },
        client_authored_at: NOW,
      },
    );

  assert.equal(styleAccepted.status, "ACCEPTED");
  assert.equal(
    await runtime.translationWorker.runFanoutOnce(),
    "FANOUT_DONE",
  );

  await withConnection(async (db) => {
    const snapshot = await db.query(
      `SELECT strategy,
              selected_claim_refs,
              selected_candidate_ids
         FROM context_snapshots
        WHERE tenant_id = $1
          AND message_id = $2
          AND recipient_user_id = $3`,
      [
        ids.tenantId,
        styleAccepted.message_id,
        ids.recipientUserId,
      ],
    );
    assert.equal(snapshot.rowCount, 1);
    assert.equal(
      snapshot.rows[0].strategy,
      "T2_ADAPTIVE_V1",
    );
    assert.ok(
      snapshot.rows[0].selected_candidate_ids.includes(
        `style:${toneStyle.repair_event_id}`,
      ),
    );
    assert.equal(
      snapshot.rows[0].selected_claim_refs.includes(
        toneStyle.repair_event_id,
      ),
      false,
    );
  });

  assert.equal(
    await runtime.contextStateWorker.runOnce(),
    "REDUCED",
  );
  assert.equal(
    await runtime.translationWorker.runExecuteOnce(),
    "EXECUTION_DONE",
  );
  assert.equal(providerCalls, 5);

  runtimeNow = "2026-10-05T08:00:05.400Z";

  const toneReset =
    await runtime.correctionService.createCorrection(
      sender,
      {
        protocol_version: 1,
        command_id: ids.toneResetCommandId,
        conversation_id: ids.conversationId,
        kind: "TONE",
        requested_scope: "CONVERSATION",
        payload: {
          schema_version: 1,
          kind: "TONE",
          preferred_register: "DEFAULT",
        },
      },
    );

  assert.equal(toneReset.status, "APPLIED");
  assert.equal(toneReset.claim_id, null);

  await withConnection(async (db) => {
    const state = await db.query(
      `SELECT style_state
         FROM conversation_context_states
        WHERE tenant_id = $1
          AND conversation_id = $2`,
      [ids.tenantId, ids.conversationId],
    );
    assert.equal(state.rowCount, 1);
    assert.deepEqual(
      state.rows[0].style_state,
      {},
    );
  });

  runtimeNow = "2026-10-05T08:00:05.401Z";

  const postStyleResetAccepted =
    await runtime.sendService.sendMessage(
      sender,
      {
        protocol_version: 1,
        command_id:
          ids.postStyleResetCommandId,
        client_message_id:
          ids.postStyleResetClientMessageId,
        conversation_id: ids.conversationId,
        source: {
          text: POST_STYLE_RESET_SOURCE_TEXT,
          language_hint: "fr-FR",
        },
        client_authored_at: NOW,
      },
    );

  assert.equal(
    postStyleResetAccepted.status,
    "ACCEPTED",
  );
  assert.equal(
    await runtime.translationWorker.runFanoutOnce(),
    "FANOUT_DONE",
  );

  await withConnection(async (db) => {
    const snapshot = await db.query(
      `SELECT selected_candidate_ids
         FROM context_snapshots
        WHERE tenant_id = $1
          AND message_id = $2
          AND recipient_user_id = $3`,
      [
        ids.tenantId,
        postStyleResetAccepted.message_id,
        ids.recipientUserId,
      ],
    );
    assert.equal(snapshot.rowCount, 1);
    assert.equal(
      snapshot.rows[0].selected_candidate_ids.some(
        (id) => id.startsWith("style:"),
      ),
      false,
    );
  });

  assert.equal(
    await runtime.contextStateWorker.runOnce(),
    "REDUCED",
  );
  assert.equal(
    await runtime.translationWorker.runExecuteOnce(),
    "EXECUTION_DONE",
  );
  assert.equal(providerCalls, 6);

  const episodeAccepted = [];

  for (let index = 0; index < 6; index += 1) {
    runtimeNow =
      `2026-10-05T09:00:0${index}.000Z`;

    const accepted =
      await runtime.sendService.sendMessage(
        sender,
        {
          protocol_version: 1,
          command_id:
            ids.episodeCommandIds[index],
          client_message_id:
            ids.episodeClientMessageIds[index],
          conversation_id: ids.conversationId,
          source: {
            text: EPISODE_SOURCE_TEXTS[index],
            language_hint: "fr-FR",
          },
          client_authored_at: NOW,
        },
      );

    assert.equal(accepted.status, "ACCEPTED");
    episodeAccepted.push(accepted);

    assert.equal(
      await runtime.translationWorker.runFanoutOnce(),
      "FANOUT_DONE",
    );
    assert.equal(
      await runtime.contextStateWorker.runOnce(),
      "REDUCED",
    );
    assert.equal(
      await runtime.translationWorker.runExecuteOnce(),
      "EXECUTION_DONE",
    );
    assert.equal(
      providerCalls,
      7 + index,
    );
  }

  await withConnection(async (db) => {
    const state = await db.query(
      `SELECT active_episode_state
         FROM conversation_context_states
        WHERE tenant_id = $1
          AND conversation_id = $2`,
      [ids.tenantId, ids.conversationId],
    );
    assert.equal(state.rowCount, 1);

    const firstRevision = await db.query(
      `SELECT op_seq
         FROM message_revisions
        WHERE tenant_id = $1
          AND message_id = $2
          AND revision = 1`,
      [
        ids.tenantId,
        episodeAccepted[0].message_id,
      ],
    );
    const lastRevision = await db.query(
      `SELECT op_seq
         FROM message_revisions
        WHERE tenant_id = $1
          AND message_id = $2
          AND revision = 1`,
      [
        ids.tenantId,
        episodeAccepted[5].message_id,
      ],
    );

    const episode = state.rows[0].active_episode_state;
    assert.equal(episode.episodeVersion, 6);
    assert.equal(
      episode.startOperationSequence,
      Number(firstRevision.rows[0].op_seq),
    );
    assert.equal(
      episode.lastOperationSequence,
      Number(lastRevision.rows[0].op_seq),
    );
    assert.equal(
      episode.startedAt,
      "2026-10-05T09:00:00.000Z",
    );
    assert.equal(
      episode.lastActivityAt,
      "2026-10-05T09:00:05.000Z",
    );
    assert.ok(
      episode.continuityConfidence >= 0.6 &&
      episode.continuityConfidence <= 1,
    );
  });

  runtimeNow = "2026-10-05T09:00:06.000Z";

  const episodeTarget =
    await runtime.sendService.sendMessage(
      sender,
      {
        protocol_version: 1,
        command_id:
          ids.episodeCommandIds[6],
        client_message_id:
          ids.episodeClientMessageIds[6],
        conversation_id: ids.conversationId,
        source: {
          text: EPISODE_SOURCE_TEXTS[6],
          language_hint: "fr-FR",
        },
        client_authored_at: NOW,
      },
    );

  assert.equal(
    episodeTarget.status,
    "ACCEPTED",
  );
  assert.equal(
    await runtime.translationWorker.runFanoutOnce(),
    "FANOUT_DONE",
  );

  await withConnection(async (db) => {
    const snapshot = await db.query(
      `SELECT strategy,
              selected_candidate_ids,
              selected_source_revision_refs
         FROM context_snapshots
        WHERE tenant_id = $1
          AND message_id = $2
          AND recipient_user_id = $3`,
      [
        ids.tenantId,
        episodeTarget.message_id,
        ids.recipientUserId,
      ],
    );
    assert.equal(snapshot.rowCount, 1);
    assert.equal(
      snapshot.rows[0].strategy,
      "T2_ADAPTIVE_V1",
    );

    const episodeIds =
      snapshot.rows[0].selected_candidate_ids
        .filter(
          (id) => id.startsWith("episode:"),
        );
    assert.equal(episodeIds.length, 1);

    for (const accepted of episodeAccepted.slice(0, 3)) {
      assert.ok(
        snapshot.rows[0].selected_source_revision_refs.includes(
          `${accepted.message_id}:1`,
        ),
      );
    }
  });

  assert.equal(
    await runtime.contextStateWorker.runOnce(),
    "REDUCED",
  );
  assert.equal(
    await runtime.translationWorker.runExecuteOnce(),
    "EXECUTION_DONE",
  );
  assert.equal(providerCalls, 13);

  assert.ok(episodeProviderObservation);
  assert.equal(
    episodeProviderObservation.sourceText,
    EPISODE_SOURCE_TEXTS[6],
  );

  const observedEpisode =
    episodeProviderObservation.contextItems.find(
      (item) =>
        item.candidateType ===
          "ACTIVE_EPISODE",
    );
  assert.ok(observedEpisode);
  assert.equal(
    observedEpisode.selectionReason,
    "ACTIVE_EPISODE",
  );

  const episodePayload =
    JSON.parse(observedEpisode.content);
  assert.equal(
    episodePayload.kind,
    "trusted_active_episode_tail",
  );
  assert.equal(
    episodePayload.episode_version,
    6,
  );
  assert.ok(
    episodePayload.continuity_confidence >= 0.6 &&
    episodePayload.continuity_confidence <= 1,
  );
  assert.deepEqual(
    episodePayload.messages,
    EPISODE_SOURCE_TEXTS
      .slice(0, 3)
      .map((source_text) => ({
        source_text,
      })),
  );

  const observedImmediate =
    episodeProviderObservation.contextItems
      .filter(
        (item) =>
          item.candidateType ===
            "IMMEDIATE_MESSAGE",
      )
      .map((item) => item.content);

  for (const oldText of EPISODE_SOURCE_TEXTS.slice(0, 3)) {
    assert.equal(
      observedImmediate.includes(oldText),
      false,
    );
  }
  for (const recentText of EPISODE_SOURCE_TEXTS.slice(3, 6)) {
    assert.equal(
      observedImmediate.includes(recentText),
      true,
    );
  }

  runtimeNow = "2026-10-05T09:00:10.000Z";

  const stalePolicyAccepted =
    await runtime.sendService.sendMessage(
      sender,
      {
        protocol_version: 1,
        command_id: ids.stalePolicyCommandId,
        client_message_id:
          ids.stalePolicyClientMessageId,
        conversation_id: ids.conversationId,
        source: {
          text: "Le SLA reste important.",
          language_hint: "fr-FR",
        },
        client_authored_at: NOW,
      },
    );

  assert.equal(
    stalePolicyAccepted.status,
    "ACCEPTED",
  );
  assert.equal(
    await runtime.translationWorker.runFanoutOnce(),
    "FANOUT_DONE",
  );

  await withConnection(async (db) => {
    const snapshots = await db.query(
      `SELECT policy_version,
               tenant_policy_version,
               selected_claim_refs
         FROM context_snapshots
        WHERE tenant_id = $1
          AND message_id = $2
          AND recipient_user_id = $3`,
      [
        ids.tenantId,
        stalePolicyAccepted.message_id,
        ids.recipientUserId,
      ],
    );
    assert.equal(snapshots.rowCount, 1);
    assert.equal(
      Number(snapshots.rows[0].policy_version),
      1,
    );
    assert.equal(
      Number(
        snapshots.rows[0].tenant_policy_version,
      ),
      3,
    );
    assert.ok(
      snapshots.rows[0].selected_claim_refs.includes(
        `${tenantPolicyClaimId}:1`,
      ),
    );

    const conversationPolicy = await db.query(
      `SELECT policy_version
         FROM conversations
        WHERE tenant_id = $1
          AND conversation_id = $2`,
      [ids.tenantId, ids.conversationId],
    );
    assert.equal(conversationPolicy.rowCount, 1);
    assert.equal(
      Number(
        conversationPolicy.rows[0].policy_version,
      ),
      1,
    );
  });

  const tenantPolicyRevoked =
    await runtime.tenantPolicyService.revokePolicy(
      tenantAdmin,
      {
        protocol_version: 1,
        command_id:
          ids.tenantPolicyRevokeCommandId,
        claim_id: tenantPolicyClaimId,
      },
    );

  assert.equal(
    tenantPolicyRevoked.status,
    "REVOKED",
  );
  assert.equal(
    tenantPolicyRevoked.claim_id,
    tenantPolicyClaimId,
  );
  assert.equal(
    tenantPolicyRevoked.claim_version,
    1,
  );
  assert.equal(
    tenantPolicyRevoked.tenant_policy_version,
    4,
  );

  await withConnection(async (db) => {
    const claim = await db.query(
      `SELECT status
         FROM context_claims
        WHERE tenant_id = $1
          AND claim_id = $2
          AND claim_version = 1`,
      [ids.tenantId, tenantPolicyClaimId],
    );
    assert.equal(claim.rowCount, 1);
    assert.equal(
      claim.rows[0].status,
      "REVOKED",
    );

    const tenant = await db.query(
      `SELECT policy_version
         FROM tenants
        WHERE tenant_id = $1`,
      [ids.tenantId],
    );
    assert.equal(tenant.rowCount, 1);
    assert.equal(
      Number(tenant.rows[0].policy_version),
      4,
    );

    const conversationPolicy = await db.query(
      `SELECT policy_version
         FROM conversations
        WHERE tenant_id = $1
          AND conversation_id = $2`,
      [ids.tenantId, ids.conversationId],
    );
    assert.equal(conversationPolicy.rowCount, 1);
    assert.equal(
      Number(
        conversationPolicy.rows[0].policy_version,
      ),
      1,
    );
  });

  assert.equal(
    await runtime.translationWorker.runExecuteOnce(),
    "SUPERSEDED",
  );
  assert.equal(providerCalls, 13);

  await withConnection(async (db) => {
    const execution = await db.query(
      `SELECT status
         FROM translation_executions
        WHERE tenant_id = $1
          AND source_message_id = $2
          AND recipient_user_id = $3`,
      [
        ids.tenantId,
        stalePolicyAccepted.message_id,
        ids.recipientUserId,
      ],
    );
    assert.equal(execution.rowCount, 1);
    assert.equal(
      execution.rows[0].status,
      "SUPERSEDED",
    );

    const translated = await db.query(
      `SELECT COUNT(*)::integer AS count
         FROM delivery_envelopes
        WHERE tenant_id = $1
          AND message_id = $2
          AND rendition_type = 'TRANSLATION'`,
      [
        ids.tenantId,
        stalePolicyAccepted.message_id,
      ],
    );
    assert.equal(
      Number(translated.rows[0].count),
      0,
    );
  });

  runtimeNow = "2026-10-05T09:00:11.000Z";

  const staleContextAccepted =
    await runtime.sendService.sendMessage(
      sender,
      {
        protocol_version: 1,
        command_id: ids.staleContextCommandId,
        client_message_id: ids.staleContextClientMessageId,
        conversation_id: ids.conversationId,
        source: {
          text: "Bonjour encore",
          language_hint: "fr-FR",
        },
        client_authored_at: NOW,
      },
    );

  assert.equal(staleContextAccepted.status, "ACCEPTED");
  assert.equal(
    await runtime.translationWorker.runFanoutOnce(),
    "FANOUT_DONE",
  );

  const staleContextSnapshot = await withConnection(
    async (db) => {
      const snapshots = await db.query(
        `SELECT snapshot_id,
                strategy,
                erasure_epoch,
                selected_candidate_ids
           FROM context_snapshots
          WHERE tenant_id = $1
            AND message_id = $2
            AND recipient_user_id = $3`,
        [
          ids.tenantId,
          staleContextAccepted.message_id,
          ids.recipientUserId,
        ],
      );
      assert.equal(snapshots.rowCount, 1);
      assert.notEqual(snapshots.rows[0].strategy, "T0");
      assert.ok(
        snapshots.rows[0].selected_candidate_ids.length > 0,
      );

      const bumped = await db.query(
        `UPDATE conversations
            SET erasure_epoch = erasure_epoch + 1
          WHERE tenant_id = $1
            AND conversation_id = $2
        RETURNING erasure_epoch`,
        [ids.tenantId, ids.conversationId],
      );
      assert.equal(bumped.rowCount, 1);
      assert.equal(
        Number(bumped.rows[0].erasure_epoch),
        Number(snapshots.rows[0].erasure_epoch) + 1,
      );

      return snapshots.rows[0].snapshot_id;
    },
  );

  assert.match(
    staleContextSnapshot,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

  assert.equal(
    await runtime.translationWorker.runExecuteOnce(),
    "SUPERSEDED",
  );
  assert.equal(providerCalls, 13);

  await withConnection(async (db) => {
    const execution = await db.query(
      `SELECT status
         FROM translation_executions
        WHERE tenant_id = $1
          AND source_message_id = $2
          AND recipient_user_id = $3`,
      [
        ids.tenantId,
        staleContextAccepted.message_id,
        ids.recipientUserId,
      ],
    );
    assert.equal(execution.rowCount, 1);
    assert.equal(execution.rows[0].status, "SUPERSEDED");

    const translated = await db.query(
      `SELECT COUNT(*)::integer AS count
         FROM delivery_envelopes
        WHERE tenant_id = $1
          AND message_id = $2
          AND rendition_type = 'TRANSLATION'`,
      [ids.tenantId, staleContextAccepted.message_id],
    );
    assert.equal(Number(translated.rows[0].count), 0);
  });

  process.stdout.write(
    "POSTGRES_TRANSLATION_E2E=PASS " +
    "send=accepted fanout=done execute=done " +
    "feedback=repair-only " +
    "correction=speaker-scoped-self-applied " +
    "supersession=old-invalidated " +
    "review=pending-approved " +
    "reviewed-claim=revoked " +
    "revocation=claim-revoked " +
    "post-revoke=correction-absent " +
    "tenant-policy=control-plane-created " +
    "tenant-policy-update=old-invalidated " +
    "tenant-policy-revoked=control-plane " +
    "style=self-formal " +
    "style-reset=default " +
    "episode=transient-tail " +
    "episode-window=disjoint " +
    "conversation_policy_version=stable " +
    "tenant_policy_version=stale-context-superseded " +
    "t2=confirmed-correction-context " +
    "hpke=original+translation sync=2 ack=purged " +
    "erasure_epoch=stale-context-superseded\n",
  );
} catch (error) {
  failure = error;
} finally {
  try {
    await cleanup();
  } catch (error) {
    failure = combineFailure(failure, error);
  }
  try {
    await runtime?.close();
  } catch (error) {
    failure = combineFailure(failure, error);
  }
}

if (failure) {
  throw failure;
}

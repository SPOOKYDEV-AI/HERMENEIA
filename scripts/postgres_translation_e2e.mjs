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
const SOURCE_TEXT = "Bonjour monde 👋";
const T2_SOURCE_TEXT = "On fait le CR demain.";
const TRANSLATED_TEXT = "Hola mundo 👋";
const TARGET_LANGUAGE = "es-CO";

const ids = {
  tenantId: randomUUID(),
  senderUserId: randomUUID(),
  recipientUserId: randomUUID(),
  senderDeviceId: randomUUID(),
  recipientDeviceId: randomUUID(),
  conversationId: randomUUID(),
  commandId: randomUUID(),
  clientMessageId: randomUUID(),
  t2CommandId: randomUUID(),
  t2ClientMessageId: randomUUID(),
  correctionCommandId: randomUUID(),
  staleContextCommandId: randomUUID(),
  staleContextClientMessageId: randomUUID(),
};

const senderKeys = await generateHpkeP256DeviceKeyPair();
const recipientKeys = await generateHpkeP256DeviceKeyPair();
const codec = createHpkeP256EnvelopeCodec();

let providerCalls = 0;
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
          meaning: "change request",
          source_language_tag: "fr-FR",
        },
      );
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
         VALUES ($1,'ACTIVE','fr-FR'), ($2,'ACTIVE','es-CO')`,
        [ids.senderUserId, ids.recipientUserId],
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
           ($1,$3,'MEMBER','ACTIVE')`,
        [ids.tenantId, ids.senderUserId, ids.recipientUserId],
      );

      await db.query(
        `INSERT INTO devices(
           device_id, user_id, status, credential_version,
           public_material_ref, revocation_epoch, platform
         ) VALUES
           ($1,$2,'ACTIVE',1,$3,0,'DESKTOP'),
           ($4,$5,'ACTIVE',1,$6,0,'DESKTOP')`,
        [
          ids.senderDeviceId,
          ids.senderUserId,
          senderKeys.publicMaterialRef,
          ids.recipientDeviceId,
          ids.recipientUserId,
          recipientKeys.publicMaterialRef,
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
           ($1,$2,$4,'MODERATOR','ACTIVE','es-CO',NULL,1)`,
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
      await db.query(
        "DELETE FROM context_snapshots WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM provenance_edges WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM context_claims WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM translation_repair_events WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM conversation_context_states WHERE tenant_id = $1",
        tenant,
      );
      await db.query(
        "DELETE FROM translation_executions WHERE tenant_id = $1",
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
          WHERE user_id IN ($1,$2)`,
        [ids.senderUserId, ids.recipientUserId],
      );
      await db.query(
        `DELETE FROM device_sync_states
          WHERE device_id IN ($1,$2)`,
        [ids.senderDeviceId, ids.recipientDeviceId],
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
        "DELETE FROM devices WHERE user_id IN ($1,$2)",
        [ids.senderUserId, ids.recipientUserId],
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
        "DELETE FROM users WHERE user_id IN ($1,$2)",
        [ids.senderUserId, ids.recipientUserId],
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
        return NOW;
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

  const correction =
    await runtime.correctionService.createCorrection(
      recipient,
      {
        protocol_version: 1,
        command_id: ids.correctionCommandId,
        conversation_id: ids.conversationId,
        target_translation_id: durable.translationId,
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
  const correctionClaimId = correction.claim_id;

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

    const claim = await db.query(
      `SELECT authority_class,
              retention_class,
              scope_kind,
              scope_conversation_id,
              trigger_kind,
              proposition_ref
         FROM context_claims
        WHERE tenant_id = $1
          AND claim_id = $2
          AND claim_version = 1`,
      [ids.tenantId, correctionClaimId],
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
      [ids.tenantId, correctionClaimId],
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
        correctionClaimId,
      ),
    );
  });

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
    "correction=service-applied " +
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

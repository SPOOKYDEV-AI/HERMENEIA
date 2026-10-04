import test from "node:test";
import assert from "node:assert/strict";

import {
  SqlTransactionManager,
} from "../.build/packages/persistence/src/index.js";
import {
  PostgresContextSnapshotRepository,
} from "../.build/packages/persistence-postgres/src/context.js";

class ScriptedConnection {
  constructor(responses = []) {
    this.responses = [...responses];
    this.queries = [];
    this.released = false;
  }

  async query(text, params = []) {
    this.queries.push({
      text,
      params: [...params],
    });

    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK"
    ) {
      return { rows: [], rowCount: 0 };
    }

    return (
      this.responses.shift() ?? {
        rows: [],
        rowCount: 0,
      }
    );
  }

  release() {
    this.released = true;
  }
}

class SingleConnectionPool {
  constructor(connection) {
    this.connection = connection;
  }

  async connect() {
    return this.connection;
  }
}

function snapshot() {
  return {
    snapshotId: "snapshot-1",
    conversationId: "conversation-1",
    messageId: "message-8",
    sourceRevision: 1,
    recipientUserId: "user-b",
    targetLanguageTag: "fr-FR",
    targetProfileVersion: 3,
    strategy: "T2_ADAPTIVE_V1",
    strategyVersion: "adaptive-context-v1",
    contextStateVersion: 4,
    activeEpisodeId: "episode-1",
    selectedCandidateIds: [
      "candidate-a",
      "candidate-b",
    ],
    selectedSourceRevisionRefs: [
      "message-7:1",
    ],
    selectedClaimRefs: [
      "claim-1",
    ],
    processedPrefixSequence: 7,
    processingGapRefs: [],
    erasureEpoch: 2,
    tokenEstimate: 18,
    recoveryMode: "FAST",
    createdAt: "2026-10-04T20:00:00.000Z",
  };
}

test("PostgreSQL context snapshot insert persists metadata only", async () => {
  const connection = new ScriptedConnection([
    { rows: [], rowCount: 1 },
  ]);
  const repository =
    new PostgresContextSnapshotRepository(
      new SqlTransactionManager(
        new SingleConnectionPool(connection),
      ),
    );

  const inserted =
    await repository.withTransaction((tx) =>
      repository.insertContextSnapshot(
        tx,
        "tenant-1",
        snapshot(),
      ),
    );

  assert.equal(inserted, true);

  const query = connection.queries[1];
  assert.match(
    query.text,
    /INSERT INTO context_snapshots/,
  );
  assert.doesNotMatch(
    query.text,
    /selected_context|raw_text|source_text|content_payload/,
  );

  const serialized = JSON.stringify(query.params);
  assert.equal(
    serialized.includes(
      "private previous message",
    ),
    false,
  );
  assert.equal(
    serialized.includes("candidate-a"),
    true,
  );
  assert.equal(query.params.length, 21);
  assert.deepEqual(query.params.slice(0, 10), [
    "tenant-1",
    "snapshot-1",
    "conversation-1",
    "message-8",
    1,
    "user-b",
    "fr-FR",
    3,
    "T2_ADAPTIVE_V1",
    "adaptive-context-v1",
  ]);
  assert.equal(
    connection.queries.at(-1).text,
    "COMMIT",
  );
});

test("PostgreSQL context snapshot lookup reconstructs typed metadata", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        snapshot_id: "snapshot-1",
        conversation_id: "conversation-1",
        message_id: "message-8",
        source_revision: 1,
        recipient_user_id: "user-b",
        target_language_tag: "fr-FR",
        target_profile_version: 3,
        strategy: "T2_ADAPTIVE_V1",
        strategy_version: "adaptive-context-v1",
        context_state_version: 4,
        active_episode_id: "episode-1",
        selected_candidate_ids: [
          "candidate-a",
          "candidate-b",
        ],
        selected_source_revision_refs: [
          "message-7:1",
        ],
        selected_claim_refs: ["claim-1"],
        processed_prefix_sequence: 7,
        processing_gap_refs: [5, 6],
        erasure_epoch: 2,
        token_estimate: 18,
        recovery_mode: "PARTIAL",
        created_at: "2026-10-04 20:00:00+00",
      }],
      rowCount: 1,
    },
  ]);
  const repository =
    new PostgresContextSnapshotRepository(
      new SqlTransactionManager(
        new SingleConnectionPool(connection),
      ),
    );

  const result =
    await repository.withTransaction((tx) =>
      repository.getContextSnapshot(
        tx,
        "tenant-1",
        "snapshot-1",
      ),
    );

  assert.deepEqual(result, {
    snapshotId: "snapshot-1",
    conversationId: "conversation-1",
    messageId: "message-8",
    sourceRevision: 1,
    recipientUserId: "user-b",
    targetLanguageTag: "fr-FR",
    targetProfileVersion: 3,
    strategy: "T2_ADAPTIVE_V1",
    strategyVersion: "adaptive-context-v1",
    contextStateVersion: 4,
    activeEpisodeId: "episode-1",
    selectedCandidateIds: [
      "candidate-a",
      "candidate-b",
    ],
    selectedSourceRevisionRefs: [
      "message-7:1",
    ],
    selectedClaimRefs: ["claim-1"],
    processedPrefixSequence: 7,
    processingGapRefs: [5, 6],
    erasureEpoch: 2,
    tokenEstimate: 18,
    recoveryMode: "PARTIAL",
    createdAt: "2026-10-04 20:00:00+00",
  });

  assert.deepEqual(
    connection.queries[1].params,
    ["tenant-1", "snapshot-1"],
  );
});

test("PostgreSQL context snapshot lookup rejects malformed JSON metadata", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        snapshot_id: "snapshot-1",
        conversation_id: "conversation-1",
        message_id: "message-8",
        source_revision: 1,
        recipient_user_id: "user-b",
        target_language_tag: "fr-FR",
        target_profile_version: 3,
        strategy: "T0",
        strategy_version: "adaptive-context-v1",
        context_state_version: null,
        active_episode_id: null,
        selected_candidate_ids: {
          not: "an array",
        },
        selected_source_revision_refs: [],
        selected_claim_refs: [],
        processed_prefix_sequence: 0,
        processing_gap_refs: [],
        erasure_epoch: 0,
        token_estimate: 0,
        recovery_mode: "DEGRADED",
        created_at: "2026-10-04 20:00:00+00",
      }],
      rowCount: 1,
    },
  ]);
  const repository =
    new PostgresContextSnapshotRepository(
      new SqlTransactionManager(
        new SingleConnectionPool(connection),
      ),
    );

  await assert.rejects(
    () =>
      repository.withTransaction((tx) =>
        repository.getContextSnapshot(
          tx,
          "tenant-1",
          "snapshot-1",
        ),
      ),
    /Invalid context snapshot JSON field/,
  );

  assert.equal(
    connection.queries.at(-1).text,
    "ROLLBACK",
  );
});

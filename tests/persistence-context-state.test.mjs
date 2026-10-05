import test from "node:test";
import assert from "node:assert/strict";

import {
  createInitialContextState,
  registerContextOperation,
} from "../.build/packages/context-state/src/index.js";
import {
  SqlTransactionManager,
} from "../.build/packages/persistence/src/index.js";
import {
  PostgresConversationContextStateRepository,
} from "../.build/packages/persistence-postgres/src/context-state.js";

class ScriptedConnection {
  constructor(responses = []) {
    this.responses = [...responses];
    this.queries = [];
    this.released = false;
  }

  async query(text, params = []) {
    this.queries.push({ text, params: [...params] });

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

function repositoryWith(responses = []) {
  const connection = new ScriptedConnection(responses);
  return {
    connection,
    repository:
      new PostgresConversationContextStateRepository(
        new SqlTransactionManager(
          new SingleConnectionPool(connection),
        ),
      ),
  };
}

function durableRow(overrides = {}) {
  return {
    tenant_id: "tenant-1",
    conversation_id: "conversation-1",
    state_version: 4,
    causal_floor_sequence: 0,
    processed_prefix_sequence: 7,
    pending_operations: [
      {
        opSeq: 8,
        operationId: "op-8",
        kind: "MESSAGE_EDITED",
        messageId: "message-7",
        sourceRevision: 2,
        status: "PENDING",
        registeredAt: "2026-10-05T09:00:00.000Z",
      },
    ],
    active_episode_state: {
      episodeId: "episode-1",
      episodeVersion: 2,
      continuityConfidence: 0.8,
      continuityStrategy: "heuristic-v1",
      startedAt: "2026-10-05T08:55:00.000Z",
      lastActivityAt: "2026-10-05T08:59:00.000Z",
      sourceLanguageTag: "fr-fr",
      sourceRevisionRefs: [
        "message-5:1",
        "message-6:1"
      ],
    },
    terminology_claim_refs: ["claim:term-1"],
    lexical_claim_refs: [],
    correction_claim_refs: ["claim:correction-1"],
    entity_handles: ["entity:project"],
    unresolved_reference_handles: [],
    style_state: {
      formality: "MEDIUM",
      confidence: 0.7,
    },
    pragmatic_state: {
      stance: "NEUTRAL",
      confidence: 0.8,
    },
    membership_epoch: 0,
    erasure_epoch: 2,
    policy_version: 1,
    strategy_version: "context-v1",
    state_schema_version: 1,
    recovery_mode: "FULL",
    status: "ACTIVE",
    updated_at: "2026-10-05 09:00:00+00",
    ...overrides,
  };
}

function initialState() {
  return createInitialContextState({
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    membershipEpoch: 0,
    erasureEpoch: 0,
    policyVersion: 1,
    strategyVersion: "context-v1",
    now: "2026-10-05T09:00:00.000Z",
  });
}

test("PostgreSQL ConversationState load validates durable JSON and maps operation causality to the Context Engine", async () => {
  const { repository, connection } = repositoryWith([
    {
      rows: [durableRow()],
      rowCount: 1,
    },
  ]);

  const result = await repository.withTransaction((tx) =>
    repository.loadEngineState(tx, {
      tenantId: "tenant-1",
      conversationId: "conversation-1",
    }),
  );

  assert.deepEqual(result, {
    conversationId: "conversation-1",
    contextVersion: 4,
    processedPrefixOperationSequence: 7,
    processingGapOperationSequences: [8],
    erasureEpoch: 2,
    policyVersion: 1,
    activeEpisodeId: "episode-1",
    activeEpisodeVersion: 2,
    activeEpisodeContinuityConfidence: 0.8,
    activeEpisodeSourceRevisionRefs: [
      "message-5:1",
      "message-6:1",
    ],
    terminologyClaimRefs: ["claim:term-1"],
    lexicalClaimRefs: [],
    correctionClaimRefs: ["claim:correction-1"],
    updatedAt: "2026-10-05 09:00:00+00",
  });

  const query = connection.queries[1];
  assert.match(query.text, /FROM conversation_context_states/);
  assert.deepEqual(query.params, [
    "tenant-1",
    "conversation-1",
  ]);
  assert.equal(connection.queries.at(-1).text, "COMMIT");
});

test("PostgreSQL ConversationState load fails closed on malformed durable state", async () => {
  const { repository, connection } = repositoryWith([
    {
      rows: [
        durableRow({
          pending_operations: {
            not: "an array",
          },
        }),
      ],
      rowCount: 1,
    },
  ]);

  await assert.rejects(
    () =>
      repository.withTransaction((tx) =>
        repository.loadState(tx, {
          tenantId: "tenant-1",
          conversationId: "conversation-1",
        }),
      ),
    /Invalid ConversationState JSON field/,
  );

  assert.equal(connection.queries.at(-1).text, "ROLLBACK");
});

test("PostgreSQL ConversationState insert persists bounded structured state and no transcript body", async () => {
  const { repository, connection } = repositoryWith([
    { rows: [], rowCount: 1 },
  ]);
  let state = initialState();
  state = registerContextOperation(state, {
    opSeq: 1,
    operationId: "op-1",
    kind: "MESSAGE_CREATED",
    messageId: "message-1",
    sourceRevision: 1,
    registeredAt: "2026-10-05T09:00:01.000Z",
  });

  const inserted = await repository.withTransaction((tx) =>
    repository.insertState(tx, state),
  );

  assert.equal(inserted, true);
  const query = connection.queries[1];
  assert.match(
    query.text,
    /INSERT INTO conversation_context_states/,
  );
  assert.doesNotMatch(
    query.text,
    /raw_text|source_text|message_text|transcript/,
  );
  assert.equal(
    JSON.stringify(query.params).includes(
      "private conversation body",
    ),
    false,
  );
  assert.equal(query.params[0], "tenant-1");
  assert.equal(query.params[1], "conversation-1");
  assert.equal(query.params[2], 2);
  assert.equal(connection.queries.at(-1).text, "COMMIT");
});

test("PostgreSQL ConversationState update is optimistic and refuses non-advancing versions", async () => {
  const { repository, connection } = repositoryWith([
    { rows: [], rowCount: 1 },
  ]);
  const base = initialState();
  const next = registerContextOperation(base, {
    opSeq: 1,
    operationId: "op-1",
    kind: "MESSAGE_CREATED",
    messageId: "message-1",
    sourceRevision: 1,
    registeredAt: "2026-10-05T09:00:01.000Z",
  });

  const updated = await repository.withTransaction((tx) =>
    repository.updateState(tx, {
      expectedStateVersion: base.stateVersion,
      state: next,
    }),
  );

  assert.equal(updated, true);
  const query = connection.queries[1];
  assert.match(
    query.text,
    /AND state_version = \$23/,
  );
  assert.equal(
    query.params.at(-1),
    base.stateVersion,
  );

  await assert.rejects(
    () =>
      repository.withTransaction((tx) =>
        repository.updateState(tx, {
          expectedStateVersion: next.stateVersion,
          state: next,
        }),
      ),
    /requires a newer stateVersion/,
  );
});

test("PostgreSQL ConversationState load can take a row lock for mutation", async () => {
  const { repository, connection } = repositoryWith([
    {
      rows: [durableRow()],
      rowCount: 1,
    },
  ]);

  await repository.withTransaction((tx) =>
    repository.loadState(tx, {
      tenantId: "tenant-1",
      conversationId: "conversation-1",
      forUpdate: true,
    }),
  );

  assert.match(
    connection.queries[1].text,
    /FOR UPDATE$/,
  );
});

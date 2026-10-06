import test from "node:test";
import assert from "node:assert/strict";

import {
  SqlTransactionManager,
} from "../.build/packages/persistence/src/index.js";
import {
  PostgresRecoveryCheckpointRepository,
} from "../.build/packages/persistence-postgres/src/recovery-checkpoints.js";
import {
  createInitialContextState,
} from "../.build/packages/context-state/src/index.js";

class ScriptedConnection {
  constructor(responses = []) {
    this.responses = [...responses];
    this.queries = [];
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
    return this.responses.shift() ?? {
      rows: [],
      rowCount: 0,
    };
  }

  release() {}
}

class Pool {
  constructor(connection) {
    this.connection = connection;
  }
  async connect() {
    return this.connection;
  }
}

function state() {
  const value = createInitialContextState({
    tenantId:
      "10000000-0000-4000-8000-000000000001",
    conversationId:
      "10000000-0000-4000-8000-000000000002",
    membershipEpoch: 2,
    erasureEpoch: 3,
    policyVersion: 4,
    strategyVersion: "context-state-v1",
    now: "2026-10-05T20:00:00.000Z",
  });
  value.stateVersion = 9;
  value.processedPrefixOpSeq = 8;
  value.correctionClaimRefs = [
    "10000000-0000-4000-8000-000000000003",
  ];
  return value;
}

test("PostgreSQL checkpoint capture is fenced, bounded and keeps only active plus previous", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        membership_epoch: 2,
        erasure_epoch: 3,
        policy_version: 4,
        tenant_policy_version: 5,
      }],
      rowCount: 1,
    },
    { rows: [], rowCount: 0 },
    {
      rows: [{
        checkpoint_version: 8,
      }],
      rowCount: 1,
    },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);
  const repository =
    new PostgresRecoveryCheckpointRepository(
      new SqlTransactionManager(
        new Pool(connection),
      ),
    );

  const result = await repository.capture(
    state(),
    "2026-10-05T20:01:00.000Z",
    3600,
  );

  assert.equal(result, "CAPTURED");

  const sql = connection.queries
    .map((query) => query.text)
    .join("\n");
  assert.match(
    sql,
    /FOR SHARE OF c, t/,
  );
  assert.match(
    sql,
    /status = 'SUPERSEDED'/,
  );
  assert.match(
    sql,
    /INSERT INTO recovery_checkpoints/,
  );
  assert.match(
    sql,
    /DELETE FROM recovery_checkpoints/,
  );

  const insert = connection.queries.find(
    (query) =>
      /INSERT INTO recovery_checkpoints/.test(
        query.text,
      ),
  );
  const payload = JSON.parse(
    insert.params[9],
  );
  assert.deepEqual(
    payload.correction_claim_refs,
    [
      "10000000-0000-4000-8000-000000000003",
    ],
  );
  assert.equal(
    "style_state" in payload,
    false,
  );
  assert.equal(
    "entity_handles" in payload,
    false,
  );
});

test("checkpoint capture refuses stale authoritative frontiers", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        membership_epoch: 2,
        erasure_epoch: 99,
        policy_version: 4,
        tenant_policy_version: 5,
      }],
      rowCount: 1,
    },
  ]);
  const repository =
    new PostgresRecoveryCheckpointRepository(
      new SqlTransactionManager(
        new Pool(connection),
      ),
    );

  assert.equal(
    await repository.capture(
      state(),
      "2026-10-05T20:01:00.000Z",
    ),
    "STALE",
  );
  assert.equal(
    connection.queries.some(
      (query) =>
        /INSERT INTO recovery_checkpoints/.test(
          query.text,
        ),
    ),
    false,
  );
});

test("restore query requires exact clean prefix and all authority frontiers", async () => {
  const row = {
    tenant_id:
      "10000000-0000-4000-8000-000000000001",
    conversation_id:
      "10000000-0000-4000-8000-000000000002",
    checkpoint_version: 9,
    schema_version: 1,
    context_strategy_version:
      "context-state-v1",
    base_context_state_version: 9,
    processed_prefix_sequence: 8,
    processing_gap_manifest: [],
    membership_epoch: 2,
    erasure_epoch: 3,
    policy_version: 4,
    tenant_policy_version: 5,
    payload: {
      schema_version: 1,
      terminology_claim_refs: [],
      lexical_claim_refs: [],
      correction_claim_refs: [],
    },
    status: "ACTIVE",
    created_at:
      "2026-10-05 20:00:00+00",
    expires_at:
      "2026-10-06 20:00:00+00",
  };
  const connection = new ScriptedConnection([
    { rows: [row], rowCount: 1 },
  ]);
  const repository =
    new PostgresRecoveryCheckpointRepository(
      new SqlTransactionManager(
        new Pool(connection),
      ),
    );

  const checkpoint =
    await repository.withTransaction((tx) =>
      repository.loadValidForRestore(
        tx,
        {
          tenantId: row.tenant_id,
          conversationId:
            row.conversation_id,
          requiredProcessedPrefixOpSeq: 8,
          strategyVersion:
            "context-state-v1",
          now:
            "2026-10-05T20:05:00.000Z",
        },
      ),
    );

  assert.ok(checkpoint);
  assert.equal(
    checkpoint.tenantPolicyVersion,
    5,
  );

  const query = connection.queries[1];
  assert.match(
    query.text,
    /processed_prefix_sequence = \$4/,
  );
  assert.match(
    query.text,
    /processing_gap_manifest = '\[\]'::jsonb/,
  );
  assert.match(
    query.text,
    /rc\.membership_epoch =/,
  );
  assert.match(
    query.text,
    /rc\.erasure_epoch =/,
  );
  assert.match(
    query.text,
    /rc\.policy_version =/,
  );
  assert.match(
    query.text,
    /rc\.tenant_policy_version =/,
  );
  assert.match(
    query.text,
    /rc\.expires_at > \$5/,
  );
});

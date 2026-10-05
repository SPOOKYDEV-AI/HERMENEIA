import test from "node:test";
import assert from "node:assert/strict";

import {
  SqlTransactionManager,
} from "../.build/packages/persistence/src/index.js";
import {
  PostgresContextClaimRepository,
} from "../.build/packages/persistence-postgres/src/context-claims.js";

class ScriptedConnection {
  constructor(responses = []) {
    this.responses = [...responses];
    this.queries = [];
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
    return this.responses.shift() ?? {
      rows: [],
      rowCount: 0,
    };
  }

  release() {}
}

class SingleConnectionPool {
  constructor(connection) {
    this.connection = connection;
  }

  async connect() {
    return this.connection;
  }
}

test("PostgreSQL claim loader enforces referenced IDs and admissibility in SQL", async () => {
  const connection = new ScriptedConnection([
    {
      rows: [{
        claim_id: "11111111-1111-4111-8111-111111111111",
        claim_version: 2,
        conversation_id:
          "22222222-2222-4222-8222-222222222222",
        subject_user_id:
          "44444444-4444-4444-8444-444444444444",
        proposition_ref: {
          schema_version: 1,
          kind: "TERM_MEANING",
          surface_form: "CR",
          meaning: "change request",
        },
        modality: "CORRECTION",
        authority_class: "CONFIRMED_CORRECTION",
        retention_class: "CORRECTIVE_DURABLE",
        sensitivity_class: "NORMAL",
        confidence: "1.0",
        scope_kind: "CONVERSATION",
        scope_conversation_id:
          "22222222-2222-4222-8222-222222222222",
        trigger_kind: "EXPLICIT_TEXTUAL_CORRECTION",
        valid_from: "2026-10-05 09:00:00+00",
        valid_until: null,
        status: "ACTIVE",
      }],
      rowCount: 1,
    },
  ]);

  const repository = new PostgresContextClaimRepository(
    new SqlTransactionManager(
      new SingleConnectionPool(connection),
    ),
  );

  const claims = await repository.withTransaction((tx) =>
    repository.loadReferencedClaims(tx, {
      tenantId:
        "33333333-3333-4333-8333-333333333333",
      conversationId:
        "22222222-2222-4222-8222-222222222222",
      claimIds: [
        "11111111-1111-4111-8111-111111111111",
        "11111111-1111-4111-8111-111111111111",
      ],
      asOf: "2026-10-05T10:00:00.000Z",
    }),
  );

  assert.equal(claims.length, 1);
  assert.equal(claims[0].claimVersion, 2);
  assert.equal(claims[0].confidence, 1);
  assert.equal(
    claims[0].subjectUserId,
    "44444444-4444-4444-8444-444444444444",
  );
  assert.deepEqual(claims[0].propositionRef, {
    schema_version: 1,
    kind: "TERM_MEANING",
    surface_form: "CR",
    meaning: "change request",
  });

  const query = connection.queries[1];
  assert.match(
    query.text,
    /jsonb_array_elements_text\(\$2::jsonb\)/,
  );
  assert.match(query.text, /subject_user_id/);
  assert.match(query.text, /status = 'ACTIVE'/);
  assert.match(query.text, /sensitivity_class = 'NORMAL'/);
  assert.match(query.text, /valid_from IS NULL OR valid_from < \$4/);
  assert.match(query.text, /valid_until IS NULL OR valid_until > \$4/);
  assert.match(query.text, /scope_conversation_id = \$3/);
  assert.match(query.text, /CONFIRMED_CORRECTION/);
  assert.match(query.text, /APPROVED_GLOSSARY/);
  assert.match(query.text, /TENANT_POLICY_CHANGE/);
  assert.deepEqual(query.params, [
    "33333333-3333-4333-8333-333333333333",
    '["11111111-1111-4111-8111-111111111111"]',
    "22222222-2222-4222-8222-222222222222",
    "2026-10-05T10:00:00.000Z",
  ]);
});

test("PostgreSQL claim loader avoids a query for an empty bounded reference set", async () => {
  const connection = new ScriptedConnection();
  const repository = new PostgresContextClaimRepository(
    new SqlTransactionManager(
      new SingleConnectionPool(connection),
    ),
  );

  const claims = await repository.withTransaction((tx) =>
    repository.loadReferencedClaims(tx, {
      tenantId: "tenant-1",
      conversationId: "conversation-1",
      claimIds: [],
      asOf: "2026-10-05T10:00:00.000Z",
    }),
  );

  assert.deepEqual(claims, []);
  assert.deepEqual(
    connection.queries.map((query) => query.text),
    ["BEGIN", "COMMIT"],
  );
});


test("PostgreSQL claim loader rejects malformed durable claim references before SQL casting", async () => {
  const connection = new ScriptedConnection();
  const repository = new PostgresContextClaimRepository(
    new SqlTransactionManager(
      new SingleConnectionPool(connection),
    ),
  );

  await assert.rejects(
    () =>
      repository.withTransaction((tx) =>
        repository.loadReferencedClaims(tx, {
          tenantId:
            "33333333-3333-4333-8333-333333333333",
          conversationId:
            "22222222-2222-4222-8222-222222222222",
          claimIds: ["not-a-uuid"],
          asOf: "2026-10-05T10:00:00.000Z",
        }),
      ),
    /canonical UUID/,
  );

  assert.deepEqual(
    connection.queries.map((query) => query.text),
    ["BEGIN", "ROLLBACK"],
  );
});

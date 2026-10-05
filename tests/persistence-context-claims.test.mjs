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


function tenantPolicyRow(
  claimId =
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  overrides = {},
) {
  return {
    claim_id: claimId,
    claim_version: 1,
    conversation_id: null,
    subject_user_id: null,
    proposition_ref: {
      schema_version: 1,
      kind: "TERM_MEANING",
      surface_form: "CR",
      meaning: "change request",
      source_language_tag: "fr-FR",
    },
    modality: "ASSERTION",
    authority_class: "APPROVED_GLOSSARY",
    retention_class: "POLICY_REFERENCE",
    sensitivity_class: "NORMAL",
    confidence: "1.0",
    scope_kind: "TENANT",
    scope_conversation_id: null,
    trigger_kind: "APPROVED_GLOSSARY_CHANGE",
    valid_from: "2026-10-05 09:00:00+00",
    valid_until: null,
    status: "ACTIVE",
    ...overrides,
  };
}

test("PostgreSQL tenant policy overlay loads only bounded active generic tenant authority", async () => {
  const connection = new ScriptedConnection([{
    rows: [tenantPolicyRow()],
    rowCount: 1,
  }]);
  const repository = new PostgresContextClaimRepository(
    new SqlTransactionManager(
      new SingleConnectionPool(connection),
    ),
  );

  const claims = await repository.withTransaction((tx) =>
    repository.loadTenantPolicyClaims(tx, {
      tenantId:
        "33333333-3333-4333-8333-333333333333",
      asOf: "2026-10-05T10:00:00.000Z",
    }),
  );

  assert.equal(claims.length, 1);
  assert.equal(
    claims[0].authorityClass,
    "APPROVED_GLOSSARY",
  );
  assert.equal(claims[0].scopeKind, "TENANT");
  assert.equal(claims[0].conversationId, null);
  assert.equal(claims[0].subjectUserId, null);

  const query = connection.queries[1];
  assert.match(
    query.text,
    /conversation_id IS NULL/,
  );
  assert.match(
    query.text,
    /subject_user_id IS NULL/,
  );
  assert.match(
    query.text,
    /scope_kind = 'TENANT'/,
  );
  assert.match(
    query.text,
    /scope_conversation_id IS NULL/,
  );
  assert.match(
    query.text,
    /authority_class = 'APPROVED_GLOSSARY'/,
  );
  assert.match(
    query.text,
    /authority_class = 'POLICY'/,
  );
  assert.match(
    query.text,
    /retention_class = 'POLICY_REFERENCE'/,
  );
  assert.match(
    query.text,
    /modality = 'ASSERTION'/,
  );
  assert.match(
    query.text,
    /valid_from IS NULL OR valid_from < \$2/,
  );
  assert.match(query.text, /LIMIT 129/);
  assert.deepEqual(query.params, [
    "33333333-3333-4333-8333-333333333333",
    "2026-10-05T10:00:00.000Z",
  ]);
});

test("PostgreSQL tenant policy overlay fails closed instead of truncating more than 128 active claims", async () => {
  const rows = Array.from(
    { length: 129 },
    (_, index) =>
      tenantPolicyRow(
        `aaaaaaaa-aaaa-4aaa-8aaa-${String(
          index + 1,
        ).padStart(12, "0")}`,
      ),
  );
  const connection = new ScriptedConnection([{
    rows,
    rowCount: rows.length,
  }]);
  const repository = new PostgresContextClaimRepository(
    new SqlTransactionManager(
      new SingleConnectionPool(connection),
    ),
  );

  await assert.rejects(
    () =>
      repository.withTransaction((tx) =>
        repository.loadTenantPolicyClaims(
          tx,
          {
            tenantId:
              "33333333-3333-4333-8333-333333333333",
            asOf:
              "2026-10-05T10:00:00.000Z",
          },
        ),
      ),
    /exceeds bounded limit/,
  );

  assert.equal(
    connection.queries.at(-1).text,
    "ROLLBACK",
  );
});

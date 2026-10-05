import test from "node:test";
import assert from "node:assert/strict";

import {
  SqlTransactionManager,
} from "../.build/packages/persistence/src/index.js";
import {
  PostgresTenantContextPolicyRepository,
} from "../.build/packages/persistence-postgres/src/context-policies.js";

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
    return (
      this.responses.shift() ?? {
        rows: [],
        rowCount: 0,
      }
    );
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

function repositoryWith(responses) {
  const connection =
    new ScriptedConnection(responses);
  return {
    connection,
    repository:
      new PostgresTenantContextPolicyRepository(
        new SqlTransactionManager(
          new SingleConnectionPool(
            connection,
          ),
        ),
      ),
  };
}

const actor = {
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-1",
};

test("PostgreSQL tenant policy authority locks active tenant and requires active membership/device", async () => {
  const { repository, connection } =
    repositoryWith([{
      rows: [{
        tenant_role: "OWNER",
        policy_version: 7,
      }],
      rowCount: 1,
    }]);

  const authority =
    await repository.withTransaction(
      (tx) =>
        repository.lockTenantAuthority(
          tx,
          actor,
        ),
    );

  assert.deepEqual(authority, {
    tenantRole: "OWNER",
    tenantPolicyVersion: 7,
  });

  const query = connection.queries[1];
  assert.match(
    query.text,
    /tm\.status = 'ACTIVE'/,
  );
  assert.match(
    query.text,
    /d\.status = 'ACTIVE'/,
  );
  assert.match(
    query.text,
    /t\.status = 'ACTIVE'/,
  );
  assert.match(
    query.text,
    /FOR UPDATE OF t/,
  );
  assert.deepEqual(query.params, [
    "tenant-1",
    "user-1",
    "device-1",
  ]);
});

test("PostgreSQL tenant policy supersession is generic tenant-only and authority-class specific", async () => {
  const { repository, connection } =
    repositoryWith([{
      rows: [{
        claim_id: "claim-old",
        claim_version: 2,
      }],
      rowCount: 1,
    }]);

  const proposition = {
    schema_version: 1,
    kind: "TERM_MEANING",
    surface_form: "SLA",
    meaning:
      "service level agreement",
    source_language_tag: "fr-FR",
  };

  const superseded =
    await repository.withTransaction(
      (tx) =>
        repository
          .invalidateSupersededTenantClaims(
            tx,
            {
              tenantId: "tenant-1",
              authorityClass:
                "APPROVED_GLOSSARY",
              propositionRef:
                proposition,
              invalidatedAt:
                "2026-10-05T13:20:00.000Z",
            },
          ),
    );

  assert.deepEqual(superseded, [{
    claimId: "claim-old",
    claimVersion: 2,
  }]);

  const query = connection.queries[1];
  assert.match(
    query.text,
    /conversation_id IS NULL/,
  );
  assert.match(
    query.text,
    /message_id IS NULL/,
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
    /authority_class = \$2/,
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
    /surface_form/,
  );
  assert.deepEqual(
    query.params.slice(0, 3),
    [
      "tenant-1",
      "APPROVED_GLOSSARY",
      JSON.stringify(proposition),
    ],
  );
});

test("PostgreSQL tenant policy insert persists only structured generic tenant authority", async () => {
  const { repository, connection } =
    repositoryWith([{
      rows: [],
      rowCount: 1,
    }]);

  await repository.withTransaction(
    (tx) =>
      repository
        .insertTenantPolicyClaim(
          tx,
          {
            tenantId: "tenant-1",
            claimId: "claim-new",
            claimType:
              "LEXICAL_PREFERENCE",
            propositionRef: {
              schema_version: 1,
              kind:
                "PREFERRED_RENDERING",
              source_form: "SLA",
              target_form: "ANS",
              target_language_tag:
                "fr-FR",
            },
            authorityClass: "POLICY",
            triggerKind:
              "TENANT_POLICY_CHANGE",
            createdAt:
              "2026-10-05T13:20:00.000Z",
          },
        ),
  );

  const query = connection.queries[1];
  assert.match(
    query.text,
    /INSERT INTO context_claims/,
  );
  assert.match(
    query.text,
    /'ASSERTION'/,
  );
  assert.match(
    query.text,
    /'POLICY_REFERENCE'/,
  );
  assert.match(
    query.text,
    /'TENANT'/,
  );
  assert.match(
    query.text,
    /NULL,NULL,NULL/,
  );
  assert.deepEqual(query.params, [
    "tenant-1",
    "claim-new",
    "LEXICAL_PREFERENCE",
    JSON.stringify({
      schema_version: 1,
      kind: "PREFERRED_RENDERING",
      source_form: "SLA",
      target_form: "ANS",
      target_language_tag: "fr-FR",
    }),
    "POLICY",
    "TENANT_POLICY_CHANGE",
    "2026-10-05T13:20:00.000Z",
  ]);
});

test("PostgreSQL tenant policy version bump and revocation stay on tenant authority rows", async () => {
  const { repository, connection } =
    repositoryWith([
      {
        rows: [{
          policy_version: 9,
        }],
        rowCount: 1,
      },
      {
        rows: [{
          claim_id: "claim-1",
          claim_version: 3,
          authority_class:
            "APPROVED_GLOSSARY",
        }],
        rowCount: 1,
      },
      {
        rows: [],
        rowCount: 1,
      },
    ]);

  const version =
    await repository.withTransaction(
      async (tx) => {
        const next =
          await repository
            .bumpTenantPolicyVersion(
              tx,
              "tenant-1",
            );
        const claim =
          await repository
            .loadRevocableTenantClaim(
              tx,
              {
                tenantId: "tenant-1",
                claimId: "claim-1",
              },
            );
        assert.deepEqual(claim, {
          claimId: "claim-1",
          claimVersion: 3,
          authorityClass:
            "APPROVED_GLOSSARY",
        });
        const revoked =
          await repository.revokeTenantClaim(
            tx,
            {
              tenantId: "tenant-1",
              claimId: "claim-1",
              claimVersion: 3,
              revokedAt:
                "2026-10-05T13:21:00.000Z",
            },
          );
        assert.equal(revoked, true);
        return next;
      },
    );

  assert.equal(version, 9);

  const bump = connection.queries[1];
  assert.match(
    bump.text,
    /UPDATE tenants/,
  );
  assert.match(
    bump.text,
    /policy_version \+ 1/,
  );

  const load = connection.queries[2];
  assert.match(
    load.text,
    /scope_kind = 'TENANT'/,
  );
  assert.match(
    load.text,
    /authority_class IN/,
  );
  assert.match(
    load.text,
    /FOR UPDATE/,
  );

  const revoke = connection.queries[3];
  assert.match(
    revoke.text,
    /SET status = 'REVOKED'/,
  );
  assert.match(
    revoke.text,
    /conversation_id IS NULL/,
  );
  assert.match(
    revoke.text,
    /retention_class =/,
  );
});

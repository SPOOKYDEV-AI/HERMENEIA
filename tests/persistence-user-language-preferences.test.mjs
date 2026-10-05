import test from "node:test";
import assert from "node:assert/strict";

import {
  SqlTransactionManager,
} from "../.build/packages/persistence/src/index.js";
import {
  PostgresUserLanguagePreferenceRepository,
} from "../.build/packages/persistence-postgres/src/user-language-preferences.js";

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

function repositoryWith(responses) {
  const connection =
    new ScriptedConnection(responses);
  return {
    connection,
    repository:
      new PostgresUserLanguagePreferenceRepository(
        new SqlTransactionManager(
          new Pool(connection),
        ),
      ),
  };
}

const actor = {
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-1",
};

test("preference authority requires active tenant membership and active actor device", async () => {
  const { repository, connection } =
    repositoryWith([{
      rows: [{ "?column?": 1 }],
      rowCount: 1,
    }]);

  const authorized =
    await repository.withTransaction(
      (tx) =>
        repository.lockActiveActor(
          tx,
          actor,
        ),
    );

  assert.equal(authorized, true);
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
    /FOR SHARE OF tm, d/,
  );
});

test("preference read locks the durable user default row", async () => {
  const { repository, connection } =
    repositoryWith([{
      rows: [{
        tenant_id: "tenant-1",
        user_id: "user-1",
        target_language_tag: "es",
        target_locale_override: "es-CO",
        preferred_register: "FORMAL",
        preference_version: 3,
        updated_at:
          "2026-10-05 14:00:00+00",
      }],
      rowCount: 1,
    }]);

  const value =
    await repository.withTransaction(
      (tx) =>
        repository.loadForUpdate(tx, {
          tenantId: "tenant-1",
          userId: "user-1",
        }),
    );

  assert.equal(
    value.preferredRegister,
    "FORMAL",
  );
  assert.equal(
    value.preferenceVersion,
    3,
  );
  assert.match(
    connection.queries[1].text,
    /FOR UPDATE/,
  );
});

test("preference write is bounded upsert and profile invalidation bumps only active memberships", async () => {
  const { repository, connection } =
    repositoryWith([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 4 },
    ]);

  const result =
    await repository.withTransaction(
      async (tx) => {
        await repository.write(
          tx,
          {
            tenantId: "tenant-1",
            userId: "user-1",
            targetLanguageTag: "es",
            targetLocaleOverride: "es-CO",
            preferredRegister: "INFORMAL",
            preferenceVersion: 4,
            updatedAt:
              "2026-10-05T14:00:00.000Z",
          },
        );
        return repository
          .bumpActiveMembershipProfiles(
            tx,
            {
              tenantId: "tenant-1",
              userId: "user-1",
            },
          );
      },
    );

  assert.equal(result, 4);
  const upsert = connection.queries[1];
  assert.match(
    upsert.text,
    /INSERT INTO user_language_preferences/,
  );
  assert.match(
    upsert.text,
    /ON CONFLICT \(tenant_id, user_id\)/,
  );
  assert.deepEqual(upsert.params, [
    "tenant-1",
    "user-1",
    "es",
    "es-CO",
    "INFORMAL",
    4,
    "2026-10-05T14:00:00.000Z",
  ]);

  const bump = connection.queries[2];
  assert.match(
    bump.text,
    /membership_version =/,
  );
  assert.match(
    bump.text,
    /membership_version \+ 1/,
  );
  assert.match(
    bump.text,
    /status = 'ACTIVE'/,
  );
});

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
    this.queries.push({ text, params: [...params] });
    if (["BEGIN","COMMIT","ROLLBACK"].includes(text)) {
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
  const connection = new ScriptedConnection(responses);
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

test("language preference authority requires active tenant membership and actor device", async () => {
  const { repository, connection } =
    repositoryWith([{
      rows: [{ "?column?": 1 }],
      rowCount: 1,
    }]);

  assert.equal(
    await repository.withTransaction((tx) =>
      repository.lockActiveActor(tx, actor),
    ),
    true,
  );
  const query = connection.queries[1];
  assert.match(query.text, /tm\.status = 'ACTIVE'/);
  assert.match(query.text, /d\.status = 'ACTIVE'/);
  assert.match(query.text, /FOR SHARE OF tm, d/);
});

test("language preference row contains no durable style/register field", async () => {
  const { repository, connection } =
    repositoryWith([{
      rows: [{
        tenant_id: "tenant-1",
        user_id: "user-1",
        target_language_tag: "es",
        target_locale_override: "es-CO",
        preference_version: 3,
        updated_at: "2026-10-05 20:00:00+00",
      }],
      rowCount: 1,
    }]);

  const value = await repository.withTransaction(
    (tx) =>
      repository.loadForUpdate(tx, {
        tenantId: "tenant-1",
        userId: "user-1",
      }),
  );

  assert.deepEqual(value, {
    tenantId: "tenant-1",
    userId: "user-1",
    targetLanguageTag: "es",
    targetLocaleOverride: "es-CO",
    preferenceVersion: 3,
    updatedAt: "2026-10-05 20:00:00+00",
  });
  assert.doesNotMatch(
    connection.queries[1].text,
    /preferred_register/,
  );
});

test("language preference upsert bumps only active conversation target profiles", async () => {
  const { repository, connection } =
    repositoryWith([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 4 },
    ]);

  const result = await repository.withTransaction(
    async (tx) => {
      await repository.write(tx, {
        tenantId: "tenant-1",
        userId: "user-1",
        targetLanguageTag: "es",
        targetLocaleOverride: "es-CO",
        preferenceVersion: 4,
        updatedAt:
          "2026-10-05T20:00:00.000Z",
      });
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
  assert.doesNotMatch(
    upsert.text,
    /preferred_register/,
  );
  assert.deepEqual(upsert.params, [
    "tenant-1",
    "user-1",
    "es",
    "es-CO",
    4,
    "2026-10-05T20:00:00.000Z",
  ]);

  const bump = connection.queries[2];
  assert.match(
    bump.text,
    /membership_version \+/,
  );
  assert.match(
    bump.text,
    /status = 'ACTIVE'/,
  );
});

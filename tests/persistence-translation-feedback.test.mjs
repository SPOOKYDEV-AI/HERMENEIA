import test from "node:test";
import assert from "node:assert/strict";

import {
  SqlTransactionManager,
} from "../.build/packages/persistence/src/index.js";
import {
  PostgresTranslationFeedbackRepository,
} from "../.build/packages/persistence-postgres/src/translation-feedback.js";

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
      return {
        rows: [],
        rowCount: 0,
      };
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

function fixture(responses) {
  const connection =
    new ScriptedConnection(responses);
  const repository =
    new PostgresTranslationFeedbackRepository(
      new SqlTransactionManager(
        new SingleConnectionPool(connection),
      ),
    );

  return {
    connection,
    repository,
  };
}

const actor = {
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-1",
};

test("PostgreSQL feedback target is recipient-only, READY and current-revision only", async () => {
  const { repository, connection } =
    fixture([{
      rows: [{
        conversation_id:
          "conversation-1",
        source_message_id:
          "message-1",
        source_revision: 2,
      }],
      rowCount: 1,
    }]);

  const target =
    await repository.withTransaction(
      (tx) =>
        repository.loadEligibleTranslation(
          tx,
          {
            actor,
            translationId:
              "translation-1",
          },
        ),
    );

  assert.deepEqual(target, {
    conversationId: "conversation-1",
    messageId: "message-1",
    sourceRevision: 2,
  });

  const query = connection.queries[1];
  assert.match(
    query.text,
    /te\.recipient_user_id = \$3/,
  );
  assert.match(
    query.text,
    /te\.status = 'READY'/,
  );
  assert.match(
    query.text,
    /mm\.current_revision = te\.source_revision/,
  );
  assert.match(
    query.text,
    /cm\.status = 'ACTIVE'/,
  );
  assert.match(
    query.text,
    /tm\.status = 'ACTIVE'/,
  );
  assert.match(
    query.text,
    /d\.status = 'ACTIVE'/,
  );
});

test("PostgreSQL feedback repair persistence contains only structured metadata", async () => {
  const { repository, connection } =
    fixture([{
      rows: [],
      rowCount: 1,
    }]);

  await repository.withTransaction(
    (tx) =>
      repository.insertFeedbackRepairEvent(
        tx,
        {
          tenantId: "tenant-1",
          repairEventId: "repair-1",
          conversationId:
            "conversation-1",
          actorUserId: "user-1",
          targetTranslationId:
            "translation-1",
          targetMessageId:
            "message-1",
          targetSourceRevision: 2,
          kind: "MEANING_CORRECTION",
          status:
            "NEEDS_CONFIRMATION",
          structuredPayload: {
            schema_version: 1,
            feedback_kind:
              "WRONG_MEANING",
            note_present: true,
            note_length: 22,
          },
          commandId: "command-1",
          createdAt:
            "2026-10-05T12:00:00.000Z",
        },
      ),
  );

  const query = connection.queries[1];
  assert.match(
    query.text,
    /INSERT INTO translation_repair_events/,
  );
  assert.equal(
    JSON.stringify(query.params).includes(
      "private note text",
    ),
    false,
  );
  assert.deepEqual(
    JSON.parse(query.params[9]),
    {
      schema_version: 1,
      feedback_kind:
        "WRONG_MEANING",
      note_present: true,
      note_length: 22,
    },
  );
  assert.equal(
    connection.queries.at(-1).text,
    "COMMIT",
  );
});

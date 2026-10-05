import test from "node:test";
import assert from "node:assert/strict";

import {
  SqlTransactionManager,
} from "../.build/packages/persistence/src/index.js";
import {
  PostgresContextCorrectionRepository,
} from "../.build/packages/persistence-postgres/src/context-corrections.js";

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

function repositoryWith(responses) {
  const connection = new ScriptedConnection(
    responses,
  );
  return {
    connection,
    repository:
      new PostgresContextCorrectionRepository(
        new SqlTransactionManager(
          new SingleConnectionPool(connection),
        ),
      ),
  };
}

const actor = {
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-1",
};

test("PostgreSQL correction authority requires active conversation, membership and device and returns authority epochs", async () => {
  const { repository, connection } =
    repositoryWith([{
      rows: [{
        tenant_role: "ADMIN",
        conversation_role: "MODERATOR",
        membership_epoch: 4,
        erasure_epoch: 5,
        policy_version: 6,
        next_op_seq: 9,
      }],
      rowCount: 1,
    }]);

  const authority =
    await repository.withTransaction((tx) =>
      repository.loadAuthority(tx, {
        actor,
        conversationId: "conversation-1",
      }),
    );

  assert.deepEqual(authority, {
    tenantRole: "ADMIN",
    conversationRole: "MODERATOR",
    membershipEpoch: 4,
    erasureEpoch: 5,
    policyVersion: 6,
    nextOperationSequence: 9,
  });

  const query = connection.queries[1];
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
  assert.match(
    query.text,
    /c\.status = 'ACTIVE'/,
  );
  assert.match(
    query.text,
    /c\.next_op_seq/,
  );
  assert.deepEqual(query.params, [
    "tenant-1",
    "conversation-1",
    "user-1",
    "device-1",
  ]);
});

test("PostgreSQL translation correction target is restricted to the receiving actor", async () => {
  const { repository, connection } =
    repositoryWith([{
      rows: [{
        source_message_id: "message-1",
        source_revision: 3,
        author_user_id: "author-1",
      }],
      rowCount: 1,
    }]);

  const target =
    await repository.withTransaction((tx) =>
      repository.loadVisibleTranslationTarget(
        tx,
        {
          actor,
          conversationId:
            "conversation-1",
          translationId:
            "translation-1",
        },
      ),
    );

  assert.deepEqual(target, {
    messageId: "message-1",
    sourceRevision: 3,
    authorUserId: "author-1",
  });
  assert.match(
    connection.queries[1].text,
    /te\.recipient_user_id = \$4/,
  );
  assert.match(
    connection.queries[1].text,
    /mm\.author_user_id/,
  );
  assert.deepEqual(
    connection.queries[1].params,
    [
      "tenant-1",
      "conversation-1",
      "translation-1",
      "user-1",
    ],
  );
});

test("PostgreSQL correction writes bounded structured repair, claim and provenance records", async () => {
  const { repository, connection } =
    repositoryWith([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

  await repository.withTransaction(async (tx) => {
    await repository.insertRepairEvent(tx, {
      tenantId: "tenant-1",
      repairEventId: "repair-1",
      conversationId: "conversation-1",
      actorUserId: "user-1",
      targetTranslationId: "translation-1",
      targetMessageId: "message-1",
      targetSourceRevision: 1,
      kind: "TERMINOLOGY_CORRECTION",
      status: "APPLIED",
      structuredPayload: {
        schema_version: 1,
        kind: "TERM_MEANING",
        surface_form: "CR",
        meaning: "change request",
      },
      commandId: "command-1",
      createdAt:
        "2026-10-05T11:00:00.000Z",
    });

    await repository.insertConfirmedClaim(tx, {
      tenantId: "tenant-1",
      claimId: "claim-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      subjectUserId: "user-1",
      claimType: "TERMINOLOGY",
      propositionRef: {
        schema_version: 1,
        kind: "TERM_MEANING",
        surface_form: "CR",
        meaning: "change request",
      },
      scopeKind: "CONVERSATION",
      scopeConversationId:
        "conversation-1",
      createdAt:
        "2026-10-05T11:00:00.000Z",
    });

    await repository.insertRepairProvenance(
      tx,
      {
        tenantId: "tenant-1",
        provenanceEdgeId:
          "provenance-1",
        claimId: "claim-1",
        repairEventId: "repair-1",
        strategyVersion:
          "context-state-v1",
        createdAt:
          "2026-10-05T11:00:00.000Z",
      },
    );
  });

  const repair = connection.queries[1];
  const claim = connection.queries[2];
  const provenance = connection.queries[3];

  assert.match(
    repair.text,
    /INSERT INTO translation_repair_events/,
  );
  assert.match(
    claim.text,
    /subject_user_id/,
  );
  assert.equal(
    claim.params[4],
    "user-1",
  );
  assert.match(
    claim.text,
    /'CONFIRMED_CORRECTION'/,
  );
  assert.match(
    claim.text,
    /'CORRECTIVE_DURABLE'/,
  );
  assert.match(
    claim.text,
    /'EXPLICIT_UI_CORRECTION'/,
  );
  assert.match(
    provenance.text,
    /'CORRECTED_BY'/,
  );
  assert.equal(
    JSON.stringify([
      ...repair.params,
      ...claim.params,
      ...provenance.params,
    ]).includes("private transcript"),
    false,
  );
  assert.equal(
    connection.queries.at(-1).text,
    "COMMIT",
  );
});


test("PostgreSQL direct correction target resolves the source author", async () => {
  const { repository, connection } =
    repositoryWith([{
      rows: [{
        message_id: "message-1",
        revision: 2,
        author_user_id: "author-1",
      }],
      rowCount: 1,
    }]);

  const target =
    await repository.withTransaction((tx) =>
      repository.loadMessageRevisionTarget(
        tx,
        {
          tenantId: "tenant-1",
          conversationId:
            "conversation-1",
          messageId: "message-1",
          sourceRevision: 2,
        },
      ),
    );

  assert.deepEqual(target, {
    messageId: "message-1",
    sourceRevision: 2,
    authorUserId: "author-1",
  });
  assert.match(
    connection.queries[1].text,
    /JOIN message_metadata mm/,
  );
  assert.match(
    connection.queries[1].text,
    /mm\.author_user_id/,
  );
});

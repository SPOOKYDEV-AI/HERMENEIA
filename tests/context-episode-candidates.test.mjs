import test from "node:test";
import assert from "node:assert/strict";

import {
  materializeActiveEpisodeCandidates,
} from "../.build/packages/runtime/src/persistent-context-translation.js";

function store(records) {
  const map = new Map(
    records.map((record) => [
      [
        record.tenantId,
        record.messageId,
        record.sourceRevision,
      ].join(":"),
      structuredClone(record),
    ]),
  );

  return {
    async get(input) {
      return structuredClone(
        map.get(
          [
            input.tenantId,
            input.messageId,
            input.sourceRevision,
          ].join(":"),
        ),
      );
    },
  };
}

function record(messageId, revision, text, expiresAt) {
  return {
    tenantId: "tenant-1",
    messageId,
    sourceRevision: revision,
    sourceHash: "hash",
    source: {
      text,
      language_hint: "fr-FR",
    },
    createdAt: "2026-10-05T09:00:00.000Z",
    expiresAt,
  };
}

const state = {
  conversationId: "conversation-1",
  contextVersion: 7,
  processedPrefixOperationSequence: 8,
  processingGapOperationSequences: [],
  erasureEpoch: 2,
  policyVersion: 1,
  activeEpisodeId: "episode-1",
  activeEpisodeVersion: 3,
  activeEpisodeContinuityConfidence: 0.8,
  activeEpisodeSourceRevisionRefs: [
    "message-old:1",
    "message-recent:1",
  ],
  updatedAt: "2026-10-05T09:01:00.000Z",
};

test("active episode materializer adds only non-immediate transient episode sources", async () => {
  const candidates =
    await materializeActiveEpisodeCandidates(
      store([
        record(
          "message-old",
          1,
          "On parlait du cache Redis",
          "2026-10-05T09:10:00.000Z",
        ),
        record(
          "message-recent",
          1,
          "Le bug est toujours là",
          "2026-10-05T09:10:00.000Z",
        ),
      ]),
      "tenant-1",
      state,
      {
        recentMessages: [{
          messageId: "message-recent",
          sourceRevision: 1,
        }],
      },
    );

  assert.equal(candidates.length, 1);
  assert.equal(
    candidates[0].candidateType,
    "ACTIVE_EPISODE",
  );
  assert.equal(
    candidates[0].content,
    "On parlait du cache Redis",
  );
  assert.deepEqual(
    candidates[0].sourceRevisionRefs,
    ["message-old:1"],
  );
  assert.equal(
    candidates[0].causalThroughOperationSequence,
    8,
  );
  assert.equal(
    candidates[0].privacyScope,
    "TRANSIENT",
  );
  assert.equal(
    candidates[0].activeEpisode,
    true,
  );
});

test("missing transient episode payload is omitted instead of reconstructed", async () => {
  const candidates =
    await materializeActiveEpisodeCandidates(
      store([]),
      "tenant-1",
      state,
      { recentMessages: [] },
    );

  assert.deepEqual(candidates, []);
});

test("episode materializer is inert without active episode refs", async () => {
  const candidates =
    await materializeActiveEpisodeCandidates(
      store([]),
      "tenant-1",
      {
        ...state,
        activeEpisodeId: null,
        activeEpisodeVersion: null,
        activeEpisodeSourceRevisionRefs: [],
      },
      { recentMessages: [] },
    );

  assert.deepEqual(candidates, []);
});

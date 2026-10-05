import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveActiveEpisode,
  episodeSourceRef,
  parseEpisodeSourceRef,
} from "../.build/packages/context-episode-heuristic/src/index.js";

const FIRST_OP =
  "10000000-0000-4000-8000-000000000001";
const NEXT_OP =
  "10000000-0000-4000-8000-000000000002";

function source(overrides = {}) {
  return {
    messageId:
      "20000000-0000-4000-8000-000000000001",
    sourceRevision: 1,
    text: "On corrige le bug du cache demain",
    languageTag: "fr-FR",
    createdAt: "2026-10-05T09:00:00.000Z",
    ...overrides,
  };
}

test("first source starts a bounded episode without persisting raw text", () => {
  const result = deriveActiveEpisode({
    operationId: FIRST_OP,
    current: source(),
    priorSources: [],
  });

  assert.equal(result.decision, "START_NEW");
  assert.equal(
    result.activeEpisode.episodeId,
    FIRST_OP,
  );
  assert.equal(
    result.activeEpisode.episodeVersion,
    1,
  );
  assert.deepEqual(
    result.activeEpisode.sourceRevisionRefs,
    [episodeSourceRef(source())],
  );
  assert.equal(
    JSON.stringify(result.activeEpisode).includes(
      "corrige le bug",
    ),
    false,
  );
});

test("lexically coherent nearby source continues the active episode", () => {
  const first = deriveActiveEpisode({
    operationId: FIRST_OP,
    current: source(),
    priorSources: [],
  }).activeEpisode;

  const current = source({
    messageId:
      "20000000-0000-4000-8000-000000000002",
    text: "Le bug du cache est corrigé",
    createdAt: "2026-10-05T09:03:00.000Z",
  });

  const result = deriveActiveEpisode({
    operationId: NEXT_OP,
    current,
    activeEpisode: first,
    priorSources: [source()],
  });

  assert.equal(result.decision, "CONTINUE_ACTIVE");
  assert.equal(
    result.activeEpisode.episodeId,
    FIRST_OP,
  );
  assert.equal(
    result.activeEpisode.episodeVersion,
    2,
  );
  assert.ok(result.lexicalScore > 0);
  assert.deepEqual(
    result.activeEpisode.sourceRevisionRefs,
    [
      episodeSourceRef(source()),
      episodeSourceRef(current),
    ],
  );
});

test("crossing midnight alone does not reset a coherent episode", () => {
  const firstSource = source({
    createdAt: "2026-10-05T23:59:00.000Z",
  });
  const first = deriveActiveEpisode({
    operationId: FIRST_OP,
    current: firstSource,
    priorSources: [],
  }).activeEpisode;

  const current = source({
    messageId:
      "20000000-0000-4000-8000-000000000002",
    text: "On revalide le cache et le bug",
    createdAt: "2026-10-06T00:02:00.000Z",
  });

  const result = deriveActiveEpisode({
    operationId: NEXT_OP,
    current,
    activeEpisode: first,
    priorSources: [firstSource],
  });

  assert.equal(result.decision, "CONTINUE_ACTIVE");
});

test("old unrelated source starts a new episode", () => {
  const firstSource = source();
  const first = deriveActiveEpisode({
    operationId: FIRST_OP,
    current: firstSource,
    priorSources: [],
  }).activeEpisode;

  const current = source({
    messageId:
      "20000000-0000-4000-8000-000000000002",
    text: "Réservation hôtel Madrid vendredi",
    createdAt: "2026-10-07T09:00:00.000Z",
  });

  const result = deriveActiveEpisode({
    operationId: NEXT_OP,
    current,
    activeEpisode: first,
    priorSources: [firstSource],
  });

  assert.equal(result.decision, "START_NEW");
  assert.equal(
    result.activeEpisode.episodeId,
    NEXT_OP,
  );
});

test("ambiguous continuity stays uncertain instead of fabricating a boundary", () => {
  const firstSource = source();
  const first = deriveActiveEpisode({
    operationId: FIRST_OP,
    current: firstSource,
    priorSources: [],
  }).activeEpisode;

  const current = source({
    messageId:
      "20000000-0000-4000-8000-000000000002",
    text: "Ok pour demain",
    createdAt: "2026-10-05T09:10:00.000Z",
  });

  const result = deriveActiveEpisode({
    operationId: NEXT_OP,
    current,
    activeEpisode: first,
    priorSources: [firstSource],
  });

  assert.equal(result.decision, "UNCERTAIN");
  assert.equal(result.activeEpisode, undefined);
});

test("continued episode keeps only the newest eight source refs", () => {
  const refs = Array.from({ length: 8 }, (_, index) =>
    `20000000-0000-4000-8000-${String(
      index + 1,
    ).padStart(12, "0")}:${index + 1}`,
  );
  const activeEpisode = {
    episodeId: FIRST_OP,
    episodeVersion: 8,
    continuityConfidence: 0.8,
    continuityStrategy: "heuristic-v1",
    startedAt: "2026-10-05T08:00:00.000Z",
    lastActivityAt: "2026-10-05T08:59:00.000Z",
    sourceLanguageTag: "fr-fr",
    sourceRevisionRefs: refs,
  };

  const current = source({
    messageId:
      "20000000-0000-4000-8000-999999999999",
    text: "cache bug corrigé demain",
    createdAt: "2026-10-05T09:00:00.000Z",
  });

  const result = deriveActiveEpisode({
    operationId: NEXT_OP,
    current,
    activeEpisode,
    priorSources: [
      source({
        text: "cache bug corrigé",
        createdAt: "2026-10-05T08:59:00.000Z",
      }),
    ],
  });

  assert.equal(result.decision, "CONTINUE_ACTIVE");
  assert.equal(
    result.activeEpisode.sourceRevisionRefs.length,
    8,
  );
  assert.equal(
    result.activeEpisode.sourceRevisionRefs.at(-1),
    episodeSourceRef(current),
  );
});

test("episode source refs parse conservatively", () => {
  const ref =
    "20000000-0000-4000-8000-000000000001:3";
  assert.deepEqual(parseEpisodeSourceRef(ref), {
    messageId:
      "20000000-0000-4000-8000-000000000001",
    sourceRevision: 3,
  });
  assert.equal(
    parseEpisodeSourceRef("bad"),
    undefined,
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveSemanticEpisodeContinuity,
} from "../.build/packages/context-episode-heuristic/src/index.js";

const prior = {
  text: "On corrige le bug du cache demain",
  languageTag: "fr-FR",
  createdAt: "2026-10-05T09:00:00.000Z",
};

test("semantic episode continues coherent nearby context", () => {
  const result = deriveSemanticEpisodeContinuity({
    previousLastActivityAt:
      "2026-10-05T09:00:00.000Z",
    priorSources: [prior],
    current: {
      text: "Le bug du cache est corrigé",
      languageTag: "fr-FR",
      createdAt:
        "2026-10-05T09:03:00.000Z",
    },
  });

  assert.equal(
    result.decision,
    "CONTINUE_ACTIVE",
  );
  assert.ok(result.lexicalScore > 0);
  assert.ok(result.confidence > 0);
});

test("semantic episode can preserve a coherent topic across the temporal V1 gap", () => {
  const result = deriveSemanticEpisodeContinuity({
    previousLastActivityAt:
      "2026-10-05T23:59:00.000Z",
    priorSources: [{
      ...prior,
      createdAt:
        "2026-10-05T23:59:00.000Z",
    }],
    current: {
      text: "On revalide le cache et le bug",
      languageTag: "fr-FR",
      createdAt:
        "2026-10-06T00:25:00.000Z",
    },
  });

  assert.equal(
    result.decision,
    "CONTINUE_ACTIVE",
  );
});

test("old unrelated context starts a new semantic episode", () => {
  const result = deriveSemanticEpisodeContinuity({
    previousLastActivityAt:
      "2026-10-05T09:00:00.000Z",
    priorSources: [prior],
    current: {
      text: "Réservation hôtel Madrid vendredi",
      languageTag: "fr-FR",
      createdAt:
        "2026-10-07T09:00:00.000Z",
    },
  });

  assert.equal(result.decision, "START_NEW");
});

test("ambiguous semantic evidence stays uncertain", () => {
  const result = deriveSemanticEpisodeContinuity({
    previousLastActivityAt:
      "2026-10-05T09:00:00.000Z",
    priorSources: [prior],
    current: {
      text: "Ok je regarde",
      languageTag: "fr-FR",
      createdAt:
        "2026-10-05T09:10:00.000Z",
    },
  });

  assert.equal(result.decision, "UNCERTAIN");
});

test("semantic result never returns source plaintext", () => {
  const secret =
    "private payload lexical-marker-7421";
  const result = deriveSemanticEpisodeContinuity({
    previousLastActivityAt:
      "2026-10-05T09:00:00.000Z",
    priorSources: [{
      text: secret,
      languageTag: "fr-FR",
      createdAt:
        "2026-10-05T09:00:00.000Z",
    }],
    current: {
      text: secret,
      languageTag: "fr-FR",
      createdAt:
        "2026-10-05T09:01:00.000Z",
    },
  });

  assert.equal(
    JSON.stringify(result).includes(secret),
    false,
  );
});

test("semantic prior-source input is bounded", () => {
  assert.throws(
    () =>
      deriveSemanticEpisodeContinuity({
        previousLastActivityAt:
          "2026-10-05T09:00:00.000Z",
        priorSources: Array.from(
          { length: 9 },
          () => prior,
        ),
        current: prior,
      }),
    /bounded size 8/,
  );
});

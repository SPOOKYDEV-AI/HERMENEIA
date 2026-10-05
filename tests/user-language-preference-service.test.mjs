import test from "node:test";
import assert from "node:assert/strict";

import {
  UserLanguagePreferenceService,
} from "../.build/packages/user-language-preference-service/src/index.js";

const ACTOR = {
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-1",
};
const NOW = "2026-10-05T20:00:00.000Z";

function fixture({
  authorized = true,
  existing,
  bumped = 2,
} = {}) {
  const calls = {
    writes: [],
    bumps: [],
    auth: 0,
  };

  const store = {
    async lockActiveActor() {
      calls.auth += 1;
      return authorized;
    },
    async loadForUpdate() {
      return existing
        ? structuredClone(existing)
        : undefined;
    },
    async write(_tx, input) {
      calls.writes.push(structuredClone(input));
    },
    async bumpActiveMembershipProfiles(_tx, input) {
      calls.bumps.push(structuredClone(input));
      return bumped;
    },
  };

  const service =
    new UserLanguagePreferenceService({
      transactions: {
        async withTransaction(work) {
          return work({});
        },
      },
      store,
      clock: {
        now() {
          return NOW;
        },
      },
    });

  return { service, calls };
}

test("explicit language defaults are normalized and bump active target profiles once", async () => {
  const { service, calls } = fixture({
    bumped: 3,
  });

  const result = await service.update(
    ACTOR,
    {
      target_language: " es ",
      target_locale: " es-CO ",
    },
  );

  assert.deepEqual(result, {
    changed: true,
    preference_version: 1,
    target_profile_updates: 3,
  });
  assert.deepEqual(calls.writes[0], {
    tenantId: "tenant-1",
    userId: "user-1",
    targetLanguageTag: "es",
    targetLocaleOverride: "es-CO",
    preferenceVersion: 1,
    updatedAt: NOW,
  });
  assert.deepEqual(calls.bumps, [{
    tenantId: "tenant-1",
    userId: "user-1",
  }]);
});

test("identical language preference PUT is semantically idempotent", async () => {
  const { service, calls } = fixture({
    existing: {
      tenantId: "tenant-1",
      userId: "user-1",
      targetLanguageTag: "es",
      targetLocaleOverride: "es-CO",
      preferenceVersion: 7,
      updatedAt: NOW,
    },
  });

  const result = await service.update(
    ACTOR,
    {
      target_language: "ES",
      target_locale: "es-co",
    },
  );

  assert.deepEqual(result, {
    changed: false,
    preference_version: 7,
    target_profile_updates: 0,
  });
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(calls.bumps, []);
});

test("locale-only change advances preference and target-profile fence", async () => {
  const { service, calls } = fixture({
    existing: {
      tenantId: "tenant-1",
      userId: "user-1",
      targetLanguageTag: "es",
      targetLocaleOverride: null,
      preferenceVersion: 2,
      updatedAt: NOW,
    },
    bumped: 4,
  });

  const result = await service.update(
    ACTOR,
    {
      target_language: "es",
      target_locale: "es-CO",
    },
  );

  assert.equal(result.changed, true);
  assert.equal(result.preference_version, 3);
  assert.equal(result.target_profile_updates, 4);
  assert.equal(
    calls.writes[0].targetLocaleOverride,
    "es-CO",
  );
});

test("malformed language tags fail before persistence", async () => {
  const { service, calls } = fixture();

  await assert.rejects(
    () =>
      service.update(ACTOR, {
        target_language: "es CO",
      }),
    (error) =>
      error?.code === "INVALID_COMMAND",
  );

  assert.equal(calls.auth, 0);
  assert.deepEqual(calls.writes, []);
});

test("inactive tenant membership or device fails closed", async () => {
  const { service, calls } = fixture({
    authorized: false,
  });

  await assert.rejects(
    () =>
      service.update(ACTOR, {
        target_language: "es",
      }),
    (error) =>
      error?.code === "NOT_AUTHORIZED",
  );

  assert.deepEqual(calls.writes, []);
  assert.deepEqual(calls.bumps, []);
});

import test from "node:test";
import assert from "node:assert/strict";

import { createHmacSourceDigester } from "../apps/api/source-fingerprint.mjs";

test("HMAC source fingerprint is stable, versioned and does not expose plaintext", () => {
  const digester = createHmacSourceDigester({
    key: "0123456789abcdef0123456789abcdef",
    keyVersion: "k1",
  });

  const source = {
    text: "ok",
    language_hint: "fr-FR",
  };

  const first = digester.digest(source);
  const second = digester.digest(source);

  assert.equal(first, second);
  assert.match(first, /^hmac-sha256:k1:[0-9a-f]{64}$/);
  assert.equal(first.includes(source.text), false);
});

test("HMAC source fingerprint changes with source content or key version", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const v1 = createHmacSourceDigester({ key, keyVersion: "k1" });
  const v2 = createHmacSourceDigester({ key, keyVersion: "k2" });

  assert.notEqual(
    v1.digest({ text: "yes", language_hint: "en-US" }),
    v1.digest({ text: "no", language_hint: "en-US" }),
  );
  assert.notEqual(
    v1.digest({ text: "yes", language_hint: "en-US" }),
    v2.digest({ text: "yes", language_hint: "en-US" }),
  );
});

test("HMAC source fingerprint rejects weak keys and invalid key versions", () => {
  assert.throws(
    () =>
      createHmacSourceDigester({
        key: "too-short",
        keyVersion: "k1",
      }),
    /at least 32 bytes/,
  );

  assert.throws(
    () =>
      createHmacSourceDigester({
        key: "0123456789abcdef0123456789abcdef",
        keyVersion: "bad version",
      }),
    /Invalid HMAC/,
  );
});

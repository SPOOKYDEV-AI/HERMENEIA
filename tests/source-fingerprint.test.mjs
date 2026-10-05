import test from "node:test";
import assert from "node:assert/strict";

import {
  createHmacSourceDigester,
  createHmacSourceFingerprinter,
} from "../apps/api/source-fingerprint.mjs";

test("HMAC source fingerprint is stable, versioned and does not expose plaintext", () => {
  const fingerprinter = createHmacSourceFingerprinter({
    key: "0123456789abcdef0123456789abcdef",
    keyVersion: "k1",
  });

  const source = {
    text: "ok",
    language_hint: "fr-FR",
  };

  const first = fingerprinter.fingerprint(source);
  const second = fingerprinter.fingerprint(source);

  assert.equal(first, second);
  assert.match(first, /^hmac-sha256:k1:[0-9a-f]{64}$/);
  assert.equal(first.includes(source.text), false);
  assert.equal(fingerprinter.matches(source, first), true);
  assert.equal(
    fingerprinter.matches({ ...source, text: "different" }, first),
    false,
  );
});

test("HMAC verification keyring recognizes retained fingerprints across rotation", () => {
  const oldKey = "old-key-0123456789abcdef0123456789abcdef";
  const newKey = "new-key-0123456789abcdef0123456789abcdef";
  const source = { text: "rotation-safe", language_hint: "fr-FR" };

  const oldFingerprinter = createHmacSourceFingerprinter({
    key: oldKey,
    keyVersion: "k1",
  });
  const oldFingerprint = oldFingerprinter.fingerprint(source);

  const rotated = createHmacSourceFingerprinter({
    key: newKey,
    keyVersion: "k2",
    verificationKeys: [
      { key: oldKey, keyVersion: "k1" },
    ],
  });

  assert.match(
    rotated.fingerprint(source),
    /^hmac-sha256:k2:[0-9a-f]{64}$/,
  );
  assert.equal(rotated.matches(source, oldFingerprint), true);

  const withoutOldKey = createHmacSourceFingerprinter({
    key: newKey,
    keyVersion: "k2",
  });
  assert.equal(withoutOldKey.matches(source, oldFingerprint), false);
});

test("HMAC compatibility digester alias remains available", () => {
  const digester = createHmacSourceDigester({
    key: "0123456789abcdef0123456789abcdef",
    keyVersion: "k1",
  });
  assert.equal(
    digester.digest({ text: "a" }),
    digester.fingerprint({ text: "a" }),
  );
});

test("HMAC source fingerprinter rejects weak keys invalid versions and duplicate key versions", () => {
  assert.throws(
    () =>
      createHmacSourceFingerprinter({
        key: "too-short",
        keyVersion: "k1",
      }),
    /at least 32 bytes/,
  );

  assert.throws(
    () =>
      createHmacSourceFingerprinter({
        key: "0123456789abcdef0123456789abcdef",
        keyVersion: "bad version",
      }),
    /Invalid HMAC/,
  );

  assert.throws(
    () =>
      createHmacSourceFingerprinter({
        key: "0123456789abcdef0123456789abcdef",
        keyVersion: "k1",
        verificationKeys: [
          {
            key: "abcdef0123456789abcdef0123456789",
            keyVersion: "k1",
          },
        ],
      }),
    /Duplicate HMAC/,
  );
});

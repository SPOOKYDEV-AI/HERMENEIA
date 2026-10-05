import { createHmac, timingSafeEqual } from "node:crypto";

function canonicalSource(source) {
  return JSON.stringify({
    text: source.text,
    language_hint: source.language_hint ?? null,
  });
}

function validateKey(key, label) {
  if (
    (typeof key !== "string" && !Buffer.isBuffer(key)) ||
    Buffer.byteLength(key) < 32
  ) {
    throw new TypeError(
      `${label} HMAC source fingerprint key must be at least 32 bytes`,
    );
  }
}

function validateKeyVersion(keyVersion) {
  if (
    typeof keyVersion !== "string" ||
    !/^[A-Za-z0-9._-]{1,32}$/.test(keyVersion)
  ) {
    throw new TypeError("Invalid HMAC source fingerprint keyVersion");
  }
}

function digestWith(key, source) {
  return createHmac("sha256", key)
    .update(canonicalSource(source), "utf8")
    .digest("hex");
}

export function createHmacSourceFingerprinter({
  key,
  keyVersion,
  verificationKeys = [],
}) {
  validateKey(key, "Primary");
  validateKeyVersion(keyVersion);

  const keys = new Map([[keyVersion, key]]);
  for (const candidate of verificationKeys) {
    validateKey(candidate.key, "Verification");
    validateKeyVersion(candidate.keyVersion);
    if (keys.has(candidate.keyVersion)) {
      throw new TypeError(
        `Duplicate HMAC source fingerprint keyVersion: ${candidate.keyVersion}`,
      );
    }
    keys.set(candidate.keyVersion, candidate.key);
  }

  function fingerprint(source) {
    return `hmac-sha256:${keyVersion}:${digestWith(key, source)}`;
  }

  function matches(source, storedFingerprint) {
    if (typeof storedFingerprint !== "string") {
      return false;
    }

    const match = /^hmac-sha256:([A-Za-z0-9._-]{1,32}):([0-9a-f]{64})$/.exec(
      storedFingerprint,
    );
    if (!match) {
      return false;
    }

    const verificationKey = keys.get(match[1]);
    if (!verificationKey) {
      return false;
    }

    const expected = Buffer.from(digestWith(verificationKey, source), "hex");
    const actual = Buffer.from(match[2], "hex");
    return (
      expected.length === actual.length &&
      timingSafeEqual(expected, actual)
    );
  }

  return {
    fingerprint,
    matches,
    // Compatibility alias for callers created during the persistence spike.
    digest: fingerprint,
  };
}

export const createHmacSourceDigester = createHmacSourceFingerprinter;

import { createHmac } from "node:crypto";

function canonicalSource(source) {
  return JSON.stringify({
    text: source.text,
    language_hint: source.language_hint ?? null,
  });
}

export function createHmacSourceDigester({
  key,
  keyVersion,
}) {
  if (
    (typeof key !== "string" && !Buffer.isBuffer(key)) ||
    key.length < 32
  ) {
    throw new TypeError("HMAC source fingerprint key must be at least 32 bytes");
  }
  if (
    typeof keyVersion !== "string" ||
    !/^[A-Za-z0-9._-]{1,32}$/.test(keyVersion)
  ) {
    throw new TypeError("Invalid HMAC source fingerprint keyVersion");
  }

  return {
    digest(source) {
      const digest = createHmac("sha256", key)
        .update(canonicalSource(source), "utf8")
        .digest("hex");
      return `hmac-sha256:${keyVersion}:${digest}`;
    },
  };
}

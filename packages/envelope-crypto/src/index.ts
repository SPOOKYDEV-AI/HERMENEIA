import {
  Aes128Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";

export type EnvelopeRenditionType = "ORIGINAL" | "TRANSLATION";

export interface EnvelopeBinding {
  envelopeId: string;
  tenantId: string;
  conversationId: string;
  messageId: string;
  sourceRevision: number;
  recipientUserId: string;
  recipientDeviceId: string;
  recipientCredentialVersion: number;
  renditionType: EnvelopeRenditionType;
  translationId?: string | null;
  targetLanguageTag?: string | null;
}

export interface OriginalEnvelopePlaintext {
  v: 1;
  kind: "ORIGINAL";
  text: string;
  language_hint?: string;
}

export interface TranslationEnvelopePlaintext {
  v: 1;
  kind: "TRANSLATION";
  text: string;
  target_language_tag: string;
}

export type EnvelopePlaintext =
  | OriginalEnvelopePlaintext
  | TranslationEnvelopePlaintext;

const PUBLIC_MATERIAL_PREFIX = "hpke-p256-v1:";
const MAGIC = new Uint8Array([0x48, 0x45, 0x4e, 0x56]); // HENV
const WIRE_VERSION = 1;
const KEM_ID = 0x0010;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0001;
const P256_ENC_SIZE = 65;
const TAG_SIZE = 16;
const INFO = new TextEncoder().encode(
  "HERMENEIA|HPKE|P256|HKDF-SHA256|AES-128-GCM|V1",
);
const ZERO_UUID = new Uint8Array(16);

function createSuite() {
  return new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes128Gcm(),
  });
}

function assertSafePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function uuidBytes(value: string, label: string): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }

  const hex = value.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function uint16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function uint64(value: number): Uint8Array {
  assertSafePositiveInteger(value, "recipientCredentialVersion");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

function renditionByte(value: EnvelopeRenditionType): number {
  if (value === "ORIGINAL") return 1;
  if (value === "TRANSLATION") return 2;
  throw new TypeError("Unsupported rendition type");
}

function base64Encode(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const word = (a << 16) | (b << 8) | c;

    out += alphabet[(word >>> 18) & 63];
    out += alphabet[(word >>> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(word >>> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[word & 63] : "=";
  }
  return out;
}

function base64Decode(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new TypeError("Invalid base64 payload");
  }

  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Map([...alphabet].map((char, index) => [char, index]));
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const outputLength = (value.length / 4) * 3 - padding;
  const out = new Uint8Array(outputLength);
  let offset = 0;

  for (let i = 0; i < value.length; i += 4) {
    const a = lookup.get(value[i]);
    const b = lookup.get(value[i + 1]);
    const c = value[i + 2] === "=" ? 0 : lookup.get(value[i + 2]);
    const d = value[i + 3] === "=" ? 0 : lookup.get(value[i + 3]);

    if (
      a === undefined ||
      b === undefined ||
      c === undefined ||
      d === undefined
    ) {
      throw new TypeError("Invalid base64 payload");
    }

    const word = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < out.length) out[offset++] = (word >>> 16) & 0xff;
    if (offset < out.length) out[offset++] = (word >>> 8) & 0xff;
    if (offset < out.length) out[offset++] = word & 0xff;
  }

  if (base64Encode(out) !== value) {
    throw new TypeError("Base64 payload must be canonical");
  }
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new TypeError("Invalid base64url value");
  }
  const standard = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = base64Decode(standard);
  if (base64UrlEncode(decoded) !== value) {
    throw new TypeError("Base64url value must be canonical");
  }
  return decoded;
}

export function buildEnvelopeAad(binding: EnvelopeBinding): Uint8Array {
  assertSafePositiveInteger(binding.sourceRevision, "sourceRevision");
  assertSafePositiveInteger(
    binding.recipientCredentialVersion,
    "recipientCredentialVersion",
  );

  const rendition = renditionByte(binding.renditionType);
  const translationId =
    binding.renditionType === "TRANSLATION"
      ? uuidBytes(
          binding.translationId ?? "",
          "translationId",
        )
      : ZERO_UUID;

  const targetLanguageBytes =
    binding.renditionType === "TRANSLATION"
      ? new TextEncoder().encode(binding.targetLanguageTag ?? "")
      : new Uint8Array();

  if (
    binding.renditionType === "TRANSLATION" &&
    targetLanguageBytes.byteLength === 0
  ) {
    throw new TypeError(
      "targetLanguageTag is required for TRANSLATION envelopes",
    );
  }
  if (targetLanguageBytes.byteLength > 255) {
    throw new TypeError("targetLanguageTag is too long");
  }

  return concat([
    new Uint8Array([0x48, 0x41, 0x41, 0x44, 0x01, rendition]),
    uuidBytes(binding.envelopeId, "envelopeId"),
    uuidBytes(binding.tenantId, "tenantId"),
    uuidBytes(binding.conversationId, "conversationId"),
    uuidBytes(binding.messageId, "messageId"),
    uint32(binding.sourceRevision),
    uuidBytes(binding.recipientUserId, "recipientUserId"),
    uuidBytes(binding.recipientDeviceId, "recipientDeviceId"),
    uint64(binding.recipientCredentialVersion),
    translationId,
    new Uint8Array([targetLanguageBytes.byteLength]),
    targetLanguageBytes,
  ]);
}

export async function encodeHpkeP256PublicMaterial(
  publicKey: CryptoKey,
): Promise<string> {
  const suite = createSuite();
  const raw = new Uint8Array(
    await suite.kem.serializePublicKey(publicKey),
  );
  if (
    raw.byteLength !== P256_ENC_SIZE ||
    raw[0] !== 0x04
  ) {
    throw new Error(
      "Unexpected RFC 9180 P-256 public-key serialization",
    );
  }
  return `${PUBLIC_MATERIAL_PREFIX}${base64UrlEncode(raw)}`;
}

export function validateHpkeP256PublicMaterialSyntax(
  value: string,
): void {
  if (
    typeof value !== "string" ||
    !value.startsWith(PUBLIC_MATERIAL_PREFIX)
  ) {
    throw new TypeError(
      `public_material_ref must start with ${PUBLIC_MATERIAL_PREFIX}`,
    );
  }

  const raw = base64UrlDecode(
    value.slice(PUBLIC_MATERIAL_PREFIX.length),
  );
  if (
    raw.byteLength !== P256_ENC_SIZE ||
    raw[0] !== 0x04
  ) {
    throw new TypeError(
      "public_material_ref must contain one RFC 9180 uncompressed P-256 key",
    );
  }
}

export async function decodeHpkeP256PublicMaterial(
  value: string,
): Promise<CryptoKey> {
  validateHpkeP256PublicMaterialSyntax(value);
  const raw = base64UrlDecode(
    value.slice(PUBLIC_MATERIAL_PREFIX.length),
  );
  return createSuite().kem.deserializePublicKey(raw);
}

export async function validateHpkeP256PublicMaterial(
  value: string,
): Promise<void> {
  await decodeHpkeP256PublicMaterial(value);
}

export async function generateHpkeP256DeviceKeyPair(): Promise<{
  keyPair: CryptoKeyPair;
  publicMaterialRef: string;
}> {
  const suite = createSuite();
  const keyPair = await suite.kem.generateKeyPair();
  return {
    keyPair,
    publicMaterialRef: await encodeHpkeP256PublicMaterial(
      keyPair.publicKey,
    ),
  };
}

function encodeProtectedPayload(
  enc: Uint8Array,
  ciphertext: Uint8Array,
): string {
  if (enc.byteLength !== P256_ENC_SIZE) {
    throw new Error("Unexpected HPKE encapsulated-key length");
  }
  if (ciphertext.byteLength < TAG_SIZE) {
    throw new Error("HPKE ciphertext is too short");
  }

  return base64Encode(
    concat([
      MAGIC,
      new Uint8Array([WIRE_VERSION]),
      uint16(KEM_ID),
      uint16(KDF_ID),
      uint16(AEAD_ID),
      uint16(enc.byteLength),
      enc,
      ciphertext,
    ]),
  );
}

function decodeProtectedPayload(value: string): {
  enc: Uint8Array;
  ciphertext: Uint8Array;
} {
  const bytes = base64Decode(value);
  const headerLength = 13;
  if (bytes.byteLength < headerLength + P256_ENC_SIZE + TAG_SIZE) {
    throw new TypeError("Protected envelope payload is too short");
  }

  if (
    !MAGIC.every((byte, index) => bytes[index] === byte) ||
    bytes[4] !== WIRE_VERSION
  ) {
    throw new TypeError("Unsupported protected envelope version");
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  if (
    view.getUint16(5, false) !== KEM_ID ||
    view.getUint16(7, false) !== KDF_ID ||
    view.getUint16(9, false) !== AEAD_ID
  ) {
    throw new TypeError("Unsupported HPKE cipher suite");
  }

  const encLength = view.getUint16(11, false);
  if (encLength !== P256_ENC_SIZE) {
    throw new TypeError("Invalid HPKE encapsulated-key length");
  }

  const encStart = headerLength;
  const ciphertextStart = encStart + encLength;
  return {
    enc: bytes.slice(encStart, ciphertextStart),
    ciphertext: bytes.slice(ciphertextStart),
  };
}

function encodePlaintext(value: EnvelopePlaintext): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decodePlaintext(bytes: Uint8Array): EnvelopePlaintext {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TypeError("Envelope plaintext is not valid JSON");
  }

  if (!value || typeof value !== "object") {
    throw new TypeError("Envelope plaintext has invalid shape");
  }
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    typeof record.text !== "string" ||
    record.text.length === 0
  ) {
    throw new TypeError("Envelope plaintext has invalid fields");
  }

  if (record.kind === "ORIGINAL") {
    if (
      record.language_hint !== undefined &&
      typeof record.language_hint !== "string"
    ) {
      throw new TypeError("Original language_hint is invalid");
    }
    return {
      v: 1,
      kind: "ORIGINAL",
      text: record.text,
      ...(typeof record.language_hint === "string"
        ? { language_hint: record.language_hint }
        : {}),
    };
  }

  if (
    record.kind === "TRANSLATION" &&
    typeof record.target_language_tag === "string" &&
    record.target_language_tag.length > 0
  ) {
    return {
      v: 1,
      kind: "TRANSLATION",
      text: record.text,
      target_language_tag: record.target_language_tag,
    };
  }

  throw new TypeError("Envelope plaintext kind is invalid");
}

export function createHpkeP256EnvelopeCodec() {
  const suite = createSuite();

  return {
    async seal(input: {
      binding: EnvelopeBinding;
      recipientPublicMaterialRef: string;
      plaintext: EnvelopePlaintext;
    }): Promise<string> {
      if (
        (input.binding.renditionType === "ORIGINAL" &&
          input.plaintext.kind !== "ORIGINAL") ||
        (input.binding.renditionType === "TRANSLATION" &&
          input.plaintext.kind !== "TRANSLATION")
      ) {
        throw new TypeError(
          "Envelope rendition and plaintext kind do not match",
        );
      }

      const recipientPublicKey =
        await decodeHpkeP256PublicMaterial(
          input.recipientPublicMaterialRef,
        );
      const aad = buildEnvelopeAad(input.binding);
      const result = await suite.seal(
        {
          recipientPublicKey,
          info: INFO,
        },
        encodePlaintext(input.plaintext),
        aad,
      );

      return encodeProtectedPayload(
        new Uint8Array(result.enc),
        new Uint8Array(result.ct),
      );
    },

    async open(input: {
      binding: EnvelopeBinding;
      recipientPrivateKey: CryptoKey | CryptoKeyPair;
      protectedPayload: string;
    }): Promise<EnvelopePlaintext> {
      const parsed = decodeProtectedPayload(
        input.protectedPayload,
      );
      const aad = buildEnvelopeAad(input.binding);
      const plaintext = await suite.open(
        {
          recipientKey: input.recipientPrivateKey,
          enc: parsed.enc,
          info: INFO,
        },
        parsed.ciphertext,
        aad,
      );

      const decoded = decodePlaintext(
        new Uint8Array(plaintext),
      );
      if (
        (input.binding.renditionType === "ORIGINAL" &&
          decoded.kind !== "ORIGINAL") ||
        (input.binding.renditionType === "TRANSLATION" &&
          decoded.kind !== "TRANSLATION")
      ) {
        throw new TypeError(
          "Decrypted envelope rendition does not match binding",
        );
      }
      return decoded;
    },
  };
}

export function createHpkeP256OriginalEnvelopeProtector() {
  const codec = createHpkeP256EnvelopeCodec();
  return {
    async protect(input: {
      envelopeId: string;
      tenantId: string;
      conversationId: string;
      messageId: string;
      sourceRevision: number;
      recipientUserId: string;
      recipientDeviceId: string;
      recipientCredentialVersion: number;
      recipientPublicMaterialRef: string;
      source: {
        text: string;
        language_hint?: string;
      };
    }): Promise<string> {
      return codec.seal({
        binding: {
          envelopeId: input.envelopeId,
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          sourceRevision: input.sourceRevision,
          recipientUserId: input.recipientUserId,
          recipientDeviceId: input.recipientDeviceId,
          recipientCredentialVersion:
            input.recipientCredentialVersion,
          renditionType: "ORIGINAL",
        },
        recipientPublicMaterialRef:
          input.recipientPublicMaterialRef,
        plaintext: {
          v: 1,
          kind: "ORIGINAL",
          text: input.source.text,
          ...(input.source.language_hint
            ? { language_hint: input.source.language_hint }
            : {}),
        },
      });
    },
  };
}

export function createHpkeP256TranslationEnvelopeProtector() {
  const codec = createHpkeP256EnvelopeCodec();
  return {
    async protect(input: {
      envelopeId: string;
      tenantId: string;
      conversationId: string;
      messageId: string;
      sourceRevision: number;
      translationId: string;
      recipientUserId: string;
      recipientDeviceId: string;
      recipientCredentialVersion: number;
      recipientPublicMaterialRef: string;
      translatedText: string;
      targetLanguageTag: string;
    }): Promise<string> {
      return codec.seal({
        binding: {
          envelopeId: input.envelopeId,
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          sourceRevision: input.sourceRevision,
          recipientUserId: input.recipientUserId,
          recipientDeviceId: input.recipientDeviceId,
          recipientCredentialVersion:
            input.recipientCredentialVersion,
          renditionType: "TRANSLATION",
          translationId: input.translationId,
          targetLanguageTag: input.targetLanguageTag,
        },
        recipientPublicMaterialRef:
          input.recipientPublicMaterialRef,
        plaintext: {
          v: 1,
          kind: "TRANSLATION",
          text: input.translatedText,
          target_language_tag: input.targetLanguageTag,
        },
      });
    },
  };
}

export const HPKE_P256_V1 = Object.freeze({
  publicMaterialPrefix: PUBLIC_MATERIAL_PREFIX,
  wireVersion: WIRE_VERSION,
  kemId: KEM_ID,
  kdfId: KDF_ID,
  aeadId: AEAD_ID,
  encapsulatedKeySize: P256_ENC_SIZE,
});

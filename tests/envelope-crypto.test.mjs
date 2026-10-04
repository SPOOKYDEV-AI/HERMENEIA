import test from "node:test";
import assert from "node:assert/strict";

import {
  HPKE_P256_V1,
  buildEnvelopeAad,
  createHpkeP256EnvelopeCodec,
  createHpkeP256OriginalEnvelopeProtector,
  createHpkeP256TranslationEnvelopeProtector,
  generateHpkeP256DeviceKeyPair,
  validateHpkeP256PublicMaterial,
  validateHpkeP256PublicMaterialSyntax,
} from "../.build/packages/envelope-crypto/src/index.js";

const IDS = {
  envelopeId: "10000000-0000-4000-8000-000000000001",
  tenantId: "20000000-0000-4000-8000-000000000002",
  conversationId: "30000000-0000-4000-8000-000000000003",
  messageId: "40000000-0000-4000-8000-000000000004",
  recipientUserId: "50000000-0000-4000-8000-000000000005",
  recipientDeviceId: "60000000-0000-4000-8000-000000000006",
  translationId: "70000000-0000-4000-8000-000000000007",
};

function originalBinding(overrides = {}) {
  return {
    envelopeId: IDS.envelopeId,
    tenantId: IDS.tenantId,
    conversationId: IDS.conversationId,
    messageId: IDS.messageId,
    sourceRevision: 3,
    recipientUserId: IDS.recipientUserId,
    recipientDeviceId: IDS.recipientDeviceId,
    recipientCredentialVersion: 4,
    renditionType: "ORIGINAL",
    ...overrides,
  };
}

function translationBinding(overrides = {}) {
  return {
    ...originalBinding(),
    renditionType: "TRANSLATION",
    translationId: IDS.translationId,
    targetLanguageTag: "es-CO",
    ...overrides,
  };
}

test("HPKE P-256 public material round-trips original envelope", async () => {
  const { keyPair, publicMaterialRef } =
    await generateHpkeP256DeviceKeyPair();
  assert.match(
    publicMaterialRef,
    /^hpke-p256-v1:[A-Za-z0-9_-]+$/,
  );

  const codec = createHpkeP256EnvelopeCodec();
  const protectedPayload = await codec.seal({
    binding: originalBinding(),
    recipientPublicMaterialRef: publicMaterialRef,
    plaintext: {
      v: 1,
      kind: "ORIGINAL",
      text: "Bonjour 👋",
      language_hint: "fr-FR",
    },
  });

  const opened = await codec.open({
    binding: originalBinding(),
    recipientPrivateKey: keyPair.privateKey,
    protectedPayload,
  });

  assert.deepEqual(opened, {
    v: 1,
    kind: "ORIGINAL",
    text: "Bonjour 👋",
    language_hint: "fr-FR",
  });
});

test("HPKE translation envelope round-trips with translation binding", async () => {
  const { keyPair, publicMaterialRef } =
    await generateHpkeP256DeviceKeyPair();
  const codec = createHpkeP256EnvelopeCodec();

  const protectedPayload = await codec.seal({
    binding: translationBinding(),
    recipientPublicMaterialRef: publicMaterialRef,
    plaintext: {
      v: 1,
      kind: "TRANSLATION",
      text: "Hola 👋",
      target_language_tag: "es-CO",
    },
  });

  assert.deepEqual(
    await codec.open({
      binding: translationBinding(),
      recipientPrivateKey: keyPair.privateKey,
      protectedPayload,
    }),
    {
      v: 1,
      kind: "TRANSLATION",
      text: "Hola 👋",
      target_language_tag: "es-CO",
    },
  );
});

test("wrong private key cannot decrypt envelope", async () => {
  const recipient = await generateHpkeP256DeviceKeyPair();
  const attacker = await generateHpkeP256DeviceKeyPair();
  const codec = createHpkeP256EnvelopeCodec();

  const payload = await codec.seal({
    binding: originalBinding(),
    recipientPublicMaterialRef: recipient.publicMaterialRef,
    plaintext: { v: 1, kind: "ORIGINAL", text: "secret" },
  });

  await assert.rejects(() =>
    codec.open({
      binding: originalBinding(),
      recipientPrivateKey: attacker.keyPair.privateKey,
      protectedPayload: payload,
    }),
  );
});

test("AAD mutation rejects envelope replay across identity boundaries", async () => {
  const recipient = await generateHpkeP256DeviceKeyPair();
  const codec = createHpkeP256EnvelopeCodec();
  const payload = await codec.seal({
    binding: originalBinding(),
    recipientPublicMaterialRef: recipient.publicMaterialRef,
    plaintext: { v: 1, kind: "ORIGINAL", text: "bound" },
  });

  const mutations = [
    { envelopeId: "10000000-0000-4000-8000-000000000009" },
    { messageId: "40000000-0000-4000-8000-000000000009" },
    { sourceRevision: 4 },
    { recipientDeviceId: "60000000-0000-4000-8000-000000000009" },
    { recipientCredentialVersion: 5 },
  ];

  for (const mutation of mutations) {
    await assert.rejects(() =>
      codec.open({
        binding: originalBinding(mutation),
        recipientPrivateKey: recipient.keyPair.privateKey,
        protectedPayload: payload,
      }),
    );
  }
});

test("translation id and target locale are authenticated", async () => {
  const recipient = await generateHpkeP256DeviceKeyPair();
  const codec = createHpkeP256EnvelopeCodec();
  const payload = await codec.seal({
    binding: translationBinding(),
    recipientPublicMaterialRef: recipient.publicMaterialRef,
    plaintext: {
      v: 1,
      kind: "TRANSLATION",
      text: "Hola",
      target_language_tag: "es-CO",
    },
  });

  await assert.rejects(() =>
    codec.open({
      binding: translationBinding({
        translationId: "70000000-0000-4000-8000-000000000009",
      }),
      recipientPrivateKey: recipient.keyPair.privateKey,
      protectedPayload: payload,
    }),
  );
  await assert.rejects(() =>
    codec.open({
      binding: translationBinding({ targetLanguageTag: "es-ES" }),
      recipientPrivateKey: recipient.keyPair.privateKey,
      protectedPayload: payload,
    }),
  );
});

test("tampered protected payload fails authentication", async () => {
  const recipient = await generateHpkeP256DeviceKeyPair();
  const codec = createHpkeP256EnvelopeCodec();
  const payload = await codec.seal({
    binding: originalBinding(),
    recipientPublicMaterialRef: recipient.publicMaterialRef,
    plaintext: { v: 1, kind: "ORIGINAL", text: "integrity" },
  });

  const bytes = Buffer.from(payload, "base64");
  bytes[bytes.length - 1] ^= 0x01;

  await assert.rejects(() =>
    codec.open({
      binding: originalBinding(),
      recipientPrivateKey: recipient.keyPair.privateKey,
      protectedPayload: bytes.toString("base64"),
    }),
  );
});

test("serialized protected payload does not contain plaintext bytes", async () => {
  const recipient = await generateHpkeP256DeviceKeyPair();
  const codec = createHpkeP256EnvelopeCodec();
  const secret = "DO-NOT-LEAK-THIS-PLAINTEXT";

  const payload = await codec.seal({
    binding: originalBinding(),
    recipientPublicMaterialRef: recipient.publicMaterialRef,
    plaintext: { v: 1, kind: "ORIGINAL", text: secret },
  });

  const raw = Buffer.from(payload, "base64");
  assert.equal(raw.includes(Buffer.from(secret, "utf8")), false);
  assert.equal(raw.subarray(0, 4).toString("ascii"), "HENV");
});

test("malformed public material and binding are rejected before encryption", async () => {
  const codec = createHpkeP256EnvelopeCodec();

  await assert.rejects(() =>
    codec.seal({
      binding: originalBinding(),
      recipientPublicMaterialRef: "hpke-p256-v1:not-a-key",
      plaintext: { v: 1, kind: "ORIGINAL", text: "x" },
    }),
  );

  assert.throws(
    () =>
      buildEnvelopeAad(
        originalBinding({ envelopeId: "not-a-uuid" }),
      ),
    /canonical UUID/,
  );
});

test("syntax-valid off-curve P-256 public material is rejected cryptographically", async () => {
  const raw = Buffer.alloc(65);
  raw[0] = 0x04;
  const publicMaterialRef =
    `hpke-p256-v1:${raw.toString("base64url")}`;

  assert.doesNotThrow(() =>
    validateHpkeP256PublicMaterialSyntax(publicMaterialRef),
  );

  await assert.rejects(() =>
    validateHpkeP256PublicMaterial(publicMaterialRef),
  );
});

test("original and translation protector adapters produce decryptable envelopes", async () => {
  const recipient = await generateHpkeP256DeviceKeyPair();
  const originalProtector =
    createHpkeP256OriginalEnvelopeProtector();
  const translationProtector =
    createHpkeP256TranslationEnvelopeProtector();
  const codec = createHpkeP256EnvelopeCodec();

  const original = await originalProtector.protect({
    envelopeId: IDS.envelopeId,
    tenantId: IDS.tenantId,
    conversationId: IDS.conversationId,
    messageId: IDS.messageId,
    sourceRevision: 3,
    recipientUserId: IDS.recipientUserId,
    recipientDeviceId: IDS.recipientDeviceId,
    recipientCredentialVersion: 4,
    recipientPublicMaterialRef: recipient.publicMaterialRef,
    source: { text: "source", language_hint: "fr-FR" },
  });

  assert.equal(
    (
      await codec.open({
        binding: originalBinding(),
        recipientPrivateKey: recipient.keyPair.privateKey,
        protectedPayload: original,
      })
    ).kind,
    "ORIGINAL",
  );

  const translated = await translationProtector.protect({
    envelopeId: IDS.envelopeId,
    tenantId: IDS.tenantId,
    conversationId: IDS.conversationId,
    messageId: IDS.messageId,
    sourceRevision: 3,
    translationId: IDS.translationId,
    recipientUserId: IDS.recipientUserId,
    recipientDeviceId: IDS.recipientDeviceId,
    recipientCredentialVersion: 4,
    recipientPublicMaterialRef: recipient.publicMaterialRef,
    translatedText: "traducción",
    targetLanguageTag: "es-CO",
  });

  assert.equal(
    (
      await codec.open({
        binding: translationBinding(),
        recipientPrivateKey: recipient.keyPair.privateKey,
        protectedPayload: translated,
      })
    ).kind,
    "TRANSLATION",
  );
});

test("suite constants match RFC 9180 P-256/HKDF-SHA256/AES-128-GCM", () => {
  assert.deepEqual(HPKE_P256_V1, {
    publicMaterialPrefix: "hpke-p256-v1:",
    wireVersion: 1,
    kemId: 0x0010,
    kdfId: 0x0001,
    aeadId: 0x0001,
    encapsulatedKeySize: 65,
  });
});

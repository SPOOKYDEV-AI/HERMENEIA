# ADR-0016 — HPKE P-256 delivery envelopes

**Status:** Accepted as V1 interoperability/security candidate; external cryptographic review still required  
**Date:** 2026-10-04

## Context

HERMENEIA needs a per-device protected delivery envelope for ORIGINAL and TRANSLATION renditions.

The server sees plaintext transiently for translation and therefore V1 is **not end-to-end encrypted**. The envelope layer protects durable relay payloads and binds each ciphertext to one recipient device/credential and one logical message revision.

The project previously kept `public_material_ref` opaque and deliberately refused to invent a custom ECDH/HKDF/AEAD protocol.

## Decision

Use RFC 9180 HPKE Base mode with:

- KEM: `DHKEM(P-256, HKDF-SHA256)` — ID `0x0010`;
- KDF: `HKDF-SHA256` — ID `0x0001`;
- AEAD: `AES-128-GCM` — ID `0x0001`;
- implementation candidate: `@hpke/core@1.9.0`;
- exact transitive override: `@hpke/common@1.10.1`.

The package version is pinned because versions of `@hpke/core` through 1.7.4 were affected by GHSA-73g8-5h73-26h4 (concurrent SenderContext nonce reuse). The project must not downgrade below the fixed line.

## Why P-256 instead of X25519 for V1

X25519 is technically attractive and is now available in modern WebCrypto, but browser/WebView support arrived relatively recently.

P-256 gives HERMENEIA a wider deployment baseline and a stronger hardware-backed mobile path:

- mature WebCrypto support;
- Android Keystore/StrongBox supports ECDH P-256;
- Apple Secure Enclave exposes P-256 key agreement;
- RFC 9180 defines the exact uncompressed 65-byte public-key encoding.

The network cost versus X25519 is 33 additional public/encapsulation bytes per HPKE envelope. For V1 that trade-off is preferred over excluding older mobile runtimes or forcing a pure-JS secret-key fallback.

## Device public material

V1 format:

    hpke-p256-v1:<base64url>

The body is exactly the RFC 9180 `SerializePublicKey()` output for P-256:

- 65 bytes;
- uncompressed EC point;
- first byte `0x04`.

Enrollment and rotation validate this format before persistence.

Private delivery keys are never stored in HERMENEIA Core.

Platform clients should prefer non-exportable/hardware-backed private keys where their platform permits it.

## Envelope wire format

The durable protected payload is standard base64 over:

    magic             4 bytes  "HENV"
    wire_version      1 byte   0x01
    kem_id            2 bytes  0x0010
    kdf_id            2 bytes  0x0001
    aead_id           2 bytes  0x0001
    enc_length        2 bytes  0x0041
    enc              65 bytes  RFC 9180 encapsulated key
    ciphertext        N bytes  HPKE ciphertext + AEAD tag

Unknown version/suite values are rejected.

## HPKE info

The V1 HPKE application info is:

    HERMENEIA|HPKE|P256|HKDF-SHA256|AES-128-GCM|V1

This supplies protocol-level domain separation in addition to the RFC HPKE suite labels.

## Authenticated application binding

AAD is deterministic binary, not JSON.

It binds:

- envelope ID;
- tenant ID;
- conversation ID;
- logical message ID;
- source revision;
- recipient user ID;
- recipient device ID;
- recipient credential version;
- rendition type;
- translation ID for TRANSLATION;
- target language tag for TRANSLATION.

Changing any bound value makes decryption fail.

UUIDs are encoded as 16 bytes, source revision as unsigned 32-bit big endian and credential version as unsigned 64-bit big endian.

The implementation MUST reject source revisions outside `1..0xffffffff` before binary encoding. Silent integer truncation/wrap is forbidden.

For ORIGINAL envelopes, translation-only binding fields (`translation_id`, `target_language_tag`) are invalid rather than ignored. This prevents callers from believing data is authenticated when it is not part of the ORIGINAL AAD.

## Plaintext payload

ORIGINAL payload:

    {
      "v": 1,
      "kind": "ORIGINAL",
      "text": "...",
      "language_hint": "optional"
    }

TRANSLATION payload:

    {
      "v": 1,
      "kind": "TRANSLATION",
      "text": "...",
      "target_language_tag": "..."
    }

The JSON is inside HPKE ciphertext; it is not AAD and is not durable plaintext.

## Rotation

New envelopes use only the current device credential/public material.

The existing V1 device lifecycle remains authoritative:

- rotation increments `credential_version`;
- old PENDING envelopes are revoked;
- their protected payload bytes are purged;
- they are not silently re-encrypted.

## Non-goals / security claims

This ADR does **not** claim:

- E2EE;
- sender authentication from HPKE Base mode;
- a formally audited JavaScript implementation;
- cross-device private-key backup/recovery;
- proof-of-possession during device enrollment.

Those require separate work.

## Dependency reproducibility gate

Before any production crypto claim:

- `@hpke/core` must remain exactly pinned to `1.9.0`;
- `@hpke/common` must remain exactly pinned to `1.10.1`;
- a committed npm `package-lock.json` with lockfileVersion >= 3 is required;
- both resolved HPKE packages must carry npm-registry URLs and `sha512-` integrity entries;
- `npm run verify:crypto-deps` must pass in the release environment.

Direct version pins without a lockfile are not considered a reproducible cryptographic dependency set.

## Required verification before production crypto claim

- install and execute the pinned + locked package versions;
- run malformed wire-header/truncation/public-key corpus;
- run concurrent seal regression tests to detect context/nonce reuse regressions;
- RFC 9180/interoperability vectors;
- browser tests on supported Chrome/Firefox/Safari/WebView baselines;
- native iOS and Android interop;
- wrong-key/tamper/AAD-binding tests;
- mobile latency and allocation benchmarks;
- security review of key generation/storage, enrollment proof and recovery;
- dependency/advisory scan.

Passing the local malformed/concurrency suite is necessary but does not replace external cryptographic review.

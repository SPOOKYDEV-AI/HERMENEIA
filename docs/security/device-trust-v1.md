# Device Trust and Delivery Envelope Security — V1

**Status:** Executable device lifecycle and built-in RFC 9180 HPKE P-256 envelope implementation; independent cryptographic/platform review still required
**Scope:** device identity, authenticated enrollment, delivery-material rotation, revocation, delivery-envelope trust boundary

## 1. Security statement

HERMENEIA V1 is not claimed to be end-to-end encrypted.

The trusted Core may process plaintext transiently for translation/context. Durable relay storage must nevertheless avoid plaintext message bodies.

The executable device lifecycle does not invent cryptographic primitives. The built-in delivery envelope uses RFC 9180 HPKE with DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-128-GCM. HERMENEIA adds versioned envelope framing and authenticated application binding; that integration still requires independent review before a production cryptography claim.

## 2. Device identity

Each registered device has a stable `device_id`, one owning `user_id`, lifecycle status `ACTIVE | REVOKED | LOST`, server-owned monotone `credential_version`, HPKE P-256 public material encoded as `hpke-p256-v1:<base64url uncompressed point>`, platform metadata, `revocation_epoch`, and lifecycle timestamps. Enrollment and rotation cryptographically deserialize the submitted public point before any persistence transaction begins; syntax-valid off-curve points are rejected.

Private key/credential material remains client-side or in platform-secure storage according to the future reviewed cryptographic implementation.

## 3. Additional-device enrollment

Endpoint: `POST /v1/devices`.

Enrollment requires an already authenticated ACTIVE device for the same user and an ACTIVE tenant membership.

The enrolling client supplies `command_id`, a high-entropy client-generated `device_id` (UUID at the API contract), opaque `public_material_ref`, and optional platform.

The server owns the initial values: `status=ACTIVE`, `credential_version=1`, `revocation_epoch=0`. The client cannot choose `credential_version`.

The client-generated device identifier is **not** authority. It provides stable pre-session identity and allows retry with a new `command_id` without accidentally creating duplicate devices. The same `device_id` cannot be rebound to another material/platform state.

Enrollment also creates the base device sync state.

### Initial device bootstrap

This endpoint deliberately does **not** solve first-device account bootstrap.

The first authenticated device, login/account recovery, MFA/OIDC/password/social identity and issuance of a session for a newly enrolled device belong to the Identity boundary. Messaging Core must not invent those identity flows merely to make device enrollment appear complete.

## 4. Device inventory

Endpoint: `GET /v1/devices`.

The current authenticated user may list lifecycle metadata for their own devices. Responses do not expose `public_material_ref`. Cross-user device inventory is not available.

## 5. Delivery-material rotation

Endpoint: `PATCH /v1/devices/{device_id}/delivery-material`.

V1 rotation is **self-only**: `actor.device_id == target device_id`. This prevents one already authenticated device from silently replacing the delivery material of another device.

Rotation requires `expected_credential_version`. The server atomically advances `credential_version = previous + 1`. A stale expected version produces a revision conflict.

A lost-response retry with a new `command_id` can recover the already-applied next version when the requested material is identical.

### Pending envelopes during rotation

V1 chooses an explicit fail-secure policy: new envelopes use only the new credential version; PENDING envelopes at the old version are marked `REVOKED`; their protected payload bytes are purged; they are **not** silently re-encrypted.

This may make an unacknowledged old envelope unrecoverable for that device. That behaviour is intentional until a separately reviewed migration/re-key mechanism exists.

## 6. Device revocation

Endpoint: `POST /v1/devices/{device_id}/revoke`.

An authenticated ACTIVE device may revoke another device owned by the same user, or revoke itself.

Revocation atomically marks the target `REVOKED`, increments `revocation_epoch`, sets `revoked_at`, revokes all ACTIVE sessions for the target, revokes its PENDING delivery envelopes, and purges those pending protected payload bytes.

New delivery already filters to ACTIVE devices, so a revoked device immediately stops receiving new envelopes.

Revocation is user-global because `device_id` is user-global in the canonical model. Pending envelopes are purged across every tenant for that device.

A self-revocation may make the just-used Bearer session unusable immediately after commit. A lost HTTP response can therefore surface as a subsequent authentication failure; this is consistent with the committed revoked state.

## 7. Idempotency

Device lifecycle mutations use the existing durable command-receipt mechanism.

Command fingerprints never duplicate `public_material_ref` directly. Runtime uses an opaque SHA-256 fingerprint of the **public** material reference for idempotency only. This SHA-256 helper is not a password hash and is not used to protect secret material.

The exact successful device result is persisted in the command receipt.

## 8. Delivery envelopes

Every durable envelope is bound to tenant, conversation, logical message/source revision, target user/device, target `credential_version`, and rendition type. An envelope is never transferable to another device merely because both devices belong to the same user.

## 9. Multi-device semantics

Delivery acknowledgement is per envelope and per device. An ACK from one device never deletes another device's envelope. Read state may be aggregated at user level, but it remains distinct from device delivery state.

## 10. Device loss

Loss of client-side secrets may make existing protected envelopes unrecoverable. The product must not promise recovery beyond the selected future client security model.

A LOST-specific reporting workflow is not yet exposed by the V1 API. Security-sensitive removal currently uses revocation.

## 11. Threat boundary

Device enrollment/rotation/revocation protects **which device/version may receive future protected delivery**. It does not provide E2EE by itself, prove possession of a cryptographic private key, protect transient Core plaintext, or define key backup/transfer.

## 12. Cryptography still requiring dedicated review

The current implementation fixes the internal baseline to RFC 9180 HPKE using DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-128-GCM, with credential-versioned public material and authenticated application binding.

Before production envelope protection is claimed, independent review must still validate the HERMENEIA framing/AAD integration, browser/native interoperability, private-key generation and secure storage, proof-of-possession/enrollment UX, replay assumptions, recovery/backup/transfer policy, metadata exposure and rotation/re-key behaviour for existing envelopes.

Passing internal tests is evidence of implementation consistency, not a substitute for external cryptographic review.

## 13. PostgreSQL/runtime implementation

Migration `db/migrations/0010_device_trust_lifecycle.sql` adds validated platform values for new device state, a bounded public-material-reference constraint for new/updated rows, and a user/registration inventory index.

The persistent runtime exposes one `PersistentDeviceService` backed by `PostgresMessagingRepository`. Readiness requires the device-trust schema before `/readyz` reports ready.

## 14. Current executable evidence

The device-service sandbox gate covers enrollment with server-owned version 1, same/new command retry, device-id rebind conflict, self-only monotone rotation, old-envelope purge, lost-response rotation recovery, stale rotation conflict, session revocation, pending-envelope purge, inventory without public material, and revoked actor rejection.

The disposable PostgreSQL 16 qualification workflow now executes the full migration chain through 0011, SQL smoke tests, Node regression suite and persistent-process runtime smoke. The remaining security gate is independent cryptographic/platform validation, not database execution.

# Device Trust and Delivery Envelope Security — V1

**Status:** Pre-implementation security contract  
**Scope:** device identity, delivery-envelope confidentiality, rotation and revocation

## 1. Security statement

HERMENEIA V1 is not claimed to be end-to-end encrypted.

The Core may process plaintext transiently for translation/context. Durable delivery storage should nevertheless avoid plaintext message bodies.

## 2. Device identity

Each registered device has a stable identifier, an active credential/key version, lifecycle status, registration time and revocation state.

Sensitive private material remains client-side or in platform-secure storage according to the selected implementation.

## 3. Enrollment

A device becomes eligible for delivery only after an authenticated enrollment flow binds it to the user and publishes the public material/identifier required by the selected reviewed envelope-protection mechanism.

The exact cryptographic construction is intentionally not specified here and requires a separate security review.

## 4. Delivery envelopes

Every durable envelope is bound to:

- tenant;
- conversation;
- logical message and source revision;
- target device;
- target credential/key version;
- rendition type (original or translation).

The relay must not treat an envelope as transferable to another device merely because both devices belong to the same user.

## 5. Rotation and revocation

New envelopes target only active device versions.

Revocation stops new delivery to the device and invalidates pending publication where policy requires it.

Existing undelivered envelopes are expired/deleted or migrated only according to an explicitly reviewed mechanism; the system must not assume old protected payloads can always be recovered.

## 6. Multi-device semantics

Delivery acknowledgement is per envelope and per device.

A delivery ACK from one device does not delete another device's envelope.

Read state may be aggregated at user level, but it is distinct from device delivery.

## 7. Device loss

Loss of device-local secrets/credentials may make existing protected envelopes unrecoverable for that device.

The product must not promise recovery beyond the actual selected client security model.

## 8. Threat boundary

Envelope protection reduces exposure of durable relay storage.

It does not protect plaintext while the trusted Core is actively processing a source.

## 9. Before implementation

A dedicated security review must choose and validate:

- reviewed libraries/standards;
- device enrollment and proof/binding;
- secure client storage;
- rotation and revocation;
- replay protection;
- metadata exposure;
- optional transfer/backup policy.

No custom cryptographic protocol is authorised by this document.

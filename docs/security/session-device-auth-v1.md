# Session & Device Authentication — V1

**Status:** Executable security slice

## 1. Goal

The HTTP API no longer needs to trust caller-supplied user/device identity fields.

A successful authentication resolves exactly one:

    tenant_id
    user_id
    device_id

which becomes the server-side ActorContext used by Messaging Core authorisation checks.

## 2. Bearer credential model

V1 supports opaque Bearer credentials through an injected authenticator.

The server stores/indexes only an **access credential reference**, not the raw Bearer value.

The Node runtime helper currently derives that reference using SHA-256.

This is appropriate only for high-entropy opaque credentials issued by a trusted identity/session issuer.

Low-entropy passwords, PINs or human-memorable secrets must never be treated as Bearer session tokens under this design.

## 3. Session lifecycle

A session is bound to:

- tenant;
- user;
- device;
- issue time;
- expiry time;
- lifecycle state.

States:

    ACTIVE
    REVOKED
    EXPIRED

Expired credentials are invalidated when observed.

Explicit session revocation removes access immediately.

Device-level session revocation can invalidate every active session for that device.

## 4. Defence in depth

Authentication does not replace Core authorisation.

Flow:

    Bearer credential
        ↓
    Session registry
        ↓
    ActorContext
        ↓
    Core verifies active device
        ↓
    Core verifies tenant/conversation/message authority

Therefore a valid session cannot make another user's device ID authoritative.

## 5. Identity spoofing

Headers such as:

    x-user-id
    x-device-id
    x-tenant-id

are not accepted by the production Bearer authenticator.

Tests may inject fake authenticators at the server dependency boundary, but those fake identity mechanisms are not production defaults.

## 6. Logging

Never log:

- Authorization header;
- raw Bearer credential;
- refresh credential;
- credential material supplied by clients.

Technical logs may include bounded identifiers such as:

    session_id
    device_id
    user_id
    tenant_id
    auth outcome/error class

subject to the wider privacy/logging policy.

## 7. TLS

Bearer credentials require HTTPS/TLS in any non-local deployment.

No production deployment may send these credentials over plaintext HTTP.

## 8. What is deliberately not implemented yet

This slice does not implement:

- user registration;
- password authentication;
- social/OIDC login;
- MFA;
- session refresh endpoint;
- credential issuance UI;
- account recovery.

Those belong to the Identity boundary and must not be invented inside Messaging Core.

The executable session registry accepts already-authorised session records so messaging/auth invariants can be proven independently.

## 9. PostgreSQL

Migration:

    db/migrations/0002_session_access_credential.sql

adds a nullable migration-safe:

    access_credential_ref

with a unique partial index.

New persistent session issuance will require this field.

A future persistence/auth PR may enforce stricter NOT NULL rules after defining migration/rotation behaviour for existing sessions.

## 10. Sandbox evidence

At implementation time:

    npm run typecheck
    npm run build
    npm test

passed with:

    30 tests
    0 failures

including:

- Bearer authentication;
- expiry;
- session revocation;
- device-session revocation;
- spoofed identity headers ignored;
- HTTP messaging authenticated from session ActorContext.

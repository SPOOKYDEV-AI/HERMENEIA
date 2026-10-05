# Persistent Messaging Execution — V1

**Status:** Implemented execution slice; live PostgreSQL/runtime CI gate qualified  
**Scope:** durable Send, command recovery, edit/delete revisions, tenant-scoped sync/ACK, transient source handling and translation dispatch reference

## 1. Goal

The Send path must remain correct when:

- the client retries after an uncertain response;
- the process crashes;
- translation is unavailable;
- transient plaintext capacity is exhausted;
- a recipient has several devices;
- a database transaction rolls back or fails during COMMIT;
- source-fingerprint keys rotate.

The original message is accepted independently from translation.

HERMENEIA Core does not durably store the raw source body by default.

## 2. Canonical runtime path

There is one canonical persistent messaging implementation for Send and source mutations:

```text
HTTP POST /v1/conversations/:conversation_id/messages
        |
        v
sendService.sendMessage(...)
        |
        v
PersistentMessagingService
        |
        +--> PostgresMessagingRepository
        |      +--> command_receipts
        |      +--> message_metadata
        |      +--> message_revisions
        |      +--> delivery_envelopes
        |      +--> device_inbox_events
        |      +--> outbox_jobs
        |
        +--> TransientSourceStore
```

`packages/runtime/src/persistent-messaging.ts` builds the application service from the repository and runtime dependencies.

`apps/api/server.mjs` accepts explicit `sendService`, `commandService`, `mutationService` and `deliveryService` dependencies. The in-memory Core remains only a compatibility/test profile; `apps/api/persistent-server.mjs` composes a pure persistent HTTP profile with no Core fallback.

The previous duplicate persistent Send implementation was removed. New Send behaviour must be added to `packages/messaging-service`, not to a parallel service.

## 3. Durable transaction

A new Send performs, in one PostgreSQL transaction:

1. claim `command_id` as `IN_PROGRESS`;
2. acquire the actor-scoped `client_message_id` advisory lock;
3. check for an already accepted logical message;
4. authorise conversation/device membership while allocating message/op sequence;
5. validate reply target;
6. resolve deliverable recipient devices;
7. best-effort admit source plaintext to bounded transient memory;
8. persist MessageMetadata;
9. persist immutable source revision metadata and opaque source fingerprint;
10. persist one protected ORIGINAL envelope per target device;
11. allocate one tenant-local device inbox offset and event per envelope;
12. persist a plaintext-free translation outbox job;
13. persist the exact `ACCEPTED` result in the command receipt;
14. COMMIT;
15. return the committed result.

No translation-provider call is part of this transaction.

## 4. Command idempotency

`command_id` is claimed atomically with:

```text
INSERT ... status=IN_PROGRESS
ON CONFLICT (tenant_id, command_id) DO NOTHING
```

A conflicting receipt is then read `FOR UPDATE`.

The durable command fingerprint is a structured V1 value containing:

- command type;
- conversation id;
- client message id;
- source fingerprint;
- reply target;
- client-authored timestamp.

A retry must match the original semantic operation.

The originating actor user/device is also fenced.

A successful retry returns the exact previously persisted `ACCEPTED` result.

## 5. client_message_id idempotency

The logical key is scoped by:

```text
tenant_id + author_user_id + client_message_id
```

Concurrent requests are serialized with a transaction-scoped PostgreSQL advisory lock.

The same `client_message_id` is accepted only when all relevant Send semantics still match:

- conversation;
- original source revision;
- reply target;
- client-authored instant.

The original revision fingerprint is always revision 1 even if the message is later edited.

A new `command_id` for the same logical Send returns the exact original acceptance result rather than manufacturing a new status.

## 6. Source fingerprint

Production source fingerprints use versioned HMAC-SHA-256:

```text
hmac-sha256:<key_version>:<digest>
```

An unkeyed SHA of short human text is not an acceptable production source fingerprint because common messages are dictionaryable.

The fingerprinter exposes:

- `fingerprint(source)` for new durable records;
- `matches(source, storedFingerprint)` for retry/re-supply verification.

### Key rotation

The active key signs new fingerprints.

Explicit verification keys may remain available so retries created before rotation still match after rotation.

Old verification keys must not be silently removed while durable command receipts/source fingerprints that depend on them are still expected to be retryable or verifiable.

Key retirement therefore requires an explicit lifecycle decision:

- dependent idempotency/re-supply records have expired or been erased; or
- the deployment accepts that those old source fingerprints can no longer be verified.

Fingerprint key rotation is independent from per-device envelope-key rotation.

## 7. Transient plaintext

The transient source store is:

- in memory;
- TTL-bound;
- bounded by entry count and approximate bytes;
- non-evicting for already admitted work;
- non-overwriting for an existing source key.

Each record is bound to:

- tenant id;
- message id;
- source revision;
- source fingerprint.

If transient admission fails, original delivery still commits and translation status is:

```text
SOURCE_REQUIRED
```

The service does not evict an older in-flight source to admit a newer message.

If the database transaction or final COMMIT fails after transient admission, the newly admitted source is removed.

## 8. Durable plaintext prohibition

The following durable control surfaces must not contain the raw source body:

- MessageMetadata;
- MessageRevision metadata;
- command receipts;
- outbox payload refs;
- routine logs/traces.

The outbox references message/revision/fingerprint/buffer identity and policy epochs.

The original source body is present only in:

- authorised client/customer history;
- transient processing memory;
- protected per-device delivery envelope payload.

## 9. Recipient/device semantics

Send is not reported as `ACCEPTED` when an external active recipient has no deliverable active device.

A deliverable device must have usable public delivery material.

The sender's other active devices also receive ORIGINAL envelopes so multi-device state remains coherent.

ACK lifecycle is per device/envelope.

## 10. Persistent mutation and delivery semantics

Edit and delete use the same durable command/idempotency boundary as Send.

Edit:

- locks the authored message row;
- verifies `expected_revision`;
- allocates only a new conversation `op_seq`;
- creates an immutable `EDITED` source revision;
- revokes and payload-purges pending envelopes for older revisions;
- marks pending/leased translation request/execute jobs `SUPERSEDED`;
- marks older translation executions `SUPERSEDED`;
- marks already-started provider attempts `CANCELLED_LOGICALLY`;
- creates fresh protected envelopes and `message.edited` events only for active devices that were already historically targeted by an ORIGINAL envelope for this message and whose user remains an active member;
- admits the new source to transient memory best-effort and removes the previous transient revision after commit.

Delete:

- creates an immutable content-free `DELETED` tombstone revision;
- marks MessageMetadata deleted;
- revokes/purges old pending envelopes;
- supersedes old translation request/execute jobs and translation executions;
- marks already-started provider attempts `CANCELLED_LOGICALLY`;
- emits content-free `message.deleted` control events to active devices with retained ORIGINAL-envelope exposure metadata, without requiring current conversation membership or delivery-key material;
- is not blocked merely because a recipient currently has no active encryption-capable device.

Sync state is fully scoped by **tenant + device**. Each tenant/device pair owns its own inbox epoch, next offset and ACK payload-purge watermark.

This prevents both state corruption and cross-tenant activity leakage through cursor gaps or offset growth. The same physical device may legitimately use the same numeric offset in two tenants.

ACK watermark advancement is restricted to the contiguous terminal envelope prefix, so an out-of-order ACK cannot skip an earlier PENDING envelope. The ACK watermark is not a generic replay floor: content-free control events such as `message.deleted` remain replayable, while ACKED/REVOKED content-envelope events can be skipped safely because their payloads are already terminal.

## 11. Translation independence

Translation work is represented by a durable outbox job.

If the transient source is present:

```text
translation_status = PENDING
```

If it is not available:

```text
translation_status = SOURCE_REQUIRED
```

Provider availability never gates original Send acceptance.

If an edit/delete supersedes a source revision while a provider call is already in flight, the provider attempt becomes `CANCELLED_LOGICALLY`. Provider completion is fenced on `status = 'STARTED'`; a late response therefore becomes `STALE_ATTEMPT`, and the worker returns `SUPERSEDED` immediately without publishing, retrying or reviving the old revision.

## 12. Current verification gates

The canonical `Persistent Core Qualification` workflow now executes the critical persistence/runtime gates against disposable PostgreSQL 16.

Verified at branch commit `900c34a7`:

- full rollback chain 0011→0001 and forward migration chain 0001→0011: **PASS**;
- PostgreSQL schema/SQL smoke contract: **PASS**;
- committed npm lockfile + `npm ci` reproducibility gate: **PASS**;
- strict TypeScript build/typecheck: **PASS**;
- Node regression suite: **255/255 PASS**;
- persistent HTTP runtime against real PostgreSQL: **PASS**;
- `/healthz`, `/readyz` and a real pool query: **PASS**;
- real child-process startup followed by SIGTERM and clean exit code 0: **PASS**;
- HPKE P-256 invalid/off-curve public material rejected before device persistence: **PASS**;
- PostgreSQL translation publication E2E: **PASS**.

The PostgreSQL translation E2E exercises the real repository/runtime boundaries:

```text
Send
  → translation.request
  → fanout
  → translation.execute
  → deterministic provider adapter
  → HPKE TRANSLATION envelope
  → recipient sync
  → recipient HPKE decrypt
  → ACK
  → protected payload purge
```

That E2E exposed and caused fixes for three production-only persistence defects that mocked SQL tests had not caught:

1. nullable `jsonb_build_object` parameters lacked explicit PostgreSQL types and failed with `42P18`;
2. translation publish used illegal `SELECT DISTINCT ... FOR SHARE` SQL and failed with `0A000`;
3. PostgreSQL `encode(bytea,'base64')` inserted line breaks in long ciphertexts, violating the canonical base64 protocol boundary.

Regression coverage now locks all three fixes.

This evidence qualifies the internal PostgreSQL publication path. It does **not** replace independent cryptographic review, a live external-provider call, browser/native interoperability validation or target-deployment crash/restart testing.

## 13. Runtime composition status

The repository now contains:

- a pinned `pg` runtime dependency;
- `apps/api/postgres-pool.mjs` adapting node-postgres to the internal SQL ports;
- `apps/api/persistent-send-runtime.mjs` composing PostgreSQL repositories, transient source storage, versioned HMAC source fingerprints, session authentication and the canonical persistent Send service;
- explicit HTTP injection of that Send service.

The persistent server uses the built-in HPKE P-256 envelope implementation by default. A local security module may override that boundary explicitly, but there is no plaintext or TEST_ONLY production fallback. External cryptographic review and platform interoperability validation remain required before a production cryptography claim.

`apps/api/start-persistent-server.mjs` is the executable process entrypoint. It uses the built-in HPKE P-256 envelope implementation by default, accepts an explicit local `HERMENEIA_SECURITY_MODULE` override when configured, starts the persistent HTTP server, supports an embedded/external translation worker mode, and performs idempotent graceful shutdown.

Qualified by the `Persistent Core Qualification` workflow:

- the actual external `pg` dependency runs against disposable PostgreSQL 16;
- rollback 0011→0001, migrations 0001→0011 and SQL smoke tests pass through `scripts/postgres_integration.py`;
- the committed npm lockfile is installed with `npm ci` without mutation;
- the persistent HTTP process starts against the migrated database, passes `/healthz` and `/readyz`, executes a real pool query and closes idempotently;
- a real Linux child process reaches readiness, handles SIGTERM and exits cleanly with code 0;
- the HPKE device-material boundary cryptographically deserializes P-256 public points before persistence and rejects syntax-valid off-curve material;
- a real PostgreSQL Send→translation→HPKE→sync/decrypt→ACK/purge E2E passes with a deterministic provider adapter.

Still required before a production claim:

- complete independent cryptographic review plus browser/native interoperability and private-key storage validation;
- run the first-party OpenAI Responses adapter against controlled live credentials/model access and verify the full provider/publication path;
- run the persistent process under its actual deployment target and verify crash/failure recovery and operational observability. Linux process startup, readiness and graceful SIGTERM shutdown are already exercised in CI.

Do not silently fall back to the in-memory Core in a production profile.

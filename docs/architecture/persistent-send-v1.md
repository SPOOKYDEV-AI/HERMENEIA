# Persistent Send Execution — V1

**Status:** Implemented execution slice; live PostgreSQL gate still required  
**Scope:** durable Send acceptance, idempotency, per-device original delivery, transient source handling, translation dispatch reference

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

There is one canonical persistent Send implementation:

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

`apps/api/server.mjs` accepts an explicit `sendService`. It defaults to the supplied `core` only for the existing in-memory executable/test profile.

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
11. allocate one device inbox offset and event per envelope;
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

## 10. Translation independence

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

## 11. Current verification gates

Verified in the local sandbox for this slice:

- strict TypeScript typecheck on the canonical persistent path;
- TypeScript build;
- persistent Send behaviour;
- repository SQL construction and transaction semantics;
- command/idempotency conflicts;
- multi-device delivery;
- transient-pressure degradation;
- transaction and COMMIT rollback cleanup;
- HMAC fingerprint generation and verification;
- HMAC key-rotation retry compatibility;
- HTTP Send routing to an injected persistent service;
- static SQL migration contract;
- no durable plaintext token/column in the SQL contract.

The live PostgreSQL smoke test is intentionally separate.

It requires:

```text
psql
HERMENEIA_TEST_DATABASE_URL
```

Until that gate passes, this slice must not be described as live-PostgreSQL validated.

## 12. Known next integration step

The repository currently defines the PostgreSQL repository against the internal `SqlPool`/`SqlExecutor` contract.

A production composition root still needs a reviewed concrete PostgreSQL driver/pool, configuration/secrets wiring, migration startup policy and lifecycle handling.

Do not silently fall back to the in-memory Core in a production profile.

The HTTP boundary is now able to receive the persistent Send service explicitly so that composition can be added without changing the public Send route.

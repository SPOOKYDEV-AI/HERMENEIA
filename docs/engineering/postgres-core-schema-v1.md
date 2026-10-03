# PostgreSQL Core Schema — V1

**Status:** first persistence migration  
**Scope:** Core Messaging only

Migration:

    db/migrations/0001_core_messaging.sql

Rollback helper for development:

    db/migrations/0001_core_messaging.down.sql

## Included now

- users / tenants / tenant membership;
- devices / sessions;
- direct conversations / members;
- message metadata / immutable revisions;
- command receipts;
- per-device sync state;
- delivery envelopes;
- device inbox journal;
- durable outbox jobs.

## Deliberately excluded

- translation/provider execution tables;
- ContextState / ContextClaim / provenance;
- glossary/corrections;
- checkpoints;
- usage ledger;
- deletion ledger;
- pgvector;
- Redis;
- partitioning.

Those arrive only when the executable slice needs them.

## No plaintext transcript

The schema intentionally has no:

    message_text
    source_text
    translated_text
    prompt
    full_history

columns.

`protected_payload` belongs to the Delivery Relay contract and is not plaintext conversation history.

## Transaction contract for Send

One application transaction must:

1. authorise actor device/session and active conversation membership;
2. detect existing `client_message_id` for the same actor;
3. compare the create revision's `source_hash` for idempotency conflict detection;
4. atomically allocate conversation `message_seq` and create `op_seq`;
5. insert MessageMetadata + MessageRevision;
6. insert one ORIGINAL DeliveryEnvelope per eligible recipient device;
7. append one DeviceInboxEvent per envelope with a device-scoped offset;
8. insert durable OutboxJob for translation scheduling;
9. store/complete CommandReceipt;
10. commit;
11. only after commit return `ACCEPTED`.

No provider call occurs inside this transaction.

## Authorisation

SQL foreign keys provide structural tenant/device/conversation integrity.

They are **not** the full authorisation layer.

Application logic must still verify:

- active session/device;
- active tenant membership;
- active conversation membership;
- actor ownership/edit/delete permissions;
- current membership/policy/revocation epochs.

RLS is deferred until we have measured whether it improves defence-in-depth without obscuring service-level authz.

## PostgreSQL integration test status

The repository includes static migration contract validation in local CI.

A live PostgreSQL execution check is conditionally supported when `HERMENEIA_TEST_DATABASE_URL` and `psql` are available.

The current sandbox cannot reach Debian package repositories, so PostgreSQL installation was not possible here. We therefore do **not** claim the migration has been executed against PostgreSQL yet.

# PostgreSQL Persistence Ports — V1

**Status:** Executable repository boundary + node-postgres runtime adapter; live PostgreSQL gate pending

This slice introduces transaction and SQL repository ports without coupling the domain to a particular Node PostgreSQL client library.

## 1. Packages

    packages/persistence/
    packages/persistence-postgres/

The generic package defines:

    SqlPool
    SqlConnection
    SqlExecutor
    SqlTransactionManager

The PostgreSQL package implements messaging/session queries against the canonical schema.

The current Node runtime adapter is `apps/api/postgres-pool.mjs`, backed by the pinned `pg` dependency. It adapts `pg.Pool` to the internal ports without leaking driver concepts into domain/application packages.

The persistent messaging runtime is composed by `apps/api/persistent-send-runtime.mjs`, while `apps/api/persistent-server.mjs` creates the pure persistent HTTP profile. Together they wire:

- node-postgres pool;
- transaction manager;
- PostgreSQL messaging/session repositories;
- bounded transient source store;
- versioned HMAC source fingerprinting;
- persistent Bearer-session authentication;
- the canonical PersistentMessagingService.

Envelope protection remains a required injected dependency because the cryptographic construction has not yet completed its dedicated security review. There is intentionally no insecure production fallback.

## 2. Transaction rule

`SqlTransactionManager` owns:

    BEGIN
      -> work
    COMMIT

and on failure:

    ROLLBACK

Connection release occurs in `finally`.

Business services must not independently nest implicit transaction ownership around the same operation.

## 3. Parameterisation

All runtime values are passed as SQL parameters.

Conversation IDs, tenant IDs, device IDs, credentials and user-controlled identifiers must never be interpolated into SQL strings.

Sandbox tests deliberately use SQL-looking malicious input and verify it remains in the params array.

## 4. Sequence allocation

The repository allocates `message_seq` and create `op_seq` with one atomic PostgreSQL UPDATE guarded by:

- exact tenant;
- conversation;
- ACTIVE conversation status;
- ACTIVE conversation membership.

No provider/network call belongs inside that lock/transaction.

## 5. Inbox and runtime schema alignment

Migration:

    db/migrations/0003_runtime_alignment.sql

adds two previously missing runtime invariants:

1. sessions are tenant-bound;
2. device inbox events support:
   - message.available -> envelope required;
   - message.edited -> envelope required;
   - message.deleted -> envelope forbidden/content-free.

This fixes a mismatch discovered only after edit/delete became executable.

## 6. Session tenant binding

Persistent sessions must contain an exact `tenant_id`.

A user may belong to several tenants. Authentication must never select:

    first active tenant membership

or any other arbitrary membership.

The persistent session lookup joins the session's exact tenant membership.

The migration initially keeps `sessions.tenant_id` nullable for safe pre-production migration/backfill. New persistent session issuance must populate it.

## 7. ACK / payload purge

PostgreSQL retains a minimal DeliveryEnvelope row for:

- idempotent ACK status;
- inbox-event referential integrity;
- delivery metadata.

After ACK it destroys the protected payload:

    protected_payload = empty bytea
    status = ACKED
    acked_at = ...

Therefore the durable privacy invariant is **payload purge on ACK**, not necessarily physical row deletion.

This is the persistent equivalent of the in-memory relay tombstone.

## 8. Tenant-local cursor and payload purge

Persistent sync cursor state is stored in `tenant_device_sync_states` and is scoped by:

    tenant_id
    device_id

The state owns:

    inbox_epoch
    next_offset
    last_acked_offset

`next_offset` is tenant-local. The same physical device may therefore have the same numeric offset in multiple tenants without exposing activity between them.

`last_acked_offset` tracks the contiguous terminal envelope prefix for payload lifecycle purposes. It is deliberately **not** used as a blanket replay floor because content-free control events may still need replay.

Persistent sync behavior therefore distinguishes:

- ACKED/REVOKED content envelopes: advance cursor without exposing payload;
- PENDING content envelopes: deliver normally;
- EXPIRED/missing content payload at the current replay point: controlled reset;
- content-free controls such as `message.deleted`: remain replayable even below the ACK watermark.

`evaluateSyncCursor()` rejects wrong epochs and cursors ahead of the tenant-local issued range; it does not infer another tenant's activity from a global device counter.

## 9. Mutation lifecycle

Migration `0006_outbox_superseded.sql` adds the explicit `SUPERSEDED` lifecycle for translation outbox jobs. Edit/delete mark AVAILABLE or LEASED jobs from stale source revisions as superseded and purge pending protected delivery payloads in the same transaction.

A running worker also fences publication against current source revision/message status, and provider-attempt completion is conditional on the attempt still being STARTED. Edit/delete logically cancel started provider attempts, supersede stale translation executions, and make stale leases unable to complete/retry/dead-letter successfully.

## 10. Historical edit/delete fanout

Mutation fanout is derived from retained `delivery_envelopes` metadata rather than the replay journal.

- edit targets only active devices with prior ORIGINAL-envelope exposure and current active membership;
- delete targets active devices with prior ORIGINAL-envelope exposure even if current membership has ended, because deletion reduces retained client exposure;
- raw protected payload is not required for this lookup.

This avoids coupling mutation correctness to future inbox-event compaction.

## 11. No live PostgreSQL claim yet

The current repository now declares a pinned `pg` runtime dependency and contains the concrete pool adapter/composition root.

The current execution sandbox still has:

- no `psql` binary;
- no configured live PostgreSQL test URL;
- no installed external `pg` package in the isolated local test runtime.

Therefore:

- TypeScript repository logic is sandbox-tested;
- the node-postgres adapter/composition logic is tested with an injected driver-compatible fake;
- SQL query ordering/parameters are sandbox-tested with a scripted driver;
- migrations are statically checked;
- the live PostgreSQL integration runner is prepared;
- the actual external `pg` package + live PostgreSQL server path is **not claimed as executed yet**.

When available:

    HERMENEIA_TEST_DATABASE_URL=...
    python scripts/postgres_integration.py

must apply migrations 0001 -> ... -> 0010 and the declared smoke tests successfully before production persistence is considered validated.

## 12. Sandbox evidence

Executed:

    npm run typecheck
    npm run build
    npm test

Result while implementing the slice:

    37 tests passed
    0 failed

The persistence-specific suite contains 7 tests covering:

- commit/release;
- rollback/release;
- parameterized sequence allocation;
- ACK payload purge;
- ACK idempotency;
- tenant-local cursor isolation and controlled replay/reset;
- exact tenant session binding.

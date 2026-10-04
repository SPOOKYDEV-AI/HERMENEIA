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

## 8. Cursor after purge

Once the service records:

    last_acked_offset = N

a client cannot request recoverable payload history from an offset earlier than N.

`evaluateSyncCursor()` returns:

    CONTINUE
    RESET_EPOCH
    RESET_PURGED

The implemented persistent delivery service applies this rule before querying old events. Replay is filtered by authenticated tenant and device.

The purge/replay watermark is stored in `tenant_device_sync_states`; global device offsets remain monotonic in `device_sync_states`. ACK advancement scans for the first non-terminal envelope-bearing event and never jumps over it.

## 9. Mutation lifecycle

Migration `0006_outbox_superseded.sql` adds the explicit `SUPERSEDED` lifecycle for translation outbox jobs. Edit/delete mark AVAILABLE or LEASED jobs from stale source revisions as superseded and purge pending protected delivery payloads in the same transaction.

A running worker must still fence publication against current source revision/message status; changing the job row alone cannot cancel provider work already executing outside PostgreSQL.

## 10. No live PostgreSQL claim yet

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

must apply migrations 0001 -> 0002 -> 0003 -> 0004 -> 0005 -> 0006 and smoke tests successfully before production persistence is considered validated.

## 11. Sandbox evidence

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
- cursor reset after epoch/purge;
- exact tenant session binding.

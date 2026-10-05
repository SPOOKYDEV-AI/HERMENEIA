# Local / sandbox CI

During the pre-implementation phase, HERMENEIA uses a local/sandbox CI entrypoint rather than spending GitHub Actions minutes on every architecture/research change.

Run:

    python scripts/local_ci.py

Current checks:

- JSON contract files parse;
- Python research/test sources compile;
- pilot corpus invariants validate;
- evaluation harness unit tests pass;
- T0/T1/T2_ORACLE validation baselines execute without causal leakage;
- TypeScript core contracts typecheck;
- executable core builds;
- messaging invariant tests pass with the AI dispatcher down;
- HTTP send/sync/ACK integration tests pass locally, including retry/idempotency, cursor reset and payload limits;
- client outbox/restart/sync tests pass locally, including lost Send response and lost ACK recovery;
- edit/delete/command-recovery tests pass locally, including stale revisions, mutation retry idempotence and client replacement/removal;
- Bearer session tests pass locally, including expiry, revocation and spoofed identity rejection;
- PostgreSQL repository-port tests pass locally, including transaction rollback, SQL parameterisation, ACK payload purge, tenant/device cursor isolation and exact tenant session binding;
- persistent Send/command/edit/delete regression tests cover stale revision fencing, transient rollback, translation supersession and logical provider cancellation;
- translation worker tests cover late provider responses after a concurrent mutation;
- Context Engine tests cover T0/T1/T2 selection semantics, token budgets, causal/future-message exclusion, transient payload TTL/integrity and fallback behaviour;
- PostgreSQL context tests cover metadata-only ContextSnapshots and planning without durable plaintext;
- edit/delete tests cover transactional advancement, rollback and idempotence of the conversation content-invalidation (`erasure_epoch`) frontier;
- translation recovery tests cover exact source re-supply, actor/device exposure authorization, stale source/profile supersession, transient rollback and manual retry lifecycle;
- translation publish/control-event tests enforce no historical backfill to newly enrolled device IDs;
- persistent process tests cover built-in HPKE defaults and separate provider-module loading;
- SQL migration validation covers migrations 0001..0012;
- live PostgreSQL integration replays down migrations 0012→0001, then up migrations 0001→0012, then schema smoke tests when `psql` and `HERMENEIA_TEST_DATABASE_URL` are available;
- the runtime stage starts the real persistent process, checks health/readiness against PostgreSQL and verifies graceful SIGTERM shutdown;
- the PostgreSQL translation E2E seeds real tenant/user/device/conversation rows, executes Send → context snapshot/fanout → execute → HPKE publication → recipient sync/decrypt → ACK/payload purge with a deterministic provider adapter;
- the same PostgreSQL E2E prepares a contextual T1 execution, advances the conversation erasure epoch, then proves the stale execution is superseded before another provider call and cannot create a translation envelope.

Node gate:

    npm run verify

`npm run verify` performs strict TypeScript checking, emits `.build`, then executes all Node test files.

### Dependency reproducibility

A committed `package-lock.json` is required. Qualification installs dependencies with `npm ci --ignore-scripts` and fails if the lockfile is missing or mutated.

The qualification workflow has read-only repository permissions. It no longer contains a fallback path that generates or commits dependency state from CI.

GitHub Actions remains deliberately limited to critical merge invariants. Expensive benchmarks, chaos/network tests and live provider evaluations belong in controlled/dedicated environments unless there is a measured reason to run them on every push.

Never claim a check passed unless its command was actually executed.

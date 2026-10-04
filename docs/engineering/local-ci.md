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
- SQL migration validation covers migrations 0001..0009;
- live PostgreSQL integration replays down migrations 0009→0001, then up migrations 0001→0009, then schema smoke tests when `psql` and `HERMENEIA_TEST_DATABASE_URL` are available.

This does **not** mean GitHub-hosted CI is permanently forbidden.

Later, when application code exists, GitHub Actions should remain deliberately small and protect only critical merge invariants. Expensive benchmarks, chaos/network tests and provider evaluations should run in controlled local/sandbox/dedicated environments unless there is a measured reason to move them.

Never claim a check passed unless its command was actually executed.

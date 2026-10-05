# Outbox Leasing and Fencing — V1

**Status:** Implemented persistence/runtime contract; live PostgreSQL gate pending

## Goal

Translation work is asynchronous and at-least-once.

A worker may crash, exceed its lease, be replaced, or continue computing after an edit/delete supersedes the work it originally leased.

HERMENEIA must prevent an obsolete worker from committing a stale result.

## Lease contract

Eligible work is:

- `AVAILABLE` with `available_at <= now`; or
- `LEASED` with an expired `lease_until`.

Leasing uses PostgreSQL row locking with:

```text
FOR UPDATE SKIP LOCKED
```

Each successful lease:

- sets status to `LEASED`;
- assigns a bounded `lease_until`;
- increments `attempt_count`;
- increments `fencing_token`.

The tuple:

```text
tenant_id + job_id + fencing_token
```

identifies one worker authority window.

## Completion fencing

A worker may complete, retry or dead-letter a job only when all are still true:

- the job is `LEASED`;
- the tenant/job identity matches;
- the supplied fencing token equals the current token;
- the lease has not expired.

Otherwise the transition returns a stale-lease result and changes nothing.

## Supersession

Editing or deleting a source revision may transition matching translation jobs from `AVAILABLE` or `LEASED` to `SUPERSEDED`.

Supersession:

- clears `lease_until`;
- sets `completed_at`;
- increments `fencing_token`.

A provider call already in flight may still finish at the network layer. Its old worker token can no longer commit the obsolete result.

## Lifecycle shape

Database constraints require:

- `AVAILABLE`: no lease and no completion timestamp;
- `LEASED`: active lease timestamp and no completion timestamp;
- `DONE`, `DEAD`, `SUPERSEDED`: no lease and a completion timestamp.

Impossible lifecycle combinations must fail at the database boundary.

## Plaintext rule

Outbox payload references may contain IDs, versions, epochs, fingerprints and bounded control metadata.

They must not contain:

- raw source text;
- translated text;
- provider prompts;
- conversation transcripts;
- bearer/access tokens.

The transient source body remains outside the durable outbox.

## Process model

V1 may run the translation worker in the same process as the transient source store.

If that process crashes, transient source can disappear while the durable outbox job remains. Recovery must degrade to `SOURCE_REQUIRED` rather than reconstruct or persist a hidden plaintext transcript.

A later multi-process deployment requires an explicitly reviewed ephemeral source handoff mechanism; it must not silently turn the durable outbox into message-body storage.

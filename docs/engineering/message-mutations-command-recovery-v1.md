# Message Mutations & Command Recovery — V1 Slice

This slice makes edit/delete first-class messaging operations instead of UI-only metadata changes.

## Executable invariants

### Edit

An edit:

- preserves the same logical `message_id` and `message_seq`;
- requires `expected_revision`;
- allocates a new immutable source revision;
- allocates a new conversation `op_seq`;
- revokes undelivered envelopes of older source revisions;
- supersedes older pending translation jobs;
- creates fresh recipient envelopes for the new revision;
- emits `message.edited`;
- is idempotent by `command_id`.

### Delete

A delete:

- requires the current source revision;
- creates a new tombstone revision;
- allocates a new `op_seq`;
- revokes undelivered content envelopes;
- supersedes outstanding translation jobs;
- emits a content-free `message.deleted` sync event;
- removes the recipient's local visible message when applied;
- is idempotent by `command_id`.

## Command recovery

    GET /v1/commands/{command_id}

allows the originating device to recover a successful logical command result after transport uncertainty.

Unknown or non-visible command IDs return:

    UNKNOWN

instead of revealing another device/user's command result.

## Client application

Recipient client storage treats:

    message.available -> insert
    message.edited    -> replace same message_id
    message.deleted   -> remove same message_id

The sync cursor advances in the same local transaction as the mutation.

## Translation safety

When a source revision changes, outstanding `AVAILABLE` translation jobs for prior revisions become:

    SUPERSEDED

No future Translation Publisher may expose a result whose source revision is no longer current.

## Sandbox evidence

Executed locally:

    npm run typecheck
    npm run build
    npm test

Result at implementation time:

    24 tests passed
    0 failed

The tests include stale revision rejection, PATCH retry idempotence, command recovery, content-free delete events and client-side edit/delete application.

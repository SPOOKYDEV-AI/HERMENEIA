# Client Local Outbox & Sync Engine — V1 Slice

This package is the first client-side messaging engine for HERMENEIA.

It is UI-independent and storage-adapter-independent.

## Responsibilities implemented

- client-owned plaintext source history for outgoing messages;
- local outbox states;
- stable `command_id` and `client_message_id` across retries;
- OFFLINE / ONLINE gating;
- retryable vs permanent send failures;
- device sync cursor;
- incoming delivery-envelope persistence;
- event de-duplication;
- pending ACK queue;
- ACK after local persistence;
- ACK retry after app/engine restart.

## Important transaction rule

A real IndexedDB/SQLite adapter must implement this as one local transaction:

    persist incoming envelope
    + mark event applied
    + advance sync cursor
    + queue delivery ACK

Only after that transaction commits may the network ACK be attempted.

This guarantees that an ACK response loss cannot destroy the recipient's only copy.

## Source ownership

Outgoing plaintext remains in client-owned storage even after server `ACCEPTED`.

That source may later be used for:

- local history/display;
- authorised translation source re-supply;
- edit operations.

The Core does not require a durable plaintext transcript.

## Current store

`InMemoryClientStore` exists only to prove semantics in sandbox tests.

Next real storage adapters:

- IndexedDB for PWA/web;
- SQLite or platform-native equivalent for mobile.

## Current transport

`HttpMessagingTransport` implements the currently executable protocol subset:

- Send;
- sync;
- delivery ACK.

It uses the injected auth headers/provider supplied by the host application.

## Network state

V1 slice exposes only:

    OFFLINE
    ONLINE

The richer NetworkProfile / constrained-network scheduling defined in architecture docs comes later, after this reliability state machine is stable.

## Sandbox scenarios

Tests prove:

1. offline Send remains local;
2. network return flushes the same logical message once;
3. lost Send response retries with identical IDs and does not duplicate server state;
4. recipient persists envelope + cursor before ACK;
5. lost ACK survives engine restart and retries;
6. repeated sync does not duplicate the local inbox;
7. AI remains unavailable throughout the messaging path.

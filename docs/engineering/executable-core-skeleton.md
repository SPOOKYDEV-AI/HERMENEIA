# Executable Core Skeleton

This is the first executable application skeleton for HERMENEIA.

It is intentionally **framework-neutral and database-neutral**.

The goal is to prove domain invariants before choosing Fastify/FastAPI or writing PostgreSQL migrations.

## What is executable

The in-memory Core currently proves:

- idempotent Send;
- durable-acceptance semantics independent from AI success;
- one logical message after response-loss retry;
- per-device delivery envelopes;
- device-scoped inbox events;
- ACK isolation per recipient device;
- membership/device authorisation;
- durable translation-work intent surviving dispatcher failure (in-memory analogue).

## What is deliberately fake

The test `EnvelopeProtector` is a test fake only.

It is **not cryptography** and is never a production implementation.

Real envelope protection is deferred to the reviewed Device Trust/Delivery security implementation.

## Why no web framework yet

Framework choice is not required to prove these invariants.

The next persistence PR can connect the same Core contracts to PostgreSQL and then expose them through the canonical OpenAPI protocol.

This avoids making correctness depend on an HTTP framework.

## Local/sandbox checks

    npm run typecheck
    npm run build
    npm test

The repository-wide sandbox CI entrypoint will also run these checks when the Node/TypeScript toolchain is available.

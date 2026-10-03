# HTTP / Sync Adapter — V1 Slice

This adapter exposes the first executable subset of the canonical protocol using Node's standard HTTP server.

No web framework dependency is required yet.

## Implemented

- `GET /healthz`;
- `POST /v1/conversations/{conversation_id}/messages`;
- `GET /v1/sync?cursor=epoch:offset&limit=&wait_ms=`;
- `POST /v1/delivery/acks`.

## Authentication boundary

The server factory requires an injected:

    authenticate(request) -> ActorContext | null

There is deliberately **no built-in test-header or insecure production authenticator**.

Tests inject header-based identity only inside the test process.

A real session authenticator will be implemented with persistent Session/Device state.

## Sync semantics

The adapter uses an opaque-ish V1 cursor format internally represented as:

    inbox_epoch:offset

Clients should treat cursors as opaque strings.

If the epoch differs from the active device inbox epoch:

    409 SYNC_RESET_REQUIRED

The server never promises to recreate expired plaintext history.

## Long poll

`wait_ms` performs one bounded wait/recheck cycle.

This is enough to validate the protocol fallback. A scalable waiter/notification mechanism is deferred until a real persistence/realtime layer exists.

## Payload safety

JSON bodies are bounded before parsing.

The current limit is intentionally small and should remain aligned with OpenAPI/product policy.

## Security

The event currently carries `protected_payload` from the DeliveryEnvelope.

The executable tests still use the explicit fake EnvelopeProtector from the Core skeleton.

No production cryptography is claimed.

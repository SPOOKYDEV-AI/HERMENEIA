# ADR-0014 — Mobile-network-first adaptive transport and client orchestration

**Status:** Accepted — amended by ADR-0016  
**Date:** 2026-10-03

## Context

HERMENEIA is expected to be used heavily on phones and therefore cannot assume:

- stable Wi-Fi;
- high bandwidth;
- low RTT;
- a continuously alive foreground process;
- identical device CPU/RAM;
- a persistent WebSocket that survives Wi-Fi/4G/5G transitions;
- that "connected to a network" means the HERMENEIA service is reachable.

The translation provider is remote and adds its own latency. Draft speculation can improve perceived latency, but it can also waste bandwidth, battery and provider cost on constrained networks.

## Decision

HERMENEIA will introduce a client-side **Network Orchestrator** and treat network quality as a first-class runtime signal.

The application protocol must remain transport-independent.

The Network Orchestrator owns:

- connectivity/reachability state;
- adaptive retry/backoff;
- local send outbox;
- request priorities;
- speculative-work gating;
- connection/session recovery;
- network-change handling;
- payload batching for low-priority work;
- mobile background/foreground transitions.

## Network profile

A network profile should be inferred from several signals rather than a single label such as Wi-Fi, 4G or 5G.

Possible inputs:

    OS network connectivity
    HERMENEIA endpoint reachability
    metered/expensive flag
    cellular generation hint
    rolling RTT
    recent request failures/timeouts
    reconnect frequency
    observed throughput from actual traffic

Possible states:

    OFFLINE
    ONLINE_UNVERIFIED
    CONSTRAINED
    NORMAL
    GOOD
    RECOVERING

A "5G" label does not guarantee GOOD. A Wi-Fi connection does not guarantee internet/service reachability.

## Traffic priorities

Network work is prioritised:

    P0  user Send / ACK / auth-critical
    P1  final translation / delivery
    P2  recovery / required context-control traffic
    P3  speculative draft translation
    P4  telemetry / optional background enrichment

Lower-priority traffic must never block P0/P1.

## Adaptive speculation

Progressive draft translation is adaptive:

    GOOD:
      normal bounded speculation

    NORMAL:
      conservative speculation

    CONSTRAINED / expensive:
      raise minimum fragment size
      reduce concurrent speculative requests
      optionally disable speculation

    OFFLINE / recovering:
      no speculative remote work

This policy is local/runtime state, not a durable user profile.

## Transport strategy

V1 should use mature HTTPS-based transports and keep the application protocol transport-agnostic.

Candidates to benchmark include:

- WebSocket;
- HTTP long-poll/streaming fallback;
- a mature realtime layer that offers connection recovery.

QUIC/HTTP/3 connection migration is relevant for future native/mobile optimisation, especially across path changes, but HERMENEIA should not implement a custom QUIC stack in MVP.

Use platform/CDN HTTP/3 opportunistically when available rather than coupling the domain to QUIC.

## Background mobile rule

Do not rely on a permanent realtime connection while the application is backgrounded.

Mobile OSes may suspend/kill networking and processes.

Use push notifications as wake hints with minimal/non-sensitive payload, then synchronise when allowed.

## Local outbox

User-sent work must be locally recoverable before successful server acknowledgement.

Conceptually:

    LocalOutboxItem {
      client_message_id
      conversation_id
      source_ref/local_content_ref
      created_at
      attempt_count
      next_retry_at
      status
    }

Server effects remain idempotent via client_message_id.

## Offline recipient delivery

Zero durable plaintext retention creates a delivery problem when the recipient is offline.

HERMENEIA therefore separates:

1. **AI/context Core** — no durable raw plaintext history by default;
2. **Delivery Relay** — required for the public asynchronous profile when recipients may be offline.

The relay uses protected per-device payload envelopes, strict TTL and delete-on-ACK semantics.

This does **not** make HERMENEIA end-to-end encrypted, because plaintext is processed transiently by the AI translation path before envelope creation.

If the required relay contract is not implemented, the public asynchronous messaging profile is not complete.

## Recovery

Realtime recovery should use application-level session/sequence/offset semantics.

A reconnect must not require re-downloading all conversation state.

## Consequences

Benefits:

- resilient on Wi-Fi/3G/4G/5G transitions;
- less wasted bandwidth/cost;
- faster perceived performance;
- better battery behaviour;
- transport/provider independence;
- explicit solution to offline recipient delivery.

Costs:

- client state machine complexity;
- local outbox persistence;
- more network-specific tests;
- relay/key-management design;
- additional observability.

## Revisit when

Revisit transport choice after benchmarks on real Android/iOS devices and degraded network profiles. Protocol invariants should remain stable even if transport implementation changes.

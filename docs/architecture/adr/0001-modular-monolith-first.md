# ADR-0001 — Modular monolith first

**Status:** Accepted  
**Date:** 2026-10-03

## Context

HERMENEIA has multiple conceptual domains, but its boundaries and workloads are not yet empirically stable.

Starting with independent network services would add deployment, tracing, versioning, authentication, failure-handling and local-development complexity before those costs solve a measured problem.

## Decision

Implement the MVP as a modular monolith with explicit internal boundaries and asynchronous workers for work that should not block message delivery.

Modules must communicate through documented application interfaces rather than reaching into each other's persistence details.

## Consequences

Benefits:

- simpler transactions;
- lower operational cost;
- easier tests;
- faster architectural refactoring;
- straightforward local development.

Constraints:

- module boundaries require discipline because the process boundary does not enforce them;
- expensive AI workloads may later need independent scaling.

## Alternatives considered

### Microservices from day one

Rejected for MVP because service boundaries are not stable and operational complexity would be speculative.

### Single unstructured application

Rejected because Context, Messaging and Translation have distinct responsibilities and will evolve independently.

## Revisit when

Reconsider extraction when measurements show independent scaling, isolation, deployment cadence or reliability needs that materially outweigh distributed-system cost.

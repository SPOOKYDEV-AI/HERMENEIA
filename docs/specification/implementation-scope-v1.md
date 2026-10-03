# Implementation Scope — V1

**Status:** Canonical delivery plan  
**Purpose:** separate mandatory product invariants from beta hardening and research experiments

The repository contains long-term product architecture as well as first-release requirements. Those are intentionally not the same thing.

## 1. Core Messaging V1 — mandatory before AI sophistication

Core Messaging V1 is complete only when two authorised clients can exchange one original message reliably while every AI provider is unavailable.

Mandatory:

- authenticated user/device/session;
- 1:1 conversation membership and authorisation;
- client local outbox;
- idempotent Send;
- server-side message/source revision identity;
- durable `ACCEPTED` contract;
- per-device DeliveryEnvelope;
- offline recipient delivery through the Relay;
- device-scoped sync cursor/offset;
- ACK only after local device persistence;
- retry/reconnect without duplicates;
- original available from authorised client/customer history;
- no durable plaintext transcript in Core by default;
- basic edit/delete revision/tombstone semantics;
- causal publication and erasure epochs;
- bounded observability without message bodies.

Milestone:

> AI unavailable for the entire scenario; sender loses the response after server commit, retries, recipient returns online and receives exactly one original message.

## 2. Translation Baseline V1 — mandatory before contextual claims

After Core Messaging V1:

- provider-neutral Translation contract;
- one logical TranslationExecution separated from provider attempts;
- T0 message-only translation;
- explicit PENDING / READY / FAILED / SOURCE_REQUIRED;
- provider timeout/rate-limit handling;
- cost/token/latency telemetry;
- original delivery never blocked by translation;
- two provider adapters maximum until the contract is proven.

## 3. Context Research V1 — mandatory to validate HERMENEIA's thesis

After T0:

- T1 fixed recent-context baseline;
- T2 minimal adaptive temporal context;
- causal ContextSnapshot;
- contiguous processed-prefix + gaps;
- bounded structured ContextState;
- explicit corrections and approved glossary entries;
- provenance and authority rules;
- sanitised recovery checkpoints;
- chronological evaluation harness with no future leakage;
- equal-budget / equal-token comparisons where applicable.

T2 is successful only if it demonstrates useful quality gains without unacceptable latency/cost.

## 4. Beta hardening — required before public beta

- degraded-network test matrix;
- reconnect storms/backpressure;
- push/background lifecycle;
- block/report/invitation abuse controls;
- quotas and cost admission;
- deletion ledger and restore procedure;
- device rotation/revocation;
- RTL/IME/Unicode qualification;
- read/unread/reply/edit/delete UX;
- accessibility;
- qualified language-pair matrix;
- security/privacy operational review;
- load testing and SLO evidence.

## 5. Experimental backlog — not Core V1 blockers

These designs remain valuable but are experiments until measured:

- progressive pre-Send translation;
- stable islands / mutable frontier;
- neural local sentence segmentation;
- advanced sarcasm/affect inference;
- fine-grained regional style adaptation beyond explicit preferences;
- vector retrieval of old episodes;
- large groups / translation cohorts;
- multi-region active-active;
- CRDT draft sync;
- WebTransport/custom QUIC usage;
- custom model training.

Experimental documents may remain Accepted/Design/Experimental as architectural research, but they do not block Core V1 completion.

## 6. Scope rule

A capability moves from Experimental/Beta into Core only with:

1. a concrete user/system failure it solves;
2. measurable acceptance criteria;
3. bounded privacy/security impact;
4. cost/latency evidence;
5. regression tests.

Architecture breadth is not itself a release criterion.

# GitHub Architecture Landscape Scan — 2026-10-03

**Purpose:** identify proven open-source patterns and HERMENEIA blind spots for mobile networking, sync, local-first behaviour, NLP preprocessing and LLM provider routing.

This is a landscape scan, not a dependency-selection document. Repositories are references to study and benchmark.

## 1. Matrix Rust SDK — selective sync / bandwidth minimisation

Repository: https://github.com/matrix-org/matrix-rust-sdk

Relevant source:
https://github.com/matrix-org/matrix-rust-sdk/blob/main/crates/matrix-sdk/src/sliding_sync/README.md

Key idea observed:

- Sliding Sync focuses explicitly on bandwidth efficiency.
- The client requests specific ranges/subsets instead of downloading everything.
- Timeline depth can start very small and grow later.
- Sync is stateful and reactive.

HERMENEIA takeaway:

    request only what the UI/current operation needs
    avoid full state/history refresh
    recover from state/offset
    allow low-bandwidth startup profiles

This validates our bounded-context direction at the network layer too.

## 2. Element X Android — mobile background reality

Repository: https://github.com/element-hq/element-x-android

Relevant source:
https://github.com/element-hq/element-x-android/blob/develop/docs/notifications.md

Observed patterns:

- mobile processes can be restricted, stopped or killed;
- background networking cannot be assumed;
- push wakes the app and background work performs sync;
- network connectivity and service/internet reachability are separate concerns.

HERMENEIA takeaway:

    never design around an always-alive background WebSocket
    push should be a wake hint
    foreground reconnect/catch-up must be first-class
    "network connected" != "backend reachable"

## 3. Signal Android — connectivity monitoring and retry/backoff

Repository: https://github.com/signalapp/Signal-Android

Relevant source:
https://github.com/signalapp/Signal-Android/blob/main/app/src/main/java/org/thoughtcrime/securesms/net/InternetConnectivityMonitor.kt

Observed:

- dedicated internet-connectivity monitoring;
- retry/backoff logic;
- mobile network handling is a subsystem, not scattered calls.

HERMENEIA takeaway:

    central Network Orchestrator
    one retry policy
    avoid independent retry loops in each module

## 4. Socket.IO — session/offset connection recovery

Repository: https://github.com/socketio/socket.io

Relevant implementation/search areas:

- connection state recovery;
- client reconnection delay;
- session identifier + last packet offset.

HERMENEIA takeaway:

    application-level session/offset recovery is more important than transport brand
    reconnect should resume, not full-resync

We should benchmark Socket.IO rather than adopt automatically.

## 5. Centrifuge JS — recoverable streams and network events

Repository: https://github.com/centrifugal/centrifuge-js

Relevant source:
https://github.com/centrifugal/centrifuge-js/blob/master/README.md

Observed:

- recoverable stream positions;
- online/offline network event handling;
- batching;
- several realtime transport options.

Important note from its changelog: querying backend state after reconnect can still be the most reliable recovery method.

HERMENEIA takeaway:

    recovery flag alone is insufficient
    reconcile with authoritative HERMENEIA metadata/checkpoint/outbox after reconnect

## 6. PowerSync — local upload queue pattern

Repositories:

- https://github.com/powersync-ja/powersync-kotlin
- https://github.com/powersync-ja/powersync-js

Observed:

- explicit local CRUD/upload queue;
- failed uploads remain queued for retry;
- local database is a first-class client state.

HERMENEIA takeaway:

    local outbox for unsent messages is mandatory
    network failure must not equal lost user intent

We do not need PowerSync itself for MVP merely to use this pattern.

## 7. Automerge / Yjs — local-first and sync protocol patterns

Repositories:

- https://github.com/automerge/automerge
- https://github.com/automerge/automerge-repo
- https://github.com/yjs/yjs
- https://github.com/yjs/y-websocket

Observed:

- efficient change synchronization;
- network-agnostic/local-first concepts;
- peer/session state;
- offline editing;
- transport adapters.

HERMENEIA takeaway:

CRDTs are potentially useful later for:

    multi-device drafts
    collaborative group composition
    local-first client history sync

But they are likely overkill for V1 one-author chat messages. Do not introduce a CRDT until a true concurrent-editing requirement exists.

## 8. React Native NetInfo — adaptive network hints

Repository:
https://github.com/react-native-netinfo/react-native-netinfo

Observed API concepts:

    isInternetReachable
    isConnectionExpensive
    cellularGeneration

HERMENEIA takeaway:

Useful hints for adaptive speculation/batching, but never sufficient alone.

Do not request SSID/location permission merely for network optimisation.

## 9. QUIC / HTTP/3 implementations

Repositories:

- https://github.com/cloudflare/quiche
- https://github.com/aws/s2n-quic
- https://github.com/quinn-rs/quinn

Observed:

- HTTP/3 support;
- connection migration/path handling is an explicit concept.

HERMENEIA takeaway:

Wi-Fi -> cellular path changes make QUIC conceptually attractive.

However:

    custom QUIC in MVP = unnecessary complexity

Prefer standard HTTP stack/CDN HTTP/3 support first. Keep application recovery independent of transport.

## 10. LiteLLM — provider gateway patterns

Repository:
https://github.com/BerriAI/litellm

Relevant source:
https://github.com/BerriAI/litellm/blob/main/ARCHITECTURE.md

Observed:

- provider abstraction;
- routing;
- fallback;
- rate limits;
- budgets;
- cost tracking;
- caching.

HERMENEIA takeaway:

Our future Provider Router needs equivalent concepts, but HERMENEIA-specific policy must include:

    target language pair
    quality requirement
    privacy/data region
    tenant provider allow-list
    network latency profile
    request complexity
    current provider health
    cost budget

Do not couple Context Engine to LiteLLM/provider-specific objects.

## 11. Lingua — offline language detection

Repository:
https://github.com/pemistahl/lingua-rs

Observed:

- offline detection;
- short-text focus;
- multiple language support;
- low-accuracy mode reduces memory footprint/speed cost but significantly hurts short-text accuracy.

HERMENEIA takeaway:

Promising on-device candidate, especially for offline/private hints.

Blind spot discovered:

    low-power mode and short-chat accuracy can conflict

Benchmark memory/latency on low-end phones before adoption.

## 12. Segment Any Text / wtpsplit

Repository:
https://github.com/segment-any-text/wtpsplit

Observed:

- multilingual sentence segmentation across many languages;
- ONNX support;
- small/faster model variants;
- language/domain adaptation.

HERMENEIA takeaway:

Interesting benchmark candidate for difficult sentence boundaries in progressive translation.

Do not make it mandatory in the typing path:

    deterministic segmentation must remain fallback
    neural segmentation must not block UI
    on-device footprint must be measured

## 13. Toxiproxy / Pumba — fault injection

Repositories:

- https://github.com/Shopify/toxiproxy
- https://github.com/alexei-led/pumba

Observed:

Toxiproxy supports faults such as:

    latency + jitter
    bandwidth limit
    timeout
    abrupt reset

Pumba integrates container/network netem operations including delay/loss/rate shaping.

HERMENEIA takeaway:

Build a reproducible degraded-network benchmark suite from the start.

## 14. Blind spots surfaced by the scan

### B1 — Offline recipient delivery

If Core stores no raw history and recipient is offline, something must temporarily hold the delivery payload.

Action:

    design opaque encrypted relay with TTL + ACK

### B2 — Background process death

A socket is not a mobile delivery guarantee.

Action:

    push wake + local outbox + reconnect recovery

### B3 — Network labels are misleading

5G may be congested; Wi-Fi may have no internet.

Action:

    combine OS hints with measured HERMENEIA reachability/RTT/failure EWMA

### B4 — Radio/battery cost

Many tiny speculative requests can be worse than a slightly slower single request.

Action:

    request coalescing + speculation gating + physical-device battery tests

### B5 — Low-end device NLP

A local model that is fast on desktop may harm typing on entry-level phones.

Action:

    deterministic first path + optional model tier + device benchmarks

### B6 — Captive portal / DNS / firewall

"Connected" cannot be the only state.

Action:

    service reachability state

### B7 — Reconnect duplicates

Network switching can replay sends.

Action:

    local outbox + client_message_id + idempotent server acceptance

### B8 — Recovery storage semantics

Connection-state recovery must not secretly recreate durable chat history.

Action:

    retain only bounded delivery/control events necessary for recovery, with TTL

### B9 — Transport lock-in

Choosing WebSocket/QUIC/realtime vendor too early could leak into domain logic.

Action:

    transport-independent realtime/application protocol

### B10 — Provider routing depends on network too

A "best" model 500 ms farther away can be worse for interactive chat.

Action:

    routing inputs include measured latency and region, not model quality/cost only

## 15. Recommendation status

### Adopt as architecture patterns now

- central Network Orchestrator;
- local outbox;
- idempotent Send;
- offset/session recovery;
- adaptive network profile;
- push-assisted background catch-up;
- priority scheduling;
- degraded-network test matrix;
- transport/provider abstraction.

### Benchmark before adopting as dependencies

- Socket.IO;
- Centrifugo;
- Lingua;
- wtpsplit/SaT;
- LiteLLM;
- PowerSync.

### Keep out of MVP unless requirement appears

- CRDT for normal one-author messages;
- custom QUIC stack;
- custom binary wire protocol;
- heavy on-device neural NLP.

## 16. Next engineering experiments

1. Build transport benchmark harness: WebSocket vs HTTP streaming/long-poll under Toxiproxy.
2. Implement mock local outbox + idempotent echo server.
3. Test Wi-Fi -> cellular/disconnect recovery on physical Android.
4. Benchmark draft segmentation heuristics vs optional model.
5. Measure bytes/message and battery/network wakeups.
6. Benchmark provider routing using latency + quality + cost.
7. Prototype encrypted offline delivery envelope separately from AI Context Core.

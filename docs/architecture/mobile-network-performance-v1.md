# Mobile Network and Performance Architecture — V1

**Status:** Design baseline  
**Scope:** Mobile/web client, realtime transport, Translation Engine orchestration  
**Primary goals:** quality, speed, trust, low bandwidth, battery awareness

## 1. Product principle

HERMENEIA must feel reliable on:

    strong Wi-Fi
    weak Wi-Fi
    5G
    4G
    3G
    metered networks
    temporary offline periods
    Wi-Fi <-> cellular transitions

The user should not have to understand the network state.

## 2. End-to-end latency model

Measure:

    T_user_send_to_ready =
        T_local_enqueue
      + T_network_up
      + T_context
      + T_provider
      + T_network_down
      + T_reconcile
      + T_render

For progressive long messages, report how much provider/context work was completed before Send separately.

## 3. Network Orchestrator

Conceptual responsibilities:

    connectivity monitor
    service reachability
    request scheduler
    priority queues
    retry/backoff
    session recovery
    speculative gating
    request coalescing/batching
    local outbox
    foreground/background policy

The rest of the application should ask the orchestrator to perform work rather than implementing independent retry loops.

## 4. Connectivity is not reachability

A phone can be connected to:

    Wi-Fi with captive portal
    router with no WAN
    mobile network with broken DNS
    corporate network blocking an endpoint

Therefore separate:

    network_connected
    internet_reachable
    hermeneia_reachable

Do not infer service reachability from interface state alone.

## 5. Adaptive NetworkProfile

Conceptually:

    NetworkProfile {
      state
      interface_type
      metered_or_expensive
      cellular_generation_hint
      rtt_ewma_ms
      failure_rate_ewma
      reconnect_rate
      throughput_hint
      last_verified_at
    }

Avoid collecting SSID/location information for optimisation.

## 6. Profile behavior

### GOOD

    normal realtime connection
    progressive translation enabled
    multiple bounded speculative fragments
    normal checkpoint/control updates

### NORMAL

    progressive translation enabled conservatively
    bounded concurrency
    coalesce optional traffic

### CONSTRAINED

    user Send/final translation priority only
    speculation heavily limited or disabled
    larger fragment threshold
    batch telemetry
    no optional prefetch
    smaller context payloads where quality allows

### OFFLINE

    queue user Send locally
    no provider/network speculation
    preserve UI responsiveness
    expose simple non-blocking offline state

### RECOVERING

    reconnect with jittered backoff
    resume by session/offset/watermark
    flush P0 before optional work
    avoid reconnect stampede

## 7. Retry policy

Use:

    bounded retry
    exponential backoff
    jitter
    Retry-After when supplied
    error classification

Do not retry:

    permanent auth errors
    invalid payloads
    policy rejections

Retryable examples:

    timeout
    connection reset
    temporary provider/network failure
    429/5xx according to policy

## 8. Request priorities

A scheduler should ensure:

    user final message
        > final translation
        > ACK/recovery
        > speculative translation
        > telemetry

Speculative work may be cancelled immediately when P0/P1 work arrives.

## 9. Mobile background mode

Foreground:

    realtime transport allowed
    progressive translation allowed

Background:

    persistent connection not assumed
    speculative translation stopped
    transient drafts purged/paused according to policy
    push acts as wake hint
    catch-up runs under OS-approved background mechanism

Push payloads should reveal as little message content as possible.

## 10. Connection recovery

A realtime session should track:

    session_id
    connection_epoch
    last_received_offset
    last_acked_client_message_id

On reconnect:

    authenticate
    advertise last offset
    receive only missing control/delivery events
    reconcile local outbox
    resume active state

Recovery storage is bounded and separate from conversation history.

## 11. Local outbox

The sender device owns pending unsent content.

States:

    LOCAL_PENDING
    SENDING
    ACKED
    RETRY_WAIT
    FAILED_PERMANENT

A crash/restart should not duplicate an acknowledged message.

## 12. Delivery relay

When the recipient is offline, immediate deletion of all server-side payloads is incompatible with reliable asynchronous messaging.

A dedicated relay may retain:

    envelope_id
    recipient/device routing metadata
    encrypted payload
    created_at
    expires_at
    delivery attempts

The relay should not expose plaintext conversation history to ordinary Core storage.

Delete on ACK or TTL expiry.

Key management and multi-device encryption require a separate security ADR before implementation.

## 13. Payload design

Prefer small, bounded payloads.

Rules:

- no full conversation replay;
- no raw history attached to every request;
- send ContextSnapshot/state deltas rather than large repeated state where safe;
- batch low-priority metadata;
- compress only when measurements show a net benefit;
- avoid custom binary protocols before profiling JSON/HTTP overhead.

## 14. Device capability

Device capability must affect local optional work, not translation correctness.

Conceptual tiers:

    BASIC
    STANDARD
    CAPABLE

Possible inputs should be coarse and privacy-safe:

    platform capability
    memory-pressure feedback
    measured local task latency

Do not build a fingerprint from hardware identifiers.

## 15. On-device work

Good candidates:

    Unicode/grapheme handling
    deterministic draft segmentation
    edit/stability state machine
    hashing/revision tracking
    simple slang/glossary lookup
    simple language hints

Optional benchmark candidates:

- Lingua for offline language identification;
- compact ONNX sentence segmentation models.

Heavy neural segmentation must never be required for typing fluidity.

## 16. Language detection

Short-message language detection is inherently difficult.

Use combined evidence:

    explicit target/source preference
    conversation language state
    token/span detection
    script
    recent confirmed language
    detector confidence

Do not trust a single classifier result on "si", "no", "ok", acronyms, names or mixed-language messages.

## 17. Sentence segmentation

V1 should use a layered approach:

    deterministic fast rules
       +
    language-aware heuristics
       +
    optional lightweight model for difficult cases

The draft path must remain useful when the model is unavailable.

## 18. Battery and radio cost

Network chatter wakes radios and consumes battery.

Therefore:

- no per-keystroke requests;
- debounce/coalesce low-priority traffic;
- avoid unnecessarily short keepalive intervals;
- stop speculation in background;
- reduce speculative work on expensive/constrained links;
- measure battery impact on physical devices before enabling aggressive defaults.

## 19. Transport candidates

### WebSocket

Pros:

    ubiquitous
    simple
    low-latency bidirectional channel

Risks:

    reconnect/path-change handling is application responsibility
    mobile background lifetime is unreliable

### Long-poll/HTTP streaming

Pros:

    robust through proxies/firewalls
    mature HTTP infrastructure
    Matrix demonstrates selective long-poll sync patterns

Risks:

    request lifecycle overhead

### Socket.IO / similar recovery layer

Interesting patterns:

    session IDs
    packet offsets
    automatic reconnect/backoff
    connection-state recovery

Must benchmark protocol overhead before adoption.

### Centrifugal/Centrifuge

Interesting patterns:

    recoverable streams
    network online/offline events
    command batching
    transport fallbacks

Would add an infrastructure component; benchmark rather than adopt blindly.

### HTTP/3/QUIC

Interesting future property:

    connection/path migration across network changes

Do not implement low-level QUIC ourselves in MVP.

## 20. Network fault test matrix

At minimum test:

    baseline Wi-Fi
    50ms / 150ms / 500ms / 1000ms RTT
    bandwidth 64 / 256 / 1000 Kbit/s
    jitter
    packet loss 1% / 5% / 10%
    TCP reset
    5s / 30s disconnect
    Wi-Fi -> cellular reconnect
    cellular -> Wi-Fi reconnect
    connected network with unreachable backend
    provider 429
    provider timeout
    app background/kill/relaunch

## 21. Fault-injection tooling

Candidates:

- Shopify Toxiproxy for latency, jitter, bandwidth, timeout/reset faults;
- Pumba/netem for container-level delay/loss/rate emulation;
- platform-specific mobile network conditioners where available.

These belong in integration/performance tests, not production dependencies.

## 22. Metrics

Required:

    bytes_up_per_message
    bytes_down_per_message
    network_rtt_ms
    request_retry_count
    reconnect_count
    connection_recovery_ms
    local_outbox_depth
    outbox_oldest_age
    delivery_relay_age
    delivery_ack_ms
    network_profile
    speculative_bytes_up
    speculative_waste_bytes
    send_to_ready_ms
    background_wake_to_sync_ms

Report by network profile/device class without collecting unnecessary identifiers.

## 23. Acceptance criteria

V1 is not complete until:

1. a Send succeeds after temporary offline through local outbox;
2. retries are idempotent;
3. reconnection resumes from bounded offset/state instead of full resync;
4. user Send preempts speculative work;
5. speculation automatically reduces on constrained/expensive networks;
6. Wi-Fi/cellular transition does not duplicate or lose a message;
7. background mode does not rely on a permanent socket;
8. service reachability is distinguished from interface connectivity;
9. 3G-like fault profile remains usable;
10. network test suite covers latency/loss/bandwidth/disconnect/reset;
11. metrics quantify bytes, retries and send-to-ready latency;
12. offline-recipient delivery has an explicit TTL/ACK storage design rather than an implicit plaintext history.

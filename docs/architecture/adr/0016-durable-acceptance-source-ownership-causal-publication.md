# ADR-0016 — Durable acceptance, source ownership and causal publication

**Status:** Accepted  
**Date:** 2026-10-03

## Context

Earlier HERMENEIA documents mixed three separate concerns:

1. durable acceptance of a message for delivery;
2. transient source availability for translation/context;
3. durable conversation history.

Later privacy decisions correctly removed durable plaintext history from HERMENEIA Core by default, but several older documents still assumed recent durable messages could always be replayed.

This ambiguity affects ACK semantics, recovery, checkpoints, retries, deletion and translation publication.

## Decision

HERMENEIA separates three operations:

    persist_local_original
    commit_delivery_envelopes
    retain_transient_processing_source

They have different owners, retention and guarantees.

### ACCEPTED

A logical Send becomes `ACCEPTED` only after a durable transaction has committed:

- message identity and source revision metadata;
- recipient/device delivery envelopes required by the current delivery policy;
- sync/inbox events or durable jobs necessary to make delivery recoverable;
- idempotency state.

Provider translation must not be required before this commit.

`ACCEPTED` does not mean delivered, read or translated.

### Source ownership

The durable plaintext source belongs to the authorised client/customer-controlled history layer by default.

HERMENEIA Core may process plaintext transiently under explicit TTL and budget limits.

If transient source expires before a translation can complete, translation may enter `SOURCE_REQUIRED` / `SOURCE_EXPIRED`. The system must not fabricate missing source content.

### Delivery relay

For the public asynchronous messaging profile, the Delivery Relay is mandatory when recipients may be offline.

The relay stores per-device encrypted delivery envelopes with strict TTL and delete-on-ACK semantics.

This protects stored delivery payloads but does not constitute end-to-end encryption of HERMENEIA as a whole because the Core processes plaintext transiently.

### Causal publication

Derived results may be published only if all relevant causal preconditions still hold:

- source revision is still current;
- source is not deleted;
- recipient is still authorised;
- policy/tenant constraints are still admissible;
- correction/glossary dependencies are still valid;
- erasure epoch and membership epoch are compatible;
- execution has not been superseded.

### Context frontier

A context projection must track a contiguous processed prefix and any gaps. A monotonic maximum sequence is not sufficient.

Workers may complete out of order, but future messages must not leak backward into earlier translations.

### Checkpoint publication

A checkpoint is published only with compare-and-swap conditions over:

- base Context State version;
- causal processed prefix;
- erasure epoch;
- membership/policy versions relevant to the snapshot.

Atomic write alone is insufficient.

## Consequences

Benefits:

- Send reliability no longer depends on AI availability;
- privacy model and recovery semantics are consistent;
- stale workers/checkpoints cannot silently resurrect deleted data;
- offline delivery has a clear owner;
- causal ordering becomes executable rather than descriptive.

Costs:

- device and relay key lifecycle must be specified;
- client local persistence becomes mandatory for reliable history;
- some interrupted translations cannot resume without source re-supply;
- more explicit version/epoch fields are required.

## Supersedes / amends

This ADR amends conflicting wording in ADR-0003, ADR-0009, ADR-0010, ADR-0011 and ADR-0014.

Where those documents imply durable plaintext replay, confidence-only durable memory promotion, translation-before-ACK priority, or checkpoint publication without freshness checks, ADR-0016 takes precedence.

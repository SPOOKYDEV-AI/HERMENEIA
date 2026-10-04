# Delivery Contract — V1

**Status:** Canonical contract  
**Scope:** Send, delivery, sync, ACK, retries, offline recipients

## 1. State vocabulary

Client-facing message states:

    QUEUED_LOCAL
    SENDING
    ACCEPTED
    DELIVERED_DEVICE
    READ
    FAILED_PERMANENT

Translation state is independent:

    NOT_REQUESTED
    PENDING
    READY
    FAILED
    SOURCE_REQUIRED
    EXPIRED

A message can be `ACCEPTED` while translation is `PENDING` or `FAILED`.

## 2. Send transaction

A successful Send command must be idempotent by `client_message_id`.

Server flow:

1. authenticate session/device;
2. authorise conversation membership and policy;
3. enforce quotas and request limits;
4. deduplicate `client_message_id`;
5. allocate `message_seq` and source revision;
6. create required per-device delivery envelopes;
7. create sync/inbox events and durable jobs;
8. commit transaction;
9. return `ACCEPTED`.

No provider call is required before step 9.

Retry with the same idempotency key and same payload returns the original result.
Same key with different payload returns `IDEMPOTENCY_CONFLICT`.

## 3. Delivery envelope

Conceptual envelope:

    DeliveryEnvelope {
      tenant_id
      envelope_id
      message_id
      source_revision
      recipient_device_id
      recipient_key_version
      rendition_type
      ciphertext
      created_at
      expires_at
      acked_at
      status
    }

`rendition_type` may be:

    ORIGINAL
    TRANSLATION

Each device owns its own envelope lifecycle.

ACK from one device never deletes another device's envelope.

## 4. ACK semantics

`ACCEPTED`
: committed on the service such that delivery can survive ordinary process restart under the declared durability policy.

`DELIVERED_DEVICE`
: target device has persisted the envelope/rendition locally before ACK.

`READ`
: recipient/user declares the relevant read cursor reached the message.

Network receipt without local persistence is not a delivery ACK.

## 5. Translation independence

Original delivery and translation run independently.

Typical flow:

    original ACCEPTED
      -> ORIGINAL envelope available
      -> translation PENDING
      -> translation READY
      -> TRANSLATION envelope available

If translation fails, the original remains deliverable.

## 6. Source re-supply

If the Core no longer has authorised transient source content:

    translation -> SOURCE_REQUIRED

An authorised client/customer store may re-supply exactly the required source revision.

Re-supply must include:

    message_id
    source_revision
    source_hash
    source text

The server rejects mismatched revisions/hashes.

## 7. Edit/delete

Edits create a new immutable source revision.

Delete creates a tombstone operation and invalidates publication of older in-flight derived results.

A worker result can be published only if its source revision remains current and not deleted.

## 8. Sync/recovery

Each authenticated tenant/device pair receives ordered inbox events using a tenant-local cursor/offset.

Cursor identity is scoped by:

    tenant_id + device_id + inbox_epoch + offset

The same physical device may therefore have offset 1 in two different tenants. Activity in one tenant must not advance, gap, or otherwise reveal the cursor sequence of another tenant.

On reconnect:

1. authenticate;
2. present last committed device cursor;
3. receive only missing events/envelopes still within retention;
4. apply locally transactionally;
5. advance local cursor only after local commit.

A reset cannot recreate raw content that has already expired from all authorised sources.

## 9. Offline recipient

The public asynchronous profile requires a Delivery Relay.

Retention:

    until device ACK
    OR envelope expiry
    OR device/conversation access revocation
    OR deletion/erasure policy invalidates delivery

The Relay is not conversation history.

## 10. Required errors

    IDEMPOTENCY_CONFLICT
    REVISION_CONFLICT
    NOT_AUTHORIZED
    DEVICE_REVOKED
    SOURCE_REQUIRED
    SOURCE_EXPIRED
    SOURCE_REVISION_MISMATCH
    SYNC_CURSOR_EXPIRED
    POLICY_REJECTED
    QUOTA_EXCEEDED
    DELIVERY_EXPIRED
    PROVIDER_UNAVAILABLE

## 11. Core invariants

- translation availability never gates `ACCEPTED`;
- ACK deletion is per device/envelope;
- source revision is immutable;
- all publication is revision-checked;
- retries are at-least-once transport with idempotent effects;
- delivery retention and conversation history are separate concerns.

# Domain package — pre-implementation boundary

The canonical V1 domain model is defined in:

- `docs/architecture/canonical-data-model-v1.md`
- `docs/architecture/delivery-contract-v1.md`
- `docs/architecture/data-lifecycle-v1.md`

This directory intentionally contains no runtime-specific entities yet.

PR 4 will choose the workspace/runtime skeleton and create compiled domain types without changing these invariants:

- tenant-scoped business data;
- explicit message/op/device-inbox ordering;
- immutable source revisions;
- no generic durable MemoryItem;
- per-device DeliveryEnvelope;
- logical TranslationExecution separated from ProviderExecution;
- causal ContextSnapshot and processed-prefix/gaps;
- explicit erasure/membership/policy epochs.

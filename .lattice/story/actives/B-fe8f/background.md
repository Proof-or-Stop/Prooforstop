## Trigger Event
B-1fa6 accepted the Dynamic Finding execution plan after historical evidence showed duplicate Finding identifiers, lost concurrent updates, replay divergence, crash exposure, and runtime evidence that could remain accepted after relevant hash or environment changes. This Story begins the mandated implementation order.

## Key Insights
Ledger correctness is the foundation for every later identity, lineage, routing, and applicability decision. Runtime evidence is only gate-worthy when its signature, command result, toolchain, environment, base/head/material/story-files hashes, and authoritative mode remain valid and fresh.

## Solution Tradeoffs
Use per-story fenced locking, deterministic identity, idempotency keys, exact-byte input hashes, atomic durable replacement, and signed RuntimeEvidenceReceipt objects. The added metadata and synchronization cost is accepted because silent loss, duplication, stale authorization, or non-deterministic replay would invalidate later Stories.

## Conversational Texture
The user explicitly required the three Stories to follow the accepted document and dependency order, with executable RED before GREEN in every Story. This first Story must stay focused on ledger and runtime-evidence integrity and must not absorb identity, lineage, or applicability behavior owned downstream.

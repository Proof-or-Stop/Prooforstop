## Trigger Event
On 2026-07-02, after B-ec3b completed playbook memory M0-M2, the user asked to continue with M3-M6 until done. The current plan explicitly marks the indexed/cached million-record hot path as NOT YET PROVEN, so this story exists to close that specific runtime capability gap without overclaiming the M0-M2 result.

## Key Insights
The useful product outcome is not just faster code. Proofbound should reliably surface relevant lessons at lifecycle entrypoints while current structured facts still outrank memory. M3-M6 therefore need cache hit/miss proof, consumer rollout, reference-versus-optimized correctness, and million-record parity reporting with latency split by path.

## Solution Tradeoffs
The chosen approach is a shared optimized MemoryFreshnessPack path plus a derived pack cache, rather than separate per-consumer shortcuts. This keeps authority=non_authoritative and gateEvidence=false in one place, reduces consumer drift, and lets the M5/M6 matrix compare reference, indexed, and cached behavior consistently.

## Conversational Texture
The user is pushing Proofbound to become more reliable through consumed experience, but also keeps correcting overclaims. The story should make development feel faster and more lesson-aware while being precise that M3-M6 do not make memory a proof source and do not permit a 1-2s million-record claim unless M6 produces that report.

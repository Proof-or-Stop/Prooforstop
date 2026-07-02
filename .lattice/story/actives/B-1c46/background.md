## Trigger Event
2026-07-02 after B-6048, the user asked whether the 1,000,000-record runtime memory query was actually fast. Fresh measurement showed reference full scan 46.325s, indexed cold 12.427s, and indexed warm/cache 3.270s, so the 1-2s hot-path target remains unmet.

## Key Insights
B-6048 completed correctness parity and introduced runtime index/cache, but code review of matchingIds showed query matching still scans Object.entries(tokenMap) for fuzzy/includes matching. The next work must prove the bottleneck and optimize the indexed path without changing surfaced memory semantics.

## Solution Tradeoffs
The safe route is not a single blind rewrite. We need M0 profiling, M1 golden parity, exact-token fast path, bounded fuzzy auxiliary indexing, durable cache/prebuilt index lifecycle, and a performance gate. The tradeoff is more implementation steps, but it prevents a fake speed win that silently loses candidate/supersession/stale behavior.

## Conversational Texture
The user explicitly challenged whether M3-M6 was truly done and then asked for an optimization path. The intended outcome is concrete: make Proofbound faster and smarter at runtime memory consumption while preserving the rule that memory is advisory only, never gate evidence or proof of DONE.

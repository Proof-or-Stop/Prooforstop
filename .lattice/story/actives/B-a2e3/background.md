## Trigger Event
Baseline A (analysis dated 2026-06-18, lattice-Paper/baseline_A_results.json) measured an 8% referential drift: 8% of file-anchored historical findings point to a file that no longer exists at git HEAD. This proves accumulated experience can go stale and motivates a re-runnable validity instrument before any 'experience getting richer' claim is made.

## Key Insights
Finding-signals (core/finding-signals.ts) are derived by aggregating historical findings, but the derived FindingSignal only keeps coarse fileKinds, not the concrete anchor file paths, so staleness is currently unobservable. Recording anchor files lets a pure leaf classify each signal valid (>=1 anchor present at HEAD) or stale (all anchors gone), which yields a valid-rate / drift-rate read-out comparable to Baseline A's 0.92 finding-level number.

## Solution Tradeoffs
This story does existence-based referential re-validation only (file still present at HEAD), which is fully computable from existing data and read-only. The stronger blob-equality 'unchanged since the finding was confirmed' tier is intentionally deferred because it needs forward capture of the confirmation HEAD; folding it in here would touch the finding write path and a gate-adjacent surface. Keeping the metric read-only avoids any determinism or gate risk.

## Conversational Texture
The user explicitly chose the conservative step first after seeing Baseline A's flat-to-negative learning curve, understanding that this story is hygiene plus an instrument, not proof that development gets smarter. The forward A/B proof (real signatureTag capture, learning_scan, hint-on/off) is a separate later step that needs accumulating data.

## Trigger Event
On 2026-06-20 the user reported that Claude Code read an older backfill/plan document and suggested redoing work that current facts showed was already complete. The verified case references B-17a9 and commit 2750aadef, where signature_backfill had already persisted 656 real signatures into findings.

## Key Insights
The failure is not a Claude-only bug. It is a truth-source priority problem: plan-only documents can survive after implementation, while host handoff context may not automatically load DONE summaries, current data evidence, gap analysis, or dev-memory lessons. A host can therefore over-trust stale prose.

## Solution Tradeoffs
A pure documentation note is cheap but weak because future hosts may not read it. A hard gate everywhere could be noisy. The execution plan should combine machine-readable supersession metadata, a handoff preflight fact pack, dev-memory injection, and narrow stale-plan warnings before any host tells the user work is missing.

## Conversational Texture
The user wants any host to learn from project experience without being manually corrected. The desired behavior is practical: before asking the user to redo a task, the host should check current Lattice facts and say when an old document appears superseded instead of presenting outdated work as current backlog.

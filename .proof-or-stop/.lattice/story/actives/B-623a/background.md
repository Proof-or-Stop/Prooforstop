## Trigger Event
On 2026-07-12, after B-70e9 (DONE, v0.3.184) shipped the read-only `lattice usage_sweep` command, a manual sweep attributed a month-old Codex Desktop thread (rollout 019e40d0 under ~/.codex/sessions/2026/05/19/) with 1.76B cumulative input tokens across 13,648 turns, its per-turn prompt having grown from 47k to 247k tokens, plus 9 concurrently-open proofbound desktop threads. The user requested push-based detection because the pull-based sweep only catches such threads when someone remembers to run it.

## Key Insights
Interactive desktop threads re-send their entire accumulated context every turn: a document read once gets re-paid on every subsequent turn (the 019e40d0 thread re-paid one execution-plan doc 1251 times). Lattice cannot terminate or modify sessions it did not launch - desktop sessions are report-only per the B-70e9 non-goals - so early, loud, automatic detection is the only available lever. `lattice doctor` is the natural push surface because operators already run it habitually, and a cron-driven `usage_sweep --alert` non-zero exit covers unattended notification.

## Solution Tradeoffs
Reuse the existing core/usage-sweep.ts scanners (stat + stream-read, zero writes) rather than building a new monitor daemon: a daemon would need lifecycle management and violates the CLI-first shape, while a doctor check is one bounded scan per invocation. Thresholds (transcript file size, cumulative input tokens, session age with recent activity) are env-tunable with conservative defaults (100MB / 100M tokens / 7 days) instead of config-file plumbing, keeping the change advisory-only with no gate wiring and no new config schema. The doctor scan is bounded to recently-active files so it stays fast.

## Conversational Texture
The user cares that a runaway thread gets named EARLY and LOUDLY - the warning must name the concrete session file, its cwd, and cumulative tokens so the operator can go close that specific desktop thread. Advisory-only is an explicit boundary: no gate, gateEvidence=false, no exit-code change for plain doctor runs; only the opt-in --alert mode exits non-zero so existing automation is not broken.

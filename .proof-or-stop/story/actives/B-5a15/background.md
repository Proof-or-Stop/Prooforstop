## Trigger Event
On 2026-08-20 the operator asked for a Story that implements U-03 from cross-story-agent-session-performance-root-causes-and-prioritized-optimization-plan.md. Supporting samples are B-74af (93-command PASS then evidence/Git/metadata failure rerun), B-137a (58 intents mapping to about 10 unique commands, 300s down to 77-100s after dedupe), and B-9812 (specialized certification families rerun; merge should stale only causally affected nodes).

## Key Insights
U-03 is a time-saving P0 ranked after U-01 and U-02, expected 0.5-2 hours on verification-heavy stories. The mechanism is missing layering: same command is re-run per intent, unrelated freshness uses a coarse hash, and a commit failure after PASS re-executes the suite. Section 11 splits this into U-03a (unique execution, CAS receipt, canonical import retry) then U-03b (dependency domains, shadow compare, then precise CertificationWindow invalidation). Correctness invariants in section 12.1 still apply: old pass must not enter a gate after real material change, receipts cannot be rewritten to a new hash, and DONE-required whole-tree drift stays strict.

## Solution Tradeoffs
Ship U-03 as one Story with U-03a checklist items before U-03b, rather than two Stories, because the operator asked for the U-03 item and the P0-3 section already treats DAG plus transaction as one mechanism. Do not fold U-01 or U-09 into this Story; those own review epochs and later scoped re-review. Prefer dual-identity receipts (execution key plus per-intent selector check) over sharing one fuzzy PASS. Prefer retrying only the canonical import/commit transaction over re-running the command. Do not silently rebind or rewrite stored hashes when a merge is unrelated.

## Conversational Texture
The operator wants fewer wasted full-suite reruns when a command already passed or when an unrelated file moved, without weakening proof. Success is observable: command executions equal unique execution keys, a Git import failure does not re-run the command, and an unrelated merge does not rerun specialized commands, while a real related material change still invalidates the affected DAG nodes at 100% with zero false-fresh.

## Trigger Event
On 2026-08-16, B-d0b8 recovery was blocked by a foreign owner lease whose heartbeat was two hours old even though the owner cwd matched the current worktree. The user explicitly asked the system to finish without repeatedly requesting confirmation.

## Key Insights
Explicit stale takeover already exists from B-c55d, so the missing capability is not another flag. The safe automatic case is much narrower: stale lease, same canonical worktree, same host, and a mechanically dead recorded owner PID. Active, remote, unknown, malformed, or PID-alive owners must remain fail-closed.

## Solution Tradeoffs
Place the decision in the unified enforceStoryOwnerLeaseGate before foreign-owner rejection, reuse the existing audited takeover write path, and add a distinct automatic reason to the audit event. Prefer false negatives when PID identity is ambiguous; do not silently transfer based on age or cwd alone.

## Conversational Texture
The user wants Proof-or-Stop to resolve routine same-worktree context switches instead of stopping for confirmation, but does not want broad silent ownership seizure. The visible outcome must distinguish automatic eligibility from cases that still require explicit takeover.

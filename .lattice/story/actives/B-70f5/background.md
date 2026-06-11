## Trigger Event
On 2026-06-11, two Claude CLI host reviews and one Codex CLI host review audited the root Markdown migration documentation after B-0b9b and found two concrete consistency problems that should be corrected before the cleanup guidance is used.

## Key Insights
The docs are broadly executable and aligned with host-neutral Lattice principles, but execution guidance loses trust when inventory counts disagree with actual files or when one table narrows a migration target that the execution solution correctly treats as split scope.

## Solution Tradeoffs
Keep this as a minimal documentation correctness fix: update the stale NAV count and align the lifecycle-memory migration target with the already documented split. Avoid rewriting prose, expanding scope, or introducing new policy claims.

## Conversational Texture
The user asked for multi-host scrutiny with a strong constraint against arbitrary optimization. The right response is therefore a small, auditable correction that preserves the current design and only repairs contradictions exposed by the reviews.

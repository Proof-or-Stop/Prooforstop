## Trigger Event
On 2026-06-16, while driving B-9177 through REVIEW (rounds 1->2->3), it was confirmed that each finding-fix commit changes the source tree and stales that round's review-run bindings (content-aware materialHash in core/evidence-freshness.ts), forcing a fresh REVIEW round. The user asked whether this can deadlock; analysis showed it cannot structurally, but an operator who keeps fixing minor findings instead of dismissing them can livelock, with no mechanical signal.

## Key Insights
All inputs already exist: the REVIEW round count is derived from story events (core/guard-utils.ts, core/machine.ts; the DONE summary 'REVIEW: entered N times' uses it), and findings carry reviewRound while core/review-escalation.ts already groups them by round. Staleness is content-aware: metadata-only commits do not re-round, only source changes do. So the convergence state is fully observable without new persistence.

## Solution Tradeoffs
Option C (chosen): a SOFT advisory-only convergence-stall detector that warns and suggests escalation when rounds keep cycling without converging; minimal, additive, zero blocking risk. Option A (raw round ceiling) is simpler but false-alarms on a healthy decreasing series. Option B (targeted/partial re-review) actually reduces per-round cost but is a larger change with under-review risk and is deferred to a separate story. Choose C; record A as inferior and B as deferred.

## Conversational Texture
The user reviewed a written execution plan, selected option C, and added a standing directive: no Chinese in any documents or code, including the advisory string (everything English-only). The detector must never block a transition; thresholds are module constants with no CLI or config.

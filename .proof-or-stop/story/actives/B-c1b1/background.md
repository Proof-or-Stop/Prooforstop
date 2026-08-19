## Trigger Event
B-3523 on 2026-06-23 exposed a repeated DONE closure loop: final evidence was refreshed, then deterministic CLI-owned DONE work changed HEAD or material hash, making the just-recorded evidence stale again.

## Key Insights
The stale detector is doing its safety job and must not be weakened. The correctness issue is the ordering of deterministic DONE sync relative to final evidence binding, which makes the CLI invalidate its own proof.

## Solution Tradeoffs
Prefer moving deterministic version, dist, package, and main sync work before final evidence generation. If a refresh is needed, it must be narrowly bounded to CLI-owned deterministic sync and never mask unrelated source changes.

## Conversational Texture
The user observed a small rename story taking far longer than expected and asked for the real cause. The answer was that this ordering bug created avoidable manual stale refresh cycles during DONE closure.

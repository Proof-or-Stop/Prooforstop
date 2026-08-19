## Trigger Event
On 2026-08-13 the user confirmed that the failure occurs when one provider host launches another provider through CLI mode, such as Claude invoking Codex or Codex invoking Claude. A ten-minute caller timeout can detach or terminate observation even though the provider process may still be doing useful work. The related B-1be5 proposal only considered heuristic ledger provenance and does not solve this execution failure.

## Key Insights
The framework must supervise the provider process at the actual execution boundary. A worker heartbeat and provider progress are different facts; output silence is diagnostic rather than terminal. Every wait must be bounded, every run must have a finite absolute deadline, and a durable next-touch reconciler must be able to materialize terminal truth even when the original worker becomes wedged. Formal reviewer evidence must bind to the exact managed receipt instead of provider plus story plus time-window guesses.

## Solution Tradeoffs
A single deep ManagedHostRun module adds durable runtime artifacts, worker continuation and reconciliation complexity, but removes duplicated foreground/background supervision and makes cancellation, cleanup and evidence semantics consistent. M1 execution safety and M2 gate evidence ship together so the framework does not claim enforcement while raw CLI reviews can still satisfy formal gates. Legacy configured provider timeout ceilings remain separate and unchanged.

## Conversational Texture
The user repeatedly emphasized that a ten-minute boundary must not cause an automatic restart, that silent but still-running agents should continue to be monitored, and that the target is host-independent cross-provider CLI execution rather than native subagent APIs. After iterative Claude Opus review and empirical Codex/POSIX probes, the user approved the consolidated design and explicitly asked to start a Story and implement it.

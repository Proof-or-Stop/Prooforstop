## Trigger Event
On 2026-08-12, the current Prooforstop Claude session was inspected after the user recalled that long-running agents continue in the background beyond ten minutes. The transcript contains reviewer completions after roughly 15, 31, and 47 minutes and foreground completions after 75 to 98 minutes.

## Key Insights
Elapsed time without a final result does not establish that a host-native agent is dead. Background and foreground tasks can remain healthy far past ten minutes, while the existing generated guidance contains no authoritative host-status query before suggesting restart. Restarting by wall clock can duplicate work and concurrent evidence writes.

## Solution Tradeoffs
Prefer status-first monitoring over a larger scheduler implementation. The canonical guidance must tell Codex and Claude hosts to inspect their native task state, continue monitoring running or background work, preserve uncertainty without duplication, and restart only after a conclusive terminal state. This is enforceable across generated prompt entrypoints with source smokes.

## Conversational Texture
The user explicitly rejected elapsed-time-only restarts and asked for continuous progress monitoring unless the framework knows deterministically that the task is stuck. The desired experience is patient and observable: report that work remains alive, keep following it, and avoid spawning a duplicate merely because ten minutes passed.

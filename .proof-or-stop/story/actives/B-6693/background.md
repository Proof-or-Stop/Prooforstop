## Trigger Event

On 2026-08-14, B-d0b8 and the focused B-6f23 repair were blocked while B-a7c5 and B-9ff1 ran independent lattice validate processes in separate worktrees. System load exceeded 40, and unrelated canonical members hit unchanged 120, 180, and 300 second limits despite passing when isolated.

## Key Insights

The existing validation execution lock is canonical across worktrees but keyed by story ID. It protects one story from concurrent evidence writers, yet it intentionally allows different stories to validate simultaneously. Wall-clock proof gates share machine CPU, process, git, and filesystem capacity, so story-level ownership is not sufficient for validation capacity.

## Solution Tradeoffs

A workspace capacity lease serializes official heavyweight validation entrypoints while each validation may still use bounded internal parallelism. This increases queueing but prevents both runs from slowing each other into false timeouts. The lease must be separate from per-story evidence locking, use a fixed global-before-story lock order, heartbeat and stale recovery, and must not change test commands or budgets.

## Conversational Texture

The user explicitly asked to solve the stuck TEST problem without asking for permission and challenged whether more parallel TEST would fix the gate ceiling. The evidence showed the opposite at the workspace layer: internal bounded parallelism is useful, but two whole validation suites in parallel destabilize proof. The product-visible outcome is a clear wait/holder message instead of two doomed runs.

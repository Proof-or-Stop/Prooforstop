# Scheduler resource coordination

`runScheduled` reserves canonical resource claims before invoking an executor.
Calls using the same module instance share these reservations. Two shared claims
may overlap; an exclusive claim excludes every other claim for that canonical key.
Unrelated keys retain parallel execution. Results, job limits and cancellation
remain local to each invocation.

Reservations are released after execution and result validation, including
synchronous throws and rejected promises. Waiters receive availability signals,
not another invocation's result. A cancelled waiter does not acquire a claim or
cancel its owner. External cancellation is checked while waiting using the
registered runtime cadence.

This boundary is process-local. It does not coordinate worker threads, separate
module instances or processes, impose a machine CPU budget, or provide FIFO
fairness. Callers must not hold a resource while awaiting a nested scheduler that
requests the same exclusive resource. Cross-process workspace validation leases
remain a separate mechanism; machine-wide heavy-task coordination is still an
outstanding U-08 requirement.

`node scripts/verify-cross-scheduler-resources.mjs` verifies conflicting batches,
compatible readers, unrelated resources, exception cleanup and cancellation.
The full-suite runner smoke additionally checks canonical aliases, real port
conflicts, process cleanup and the existing per-invocation failure policy.

Managed reviewers with a sealed detached scratch use a private `provider-temp`
directory beside that worktree. The worker overrides `TMPDIR`, `TMP` and `TEMP`
for the provider, including caller-supplied aliases, without changing the parent
process environment. Existing marker-bound terminal cleanup removes that directory
with the owned scratch parent. Source integrity remains checked before and after
execution; this is not an operating-system read-only source mount or global
machine resource coordination.

`node scripts/verify-reviewer-temp-isolation.mjs` launches two real Node provider
processes, checks their distinct source and temporary roots, and verifies terminal
cleanup of the files they actually created.

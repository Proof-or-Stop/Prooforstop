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

Declared fixed ports now use a shared queue under the OS user's runtime directory,
independent of repository and TMPDIR. Actual validation command capture and
full-suite members acquire this queue; outer workspace capacity remains separate.
Exclusive ports receive real bind/close probes for both address families and
concrete local interface addresses before a child starts. macOS permits a wildcard
listener alongside a concrete-address listener, so wildcard probes alone are insufficient.
An unavailable address family fails closed; IPv4-only operation is not yet a declared mode. This
rejects a listener left by a dead owner too, but cannot prevent an unrelated
application from claiming the port after preflight. Shared claims can use an
existing service. Queue waits consume the command deadline and observe cancellation.

Declare the port on its actual executing member. The precert aggregate delegates
to those members and does not hold their ports while waiting. A conflicting
ancestor-owned ticket is refused instead of allowing a parent/child wait cycle.
The SIGINT runner fixture preserves the complete canonical inventory and starts
a port-free synthetic hanger first; cancellation prevents pending members from launching. This layer coordinates fixed ports for the same OS user;
Undeclared cross-repository resources remain a separate gap; declared heavy admission is described below.

Heavy full-suite members additionally declare `machine-cpu:heavy` and
`machine-process:fanout`. Both are exclusive, fixed policy identities shared by
all repositories for the same OS user. Different keys or shared access are refused
before a child starts. The existing repository-local heavy exclusion is retained.
Actual validation commands can declare the same claims; both execution paths use
one machine queue with the fixed-port claims, avoiding separate acquisition order.

This is conservative admission of one declared heavy member at a time, not an OS
CPU quota or descendant process-count limit. It does not classify undeclared tasks
or coordinate other OS users. Waiting consumes the caller's deadline; cancellation
releases its ticket, and a conflicting ancestor is refused before child launch.

`node scripts/verify-machine-heavy-coordination.mjs` executes the actual heavy
member policy across two repositories and then runs independent CPU/process
boundary cases: mixed executors, queued cancellation/deadlines, ancestor conflict,
invalid claims and successful reacquisition. It does not substitute socket tests
for CPU/process admission evidence.

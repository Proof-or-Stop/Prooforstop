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
remain a separate mechanism; machine admission at the actual command executors
is described below.

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
Declared heavy admission and undeclared-resource handling are described below.

Heavy full-suite members additionally declare `machine-cpu:heavy` and
`machine-process:fanout`. Both are exclusive, fixed policy identities shared by
all repositories for the same OS user. Different keys or shared access are refused
before a child starts. The existing repository-local heavy exclusion is retained.
Actual validation commands can declare the same claims; both execution paths use
one machine queue with the fixed-port claims, avoiding separate acquisition order.

This is conservative admission of one declared heavy member at a time, not an OS
CPU quota or descendant process-count limit. It does not coordinate other OS
users. Waiting consumes the caller's deadline; cancellation
releases its ticket, and a conflicting ancestor is refused before child launch.

`node scripts/verify-machine-heavy-coordination.mjs` executes the actual heavy
member policy across two repositories and then runs independent CPU/process
boundary cases: mixed executors, queued cancellation/deadlines, ancestor conflict,
invalid claims and successful reacquisition. It does not substitute socket tests
for CPU/process admission evidence.

Every classified executor now participates in a shared machine admission barrier,
including commands with only workspace-local claims. Missing validation resources
or an empty validation resource list acquire an exclusive unknown-resource lease.
Unknown commands therefore wait for classified work in other repositories, and
block later classified or unknown commands until release. Explicit full-suite
`resources: []` remains a classified isolated member and can run concurrently;
the full-suite inventory separately rejects unclassified members.

Unknown-resource waits observe cancellation and deadlines before launching a
child. Within one asynchronous owner context, a nested call can reuse a held
superset but cannot expand a classified declaration to unknown. A conflicting
ticket owned by an ancestor process fails closed; parent orchestration must not
hold a conflicting lease while awaiting child admission. Environment variables
do not grant lease inheritance. This is same-user cooperative admission, not an
operating-system sandbox or proof of every command's resource classification.

`node scripts/verify-machine-unknown-resources.mjs` runs the original cross-repo
overlap regression, both queue directions, unknown/unknown serialization,
cancellation and deadline zero-launch cases, compatible classified work,
reacquisition, and same-process versus cross-process nesting boundaries.

Validation fixtures that instantiate their own scheduler run through the explicit
entry list in `scripts/run-validation-fixture-suite.mjs`. The causal-preflight
smoke has the same isolation in its Node-test wrapper. Each wrapper creates a
private test registry home and a preload containing that concrete path. Only its
test subtree receives the preload through `NODE_OPTIONS`; all descendants share
that fixture pool. Production admission has no environment override. The outer
executor continues to hold its real machine lease for the entire test suite.

This fixture seam changes `os.userInfo().homedir` only. It also isolates the
provider admission registry, but leaves `HOME`, `os.homedir()`, actual sockets,
CPU and processes unchanged. It is not credential isolation or evidence about
the real OS-user provider pool. Real machine admission witnesses do not use the
fixture wrapper. Existing unknown-resource, discovery and fallback assertions
remain unchanged. Failed fixtures retain their registry; even successful fixtures
refuse cleanup while validation tickets or provider slots remain.

Admission time counts against the command deadline. `timeoutMs` in command
results and progress retains the budget established at invocation (including a
caller deadline cap); `effectiveTimeoutMs` records the remaining child budget.
Cancellation or an ordinary deadline reached while queued returns an infra-failure
result with code 124 and zero effective child budget, without starting a process.
A caller-supplied deadline error remains an exception. Invalid claims, ancestor
conflicts and unavailable ports still fail closed before launch.

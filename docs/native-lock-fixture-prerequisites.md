# Native lock fixture prerequisites

The native validation-lock cases must reach the intended lock with authentic
prerequisites. A rejection from a missing signature, unrelated acceptance item,
missing dispatch, or sealed review inventory does not prove lock exclusion.

`native-lock-fixture.ts` allocates a fresh disposable repository. It seeds only
initial subject data, with no acceptance obligations unrelated to these lock
cases. It then uses the real CLI to open review inventory, dispatch each required
lane, start its run, submit its one-shot broker-bound review, obtain the critic
receipt, finalize inventory, execute cheap validation, obtain certification
admission, and, when required, publish routine validation evidence. Queue tests
start in REVIEW with an unconsumed admission, so preparation does not spend the
one permitted heavy execution before the measured operation. TEST subjects use the official
phase transition. The helper never writes a synthetic admission or PASS record.

The reviewer lock case opens a new official writable inventory after routine
preparation. A focused validation holds the same Story lock while preserving
routine evidence. The retry must record its exact signed reviewer run and preserve
all historical passes, with exactly one new record for this signed run. Delivery prepares trusted dispatch before acquiring the lock and
passes the real broker descriptor into the native CLI writer. Its focused lock
probe preserves the prior routine PASS rather than spending admission twice. Both writers must
refuse with the expected busy error and preserve guarded files and HEAD.

DONE-required and routine validation must queue in both directions and publish
real evidence after release. The unadmitted negative has no unrelated checklist
failure, and asserts the exact pre_cert_window_required refusal, zero command starts, and no execution
record. The derived-verdict capacity negative first proves that its real routine
PASS is admissible through the same production checker used by the consumer.

Run `node scripts/verify-native-lock-prerequisites.mjs`. It builds independent
local core and bootstrap utility outputs, then runs the bounded native cases.
Builds, each prerequisite command/reviewer interaction, each case, and the full
native execution emit elapsed milliseconds. Compare successful runs with the
same host load; the old early failures were not equivalent completed workloads.

Native startup observation allows 12 seconds for real pre-execution checks; the
fixture probe now has a 90-second hold bound, a 100-second command deadline,
and an explicit hold-expiry diagnostic, covering the native writer's 60-second
budget. These are disposable-fixture settings; production policy is unchanged. Child wait timers are cancelled
when the child finishes, so a completed wait cannot issue a late kill.

Synthetic unit models remain appropriate for isolated logic tests. They must not
stand in for native signatures, broker descriptors or certification admission in
these CLI integration cases. A boundary change should rerun this contract before
broader suites so fixture preparation failures are diagnosed at their source.

The fixture CLI writers assert ownership of the newly allocated native root and
pin both CLI/project-root routing after sanitizing ambient authority. Focused
writer probes preserve preparation-time routine PASS; actual new PASS publication
is asserted by the native dual-order queue cases. The original fifteen-group capacity contract retains its strong admissible
derived-verdict block-then-publication check and original selector. A separate
hermetic selector checks missing-evidence refusal ordering; it does not replace
or weaken the legacy proof. The admissible case uses local generated fixture
brokers, not an external provider credential or LLM invocation. Contender queue observation is bounded below the
probe hold deadline. Child cleanup has a two-second stream-close grace after
SIGKILL. The contract driver resolves its repository from its own module URL.

Baseline boundary: on local main `3fb8385a7d` (0.3.344), the existing complete
`--workspace-capacity-contract-only` command already fails in
`assertWorkspaceWaitAndRun` because its done CHK-001 has no intent or evidence.
The Lab reproduces that same early failure and does not claim all fifteen groups
pass. The focused `--derived-refusal-contract-only` selector exercises the changed
hermetic group directly; the Lab driver requires that plus all six native cases.
The original fifteen-group selector retains admissible block-then-publication
semantics. Its legacy early failure remains a documented main baseline; this Lab
does not weaken that assertion to obtain a passing historical receipt.

The driver has no conflicting per-step watchdog; the official Lab total budget
remains authoritative. Its asynchronous process-group forwarding allows the
smoke's SIGTERM/SIGINT cleanup to stop owned children and remove registered
fixture roots before the driver's bounded escalation. A self-signalled child
regression proves registered-root cleanup. Primary CLI errors remain visible
even if lease cleanup also fails. Existing synthetic-window helpers still have
callers in done-required-validation-smoke and validation-protocol-smoke, so this
Lab does not remove those unrelated exports.

Focused validation currently returns command results but does not issue a full
routine evidence publication or a mandatory per-command receipt. Writer cases
therefore assert the structured focused status, executed disposition, exactly
one command, exact probe argv, successful exit/output and measured duration,
alongside the independent entry marker and preserved routine evidence. Sealed
certification inventory and an open reviewer-write inventory cannot authorize
the same new full certification run; the focused shared-lock probe tests the
writer boundary without manufacturing a second admission. The native dual-order
queue cases retain actual signed routine and DONE-required publication checks.

The cleanup contract also waits past a completed child wait deadline and asserts
that its kill method was never called. Capacity-holder cleanup cannot prevent
cwd restoration or fixture removal when the holder promise rejects.


Coverage follow-up: the official draft
[native-lock-regression-coverage](story/drafts/native-lock-regression-coverage/background.md)
is owned by framework validation maintenance. The standalone driver is currently
operator-invoked, not registered as its own ordinary validation entry. The new cleanup and derived-refusal helpers are also invoked by the default smoke path after the unchanged fifteen-group early return. That broader path retains its documented pre-existing baseline blocker. The focused writer cases
prove exclusion and preservation of prior routine PASS, not new full-validation
PASS publication overlapping that writer. The dual-order queue cases prove new
signed publication, and assertPostCommandPersistenceHoldsLock covers the separate
post-command lock boundary. The draft owns a legal combined full-writer witness
and automatic suite registration; neither is claimed completed by this Lab.

Native capacity holders use explicit acquisition deadlines and race readiness
against holder failure. Both queue directions release their probes and wait for
owned children before removing roots, including when an earlier assertion fails.

The timeout classifier retains an out-of-band deadline flag so a prompt child
close cannot erase the timeout result. A held real child pins that diagnostic.
Native fixture roots are deregistered on release, including a recreated-path
negative. Ambient-root errors are accumulated with case failures. The refusal
ordering control measures the same unheld handler first, then requires the exact
derived-verdict command to own a persisted waiting ticket while its promise is
pending. It has no host-speed acceptance threshold or observation sleep. Missing
queue evidence is a nonzero PROOF_UNAVAILABLE diagnostic; only release followed
by the expected ordinary refusal completes the control, and waiter timeout is
not an acceptable refusal.

See [CLI follow-up provenance](native-lock-lab-verification.md) for official
draft creation and discovery evidence against the current handler.

Spawned-child results expose a mandatory `timedOut` boolean. Refusal assertions
require an ordinary nonzero exit and reject deadlines, signals and spawn errors
before matching diagnostics. A real child prints both expected refusal markers
and then hangs; its deadline retains that output but cannot satisfy the shared
refusal assertion. Controls also reject signal/null and successful exits, while
an ordinary code-1 refusal remains admissible.

## Machine-queue interference isolation

The native fixture driver creates one private OS-user runtime namespace for its
fixture processes and actual CLI descendants. All these children share that
namespace, so their machine-capacity semantics remain active. The real Lab
process and independent Claude audit keep the actual OS-user namespace. There is
no production environment switch, queue bypass, timeout increase or credential
reuse. These bounded fixtures use disposable paths and no fixed external ports;
they do not claim to validate contention with unrelated real machine workloads.

The controlled regression holds an exclusive machine queue in one temporary
namespace. A same-namespace command must refuse at its 500 ms queue deadline;
an independently isolated fixture must enter while that holder remains active.
Before the repair the second command also timed out. The driver runs this control
before the original cleanup, refusal and six native cases, and removes its owned
runtime after the children close. Abnormal host termination can retain the
private temporary runtime; it never authorizes deleting real-user queue state.

The actual lockFixtureCli actor environment and deliveryFixtureCli child
environment assert that sanitization preserved NODE_OPTIONS before spawning.
This mechanically checks the generated test bootstrap on the real CLI paths
exercised by the native cases, instead of inferring propagation from the small
machine-queue probe alone. The shared fixture sanitizer currently removes only
its enumerated ambient authority keys; these guards refuse a future accidental
bootstrap removal. Isolation cleanup reports secondary failures without replacing
the primary failure.

The default smoke counts completed assertion groups as they execute and reports
the actual count (currently 30). The 15-group focused selector stays byte-compatible.
The historical 26-group full selector documented in CLI and testing contracts is
still emitted on a clearly labelled legacy-selector line after complete success;
it is not the reported actual group count and no frozen Story pin is rewritten.

The machine-isolation control also invokes the actual compiled CLI through
lockFixtureCli's actor-environment construction. A test-only preload observes
the CLI descendant's PID, entry file and effective OS-user home. The control
requires a distinct child PID and the private runtime home while the unrelated
outer queue holder stays alive. This observation is diagnostic fixture data, not
a signed Story receipt. Its outer transport budget exceeds the helper's existing
60-second CLI bound by 10 seconds.

This namespace is enabled only by scripts/verify-native-lock-prerequisites.mjs.
The default/direct validate-execution-lock-smoke entry does not arm it: its native
cases can still wait on unrelated real-user machine holders. CHK-001 in the
CLI-managed native-lock-regression-coverage draft explicitly owns that residual
default-entry exposure alongside routine registration. This Lab does not claim
default-entry isolation or repository-wide GREEN.

The admissible derived-verdict case retains its consumer promise outside the try
block. Error cleanup releases the holder and waits for that consumer to settle
before restoring cwd and removing the fixture, preventing a resumed consumer from
using a deleted repository. A controlled failing-assertion witness exercises the
actual queued consumer and observes its completion state immediately before root
deletion.

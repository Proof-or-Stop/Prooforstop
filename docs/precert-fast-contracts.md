# Pre-cert adversarial fast contracts

Run `npm run precert:fast` after the normal build. `npm run precert:fast -- --list`
prints the contract inventory without running checks or claiming a pass. The
configuration includes this set once in `validate --story=… --focus=fast --json`.
That existing validation path owns signed cheap-check evidence. A standalone
fast-set result is diagnostic, writes no Story evidence, and cannot replace the
complete TEST or DONE-required command plan.

The stable suite ID is `precert-adversarial.v1`. Contract and assertion IDs come
from `scripts/precert-fast-contracts.mjs`; displayed assertion counts and elapsed
time are report fields, never immutable selectors. A contract revision is needed
when its promised behavior changes. Build/config/source changes still invalidate
the normal evidence identity; stable naming does not permit stale evidence reuse.

| Contract | Actual observation and negative control |
| --- | --- |
| selector-integrity | The shared production receipt validator rejects false/missing predicates and identity drift. A module-loader mutation removes its passed-predicate guard; the unchanged rejection witness must then fail. Display counts 25, 27, 83 and 85 retain the same selector. |
| real-port-collision | A real listener owns loopback port 43127; the second bind returns EADDRINUSE; closing the owner permits a new bind. Unsupported OS capability fails the invocation. |
| causal-launches-zero | The existing verifier causal-preflight regression exercises the real execution plan and child launch marker, including allowed launch and refused drift branches. |
| terminal-process-cleanup | Real owned directories are removed while foreign/missing markers survive. A worker is killed immediately after terminal publication; the real supervisor cleans its Git scratch registration. Disabling that cleanup leaves observable residue. |
| source-dist-launches-zero | Real npm test enters the real runner against an isolated miniature build. Source and dist mutations independently stop it before argument parsing and member launch. Restored bindings reach the argument parser again. |

Each package command is checked against its declared implementation before
launch. Exit zero alone is insufficient: the named member must return PASS and
exactly one full-line contract marker. Missing, duplicate, partial and echoed
markers, failure, interruption, timeout and unsupported capability cannot pass.
The runner uses an independent full-suite process state and its existing process
identity checks, group cleanup, and unique temporary roots. SIGINT/SIGTERM and the
180-second total invocation deadline cancel through that same owner. Each case
also has a smaller individual timeout. Cases run serially within this invocation;
resource claims alone do not coordinate separate standalone invocations. Global
coordination belongs to U-08.

The terminal-publication witness explicitly uses the real runner's non-isolated
test seam inside the outer runner's owned process group. Its custom worker and
provider inherit that group, so an outer cancellation cannot strand a detached
witness. The scratch-only runner omits native admission/attestation callbacks,
requires the real provider to exit 7, and cannot produce a reviewer pass. Native
admission and isolated provider identity are covered by their separate tests.
`scripts/verify-precert-process-containment.mjs` independently prolongs that
fixture provider, observes its real worker/PID and growing heartbeat, then checks
that a real runner timeout stops both processes without a success marker.

The fast set is registered only in configured validation, not again in the root
full-suite inventory. The existing causal member remains in DONE-required npm
test; those are separate validation stages, not duplicate members of this set.

The three-minute limit is a per-invocation guard, not a measured cohort P95.
Historical capture rate and cohort P95 remain null until a fixed historical
failure-class denominator and repeated controlled measurements exist. Passing
these five negative-control families does not establish the requested historical
95-percent first-round capture rate.

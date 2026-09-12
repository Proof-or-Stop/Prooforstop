# CLI runtime Lab candidate and integration boundary

This maintenance candidate belongs to `Lab-cli-runtime-sync-20260911`, based on
the main commit recorded in each native audit binding. The current task
requests repair in the existing Lab, RED/GREEN evidence and independent Claude
CLI audit. It does not request finish, a release commit, main integration or push.
The candidate remains an active, pre-finish Lab. Its implementation identity is
the Git commit and reviewed executable bindings, not a claim of a new release.

The existing [Lab maintenance contract](lab-maintenance.md#explicit-release-and-cleanup)
separates early `audit` from `finish --confirm`. Finish synchronizes main, prepares
the atomic version commit, rebuilds and checks the runtime, and audits that prepared
candidate before integration. Runtime changes and executable maintenance scripts
require a patch release at that stage. Root/runtime manifests, their lockfiles and
the CLI brand constant must advance together. An early audit cannot approve later
commits or substitute for that final prepared-candidate audit.

Version inputs are measured by verify-cli-audit-hardening.mjs for every candidate:
root package.json, packages/main/package.json, and the source PROOF_OR_STOP_CLI_VERSION
are reported separately and compared. Read those head-bound results and the native
audit base instead of treating a version literal in this living guide as current.
Retaining the synchronized baseline during development does not waive the mandatory release step.
Before any future integration, verify the atomic bump, both entry versions, fresh
GREEN and the exact prepared candidate's independent audit. Until then these
changes and measurements are Lab evidence, not released behavior or Story DONE.

Audit-driven follow-up also removes duplicate verifier execution, distinguishes
real runtime-version refusals from adapter faults in heartbeat diagnostics, and
preserves v1 prompt response fields for read-only consumers. The read-only prompt
still has no envelope and cannot mint review evidence. Unknown locks still grant
no write authority. These are bounded runtime/observation repairs, not proof of
global owner/reviewer adoption or whole-Story delivery acceleration.

Focused regressions give prerequisite builds 180 seconds and start a separate
240-second body budget only after successful setup; outer callers reserve 30
seconds for fixture IO. Setup timeout is reported as SETUP_BUILD_TIMEOUT, without
an assertion RED claim, and requires completing the prerequisite before retrying.
The budget regression intentionally exercises a delayed build and a nested
companion diagnostic suite; its outer 750-second bound covers 180-second setup,
controlled delay/timeout probes, a 30-second mutation child, the companion's
450-second envelope and fixture IO. The companion is not scheduled a second time
by the process contract. These are failure budgets, not measured speed gains.

The focused proof scripts retain bounded setup/body deadlines. Contract reports
label setup failure and deadline exhaustion PROOF_UNAVAILABLE and preserve the
child output; an assertion failure is PROOF_ASSERTION_FAILED. Both are non-PASS.
A loaded-machine timeout requires usable evidence on retry, not a product-defect
claim or a larger default timeout. The snapshot proof excludes permitted activity
telemetry while retaining managed assets and the independent complete Story snapshot.

# CLI runtime Lab candidate and integration boundary

This maintenance candidate belongs to `Lab-cli-runtime-sync-20260911`, based on
local main 0.3.336 (`e586983d70d24b65aa09ed41da994cd5b970ee1a`). The current task
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

The present manifests and CLI constant consistently remain 0.3.336. Retaining
that baseline during development does not waive the mandatory release step.
Before any future integration, verify the atomic bump, both entry versions, fresh
GREEN and the exact prepared candidate's independent audit. Until then these
changes and measurements are Lab evidence, not released behavior or Story DONE.

Audit-driven follow-up also removes duplicate verifier execution, distinguishes
real runtime-version refusals from adapter faults in heartbeat diagnostics, and
preserves v1 prompt response fields for read-only consumers. The read-only prompt
still has no envelope and cannot mint review evidence. Unknown locks still grant
no write authority. These are bounded runtime/observation repairs, not proof of
global owner/reviewer adoption or whole-Story delivery acceleration.

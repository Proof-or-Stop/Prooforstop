# Verification entrypoints and capability modules

This user-authorized Lab refactor retains existing command paths. Entrypoints
contain imports, usage comments and one CLI call. Every extracted source file
must remain at or below 2,000 physical lines. Internal modules do not add routine
validation registrations. Capability argv is an explicit partial execution, not
an authorization for the production dynamic planner to omit other obligations.

## Implemented first entrypoint (behavioral verification in progress)

`packages/main/src/tasks/verification-run-and-guard-smoke.ts` delegates to
`verification-run-and-guard/cli.ts`. Existing shard flags and their receipts are
retained. No arguments and `--all` preserve the existing full shard orchestration.
`--list-capabilities` returns the binding list; repeated `--capability=ID` flags
select a deduplicated set. Invalid arguments are rejected before any capability
runs. Partial execution cannot emit the full aggregate PASS selector.

| Module | Responsibility | Capability consumers |
|---|---|---|
| cli.ts | Argument validation, legacy compatibility, selection and results | all |
| support.ts | Shared fixture creation, hashing, evidence helpers and paths | all |
| foundation.ts | Pinned execution, refusal, stale evidence basics, hook controls | foundation, fanout |
| refresh.ts | Execution fan-out, dependency manifests and reuse boundaries | fanout, integrity |
| integrity.ts | Receipt/gate consistency and actual executable path identity | integrity, story-identity |
| causal.ts | Causal integration controls | story-identity |
| publication.ts | Metadata maintenance, producer ownership, identity and publication | story-identity |

| Parameter | Bound functions | Registration |
|---|---|---|
| --capability=foundation | partA, partA2Refusal, partB, partC | internal catalog only |
| --capability=fanout | partD, partE | internal catalog only |
| --capability=integrity | partF, partG, partH | internal catalog only |
| --capability=story-identity | partM, partN, partL, partK, partI, partJ (full names in CLI catalog) | internal catalog only |

The Lab migration proof compares all 47 original named function bodies with the
extracted implementations. The only permitted body substitution relocates the
self-spawn target to the unchanged public entrypoint. It also checks the thin
entrypoint, file limits, actual built capability listing and invalid argv refusal.
This is not proof of all four capabilities passing; retain that distinction.

## Remaining entrypoints

The following remain pending; estimates from planning are not completion facts:
process-fact contract; quorum-submit harness; identity-cutover verifier;
retired-authority vocabulary guard; validation-tier planner smoke; flow stability;
canonical new Story artifacts; Finding ledger runtime; managed review evidence;
host-run usage; prompt baseline; milestone status; validation build-artifact binding.

Source consumers, exact-source witnesses and static dependency models must be
updated before integration. The former monolithic file cannot be retained as a
second hidden implementation, reconstructed through eval, or replaced by a broad
exception. Existing registered commands and evidence selectors remain compatible.

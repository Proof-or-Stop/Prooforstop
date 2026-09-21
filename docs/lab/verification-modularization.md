# Verification modularization: implementation and evidence ledger

This is a local Lab checkpoint, not a completion or main integration claim.
The authorized scope is all 14 entries below. Ten entries have complete passing executions at their recorded commits (nine official scoped GREEN commands and two complete finding-ledger runs). Quorum is now split with seven bounded contracts passing; three entries remain unimplemented. The main synchronization invalidates current-head Lab GREEN, not the historical logs.

Original public files contain imports, usage comments and one invocation.
Every extracted file is limited to 2,000 physical lines. No hidden monolith,
source concatenation or eval is used to execute the extracted verification.
No routine validation command is added by internal module registration.

## Entrypoint comparison

| Original entry | Before lines | Current entry lines | Modules | Largest module | Evidence/status | In main |
|---|---:|---:|---:|---:|---|---|
| `scripts/verify-process-fact-contract.mjs` | 12201 | 7 | 16 | 1857 | RED -> official GREEN at 317918539b; full suite 181.37 s | No |
| `packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs` | 10748 | 7 | 27 | 1024 | RED recorded; 196 function bodies / 18 bindings preserved; 7 scoped contracts pass, heavy campaigns not rerun | No |
| `scripts/verify-proof-or-stop-identity-cutover.mjs` | 7794 | 7794 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts` | 6101 | 7 | 14 | 1577 | RED -> official GREEN at 51b6485211; full scan 67.33 s; 109 function bodies and driver order preserved | No |
| `packages/main/src/tasks/validation-tier-planner-smoke.ts` | 5792 | 7 | 9 | 1652 | RED -> official GREEN at d8b0ad6632; full suite 12.97 s, 142 checks | No |
| `packages/main/src/tasks/flow-stability-smoke.ts` | 5528 | 7 | 11 | 989 | RED -> official GREEN at 21be146f9c; full suite 137.62 s | No |
| `packages/main/tests/canonical-new-story-artifacts.test.mjs` | 5378 | 5378 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `packages/main/src/tasks/finding-ledger-runtime-smoke.ts` | 4646 | 6 | 9 | 1134 | Full suites passed at 3b51f4f666 / f5fda7d0e6 in 130.60 / 147.00 s; combined run failed in the separate process suite | No |
| `packages/main/src/tasks/managed-review-evidence-smoke.ts` | 4360 | 4360 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `packages/main/src/tasks/host-run-usage-smoke.ts` | 3867 | 6 | 15 | 587 | RED -> official GREEN at 9c8e8b848b; full suite 34.00 s, 91 checks | No |
| `scripts/verify-proof-or-stop-prompt-baseline.mjs` | 3675 | 7 | 6 | 1344 | RED -> official GREEN at 103d6e06fa; full suite 9.60 s | No |
| `packages/main/tests/milestone-status.test.mjs` | 3447 | 6 | 9 | 670 | RED -> official GREEN at a3777644bb; full suite 39.00 s | No |
| `scripts/verify-validation-build-artifact-binding.mjs` | 3329 | 7 | 7 | 1409 | RED -> official GREEN at 4dd8c68c69; full suite 134.18 s, 598 checks | No |
| `packages/main/src/tasks/verification-run-and-guard-smoke.ts` | 3138 | 7 | 7 | 776 | RED -> official GREEN at 378d1ccb3a; full suite 94.52 s | No |

## Parameters and registration

Except for the quorum harness, implemented candidates support no arguments / `--all` for the full suite,
`--list-capabilities` for a machine-readable binding catalog, and repeated
`--capability=ID` for deduplicated explicit selection. Unknown, empty and mixed
full/partial arguments fail before verification cases execute. Partial runs use
separate success selectors and cannot claim complete-suite evidence.

| Entry family | Capability IDs | Registration required |
|---|---|---|
| retired-authority | `vocabulary-controls`, `import-controls`, `dynamic-controls`, `loader-provenance`, `compatibility-controls`, `public-contract` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |
| host-run-usage | `proposal`, `prompt-supervision`, `usage-parsing`, `story-binding`, `streaming`, `ledger-failures`, `output-errors`, `admission`, `integrations`, `ledger-concurrency`, `process-supervision`, `evidence-mapping` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |
| validation-tier-planner | `command-identity`, `historical-pins`, `change-inputs`, `selection-widening`, `cli-integration`, `hash-completeness`, `acceptance-guards` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |
| validation-build-binding | `routine`, `done-required`, `shared-cache`, `executor`, `handler` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |
| process-fact-contract | `support`, `proofstory-closeout`, `reopen`, `prompt-contracts`, `review-inventory`, `registry-parser`, `command-contracts`, `review-verification`, `scope-runtime`, `story3` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |
| finding-ledger-runtime | `proposal-envelope`, `projection-receipt`, `base-authority`, `legacy-authority`, `transactions`, `readonly-mutations`, `runtime-evidence`, `rollback-concurrency`, `historical-migration`, `build-distribution`, `tamper-dependency` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |
| verification-run-and-guard | `foundation`, `fanout`, `integrity`, `story-identity` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |
| prompt-baseline | `registry`, `prompt-policy`, `baseline-drift`, `role-matrix`, `legacy-vocabulary`, `direct-story-policy`, `measurement` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |
| milestone-status | `reporting`, `planning`, `closeout`, `freshness`, `coverage`, `read-only`, `cli-behavior` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |
| flow-stability | `done-convergence`, `lifecycle`, `workspace`, `artifacts`, `review-evidence`, `review-routing`, `done-reporting`, `phase-effects`, `liveness`, `history-compatibility` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |

Production dynamic selection is **not implemented by these parameters**. It still
requires verified dependency closure, capability-level evidence identity and
mandatory-obligation composition. Do not infer exclusion authority from a partial
PASS. Existing full entrypoints stay registered.

## Module inventory

### `scripts/process-fact-contract`

| Module | Lines | Responsibility |
|---|---:|---|
| `catalog.mjs` | 92 | Explicit capability-to-check bindings |
| `cli.mjs` | 33 | Strict argument parsing and lazy orchestration |
| `command-contracts.mjs` | 1106 | CLI policy inventory |
| `complete.mjs` | 1857 | Retained full integration driver |
| `early.mjs` | 64 | Admission refusal before positive work |
| `prompt-contracts.mjs` | 678 | Prompt and adversarial controls |
| `proofstory-closeout.mjs` | 1620 | ProofStory and closeout boundaries |
| `registry-alignment.mjs` | 634 | Registry alignment |
| `registry-parser.mjs` | 655 | Registry and policy parsing |
| `reopen.mjs` | 568 | Reopen audit controls |
| `review-inventory.mjs` | 832 | Review inventory and refresh coverage |
| `review-verification.mjs` | 1005 | Review and verification receipt contracts |
| `scope-runtime.mjs` | 1209 | Scope and runtime admission |
| `source-analysis.mjs` | 575 | TypeScript and source analysis helpers |
| `story3.mjs` | 360 | Finding runtime evidence contract |
| `support.mjs` | 1224 | Shared constants and source readers |

### `packages/main/src/tasks/retired-authority`

| Module | Lines | Responsibility |
|---|---:|---|
| `binding-classification.ts` | 427 | Callable and dynamic binding classification |
| `cli.ts` | 22 | Strict capability routing |
| `compatibility-controls.ts` | 266 | Compatibility import and escape controls |
| `driver.ts` | 105 | Full scan order and complete result |
| `dynamic-bindings.ts` | 1577 | Dynamic execution binding graph |
| `dynamic-scan.ts` | 458 | Dynamic code and import scanners |
| `execution-controls.ts` | 657 | Dynamic execution negative controls |
| `file-scan.ts` | 100 | File traversal and text quarantine predicates |
| `loader-controls.ts` | 205 | Actual loader provenance mutation controls |
| `module-loaders.ts` | 1077 | Module resolution and approved loader provenance |
| `positive-controls.ts` | 205 | Vocabulary and import controls |
| `public-contract.ts` | 129 | Documentation, command catalog and generated help |
| `rule-data.ts` | 747 | Exact rules, path inventories and compatibility data |
| `type-analysis.ts` | 286 | Shared compiler program, caches and instrumentation |

### `packages/main/src/tasks/validation-tier-planner`

| Module | Lines | Responsibility |
|---|---:|---|
| `acceptance-guards.ts` | 547 | Actual case coverage, source registration and output bounds |
| `change-inputs.ts` | 718 | Story changes and input collection |
| `cli-integration.ts` | 821 | Public planning CLI and repository integration |
| `cli.ts` | 25 | Capability routing and explicit coverage prerequisites |
| `command-identity.ts` | 649 | Portable command identities and inventory pin |
| `hash-completeness.ts` | 255 | Incomplete hash snapshot refusal |
| `historical-pins.ts` | 336 | Historical evidence resolution |
| `selection-widening.ts` | 1652 | Tier selection and widening rules |
| `support.ts` | 942 | Shared fixtures, identities and final summaries |

### `packages/main/src/tasks/flow-stability`

| Module | Lines | Responsibility |
|---|---:|---|
| `artifacts.ts` | 904 | Declared artifacts, automatic commits and global-link repair |
| `cli.ts` | 120 | Legacy flags, capability routing and historical commit controls |
| `discovery-fixture.ts` | 24 | Inert source snapshots for the isolated acceptance-discovery fixture |
| `done-convergence.ts` | 626 | Single-pass DONE preparation and workspace ownership |
| `done-reporting.ts` | 407 | DONE report projection and shared oracle |
| `lifecycle.ts` | 631 | Lifecycle registry, phase tools and hints |
| `phase-effects.ts` | 274 | Phase gates and transition effects |
| `review-evidence.ts` | 989 | Signatures, freshness and review-run compatibility |
| `review-routing.ts` | 896 | Reviewer status, phase guidance and channel checks |
| `support.ts` | 427 | Shared Story, review and acceptance fixtures |
| `workspace.ts` | 301 | Dirty-worktree classification and gates |

### `packages/main/src/tasks/finding-ledger-runtime`

| Module | Lines | Responsibility |
|---|---:|---|
| `authority.ts` | 624 | Read-only, mutation, base and legacy authority checks |
| `boundaries.ts` | 290 | Concurrency, rollback, refusal, tamper and build locks |
| `cli.ts` | 79 | Legacy workers, diagnostics and capability orchestration |
| `distribution.ts` | 295 | Version, installation and RED/GREEN bindings |
| `process-mutation-proof.ts` | 52 | Exact mutation refusal reasons and positive controls |
| `projection.ts` | 845 | Projection integrity and historical migration |
| `runtime-evidence.ts` | 990 | Runtime receipt writers, consumers and recovery |
| `support.ts` | 452 | Ledger and CLI helpers, signed proposal checks |
| `transactions.ts` | 1134 | Concurrent appends, durability, recovery and lock fencing |

### `packages/main/src/tasks/host-run-usage`

| Module | Lines | Responsibility |
|---|---:|---|
| `admission.ts` | 373 | Working directory, budget and concurrency admission |
| `cli.ts` | 119 | Argument routing and retained case order |
| `evidence-mapping.ts` | 61 | Fixture isolation and pinned child evidence |
| `integrations.ts` | 587 | Repair, readiness probe and cross-host integration |
| `ledger-concurrency.ts` | 277 | Concurrent append and lock recovery |
| `ledger-failures.ts` | 285 | Failed writes and truthful usage classification |
| `output-errors.ts` | 502 | EPIPE and late stream containment |
| `process-supervision.ts` | 396 | Startup, timeout, abort and process identity |
| `prompt-supervision.ts` | 195 | Prompt descriptor and residual process supervision |
| `proposal.ts` | 272 | Final output and proposal admission |
| `story-binding.ts` | 155 | Story, review-run and phase binding |
| `streaming.ts` | 314 | Live output and retention limits |
| `summary.ts` | 74 | Exact aggregate and compatibility selectors |
| `support.ts` | 469 | Shared fixture, counters and provider samples |
| `usage-parsing.ts` | 500 | Provider usage and failure parsing |

### `scripts/prompt-baseline`

| Module | Lines | Responsibility |
|---|---:|---|
| `cli.mjs` | 235 | Full runner, legacy flags and capability routing |
| `collection.mjs` | 357 | Prompt collection, snapshots and measurement |
| `policy-data.mjs` | 1344 | Exact policy and negative-case data |
| `policy-probes.mjs` | 262 | Policy mutation probes |
| `scanners.mjs` | 751 | Direct-reference and vocabulary scanners |
| `verification.mjs` | 804 | Registry, matrix and baseline assertions |

### `packages/main/tests/milestone-status`

| Module | Lines | Responsibility |
|---|---:|---|
| `cli-behavior.mjs` | 622 | Public CLI formats, refusal and historical snapshot reads |
| `cli.mjs` | 60 | Case order and capability routing |
| `closeout.mjs` | 670 | Capture, DONE and worktree closeout |
| `coverage.mjs` | 558 | Intent, milestone and waiver coverage |
| `freshness.mjs` | 476 | Evidence freshness and bindings |
| `planning.mjs` | 168 | Explicit planning write boundaries |
| `read-only.mjs` | 106 | No-mutation status reads |
| `reporting.mjs` | 605 | Report shape, rendering and malformed inputs |
| `support.mjs` | 293 | Shared fixture and report helpers |

### `scripts/validation-build-binding`

| Module | Lines | Responsibility |
|---|---:|---|
| `cli.mjs` | 33 | Capability routing and prerequisite deduplication |
| `done-required.mjs` | 736 | DONE required evidence binding |
| `executor.mjs` | 1409 | Execution identity, freeze, drift and tampering |
| `handler.mjs` | 218 | Public verifier handler causal preflight |
| `routine.mjs` | 619 | Routine reuse and admissibility binding |
| `shared-cache.mjs` | 261 | Shared cache admission and artifact identity |
| `support.mjs` | 106 | Shared source loader, fixtures and counters |

### `packages/main/src/tasks/verification-run-and-guard`

| Module | Lines | Responsibility |
|---|---:|---|
| `causal.ts` | 140 | Causal integration |
| `cli.ts` | 160 | Argument selection and original shard orchestration |
| `foundation.ts` | 427 | Pinned execution, refusal and stale evidence basics |
| `integrity.ts` | 762 | Receipt integrity and executable identity |
| `publication.ts` | 517 | Producer ownership and publication bindings |
| `refresh.ts` | 776 | Fan-out, manifests and evidence reuse |
| `support.ts` | 349 | Fixture creation, evidence helpers and paths |

## Preservation and discovered assertion defect

- Execution/guard: 47 original named function bodies retained; the self-spawn path
  is explicitly relocated to the unchanged public entrypoint. Four original
  shards pass, retaining the 2-execution / 71-assertion-receipt summary.
- Prompt baseline: 96 original function bodies retained. Full original baseline,
  diagnostic probes, invalid argv refusal and scoped selection pass.
- Milestone status: 31 original isolated blocks retain their execution order.
  A pre-existing assertion expected empty stdout for unknown flags in JSON mode.
  The pre-split file and candidate both reproduced the same failure on the same
  dist. The current CLI (`cli/help-renderer.ts:printValidationFailure`) deliberately
  emits a JSON refusal. Two assertions now check its exact keys and values,
  refusal reason, unknown key and absence of Story/report fields. The exact
  two replacements are recorded in `milestone-assertion-repairs.json`; other
  original blocks and helpers are byte-compared in the Lab proof.
- Flow stability: original function bodies are compared with only explicit
  location-dependent path substitutions permitted. Full GREEN passed in 137.62 seconds. Two fixture prerequisites were repaired: declared source snapshots and the official implementation dispatch records required by the current REVIEW gate. The complete/missing-source negative control remains active.

## Outstanding integration work

Complete the remaining nine entries and the fifth candidate; reconcile moved exact-source witnesses,
source readers and static dependency edges; verify those contracts; then perform
the applicable Lab integration checks. Current scoped GREEN does not mean these
cross-cutting contracts or main integration are complete. No push has occurred.

### Retired vocabulary import baseline

The unmodified scanner from `4a6d510ac0` rejects the existing fixed-target URL
import at `evidence-plan-smoke.ts:418`. The modular scan reports the same failure.
The repair uses a literal import of the same test entry, with no rule exemptions.
`verify-evidence-plan-import.mjs` checks the repaired form and reinjects the old
expression to prove it is still rejected. The 109 original scanner function bodies
and complete driver statement order remain mechanically compared with the baseline.
Main and utils builds pass; the unrelated graph web build lacks its local d3 asset.

The same end-to-end evidence-plan run exposed a stale process-entry source reader
in `intent-fingerprint-reuse.test.mjs`. It now selects the unique diagnostic block
from the complete process module AST; missing/duplicate invocation and removed
fallback fingerprint mutations still run against that actual block. The complete
process source contract now expects the same literal import.

## Quorum harness decomposition

The original entry retains `--case=ID`; `--capability=ID` is an alias for the same
18-case catalog, available through `--list-capabilities`. Each invocation selects
one unique case because cases own different exact-HEAD authorizations and performance
leases. Repeated identical selections are deduplicated; mixed cases and implicit
full runs are refused. Existing `GREEN <case>` means exactly that case.
All 196 original function bodies, all 18 catalog bindings and the isolated driver
statement order are mechanically compared to `57205854d1`. Seven bounded contracts
(inventory plus six performance protocol controls) pass. Actual expensive performance
and isolated supervision campaigns have not been rerun; no complete campaign claim.
The explicit module paths are registered under `runtime:quorum_harness_capability_selection`;
this adds no routine command.

| Module | Lines | Responsibility |
|---|---:|---|
| `callback-inventory.mjs` | 603 | callback inventory |
| `catalog.mjs` | 51 | catalog |
| `cli.mjs` | 20 | cli |
| `containment.mjs` | 689 | containment |
| `coordinator-wiring.mjs` | 401 | coordinator wiring |
| `driver.mjs` | 60 | driver |
| `environment-closure.mjs` | 425 | environment closure |
| `exact-head-authorization.mjs` | 334 | exact head authorization |
| `exact-head-checkout.mjs` | 433 | exact head checkout |
| `exact-head-supervisor.mjs` | 444 | exact head supervisor |
| `fixture-source-closure.mjs` | 1024 | fixture source closure |
| `fixture-templates.mjs` | 629 | fixture templates |
| `mutation-controls.mjs` | 242 | mutation controls |
| `owned-files.mjs` | 349 | owned files |
| `partition.mjs` | 163 | partition |
| `performance-cases.mjs` | 609 | performance cases |
| `performance-context.mjs` | 452 | performance context |
| `performance-material.mjs` | 341 | performance material |
| `process-supervision.mjs` | 252 | process supervision |
| `resource-parallel.mjs` | 271 | resource parallel |
| `resource-traces.mjs` | 421 | resource traces |
| `selection-contracts.mjs` | 691 | selection contracts |
| `selection.mjs` | 57 | selection |
| `supervisor-controls.mjs` | 675 | supervisor controls |
| `support.mjs` | 416 | support |
| `tree-lease.mjs` | 517 | tree lease |
| `worker-coordination.mjs` | 562 | worker coordination |

## Main synchronization on 2026-09-21

Main `300ed4d08b` was merged before the next RED, as required by Lab tooling.
Its two validation-verdict regressions are retained alongside all Lab registrations:
248 -> 250 commands. This growth is from main, not from module registration.
Exact static-edge config pins are retained stale and fail closed pending the already
planned closure review; merging records is not renewed audit approval. Both branches'
new exception records and source-bound evidence are retained. No push or integration
of this Lab into main has occurred.

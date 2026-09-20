# Verification modularization: implementation and evidence ledger

This is a local Lab checkpoint, not a completion or main integration claim.
The authorized scope is all 14 entries below. Three have scoped official GREEN;
the fourth is a candidate. Remaining entries have not been modularized.

Original public files contain imports, usage comments and one invocation.
Every extracted file is limited to 2,000 physical lines. No hidden monolith,
source concatenation or eval is used to execute the extracted verification.
No routine validation command is added by internal module registration.

## Entrypoint comparison

| Original entry | Before lines | Current entry lines | Modules | Largest module | Evidence/status | In main |
|---|---:|---:|---:|---:|---|---|
| `scripts/verify-process-fact-contract.mjs` | 12201 | 12201 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs` | 10748 | 10748 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `scripts/verify-proof-or-stop-identity-cutover.mjs` | 7794 | 7794 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts` | 6101 | 6101 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `packages/main/src/tasks/validation-tier-planner-smoke.ts` | 5792 | 5792 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `packages/main/src/tasks/flow-stability-smoke.ts` | 5528 | 7 | 10 | 988 | RED recorded; candidate awaiting full GREEN | No |
| `packages/main/tests/canonical-new-story-artifacts.test.mjs` | 5378 | 5378 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `packages/main/src/tasks/finding-ledger-runtime-smoke.ts` | 4646 | 4646 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `packages/main/src/tasks/managed-review-evidence-smoke.ts` | 4360 | 4360 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `packages/main/src/tasks/host-run-usage-smoke.ts` | 3867 | 3867 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `scripts/verify-proof-or-stop-prompt-baseline.mjs` | 3675 | 7 | 6 | 1344 | RED -> official GREEN at 103d6e06fa; full suite 9.60 s | No |
| `packages/main/tests/milestone-status.test.mjs` | 3447 | 6 | 9 | 670 | RED -> official GREEN at a3777644bb; full suite 39.00 s | No |
| `scripts/verify-validation-build-artifact-binding.mjs` | 3329 | 3329 | pending | pending | Pending; no modularization RED/GREEN claim | No |
| `packages/main/src/tasks/verification-run-and-guard-smoke.ts` | 3138 | 7 | 7 | 770 | RED -> official GREEN at 378d1ccb3a; full suite 94.52 s | No |

## Parameters and registration

All implemented candidates support no arguments / `--all` for the full suite,
`--list-capabilities` for a machine-readable binding catalog, and repeated
`--capability=ID` for deduplicated explicit selection. Unknown, empty and mixed
full/partial arguments fail before verification cases execute. Partial runs use
separate success selectors and cannot claim complete-suite evidence.

| Entry family | Capability IDs | Registration required |
|---|---|---|
| verification-run-and-guard | `foundation`, `fanout`, `integrity`, `story-identity` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |
| prompt-baseline | `registry`, `prompt-policy`, `baseline-drift`, `role-matrix`, `legacy-vocabulary`, `direct-story-policy`, `measurement` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |
| milestone-status | `reporting`, `planning`, `closeout`, `freshness`, `coverage`, `read-only`, `cli-behavior` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |
| flow-stability | `done-convergence`, `lifecycle`, `workspace`, `artifacts`, `review-evidence`, `review-routing`, `done-reporting`, `phase-effects`, `liveness`, `history-compatibility` | Internal CLI catalog and explicit process-fact paths; no additional routine validation command |

Production dynamic selection is **not implemented by these parameters**. It still
requires verified dependency closure, capability-level evidence identity and
mandatory-obligation composition. Do not infer exclusion authority from a partial
PASS. Existing full entrypoints stay registered.

## Module inventory

### `packages/main/src/tasks/flow-stability`

| Module | Lines | Responsibility |
|---|---:|---|
| `artifacts.ts` | 904 | Declared artifacts, automatic commits and global-link repair |
| `cli.ts` | 120 | Legacy flags, capability routing and historical commit controls |
| `done-convergence.ts` | 626 | Single-pass DONE preparation and workspace ownership |
| `done-reporting.ts` | 407 | DONE report projection and shared oracle |
| `lifecycle.ts` | 631 | Lifecycle registry, phase tools and hints |
| `phase-effects.ts` | 274 | Phase gates and transition effects |
| `review-evidence.ts` | 988 | Signatures, freshness and review-run compatibility |
| `review-routing.ts` | 890 | Reviewer status, phase guidance and channel checks |
| `support.ts` | 425 | Shared Story, review and acceptance fixtures |
| `workspace.ts` | 301 | Dirty-worktree classification and gates |

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

### `packages/main/src/tasks/verification-run-and-guard`

| Module | Lines | Responsibility |
|---|---:|---|
| `causal.ts` | 140 | Causal integration |
| `cli.ts` | 160 | Argument selection and original shard orchestration |
| `foundation.ts` | 427 | Pinned execution, refusal and stale evidence basics |
| `integrity.ts` | 762 | Receipt integrity and executable identity |
| `publication.ts` | 517 | Producer ownership and publication bindings |
| `refresh.ts` | 770 | Fan-out, manifests and evidence reuse |
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
  location-dependent path substitutions permitted. Full GREEN is pending.

## Outstanding integration work

Complete the remaining ten entries; reconcile moved exact-source witnesses,
source readers and static dependency edges; verify those contracts; then perform
the applicable Lab integration checks. Current scoped GREEN does not mean these
cross-cutting contracts or main integration are complete. No push has occurred.

# B-c163 execution plan

## Outcome

DONE-related commands show their effective budget and liveness, then report a structured execution/reuse/skip disposition and bounded final result without manual timeout overrides.

## CHK-001 — Derive and coordinate legal DONE-required timeout budgets

Create a shared core budget: sum every effective ordered command timeout once, add one bounded grace, validate/cap safe timer arithmetic. Use it for the done_prepare DONE-required phase and command-specific cli-engine defaults. Phase-specific, global, then derived precedence applies inside done_prepare; explicit LATTICE_MAX_TIMEOUT_MS always overrides CLI defaults. Preserve independent command, phase, idle, and max failures and replace the identical-rerun hint.

## CHK-002 — Reuse only structurally current DONE-required evidence

Add reuseFreshDoneRequired default true without changing reuseFreshValidation. Before execution, require canonical evidence evaluation plus an ancestor lineage in which every intervening path is trusted story metadata. Expose disposition, result, refusalReasons, timeoutLayer, and existingEvidenceBasis in human and JSON output. validate:false reports skipped_explicitly and the fresh/stale/missing basis but neither reuses nor executes. Update registry and exact-HEAD canonical wording.

## CHK-003 — Keep direct DONE-required validation observably alive and bounded

Default missing progress to the existing formatter through ctx.log; progress remains on stderr/side channel. Preserve deadlines, process tree, lock, timers, and single completion. A throwing or closed logging sink is diagnostic-only and cannot forge or change validation results.

## Verification

Add focused red/green assertions, build, run the three DONE/progress smokes plus command-catalog and process-fact contracts, run routine validate, complete independent review/quorum, execute configured DONE-required validation, run done_prepare, and update all six canonical documents.

## Non-goals

Host readiness, further candidate routing, dispatch registry, owner identity, scope paths/anchors, and remote publication are separate workstreams.

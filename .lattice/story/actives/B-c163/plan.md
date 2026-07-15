# B-c163 execution plan

## Outcome

DONE-related commands show their effective budgets and liveness, then report a structured execution/reuse/skip disposition and bounded final result without manual timeout overrides.

## CHK-001 — Derive and coordinate legal DONE-required timeout budgets

Create a shared core budget that sums effective sequential command timeouts with safe arithmetic and bounded grace. The DONE-required subphase uses its ordered command sum plus grace. The direct done_required_validate CLI default max covers that complete subphase. The done_prepare command-level default max covers the configured routine validation sequence plus every enabled closeout phase budget, including phase/global overrides and the derived DONE-required phase, so it cannot expire before legal inner work. Explicit LATTICE_MAX_TIMEOUT_MS remains authoritative. Preserve distinct command, phase, idle, and max failure attribution and replace identical-rerun guidance.

## CHK-002 — Reuse only structurally current DONE-required evidence

Add reuseFreshDoneRequired default true without changing reuseFreshValidation. Require canonical evidence evaluation plus an ancestor lineage in which every intervening path is trusted story metadata. Expose disposition, result, refusalReasons, timeoutLayer, and existingEvidenceBasis. validate:false reports skipped_explicitly and fresh/stale/missing basis but neither reuses nor executes. Update registry and all exact-HEAD canonical wording.

## CHK-003 — Keep direct DONE-required validation observably alive and bounded

Default missing progress to the existing formatter through ctx.log; progress stays off JSON stdout. Preserve deadlines, process tree, lock, timers, and single completion. A throwing or closed logging sink is diagnostic-only and cannot change PASS/FAIL.

## Verification

Test sequential arithmetic, all override precedence, command-specific max isolation, full done_prepare total budget, strict metadata ancestry, validate:false basis, JSON-safe progress, cleanup races, command catalog, process registry, and all six canonical docs. Then build, run focused smokes, routine validate, independent review/quorum, DONE-required validation, and done_prepare.

## Non-goals

Host readiness, further candidate routing, dispatch registry, owner identity, scope paths/anchors, and remote publication are separate workstreams.

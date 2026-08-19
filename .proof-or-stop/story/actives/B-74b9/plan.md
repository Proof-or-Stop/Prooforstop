# Plan: B-74b9 -- silent-fixture-debt-sweep

Three fixtures fail deterministically on a clean main checkout, none registered in
`lattice.config.json`'s `validate.commands`, so `lattice validate` never surfaces them.
Each fix follows repro-first: a committed RED script under `packages/main/tests/red/`
proves the failure on the pre-fix tree, then a GREEN fix lands, confirmed by running the
fixture directly.

## CHK-001

**Root cause** (confirmed by direct repro + source read): `proofstory-acceptance-basis-smoke.ts`'s
`plannedBeforeCode` assertion (line ~218) expects `status: 'complete'` but gets `'partial'`.
`PROCESS_FACT_REGISTRY` (`process-fact-registry.ts:1119`) has an
`artifact:acceptance-rollout-report.json` entry whose `producerSourceRefs` are
`['scripts/run-proofstory-acceptance-rollout-cohort.mjs', 'packages/main/src/core/acceptance-rollout.ts', 'packages/main/src/handlers/proofstory.ts']`.
`buildBoundedSourceGraph` (`acceptance-discovery-adapters.ts:1092`) does
`registryCandidates = stable(['packages/main/src/registry.ts', ...PROCESS_FACT_REGISTRY.flatMap(sourceFiles)])`,
pulling ALL of a registry entry's source refs into the required snapshot closure once one of
them is relevant -- here, `handlers/proofstory.ts`, which the fixture's
`writeCanonicalAcceptanceRegistration` DOES stub into its synthetic `pureRoot`. The other two
files in that same registry entry are never stubbed, so they surface as `snapshot_missing`
blind spots, flipping status to `'partial'`.

**Fix**: add two `write()` calls to `writeCanonicalAcceptanceRegistration` in
`proofstory-acceptance-basis-smoke.ts`, stubbing `packages/main/src/core/acceptance-rollout.ts`
and `scripts/run-proofstory-acceptance-rollout-cohort.mjs` with minimal content matching the
existing stub pattern (a trivial `export const ... = "...";` line), so the synthetic workspace's
snapshot closure is complete.

**RED**: `packages/main/tests/red/red-B-74b9-chk001-acceptance-basis.mjs` runs the current (pre-fix)
`proofstory-acceptance-basis-smoke.js` and asserts it fails with the `'partial'` vs `'complete'`
assertion error mentioning both missing paths.

**GREEN**: after the fix, `node packages/main/dist/tasks/proofstory-acceptance-basis-smoke.js`
exits 0.

**Discriminating-power check**: temporarily revert the two new stub lines and confirm the
original `snapshot_missing` failure reappears -- proves the fixture is still exercising a real
invariant, not passing vacuously.

## CHK-002

**Root cause** (confirmed by direct repro): `field-regression-cli-smoke.ts`'s
`assertReviewRunStartCliSurface` calls `review_pass_set` without `--readManifest`, which
`command-catalog.ts:639` marks required (a `*` required field). The actual CLI error is
`"Argument validation failed (summary): readManifest: Invalid input: expected object, received undefined"`,
but the fixture's own assertion expects `/already stale|stale/i` -- a completely different
message shape -- so it fails on a message mismatch and never exercises the staleness scenario
it was written to test.

**Fix**: pass a valid `readManifest` object (matching the shape other currently-passing tests in
the same file / repo use for a full read pass) so the call reaches the real staleness check
instead of failing argument validation, and confirm the fixture's assertion then matches the
real "already stale" CLI output.

**RED**: `packages/main/tests/red/red-B-74b9-chk002-readmanifest.mjs` runs the current (pre-fix)
`field-regression-cli-smoke.js` and asserts it fails with the readManifest argument-validation
message, not the staleness message the fixture's own assertion expects.

**GREEN**: after the fix, `node packages/main/dist/tasks/field-regression-cli-smoke.js` exits 0,
and the assertion is confirmed to be matching real staleness output (not merely any non-crashing
output) by inspecting the actual CLI stdout the test captures.

## CHK-003

**Root cause** (confirmed by direct repro): `worktree-authority-smoke.ts`'s
`assertDoneRecoverRunsPostMergeBuildForRuntimeChanges` builds a synthetic `mkdtemp` root via
`buildDoneReadyStory` with no `package.json` at the root. `handlers/done-recover.ts`'s
`done_recover` now also calls `core/version-bump.ts`'s `bumpVersionOnDoneMerge`, which requires
`root/package.json` (and the other version sync points) to exist -- it throws
`"DONE post-merge version bump failed before any commit: ENOENT ... package.json"` before the
test's stubbed `doneMainBuildRunner` is ever invoked. This wiring postdates the fixture.

**Investigation first** (resolves the PLAN unknown + preMortem #1): check whether
`bumpVersionOnDoneMerge`/`done_recover` already has any defined behavior for a worktree that
predates the version-bump feature (e.g., an existence check, a version marker, or a
documented assumption that `package.json` always exists at a real repo root). If real
partial-DONE recovery always operates on a repo that already has `package.json` (true for every
real Proofbound worktree), the ENOENT is purely a synthetic-fixture gap, not a production
robustness gap -- fixture-only fix is correct per the decision recorded in `decision.json`.
If investigation instead finds a plausible real scenario where `package.json` could be absent,
escalate: add a defensive fix to `bumpVersionOnDoneMerge`/`done_recover` (e.g. skip the bump
with a clear log line when no root `package.json` is found) rather than only patching the
fixture.

**Fix (expected path)**: extend the fixture's root scaffold in
`assertDoneRecoverRunsPostMergeBuildForRuntimeChanges` to include a minimal `package.json` (and
any other version sync-point files `bumpVersionOnDoneMerge` reads) matching a real repo's shape,
so `done_recover`'s post-merge path can run to completion and reach the stubbed build runner.

**RED**: `packages/main/tests/red/red-B-74b9-chk003-version-bump.mjs` runs the current (pre-fix)
`worktree-authority-smoke.js` and asserts it fails with the ENOENT `package.json` signature from
`bumpVersionOnDoneMerge`.

**GREEN**: after the fix, `node packages/main/dist/tasks/worktree-authority-smoke.js` exits 0.

## CHK-004

**Decision (per-fixture, recorded after CHK-001..003 landed):**

- **proofstory-acceptance-basis-smoke.ts -- REGISTERED.** Now passes cleanly end-to-end
  (confirmed: `node packages/main/dist/tasks/proofstory-acceptance-basis-smoke.js` exits 0,
  ~57s runtime). Added to `lattice.config.json`'s `validate.commands` alongside the structurally
  similar `proofstory-acceptance-rollout-smoke.js` entry (same 180000ms timeoutMs, same shape),
  so `lattice validate` now catches regressions in this class going forward.

- **field-regression-cli-smoke.ts -- NOT YET REGISTERED (deferred).** CHK-002's own defect (six
  `review_pass_set` calls missing the required `--readManifest` argument) is fully fixed and
  verified. However, fixing it unmasked a confirmed-unrelated, separately-tracked pre-existing
  defect cluster further down the SAME file: at least two functions
  (`assertReviewerListForceReviewerLaneContract`, `assertPassOnlyFindingConvertsToReviewPassCliSurface`)
  still reference a "channel" / "lattice-review-channel" reviewer lane that `review_run_start`
  and `reviewer_list` have since retired, verified via isolated reproduction (temporary
  scratch-skip) before being excluded from this story's scope and flagged separately
  (task_9f6b2322). Registering this file into `validate.commands` now would make `lattice
  validate` fail repo-wide on that unrelated, already-tracked issue -- deferred until
  task_9f6b2322 lands.

- **worktree-authority-smoke.ts -- NOT YET REGISTERED (deferred).** CHK-003's own defect (the
  `bumpVersionOnDoneMerge` ENOENT on a synthetic root missing `package.json`) is fully fixed and
  verified as a correct fixture-only fix (see CHK-003's Investigation-first finding: production
  code correctly assumes `package.json` always exists on any real repo root). However, fixing it
  unmasked a confirmed-unrelated, separately-tracked pre-existing bug further down the SAME file:
  `assertConcurrentDoneSerializesWithoutPartialDone` fails with a "File not found ...
  index.json" error during a simulated concurrent-DONE race, verified via isolated reproduction
  on a clean untouched main checkout before being excluded from this story's scope and flagged
  separately (task_a8d49518). Registering this file into `validate.commands` now would make
  `lattice validate` fail repo-wide on that unrelated, already-tracked issue -- deferred until
  task_a8d49518 lands.

This is a deliberate, documented decision (not a silent gap): the two deferred fixtures' OWN
defects are fixed and verified; their `validate.commands` registration is blocked only by
separately-tracked, confirmed-unrelated pre-existing bugs in the same files, each already flagged
as an independent follow-up task.

# DONE Prepare Automation Execution Plan

Status: implemented in B-fb36 for the conservative pre-DONE readiness assistant
Created: 2026-06-19

## Purpose

Add a conservative `lattice done_prepare` command that automates the mechanical
closure work between a TEST-passing story and an explicit DONE attempt.

The target is time reduction without quality reduction. The command must not
weaken DONE gates, review gates, evidence freshness, Authority receipt
boundaries, or version discipline. It should only orchestrate steps that agents
already run manually today.

`done_prepare` is a pre-DONE readiness assistant. It must not modify runtime
version files before DONE, because version changes alter the material hash and
can invalidate the evidence that made DONE ready. Runtime version bumping belongs
to a separate post-DONE local-main finalization step after the story branch has
merged back to local `main`.

## Problem

Small correctness fixes can spend more time in closure mechanics than in code
implementation. The repeated closure sequence is predictable:

- confirm the story is in the correct worktree and phase;
- merge local `main` into the story branch;
- refresh stale verification evidence after material hash changes;
- rerun `lattice validate`;
- run `done_closure`;
- produce the exact next DONE command.

Each step is valid. The inefficiency is that humans and agents must manually
sequence them, inspect partial failures, and remember version rules. That causes
delay and inconsistent operator behavior.

After DONE succeeds, runtime-changing stories still require a second, separate
local-main finalization sequence:

- bump the CLI patch version;
- update package and lockfile version sources;
- rebuild the CLI;
- confirm the global `lattice --version`.

That post-DONE work is related but must not be folded into pre-DONE readiness.

## Guiding Principles

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness and workflow issues.
4. Follow consistency of logic.

## Scope

This plan applies to Proofbound CLI lifecycle automation only.

In scope:

- a new `done_prepare` command;
- stale evidence refresh orchestration after `main` sync;
- validation orchestration;
- DONE closure readiness reporting;
- detecting and reporting whether post-DONE CLI runtime patch finalization will
  be required;
- clear local versus Authority completion status output;
- smoke tests for the command and its failure modes.

Out of scope:

- changing REVIEW, TEST, or DONE pass criteria;
- relaxing evidence freshness checks;
- relaxing material hash checks;
- automatically claiming Authority DONE;
- automatically claiming production DONE;
- pushing to remote;
- handling unrelated dirty files by stashing, reverting, or deleting them;
- replacing reviewer, coverage, or delivery gates.
- mutating CLI runtime version files before DONE.
- automatically rebinding, rewriting, refreshing, or re-endorsing review
  escalation / host verdict material. Stale or missing review verdicts must
  block and point to the real review, re-escalation, or fresh host verdict path.

## Command Contract

Primary command:

```bash
lattice done_prepare '{"storyId":"B-xxxx","mergeMain":true,"refreshStale":true,"validate":true}'
```

Recommended defaults:

```json
{
  "mergeMain": true,
  "refreshStale": true,
  "validate": true,
  "dryRun": false
}
```

`done_prepare` should not accept a version-bump mode in its first
implementation. It may report:

```json
{
  "postDoneRuntimeVersionBumpRequired": true,
  "postDoneNext": "After story_advance DONE succeeds on local main, run the runtime version bump/finalize path."
}
```

The post-DONE finalization surface can be a later `lattice version_bump --patch`
or `lattice done_finalize` command. It is intentionally not part of
`done_prepare`.

`done_prepare` also must not accept a review-verdict rebind mode. Review
assurance and escalation material is only valid when the relevant host actually
reviewed the current material. If `done_closure` reports stale or missing
review-assurance / escalation verdicts, `done_prepare` blocks and prints the
real diagnostic and re-review commands instead of rewriting verdict records.

When `mergeMain=true`, review-assurance / escalation diagnostics are always
reported against the post-merge worktree. If `done_prepare` blocks after syncing
main, the blocked output must include the current binding, even when another
closure requirement such as receipt verification is also blocking:

```text
Current material binding:
  currentHead: <post-merge-head>
  currentMaterialHash: <post-merge-materialHash>
  currentStoryFilesHash: <post-merge-storyFilesHash>
```

The command guidance must preserve the current-material order:

1. inspect `review_escalation_status`;
2. prefer `quorum_submit` when current reviewer pass evidence exists, because it
   computes the current `materialDigest` / `storyFilesHash`;
3. otherwise use explicit host verdict submission only with the printed current
   hashes;
4. rerun `done_prepare` and advance DONE only after it reports `PASS`.

Supported `dryRun` behavior:

- inspect current state;
- report planned steps and blockers;
- do not mutate git, evidence, version files, or build outputs.

## Execution Flow

### 1. Preflight

`done_prepare` must fail closed before mutation when:

- current cwd is not the story worktree for the requested story;
- story phase is not TEST;
- worktree has blocking dirty files;
- branch is not the expected story branch;
- story id cannot be resolved;
- repo root cannot be resolved;
- `main` cannot be found locally.

Dirty-file policy:

- supersedes the first implementation's blanket clean-tree rule: initial
  preflight may proceed when the only dirty rows classify as same-story Proofbound
  lifecycle metadata for the requested story, such as
  `.lattice/story/actives/<storyId>/done-required-evidence.json`;
- initial preflight still blocks material/source, fixture, runtime artifact,
  declared artifact, other-story Proofbound metadata, and unexpected dirty rows
  using the shared dirty-worktree classifier;
- rename rows are allowed only when every path in the row is same-story
  lifecycle metadata; metadata-to-source, source-to-metadata, and
  source-to-owner-lease renames block before mutation;
- unchanged pre-existing Proofbound story lifecycle metadata remains advisory for
  `done_prepare`; it does not force a `blockedAt: cleanTree` result by itself;
- failed DONE-required evidence is not rescued by the dirty-file allowance: it
  remains visible as same-story metadata dirt, but `doneClosure` blocks on the
  failed evidence and `done_prepare` must not claim `PASS`;
- if prepare work leaves uncommitted metadata changes, the command must stop at
  `cleanTree` and list the exact files to commit before DONE;
- if prepare work advances HEAD by delegating to an existing metadata writer that
  auto-commits, the command must stop at `cleanTree`, list the generated
  commit(s), and tell the operator to review them and rerun `done_prepare` from
  the new HEAD;
- a successful `DONE prepare: PASS` requires no new or changed dirty rows beyond
  unchanged pre-existing Proofbound story lifecycle metadata.

This keeps the implementation fail-closed for material drift and generated
outputs while aligning pre-existing lifecycle metadata dirt with the DONE oracle's
metadata-only semantics. Existing metadata writers retain their established
auto-commit semantics.

### 2. Merge Main

If `mergeMain=true`, run the equivalent of:

```bash
git merge main
```

If the merge conflicts, stop immediately and output:

- `blockedAt: mergeMain`;
- conflicted files;
- next command guidance after manual conflict resolution;
- no validation, runtime-change detection, or DONE attempt.

The command must not auto-resolve conflicts.

### 3. Refresh Stale Evidence

After a successful main merge, run a freshness check through the same material
hash logic used by `lattice validate` and `done_closure`.

First run the stale-evidence refresh path in classification mode:

```bash
lattice verification_evidence_refresh_stale --storyId=B-xxxx --dryRun
```

If the dry run reports evidence that can be safely refreshed by existing
evidence machinery and `refreshStale=true`, run:

```bash
lattice verification_evidence_refresh_stale --storyId=B-xxxx
```

That delegated command may auto-commit story metadata through the existing
`verification_evidence_refresh_stale` metadata auto-commit path. `done_prepare`
must not hide that HEAD movement. When refresh creates prepare-generated
commit(s), `done_prepare` stops with `DONE prepare: BLOCKED`, `blockedAt:
cleanTree`, a commit list, and rerun guidance before any DONE guidance is
printed.

If the dry run reports evidence commands that must be rerun, stop and print
those commands. The command must not convert stale evidence to fresh solely by
rewriting hashes.

If evidence is stale and `refreshStale=false`, stop with:

```text
blockedAt: evidenceFreshness
next: lattice verification_evidence_refresh_stale --storyId=B-xxxx
```

The command must not mark stale evidence as fresh without rerunning or
refreshing through existing evidence machinery.

### 4. Validate

If `validate=true`, run:

```bash
lattice validate --story=B-xxxx --json
```

If validation fails, stop and surface:

- `blockedAt: validate`;
- failing command or missing coverage summary;
- the next command emitted by validate when available.

No post-DONE finalization guidance should be treated as actionable after failed
validation.

### 5. DONE Closure

Run:

```bash
lattice done_closure '{"storyId":"B-xxxx"}'
```

If `canAttemptDone=false`, stop and show blocking rows. The command must not
call `story_advance DONE`.

If `canAttemptDone=true`, continue to runtime-change detection and final output.

### 6. Runtime Change Detection

Detect whether the story changed Proofbound CLI runtime behavior. The first
implementation can use a conservative path-based rule.

Report `postDoneRuntimeVersionBumpRequired=true` if the story diff includes any
of:

- `packages/main/src/core/**`;
- `packages/main/src/handlers/**`;
- `packages/main/src/tasks/**`;
- `packages/main/src/cli.ts`;
- `packages/main/src/index.ts`;
- `bin/**`;
- process fact, lifecycle gate, Authority, review, validation, or command
  dispatch code.

Do not require patch bump for docs-only, story metadata-only, review
evidence-only, or comment-only changes.

Do not update version files in `done_prepare`. The report should name the
post-DONE files that the finalization step must update:

- `package.json`;
- `package-lock.json`;
- `packages/main/package.json`;
- `packages/main/package-lock.json`;
- `packages/main/src/core/lattice-brand.ts`.

If required version sources are already inconsistent, report
`postDoneVersionState: inconsistent` and include the mismatched values. This is
advisory for `done_prepare` but should block the later post-DONE finalization
step.

### 7. Optional Worktree Build Check

`done_prepare` may run a worktree-local build when validation did not already do
so, but it should not use the global `lattice` binary for pre-DONE version
checks. In a story worktree, the reliable command is:

```bash
npm --prefix packages/main run build
node packages/main/dist/cli.js --version
```

The global `lattice --version` check belongs after DONE merge on local `main`.
Before DONE, global `lattice` may still point at local main and not the story
worktree build.

If the worktree-local CLI cannot run after build, stop with:

```text
blockedAt: worktreeVersionCheck
reason: worktree CLI build does not execute
```

Do not continue to DONE guidance if the optional build check was requested and
failed.

### 8. Final Clean-Tree Check

Before printing `DONE prepare: PASS`, rerun `git status --porcelain`.

If `done_prepare` produced metadata changes that are not committed, stop with:

```text
DONE prepare: BLOCKED
blockedAt: cleanTree
reason: done_prepare produced files that must be committed before DONE
files:
  - .lattice/story/actives/B-xxxx/test-evidence.json
next: git add <files> && git commit -m "lattice: refresh B-xxxx done prepare evidence"
```

If delegated prepare work already created commit(s), stop with:

```text
DONE prepare: BLOCKED
blockedAt: cleanTree
reason: done_prepare produced commit(s) during refresh/validate; rerun from the new HEAD before DONE
commits:
  - <sha> lattice: record B-xxxx verification_evidence_refresh_stale metadata
commands:
  - git log --oneline <old-head>..HEAD
  - lattice done_prepare '{"storyId":"B-xxxx"}'
next: review the generated commit(s), then rerun lattice done_prepare from the new HEAD
```

`done_prepare` must not invent a separate auto-commit path. The only
prepare-generated commit expected in this implementation is a delegated
story-metadata commit from existing commands such as
`verification_evidence_refresh_stale`.

### 9. Output Final Next Step

On success, print one clear next step:

```bash
lattice story_advance '{"storyId":"B-xxxx","phase":"DONE"}'
```

The command should not call DONE automatically in the first implementation.
Keeping DONE explicit preserves the existing lifecycle boundary and lets the
operator read the final readiness report.

## Output Format

Successful output:

```text
DONE prepare: PASS
storyId: B-xxxx
phase: TEST
mergeMain: PASS
staleEvidenceRefresh: PASS
validate: PASS
doneClosure: PASS
worktreeClean: PASS
postDoneRuntimeVersionBumpRequired: true

Authority completion:
  localDoneReady: true
  authorityDone: false
  fullAuthorityDone: false
  productionDone: false

Next:
lattice story_advance '{"storyId":"B-xxxx","phase":"DONE"}'
```

Blocked output:

```text
DONE prepare: BLOCKED
storyId: B-xxxx
blockedAt: validate
reason: CHK-003 verification evidence stale
next: lattice verification_evidence_refresh_stale --storyId=B-xxxx
```

Review-assurance blocked output:

```text
DONE prepare: BLOCKED
storyId: B-xxxx
blockedAt: doneClosure
reason: review-assurance-floor: Review assurance floor: full-3x2; ...
Current material binding:
  currentHead: <post-merge-head>
  currentMaterialHash: <post-merge-materialHash>
  currentStoryFilesHash: <post-merge-storyFilesHash>
commands:
  - lattice review_escalation_status '{"storyId":"B-xxxx"}'
  - lattice quorum_submit '{"storyId":"B-xxxx","hostA":"<independent-host-a>","hostB":"<independent-host-b>"}'
  - lattice autopilot_review_submit --storyId=B-xxxx ... --materialDigest=<post-merge-materialHash> --storyFilesHash=<post-merge-storyFilesHash> ...
  - lattice done_prepare '{"storyId":"B-xxxx"}'
next: inspect review status, submit current-material review/quorum evidence, then rerun lattice done_prepare '{"storyId":"B-xxxx"}'
```

This block intentionally does not print `story_advance DONE`; that command stays
on the `DONE prepare: PASS` path only.

Uncommitted metadata output:

```text
DONE prepare: BLOCKED
storyId: B-xxxx
blockedAt: cleanTree
reason: done_prepare produced metadata changes that must be committed before DONE
files:
  - .lattice/story/actives/B-xxxx/test-evidence.json
next: git add <files> && git commit -m "lattice: refresh B-xxxx done prepare evidence"
```

Generated commit output:

```text
DONE prepare: BLOCKED
storyId: B-xxxx
blockedAt: cleanTree
reason: done_prepare produced commit(s) during refresh/validate; rerun from the new HEAD before DONE
commits:
  - <sha> lattice: record B-xxxx verification_evidence_refresh_stale metadata
commands:
  - git log --oneline <old-head>..HEAD
  - lattice done_prepare '{"storyId":"B-xxxx"}'
next: review the generated commit(s), then rerun lattice done_prepare from the new HEAD
```

The output must explicitly distinguish:

- local DONE readiness;
- degraded-single-host local assurance;
- two-host review status;
- Authority receipt backed completion;
- production completion.

## Host-Neutral Authority Boundary

`done_prepare` is a local lifecycle assistant. It can prepare a story for local
DONE. It cannot prove Authority Server completion.

It must never set or imply:

- `authorityDone=true`;
- `fullAuthorityDone=true`;
- `productionDone=true`;
- `receiptVerified=true`;
- two-host quorum when only degraded-single-host fallback exists.

If `done_closure` reports degraded-single-host readiness, `done_prepare` should
render that as local readiness only:

```text
reviewAssurance: degraded-single-host
fullAuthorityDone: false
productionDone: false
```

## Implementation Steps

### Step 1. Add Command Surface

Add `done_prepare` to the CLI command registry and handler dispatch.

Inputs:

- `storyId` required;
- `mergeMain` optional boolean;
- `refreshStale` optional boolean;
- `validate` optional boolean;
- `build` optional boolean for worktree-local build checks only;
- `dryRun` optional boolean.

The handler should call existing lifecycle utilities instead of duplicating
DONE, validate, evidence, or gitroot logic.

### Step 2. Add Preflight And Step Runner

Create a small internal step runner that records:

- step id;
- status: `pending | skipped | pass | blocked`;
- command or action;
- reason;
- next command;
- mutated files.

The step runner should make partial failure easy to inspect without hiding the
actual failed command output.

### Step 3. Reuse Existing Closure And Evidence Logic

Use existing implementations for:

- story/worktree resolution;
- material hash calculation;
- stale evidence refresh;
- validation;
- DONE closure;
- dirty tree classification.

If direct reuse is not currently possible, extract a narrow shared helper from
the existing command rather than copying behavior.

### Step 4. Implement Runtime Change Detection

Add a runtime-change detector with a narrow contract:

- inspect `git diff main...HEAD`;
- classify docs-only, metadata-only, test-only, and runtime-affecting diffs;
- report whether post-DONE patch finalization is required;
- report current version source consistency without modifying files.

Do not modify version files in this helper.

### Step 5. Define Post-DONE Finalization Separately

Define the post-DONE finalization path as a separate story or a later command.
That path runs only from local `main` after `story_advance DONE` succeeds.

The finalization path may:

- bump the patch version;
- update package and lockfile version sources;
- run `npm --prefix packages/main run build`;
- verify global `lattice --version`;
- commit the version bump.

It must remain separate from pre-DONE readiness.

### Step 6. Add Smokes

Add focused smoke tests rather than broad end-to-end tests.

Required smokes:

- clean TEST story prepares successfully and prints the DONE next command;
- dirty worktree blocks before mutation;
- merge-main conflict blocks at `mergeMain`;
- stale evidence after main merge triggers refresh when enabled;
- safe stale evidence refresh may auto-commit story metadata through
  `verification_evidence_refresh_stale`, then blocks at `cleanTree` with
  generated commit list and rerun guidance;
- stale evidence that requires command rerun blocks and prints rerun commands;
- stale evidence blocks when refresh is disabled;
- validate fail stops before DONE guidance;
- runtime source diff reports post-DONE patch finalization required without
  modifying version files;
- docs-only diff reports no post-DONE patch finalization required;
- validate-created metadata changes produced by prepare block at `cleanTree`
  until committed;
- degraded-single-host readiness prints local-only status and does not claim
  Authority DONE;
- `dryRun=true` reports planned steps without changing files.

## Rollout Plan

### Wave 1. Diagnostic Dry Run

Implement `dryRun=true` and blocked/pass reporting first. No mutation except
ordinary read-only command logs.

Acceptance:

- dry run correctly reports blockers for at least one ready story and one
  intentionally blocked story;
- no files change.

### Wave 2. Merge, Refresh, Validate, Closure

Enable mutation for:

- merge main;
- stale evidence refresh;
- validate;
- done_closure report.

Acceptance:

- a story that previously required manual merge/refresh/validate reaches
  `canAttemptDone=true` through `done_prepare` when no files were mutated, or
  stops at `cleanTree` with exact commit-required files when validate produced
  uncommitted metadata changes, or with a generated commit list when safe stale
  refresh auto-committed story metadata through
  `verification_evidence_refresh_stale`;
- after commit-required files are committed, or after generated commits are
  reviewed, rerunning `done_prepare` reaches `DONE prepare: PASS`;
- failure modes stop at the correct step.

### Wave 3. Runtime Change Detection

Enable runtime-change detection and post-DONE finalization reporting.

Acceptance:

- runtime behavior changes report `postDoneRuntimeVersionBumpRequired=true`;
- docs-only changes report `postDoneRuntimeVersionBumpRequired=false`;
- no version files are modified before DONE;
- version source inconsistency is reported clearly for later finalization.

### Wave 4. Post-DONE Finalization Command

Implement a separate post-DONE main command if needed:

```bash
lattice done_finalize '{"storyId":"B-xxxx","versionBump":"patch"}'
```

Acceptance:

- runs only from local `main`;
- refuses to run before the story is DONE;
- bumps exactly one patch version for runtime behavior changes;
- updates package and lockfile version sources consistently;
- runs build and confirms global `lattice --version`;
- commits only finalization files.

### Wave 5. Default Operator Path

Update `session_brief` and DONE blocker hints to recommend:

```bash
lattice done_prepare '{"storyId":"B-xxxx"}'
```

Acceptance:

- TEST phase hints point to `done_prepare` before raw DONE when closure work is
  likely needed;
- DONE remains an explicit final command.

## Risks

- Over-broad runtime-change detection could ask for unnecessary post-DONE
  finalization on docs-only work.
- Under-broad runtime-change detection could leave runtime changes without
  post-DONE version guidance.
- Automated merge could surprise operators if dirty tree preflight is weak.
- Duplicating existing lifecycle logic could create drift from `validate` or
  `done_closure`.
- Confusing local readiness with Authority readiness could overclaim completion.
- Pre-DONE mutation that leaves the tree dirty could make `story_advance DONE`
  fail after `done_prepare` reports success.

## Risk Controls

- Start with clean-tree-only mutation.
- Keep DONE explicit.
- Reuse existing validation and DONE closure utilities.
- Make `dryRun` available from the first wave.
- Keep local/Authority/prod fields separate in output.
- Keep version mutation out of `done_prepare`.
- Add tests for docs-only and runtime-change finalization guidance.
- Require a final clean-tree check before `DONE prepare: PASS`.

## Acceptance Criteria

The implementation is accepted only when:

- `done_prepare` can turn a clean TEST story with no required metadata writes
  into a ready-to-DONE state;
- `done_prepare` can handle stale evidence after main merge by either refreshing
  safely and stopping with a generated metadata commit list plus rerun guidance,
  or by blocking with rerun commands when evidence must be regenerated;
- all existing DONE gates still run and still block when invalid;
- runtime behavior stories report post-DONE patch finalization required without
  modifying version files before DONE;
- docs-only stories do not request post-DONE patch finalization;
- blocked states report exactly where the process stopped;
- prepare-generated metadata changes or commit(s) block with a clear
  `cleanTree` state instead of printing a false DONE-ready result;
- review-assurance / escalation blockers after main sync print the post-merge
  `currentHead`, `currentMaterialHash`, `currentStoryFilesHash`, and ordered
  current-material review/quorum commands without rewriting verdict records.
- degraded-single-host local readiness is never rendered as Authority DONE;
- no remote push or production claim happens automatically.

## Expected Time Savings

The command should remove most manual closure sequencing after implementation
and review are done. For stories similar to the Authority DONE
`materialOverlapAudit` fix, expected savings are 12 to 18 minutes per story.

This does not reduce time spent on real design, caller-path review, or failing
tests. It only removes repeated closure orchestration.


## B-c163 convergence contract (implemented)

- Closeout segments check the parent watchdog before and after each segment and await cooperative abort cleanup. Synchronous JavaScript is inherently non-preemptible, so it stops at the first deadline/checkpoint boundary. Pure in-process closeout segments spawn no descendants, making process-tree ESRCH evidence not applicable there; descendant cleanup is required and tested only for validation/phase paths that actually spawn children.

DONE-required execution and reuse use one bounded contract:

- The DONE-required phase budget is the safe sum of effective sequential command timeouts plus bounded grace. A phase-specific override wins the global phase override, which wins the derived budget. The direct `done_required_validate` CLI max covers that derived phase; the `done_prepare` CLI max covers routine validation plus every enabled closeout phase. An explicit `LATTICE_MAX_TIMEOUT_MS` remains authoritative. Each effective command timeout is capped at Node's maximum legal timer delay before arming the real timer, so a huge configured value cannot overflow into an immediate timeout. Structured `failed` / `timed_out` / `blocked` results remain parseable on stdout and exit nonzero; routine `done_prepare` idle/max aborts use the same terminal timeout shape and release child processes, timers, and locks for an immediate rerun.
- `done_prepare` defaults `reuseFreshDoneRequired=true`, independently of post-closeout `reuseFreshValidation`. Reuse requires the canonical DONE-required evaluator to pass and evidence HEAD to equal current HEAD, or be its ancestor with every path touched by every intervening commit classified as trusted story metadata (including modify-then-revert history). HEAD must remain unchanged across evaluation. Any code, config, non-metadata, non-ancestor, unreadable evidence/lineage, or concurrent HEAD movement refuses reuse.
- `validate:false` means `disposition=skipped_explicitly` and `result=not_run`; it neither executes nor reuses nor manufactures evidence, while reporting `existingEvidenceBasis=fresh|stale|missing`. Executed and reused paths report `disposition`, `result`, `refusalReasons`, and any `timeoutLayer` in human and JSON output.
- Progress and heartbeat output uses stderr/the logging side channel, never JSON stdout. Reporter failures are diagnostic-only. Heartbeats refresh idle liveness only; command, phase, idle, and absolute max deadlines, child-tree termination, lock release, and timer cleanup remain independent.

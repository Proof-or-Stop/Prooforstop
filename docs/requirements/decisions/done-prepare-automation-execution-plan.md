# DONE Prepare Automation Execution Plan

Status: proposed
Created: 2026-06-19

## Purpose

Add a conservative `lattice done_prepare` command that automates the mechanical
closure work between a TEST-passing story and a clean DONE attempt.

The target is time reduction without quality reduction. The command must not
weaken DONE gates, review gates, evidence freshness, Authority receipt
boundaries, or version discipline. It should only orchestrate steps that agents
already run manually today.

## Problem

Small correctness fixes can spend more time in closure mechanics than in code
implementation. The repeated closure sequence is predictable:

- confirm the story is in the correct worktree and phase;
- merge local `main` into the story branch;
- refresh stale verification evidence after material hash changes;
- rerun `lattice validate`;
- run `done_closure`;
- handle CLI runtime patch version bump when the story changes runtime behavior;
- rebuild the CLI;
- confirm `lattice --version`;
- produce the exact next DONE command.

Each step is valid. The inefficiency is that humans and agents must manually
sequence them, inspect partial failures, and remember version rules. That causes
delay and inconsistent operator behavior.

## Guiding Principles

1. Do not optimize for the sake of optimization.
2. Do not optimize arbitrarily.
3. Only fix real correctness and workflow issues.
4. Follow consistency of logic.

## Scope

This plan applies to Lattice CLI lifecycle automation only.

In scope:

- a new `done_prepare` command;
- stale evidence refresh orchestration after `main` sync;
- validation orchestration;
- DONE closure readiness reporting;
- CLI runtime patch version bump orchestration;
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

## Command Contract

Primary command:

```bash
lattice done_prepare '{"storyId":"B-xxxx","mergeMain":true,"refreshStale":true,"validate":true,"versionBump":"auto"}'
```

Recommended defaults:

```json
{
  "mergeMain": true,
  "refreshStale": true,
  "validate": true,
  "versionBump": "auto",
  "build": true,
  "dryRun": false
}
```

Supported `versionBump` values:

- `none`: never bump version; fail if runtime change requires a bump.
- `auto`: detect runtime behavior changes and bump patch when required.
- `patch`: always bump patch version after validation succeeds.

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

Allowed dirty files:

- existing Lattice metadata changes that the current command itself produced
  and can safely commit is not allowed in the first version. The first version
  should require a clean worktree before mutation.

This keeps the first implementation simple and avoids implicit git behavior.

### 2. Merge Main

If `mergeMain=true`, run the equivalent of:

```bash
git merge main
```

If the merge conflicts, stop immediately and output:

- `blockedAt: mergeMain`;
- conflicted files;
- next command guidance after manual conflict resolution;
- no validation, version bump, or DONE attempt.

The command must not auto-resolve conflicts.

### 3. Refresh Stale Evidence

After a successful main merge, run a freshness check through the same material
hash logic used by `lattice validate` and `done_closure`.

If evidence is stale and `refreshStale=true`, run the existing stale evidence
refresh path:

```bash
lattice verification_evidence_refresh_stale --storyId=B-xxxx
```

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

No version bump should happen after failed validation.

### 5. DONE Closure

Run:

```bash
lattice done_closure '{"storyId":"B-xxxx"}'
```

If `canAttemptDone=false`, stop and show blocking rows. The command must not
call `story_advance DONE`.

If `canAttemptDone=true`, continue to optional version bump and final output.

### 6. Runtime Version Bump

When `versionBump=auto`, detect whether the story changed Lattice CLI runtime
behavior. The first implementation can use a conservative path-based rule.

Require patch bump if the story diff includes any of:

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

Patch bump must update:

- `package.json`;
- `package-lock.json`;
- `packages/main/package.json`;
- `packages/main/package-lock.json`;
- `packages/main/src/core/lattice-brand.ts`.

The command should use existing package/version parsing rather than ad hoc
string replacement where feasible. If a required version file is missing or
contains inconsistent values, stop with `blockedAt: versionBump`.

### 7. Build And Version Check

If a version bump occurred, or if `build=true`, run:

```bash
npm --prefix packages/main run build
lattice --version
```

The version check must confirm the expected version string. If the global
`lattice` binary still reports the previous version, stop with:

```text
blockedAt: versionCheck
reason: global lattice does not resolve to the rebuilt CLI
```

Do not continue to DONE guidance if version check fails.

### 8. Output Final Next Step

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
versionBump: 0.3.9 -> 0.3.10
build: PASS
versionCheck: Lattice CLI 0.3.10

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
- `versionBump` optional enum;
- `build` optional boolean;
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

### Step 4. Implement Version Bump Helper

Add a version bump helper with a narrow contract:

- read current versions;
- compute patch version;
- update required files;
- run build when requested;
- verify `lattice --version`.

The helper must fail if version sources disagree before modification, unless
the disagreement is an already-known lockfile drift that the helper is
explicitly designed to repair.

### Step 5. Add Smokes

Add focused smoke tests rather than broad end-to-end tests.

Required smokes:

- clean TEST story prepares successfully and prints the DONE next command;
- dirty worktree blocks before mutation;
- merge-main conflict blocks at `mergeMain`;
- stale evidence after main merge triggers refresh when enabled;
- stale evidence blocks when refresh is disabled;
- validate fail stops before version bump;
- runtime source diff with `versionBump=auto` bumps patch version;
- docs-only diff with `versionBump=auto` does not bump version;
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
  `canAttemptDone=true` through `done_prepare`;
- failure modes stop at the correct step.

### Wave 3. Version Bump And Build

Enable `versionBump=auto`, patch bump, build, and version check.

Acceptance:

- runtime behavior changes bump exactly one patch version;
- docs-only changes do not bump;
- version files remain consistent;
- `lattice --version` reports the bumped version.

### Wave 4. Default Operator Path

Update `session_brief` and DONE blocker hints to recommend:

```bash
lattice done_prepare '{"storyId":"B-xxxx"}'
```

Acceptance:

- TEST phase hints point to `done_prepare` before raw DONE when closure work is
  likely needed;
- DONE remains an explicit final command.

## Risks

- Over-broad version bump detection could consume version numbers on docs-only
  work.
- Under-broad version bump detection could leave runtime changes with stale
  version output.
- Automated merge could surprise operators if dirty tree preflight is weak.
- Duplicating existing lifecycle logic could create drift from `validate` or
  `done_closure`.
- Confusing local readiness with Authority readiness could overclaim completion.

## Risk Controls

- Start with clean-tree-only mutation.
- Keep DONE explicit.
- Reuse existing validation and DONE closure utilities.
- Make `dryRun` available from the first wave.
- Keep local/Authority/prod fields separate in output.
- Add tests for docs-only and runtime-change version bump decisions.

## Acceptance Criteria

The implementation is accepted only when:

- `done_prepare` can turn a clean TEST story with stale evidence after main
  merge into a ready-to-DONE state;
- all existing DONE gates still run and still block when invalid;
- runtime behavior stories bump patch version consistently;
- docs-only stories do not bump version;
- blocked states report exactly where the process stopped;
- degraded-single-host local readiness is never rendered as Authority DONE;
- no remote push or production claim happens automatically.

## Expected Time Savings

The command should remove most manual closure sequencing after implementation
and review are done. For stories similar to the Authority DONE
`materialOverlapAudit` fix, expected savings are 12 to 18 minutes per story.

This does not reduce time spent on real design, caller-path review, or failing
tests. It only removes repeated closure orchestration.

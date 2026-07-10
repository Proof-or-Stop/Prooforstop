# DONE Prepare Generated-Metadata Auto-Closeout Execution Plan

Status: execution plan
Created: 2026-07-09
Source incident: B-6914 closeout rerun loop after B-90d6 version-boundary repair

## Purpose

Add an opt-in, fail-closed `done_prepare` auto-closeout path for one narrow
case: `done_prepare` generated only Proofbound-owned lifecycle metadata, the
story material and story-owned file hashes did not change, and existing
validation evidence is still admissible for the same command and policy inputs.

This is a TEST-phase `done_prepare` automation story. It does not change the
current lifecycle rule that `done_prepare` runs only for TEST stories; DONE
recovery support would require a separate lifecycle semantics story.

The goal is to reduce the manual loop:

```text
done_prepare writes DONE metadata
commit generated metadata
rerun done_prepare
rerun full validate even though material/storyFiles are unchanged
commit refreshed metadata again
then attempt DONE
```

The new capability must not duplicate the preceding UX stories:

- B-eb08 owns closeout progress labels, heartbeat, and phase deadlines.
- B-eb92 owns early review-assurance surfacing and legal-writer guidance.
- B-b264 owns rerun-delta explanation, merge hazard guidance, generated-file
  ownership reporting, and dry-run immutability.

This story consumes those surfaces and adds a conservative automation layer on
top of their classifications. It must not reimplement their user-facing
guidance.

## Problem Solved

B-6914 showed that `done_prepare` can legitimately generate gate metadata such
as `done-required-evidence.json` and `test-evidence.json`, then block at
`cleanTree` and ask the operator to commit the generated files. That commit can
change `HEAD` while leaving both material code and story-owned semantic content
unchanged. The next `done_prepare` then re-validates the whole project and may
rewrite evidence only to bind the new metadata-only `HEAD`, causing another
manual commit/rerun cycle.

The repeated cycle is safe but expensive and hard to drive:

- agents spend minutes rerunning full validation for metadata-only HEAD drift;
- users cannot tell whether a rerun is logically required or mechanically
  avoidable;
- the operator must manually stage only generated lifecycle files while avoiding
  unrelated dirty files;
- a valid closeout can feel like it needs hand-crafted recovery steps.

This plan adds an explicit safe path for that mechanical case.

## Non-Goals

- Do not add heartbeat or progress labels; B-eb08 owns that.
- Do not add review-assurance surfacing or fallback guidance; B-eb92 owns that.
- Do not add rerun-delta explanation or merge hazard reporting; B-b264 owns that.
- Do not change `done_prepare` phase eligibility; the new path remains TEST-only.
- Do not auto-sign reviewer evidence, host verdicts, delivery checks, degraded
  fallback, Authority receipts, or production readiness.
- Do not auto-resolve merge conflicts, stash files, delete files, or overwrite
  unrelated user work.
- Do not auto-push, publish, create releases, or claim Authority/production DONE.
- Do not update runtime version files from `done_prepare`.
- Do not skip validation when material hash, storyFiles hash, validation command
  set, policy hash, or DONE-required command set changed.
- Do not auto-advance to DONE by default.
- Do not change dispatch, worker reuse, role prompts, full-history forks, or
  bounded context pack behavior.

## Resolved Design Decisions

- Metadata-only validation reuse is represented as an extension to
  `done-required-evidence.json`, not as a new gate-evidence artifact. The record
  must include the prior validation evidence reference, prior DONE-required
  evidence reference, materialHash, storyFilesHash, validation commandSetHash,
  DONE-required commandSetHash, policy/config hashes, prior transcript
  references, and a clear statement that validation was reused rather than
  rerun.
- B-fbcf does not add a wall-clock freshness window. Reuse is structural:
  unchanged material/storyFiles/command/policy/config hashes plus prior PASS
  evidence are required. Timestamps remain audit metadata only. A future
  max-age policy would need a separate story because it changes lifecycle
  policy rather than closing the generated-metadata loop.
- B-fbcf runs current-main sibling regression smokes when those smokes exist.
  Future B-eb92/B-b264 smoke scripts that are not merged into the baseline are
  not B-fbcf acceptance requirements; B-fbcf instead verifies that it does not
  duplicate or weaken those sibling-owned surfaces.

## Proposed Operator Contract

Introduce an explicit opt-in mode:

```text
lattice done_prepare --storyId=B-xxxx --autoCloseGeneratedMetadata --reuseFreshValidation
```

Preconditions:

- The story is in TEST and the normal `done_prepare` cwd, branch, and local main
  preflight checks pass.
- The command's generated metadata manifest exists for the current invocation.
- Git index and worktree contain no dirty files except current-run manifest
  files that are classified as safe lifecycle metadata.
- Prior validation and DONE-required evidence are PASS and still admissible
  under the reuse gate defined below.

Expected success shape:

```text
DONE prepare auto-closeout:
  generated metadata committed: <commit-sha>
  validation reused: materialHash/storyFilesHash unchanged, commandSetHash unchanged
  doneClosure: PASS
  runtimeChange: PASS
  cleanTree: PASS
next: lattice story_advance --storyId=B-xxxx --phase=DONE
```

Expected refusal shape:

```text
DONE prepare auto-closeout refused:
  reason: unrelated dirty files are present
  files:
    - docs/example.md
next: commit/stash/restore unrelated work yourself, then rerun done_prepare
```

The command may return `DONE prepare: PASS`, but it must not call
`story_advance --phase=DONE`.

## Milestone Ledger

| Milestone | Goal | Acceptance |
|---|---|---|
| M0 No-overlap scope lock | Prove this story only adds automation and does not duplicate B-eb08/B-eb92/B-b264 | Scope contract lists consumed outputs from prior stories and forbids new heartbeat, review-assurance guidance, and rerun-explanation features |
| M1 Generated metadata manifest | Record exactly which files the current `done_prepare` run generated and why they are safe candidates | Manifest is path-safe, story-scoped, current-run-only, reuses the lifecycle artifact classifier / configured storyDir, and excludes unrelated dirty files |
| M2 Safe auto-commit | Opt-in mode stages and commits only current-run generated lifecycle metadata | Unrelated dirty files, staged non-manifest files, runtime files, unsafe paths, commit-hook failure, or missing manifest fail closed before any commit |
| M3 Fresh-validation reuse gate | Avoid full validation only when the prior evidence is still admissible after metadata-only HEAD drift | Reuse requires unchanged materialHash, storyFilesHash, validation commandSetHash, DONE-required commandSetHash, scope contract hash, lifecycle classifier version, and relevant config hash |
| M4 Single-shot prepare re-evaluation | After safe auto-commit, re-evaluate DONE prepare from the new HEAD without looping through full validation | A fixture closes generated metadata in one command and reaches PASS or a real non-metadata blocker |
| M5 Regression and safety coverage | Prove the automation cannot weaken gates or touch user work | Smoke tests cover success, unrelated dirt, material drift, review assurance missing, JSON output, current-main sibling smokes, and no auto-signing |

## Milestone Details

### M0 - No-overlap Scope Lock

Subitems:

- Declare B-eb08, B-eb92, and B-b264 as prerequisite UX layers.
- Confirm this story does not add new heartbeat labels or phase timeout logic.
- Confirm this story does not add new review-assurance reason wording.
- Confirm this story does not replace B-b264 rerun-delta explanation.
- Confirm this story does not change dispatch / worker / role prompt behavior.
- Confirm this story does not change TEST-only `done_prepare` phase eligibility.
- Define the new behavior as an opt-in automation mode only.

Verification:

- Scope review checks touched files and user-visible strings for overlap.
- A focused test or snapshot confirms existing sibling output contracts are
  consumed when present, not duplicated.

### M1 - Generated Metadata Manifest

Subitems:

- Add a current-run generated metadata manifest produced by `done_prepare`.
- Include file path, before hash, after hash, producer phase, reason, and whether
  the file is safe to auto-stage.
- Reuse the existing lifecycle artifact classifier and registry rather than
  hard-coding `.lattice/story/actives/<storyId>/`.
- Allow only Proofbound story lifecycle metadata under the current story id,
  including configured `storyDir` shapes already accepted by the classifier.
- Mark command-backed evidence separately from ordinary lifecycle projection
  files.
- Exclude any file not produced by the current command invocation.

Verification:

- A fixture where `done_prepare` writes `done-required-evidence.json` and
  `test-evidence.json` records both files in the manifest.
- A pre-existing dirty lifecycle file is not considered current-run generated
  metadata.
- A file rejected by the lifecycle artifact classifier fails the manifest safety
  classifier even if it lives somewhere under `.lattice/`.
- A configured `storyDir` fixture proves the manifest does not depend on one
  hard-coded story path.

### M2 - Safe Auto-Commit

Subitems:

- Add an explicit opt-in auto-closeout flag.
- Before staging, re-read git status and refuse if any non-manifest dirty file
  or staged index entry exists.
- Stage files using the manifest path list only; never run broad `git add .`.
- Commit with a deterministic message such as
  `lattice: auto-close <storyId> generated DONE metadata`.
- Refuse if the commit would include runtime/source/docs/user files.
- Refuse if commit hooks fail; do not bypass hooks with `--no-verify`.
- Refuse if Git author/committer identity is unavailable.
- Print the generated commit sha and the exact files committed.

Verification:

- Success fixture commits only current-run generated lifecycle metadata.
- Unrelated modified docs, untracked files, runtime changes, deleted files, and
  unsafe renames all block before commit.
- Pre-staged files block before commit unless they are exactly the current-run
  manifest files.
- Commit hook failure blocks and leaves the worktree inspectable.
- No stash, checkout, reset, clean, push, publish, or release command is invoked.

### M3 - Fresh-Validation Reuse Gate

Subitems:

- After the safe metadata commit, recompute materialHash and storyFilesHash.
- Recompute validation commandSetHash and DONE-required commandSetHash.
- Recompute concrete policy/config inputs:
  scope contract hash, lifecycle classifier/registry version, validation command
  configuration hash, DONE-required command configuration hash, and relevant
  Lattice gate policy/config hash.
- Permit validation reuse only when all hashes match the prior PASS evidence.
- Preserve the prior command transcript and add a metadata-only reuse record to
  `done-required-evidence.json` rather than pretending commands were rerun.
- Refuse reuse and run normal validation when any material, storyFiles, command,
  policy, or required-evidence input changed.

Verification:

- Metadata-only HEAD drift reuses fresh validation and does not execute the full
  configured validate command list.
- A material source edit after the prior validate forces normal validation.
- A command config change forces normal validation.
- A scope contract or lifecycle classifier change forces normal validation.
- A stale or failed DONE-required command forces normal validation or a hard
  blocker, never reuse.

### M4 - Single-Shot Prepare Re-evaluation

Subitems:

- Re-run DONE closure projection after the safe metadata commit.
- Re-run runtime-change classification without mutating version files.
- Re-run clean-tree classification.
- Return PASS when only generated metadata was blocking and all other gates are
  satisfied.
- Preserve the existing refusal when the story is not in TEST.
- If a real blocker remains, surface the canonical blocker from B-eb92/B-b264
  rather than inventing a new explanation.
- Print the next legal command, normally `story_advance --phase=DONE`.

Verification:

- A fixture that previously required
  `done_prepare -> commit -> done_prepare` now reaches PASS in one opt-in
  command.
- A fixture with missing review assurance still blocks and does not auto-write a
  verdict or fallback.
- A fixture with generated metadata plus unrelated dirty files blocks before
  commit.
- A fixture in DONE or any non-TEST phase refuses at normal `done_prepare`
  preflight and does not attempt auto-closeout.

### M5 - Regression and Safety Coverage

Subitems:

- Add a focused smoke script for auto-closeout.
- Cover human and JSON modes.
- Assert JSON stdout stays parseable if the flag supports `--json`.
- Assert no review, host, delivery, fallback, Authority, release, or production
  evidence is auto-written.
- Assert no unrelated dirty files are staged or committed.
- Assert no remote commands are called.
- Assert dispatch / worker / role prompt behavior is untouched.
- Run current-main sibling smokes that exist for the consumed surfaces, while
  treating unmerged sibling-story smokes as future integration coverage rather
  than B-fbcf completion criteria.

Verification:

- Focused smoke passes after `npm --prefix packages/main run build`.
- Existing current-main done_prepare heartbeat and review-assurance smokes still
  pass.
- If B-b264 rerun/merge smoke exists in the merged baseline, it still passes;
  if it does not exist yet, B-fbcf verifies non-duplication and leaves the
  sibling acceptance to B-b264.

## Checklist Mapping

Recommended story checklist:

1. Implement generated metadata manifest and no-overlap guard.
2. Add opt-in safe auto-commit for manifest-only lifecycle metadata.
3. Add validation reuse gate for metadata-only HEAD drift.
4. Re-evaluate DONE prepare after safe auto-closeout and return canonical next
   action.
5. Add smoke coverage for safety, JSON cleanliness, and no auto-sign/no remote
   behavior.

## Done Means

The work is complete when a story that only needs to commit current-run
`done_prepare` generated lifecycle metadata can use one explicit opt-in command
to commit those files, reuse still-valid validation evidence without rerunning
the full validate suite, re-evaluate DONE prepare, and print the next legal DONE
command, while every unsafe or authority-sensitive case still fails closed.

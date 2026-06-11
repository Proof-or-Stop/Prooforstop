# Plan for B-e74e

## Current-State Baseline

The current DONE transition already has a pre-write block: transition-orchestrator calls runDonePreMergeGate before actor.send/writeStory, and that gate checks DONE oracle rows, stray-file offenders, and merge-tree cleanliness from the story worktree. The real merge and worktree cleanup still live in applyDoneMergeEffects after phase=DONE is persisted. This story extends the pre-write block to validate the actual main merge target before terminal metadata is written.

## CHK-001

Production behavior: add a preflight that resolves the registered main worktree, verifies it exists, is on branch main, is clean, and can accept the story branch/HEAD merge before actor.send. Failures must throw a Cannot enter DONE-style error before store.writeStory persists phase=DONE. A failed preflight leaves the story in TEST with the story branch/worktree intact.

Expected abnormal transcript: `Cannot enter DONE: main worktree is unavailable or not on branch main; phase remains TEST; cd "<actual-main-worktree>" ...`.

Normal path: if main is available and clean, the command proceeds to the existing DONE checklist, metadata commit, merge, worktree cleanup, and branch deletion.

## CHK-002

Recovery/hint behavior: share the same main-worktree resolution language with done_recover and partial-DONE summaries. When main is not the current checkout, messages must name the actual registered main worktree and tell the user to `cd "<actual-main-worktree>"` before manual merge/recovery commands. When main is already current and clean, output should stay calm and should not emit an unnecessary cd hint.

## CHK-003

Regression coverage: add or extend a focused smoke in a temporary git repo. It must simulate a multi-worktree/main-unavailable or wrong-main-owner condition, run the DONE transition preflight path, and assert the story phase remains TEST and no partial-DONE metadata/cleanup happened. It must also cover the normal main-current or main-available path enough to prove no regression in success semantics. Verification must include build plus focused smoke/process contract commands.

## Boundaries

Allowed implementation files are the DONE transition/recovery surfaces and focused smoke/test wiring. Out of scope: changing unrelated lifecycle phases, changing story JSON by hand, changing global managed assets, or rewriting the whole DONE pipeline.

## Trigger Event

During the round-4 cross-host audit (2026-07-18), both codex and agy independently found two portability defects in the validation/receipt subsystem that void B-914f's cross-host serialization assumption and cause false command-spec-digest-mismatch failures. Intake probe rp-mrqfk0cx-bvnp86 reproduced both deterministically (2/2 assertions fail); repro review rr-mrqfkaj9-hj45oz classified them target-bug.

## Key Insights

Two independent root causes, both "assume a single projectRoot":

1. **Lock is per-projectRoot, not per-story-shared.** `validationExecutionLockPath(root, storyId)` (packages/main/src/core/validation-execution-lock.ts:128) returns `join(projectRoot, VALIDATION_EXECUTION_LOCKS_REL, ...)` (the `join(...)` is at :133). Two linked worktrees of the same story have different `root` values, so they mint DIFFERENT lock files (`.lattice/locks/validation/<id>.lock` under each worktree) and never serialize against each other. Any cross-host or cross-worktree validation/reuse for the same story runs unserialized.

2. **Command-spec digest embeds an absolute cwd.** `buildDoneRequiredCommandSpecEnvelope` (done-required-validation.ts:147) sets `cwd: normalizedCommandCwd(projectRoot, ...)` (:328), and `commandCwd` (:323) returns `projectRoot` or `resolve(projectRoot, cwd)` — an ABSOLUTE path — which then participates in the digest. The same logical command (`npm test`, cwd `.`) therefore digests differently under `/…/proofbound` vs `/…/.worktrees/B-231d`, producing a false `command-spec-digest-mismatch` when a receipt recorded on one host is verified on another.

## Solution Tradeoffs

Derive the validation lock identity from a canonical shared root — the git common directory (`git rev-parse --git-common-dir`) or the resolved metadata root that DONE writes — so every worktree/host of the same story resolves the SAME lock. Digest a repo-root-RELATIVE logical cwd (recording the resolved physical workspace separately as non-digested provenance) so identical logical commands digest identically across roots. Because the digest shape changes, version the receipt/command-spec envelope (`schemaVersion` bump) with a migration that accepts old-shape receipts during transition rather than hard-failing legacy evidence. Fail-closed behavior for genuinely different commands is preserved; only incidental root differences stop mattering.

## Conversational Texture

The maintainer wants Proof-or-Stop to run unattended across multiple hosts/worktrees without validation locks silently failing to serialize and without portable receipts falsely mismatching. Success is: the same story serializes validation across worktrees, and a receipt recorded on host A verifies on host B for an unchanged logical command.

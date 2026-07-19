# Plan: B-231d worktree/host portability

## CHK-001 Derive validation lock identity from a canonical shared root

Problem: validationExecutionLockPath (validation-execution-lock.ts:128) returns join(projectRoot, ...) at :133, so two worktrees of the same story mint different locks and never serialize.

Approach: resolve the lock ROOT from the git common dir (git rev-parse --git-common-dir) or the canonical metadata root, so every worktree/host of the same story shares one lock path. Keep the same sanitized per-story filename.

Acceptance: worktree-portability smoke asserts validationExecutionLockPath(rootA, id) === validationExecutionLockPath(rootB, id) for two worktree roots; different storyIds still differ.

## CHK-002 Digest a repo-relative logical cwd with versioned receipt-envelope migration

Problem: buildDoneRequiredCommandSpecEnvelope (done-required-validation.ts:147) digests an absolute normalizedCommandCwd (:328 -> commandCwd :323), so identical logical commands digest differently across roots.

Approach: digest a repo-root-RELATIVE logical cwd; record the resolved absolute workspace separately as non-digested provenance. Bump the envelope schemaVersion and accept old-shape receipts during migration rather than hard-failing legacy evidence.

Acceptance: smoke asserts identical logical-command digests across two roots; genuinely different commands still differ; old-shape receipts still verify.

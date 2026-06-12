# B-3787 Implementation Plan

This plan implements the approved review_run_start workspace diagnostics execution plan. It is intentionally narrow: fix only correctness issues in signed workspace resolution, failure diagnostics, and regression coverage. Local host output remains non-authority evidence and cannot create productionDone, receiptVerified, or authorityChanged.

## CHK-001

**Owner**: main-agent

**Goal**: Make review_run_start prove the signed workspace is usable before writing reviewer-run or legacy currentReviewRound metadata.

**Scope**:
- Modify packages/main/src/handlers/context.ts only to expose a small read-only resolver for story worktree cwd and canonical root checks.
- Modify packages/main/src/core/review-run.ts only for snapshot diagnostics/classification and error wording.
- Modify packages/main/src/handlers/review-run.ts only to order checks as story read -> workspace/snapshot readiness -> currentReviewRound repair -> signed run write.

**Implementation**:
1. Add a helper that resolves the signed workspace for review_run_start. If the story has a recorded worktree, process.cwd must be inside that worktree and ctx.root must canonicalize to that worktree root; otherwise fail closed before signing. If there is no story worktree, direct REVIEW may use ctx.root for git-backed review-only flows.
2. Add snapshot readiness classification for not_git_repo, missing_head, and missing_material_hash. The message must say no reviewer run was created and provide the concrete next action.
3. Move legacy ensureCurrentReviewRound repair after successful workspace and snapshot readiness checks. The story must still be in REVIEW before any signed reviewer run can be created.
4. Keep scope binding behavior unchanged, using the same verified snapshot root for diff/scope material.

**Verify**:
- npm --prefix packages/main run build
- npm --prefix packages/main run test:field-regression-cli-smoke
- npm --prefix packages/main run test:review-loop-smoke

**DoneWhen**: review_run_start success still signs real HEAD/materialHash, while non-git, unborn HEAD, wrong worktree, and root mismatch cases fail before metadata mutation with specific diagnostics.

## CHK-002

**Owner**: main-agent

**Goal**: Lock the behavior with non-authority and Authority boundary regressions.

**Scope**:
- Extend packages/main/src/tasks/field-regression-cli-smoke.ts for direct REVIEW, legacy repair ordering, non-git/no-commit no-write behavior, wrong worktree/root mismatch, and review_loop regression preservation.
- Rely on existing Authority smoke commands unless a real gap is found. Do not add a new Authority abstraction for review_run_start.

**Implementation**:
1. Add field-regression cases proving direct REVIEW review_run_start still succeeds in a git-backed project.
2. Add negative cases proving legacy REVIEW currentReviewRound repair occurs only after snapshot readiness, and that failed snapshot cases do not write review-runs metadata.
3. Add a root/worktree mismatch regression where cwd is the story worktree but LATTICE_PROJECT_ROOT or --root points elsewhere; assert fail-closed before signing.
4. Preserve review_loop_start placeholder rollback hash and empty trigger validation.
5. Run Authority boundary tests to confirm local host output, local reviewRunId, and local success text cannot set productionDone, receiptVerified, or authorityChanged.

**Verify**:
- npm --prefix packages/main run build
- npm --prefix packages/main run test:field-regression-cli-smoke
- npm --prefix packages/main run test:review-loop-smoke
- npm --prefix packages/main run test:authority-boundary-smoke
- npm --prefix packages/main run test:authority-gate-consumption
- npm --prefix packages/main run test:baseline-local-certification-smoke
- npm --prefix packages/main run test:worktree-authority-smoke if shared cwd/worktree logic changes beyond the review_run_start resolver.

**DoneWhen**: required smoke commands pass and the implementation never treats local Claude/Codex host text, local reviewer runs, or local reviewRunId values as Authority Server gate_decision receipts.

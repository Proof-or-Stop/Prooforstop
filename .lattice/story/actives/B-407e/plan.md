# B-407e Plan

## Goal
Make the current project convergence report clean for annotation compliance by fixing the 64 `@task` validation errors without changing executable behavior.

## CHK-001 — Repair malformed `@task` annotation blocks reported by lint tasks

### Scope
Only update comment/annotation text at the locations reported by `npm run lint:tasks`. Do not change imports, exports, function signatures, runtime logic, tests, CLI behavior, or Koala gates.

### Touchpoints
- packages/main/src/core/auto-commit-metadata.ts
- packages/main/src/core/dirty-gate-policy.ts
- packages/main/src/core/dirty-worktree.ts
- packages/main/src/core/validation-executor.ts
- packages/main/src/core/validation-types.ts
- packages/main/src/handlers/story-advance.ts
- packages/main/src/handlers/verifier.ts
- packages/main/src/tasks/flow-stability-smoke.ts

### Implementation Guidance
For file-level story metadata that should remain structured, complete required fields from docs/requirements/decisions/annotation-system.md. For inline explanatory comments such as `// @task B-4b22: ...`, convert the tag to non-structured prose such as `// Task B-4b22: ...` so the validator no longer treats it as an incomplete annotation block.

### Guardrail
Diff review must show comment-only changes. If any non-comment code changes appear, stop and justify before proceeding.

## CHK-002 — Verify annotation lint and convergence become clean

### Required Verification
- `npm run lint:tasks` exits 0 and reports all task annotations valid.
- `koala convergence_check` no longer fails on `代码注释合规`.
- `npm --prefix packages/main run build` exits 0.

### Optional Verification
Run focused smoke tests only if the comment changes affect test-linked metadata in a way reviewers consider risky.

## Rollback
Because this is intended to be comment-only, rollback is a normal git revert of the cleanup commit. No runtime data migration or persisted state repair is expected.

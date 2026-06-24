# B-ef65 Execution Plan

## Scope

Formalize the already-proven validate execution lock fix inside the normal Lattice story lifecycle. The implementation path is known from red/spike evidence: red commit bac345a80, green commit 8248dc50d, and non-regression commit 5c643b627. This story exists to deliver that proven change through audited PLAN, DEV, REVIEW, TEST, and DONE gates while recording workflow friction.

## Principles

- Fix only the demonstrated workflow correctness issue: same-story validate execution can overlap and pollute gate evidence.
- Keep the solution host-neutral and agent-neutral. The lock belongs to Lattice workflow execution, not Codex, Claude, or any single host.
- Do not optimize arbitrarily. Do not add global serialization, owner-lease redesign, Authority server changes, or adapter namespace changes.
- Preserve unrelated concurrency and metadata writes.

## Rollback

If the lock blocks unrelated workflow commands or causes self-deadlock, revert the story code commit and keep the red/spike evidence as the explanation for a narrower follow-up. No data migration is involved.

## CHK-001

Apply the proven story-scoped validate execution lock implementation. Create packages/main/src/core/validation-execution-lock.ts and wrap the validation command path in packages/main/src/handlers/verifier.ts. Wrap packages/main/src/handlers/done-required-validation.ts with the same story lock so routine validate and DONE-required validate share one execution boundary.

Expected verification: npm --prefix packages/main run build passes, and the smoke proves same-story exclusion, different-story concurrency, stale lock recovery, reviewer/delivery non-blocking behavior, story_advance internal validate, reentrancy, and done_required_validate sharing.

Non-goals: no owner lease redesign, no project-global validate lock, no Authority server change, no host-specific Codex or Claude behavior.

## CHK-002

Carry the red/green regression smoke into the story worktree as packages/main/src/tasks/validate-execution-lock-smoke.ts. The smoke is the story regression artifact and should remain focused on validate execution locking rather than becoming a broad lifecycle simulator.

Expected verification: after build, node packages/main/dist/tasks/validate-execution-lock-smoke.js prints validate-execution-lock smoke passed: 8 assertions.

Non-goals: do not add slow full-suite pytest or unrelated Lattice stories to this regression.

## CHK-003

Record the story-to-DONE experiment friction and timing in summary evidence. The experiment began at 2026-06-24T01:02:46Z. Record observed friction including dirty canonical root before story creation, story_create background schema requirements, high-risk auto-elevation, INIT preflight artifacts, worktree dependency symlinks, PLAN review blockers, scope reviewer evidence, review/test evidence, and any stale evidence or DONE gate loops.

Expected verification: summary_set includes elapsed time and differentiates implementation correctness evidence from process friction.

Non-goals: do not claim this story proves full production Authority readiness or unattended development beyond the validate-lock correctness fix.

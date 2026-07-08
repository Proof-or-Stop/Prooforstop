# Plan

## CHK-001

Goal: freeze the M0 drivability baseline contract in the decision artifact without claiming the full autonomous fixture has been rerun.

Steps:
1. Review docs/requirements/decisions/pos-agent-drivability-optimization.md for the M0/M6 validation language.
2. If needed, tighten the M0 baseline wording so commands-to-DEV, timeout meaning, and comparison rules are explicit.
3. Record verification evidence as a docs check, not as a runtime pass.

Verify:
- Inspect the decision doc for the exact baseline: 80+ commands, never reached DEV.
- Confirm the text says future M6 runs compare against M0 and do not treat agent narration as proof.

Out of scope: running the full fix-git autonomous experiment in this story.

## CHK-002

Goal: route INIT session guidance through init_preflight.

Steps:
1. Update the INIT branch in packages/main/src/handlers/session.ts so session_brief and next name lattice init_preflight --storyId=<id> before story_advance INIT_CHECK.
2. Preserve the existing non-git repository guidance.
3. Keep the wording clear that init_preflight is read-only and does not create worktrees or write evidence.

Verify:
- Run or add focused tests for INIT session guidance.
- Manually inspect lattice session_brief / lattice next output for an INIT story if needed.

## CHK-003

Goal: route story_create and top-level help INIT flow through init_preflight.

Steps:
1. Update story_create INIT success guidance in packages/main/src/handlers/story-create.ts.
2. Update the global development-flow block in packages/main/src/cli/help-renderer.ts.
3. Keep the downstream worktree path visible after prerequisites are ready.

Verify:
- Focused assertions or CLI transcript show story_create/global help mention init_preflight before direct INIT_CHECK advancement.
- Confirm wording does not include M2-M7 behavior.

## CHK-004

Goal: add INIT_CHECK failure guidance toward init_preflight without weakening the gate.

Steps:
1. Update packages/main/src/core/machine.ts or related INIT_CHECK failure rendering so the first missing-prerequisite failure tells the agent to run lattice init_preflight --storyId=<id>.
2. Keep evaluateScopeAntiExpansionGate fail-closed for this story unless only guidance text is changed.
3. Preserve init_check_repair as a controlled fallback, not an exemption.

Verify:
- A missing INIT prerequisite failure includes init_preflight guidance.
- Tests confirm no wording claims reviewer/scope evidence is optional.

## CHK-005

Goal: protect M1 routing behavior with focused tests.

Steps:
1. Locate the smallest stable test/smoke file for CLI guidance output.
2. Add focused assertions for session guidance, story_create hint, and INIT_CHECK failure guidance.
3. Avoid brittle full-help snapshots.

Verify:
- Run the focused tests.
- Run build or the relevant package test command if touched files require it.
- Confirm tests fail on wording that claims init_preflight writes evidence, launches reviewers, advances phase, or grants production/readiness authority.

## CHK-006

Goal: remove the story-level scope-plan reviewer dispatch dead-end so future agents do not discover the missing dispatch path only after PLAN review blocks.

Steps:
1. Inspect packages/main/src/handlers/story-dispatch.ts existing INIT reviewer and item-scoped reviewer prompt builders.
2. Add the minimal story-level branch for agentType lattice-review-scope-plan when no itemId/findingId/clusterId is supplied.
3. Add a prompt builder that tells the reviewer to perform story-level PLAN scope review and finish by calling scope_check_save with covered/excluded/gap/orphan-suspect rows and openQuestions when needed.
4. Update missing_scope_check guidance in packages/main/src/handlers/story-review.ts only if needed so it names the new dispatch path.
5. Keep scope_check_save as reviewer-written evidence; dispatch output alone is not gate evidence.

Verify:
- lattice dispatch with storyId and agentType lattice-review-scope-plan succeeds without itemId.
- Existing INIT reviewer dispatch and item-scoped reviewer dispatch still work.
- story_review still blocks until scope_check_save exists.

Out of scope: full M4 open-question UX redesign, main-agent self-signing, or any gate exemption.

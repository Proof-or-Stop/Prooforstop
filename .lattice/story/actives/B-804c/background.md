## Trigger Event
On 2026-06-15 a ClawCreek user (Lattice 0.3.5) ran lattice story_advance --phase=INIT_CHECK; it reported 'advanced to INIT_CHECK' AND then '⚠ Failed to create worktree' (storyDir not inside resolved gitRoot). Advancing to PLAN then succeeded, but story_resolve reported requiresWorktree=true with no worktree on disk, and story_advance back to INIT_CHECK was rejected ('Cannot transition from PLAN to INIT_CHECK'). The story was unrecoverable. Verified in source at cli-engine.ts:4003/4010/4022-4024 and machine.ts:503-508.

## Key Insights
The non-atomic sequence is the root cause: phase is written before the side-effect (worktree bootstrap) that the phase implies. Lattice's phase machine is forward-only, so there is no backward edge to retry INIT_CHECK, and there is no idempotent re-bootstrap command. The fix is transactional: persist the new phase only after bootstrap succeeds, or roll the phase back if bootstrap throws, and/or expose a supported recovery command for stories already stuck in this state.

## Solution Tradeoffs
Option A (defer write): only writeStory(INIT_CHECK) after dev_start bootstrap returns success — cleanest, but must ensure no other code already read the in-memory advanced phase. Option B (rollback on failure): keep current order but catch bootstrap failure and revert phase + emit a clear error — smaller diff, but rollback must be complete (phase + any mirror). Option C (recovery command): add lattice worktree re-bootstrap / a guarded INIT_CHECK re-entry for already-stuck stories — necessary regardless to heal existing victims. Likely A or B for the forward fix PLUS C for recovery. Risk: touching the xstate machine + phase persistence is high-blast-radius; needs preMortem and regression tests for partial-advance.

## Conversational Texture
Surfaced alongside three sibling Lattice bugs in a ClawCreek wrapper-root report; the user asked to open a story for each and dispatch a driver agent per story. This story is scoped to the atomicity/recoverability defect only; the gitRoot cwd resolution (B-2856) and the .lattice data-loss model are tracked separately to keep each diff and review surface focused.

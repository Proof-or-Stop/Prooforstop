# Plan: B-d877 transition integrity

## CHK-001 Route dev_finish and dev_merge through runStoryTransition

Problem: dev_finish (worktree.ts:997) and dev_merge (:1061) advance phase by driving a raw XState actor and writing story.phase directly, skipping runStoryTransition (:364). They never mint currentReviewRound, never append a phase_transition process-event, and push a story.events entry hardcoded to TEST even though the DEV CODE_REVIEW target is REVIEW.

Approach: replace the raw actor+write block in dev_finish (and the analogous block in dev_merge) with an await runStoryTransition(ctx, {storyId, phase: <target>}) call, preserving the existing worktree preconditions (uncommitted-change guard, auto-add). The handler keeps its worktree-specific pre/post text but delegates the lifecycle write entirely to the orchestrator.

Acceptance: the transition-integrity smoke asserts, after dev_finish on a completed DEV fixture story, phase==REVIEW, a non-empty currentReviewRound, a phase_transition event with toPhase==REVIEW, and no TEST-mislabeled event. All four currently fail; all four pass after the fix.

## CHK-002 Serialize same-owner concurrent transitions with a per-story transition lock

Problem: runStoryTransition reads the story (:425) then persists phase and review round (:660) non-atomically; the owner lease rejects only foreign sessions (ownership-gate.ts:282), so two concurrent same-owner transitions can both observe the same pre-transition state.

Approach: add a small per-story transition lock primitive (core/story-transition-lock.ts) and hold it in runStoryTransitionInner across read -> gate -> persist for non-DONE transitions (DONE already holds the main write lock). The second concurrent attempt serializes and re-reads the committed state.

Acceptance: the smoke launches two concurrent DEV->REVIEW transitions for the same story and asserts exactly one currentReviewRound and one phase_transition event result.

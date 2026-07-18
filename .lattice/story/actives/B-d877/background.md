## Trigger Event

A round-4 cross-host audit (codex + agy) of two gate-hardening execution plans discovered a pre-existing defect on current `main`: the registered worktree handlers `dev_finish` (packages/main/src/handlers/worktree.ts:997) and `dev_merge` (:1061) advance a story's phase by driving a raw XState actor and then writing `story.phase` directly, instead of routing through the canonical transition orchestrator `runStoryTransition` (packages/main/src/handlers/transition-orchestrator.ts:364).

A repro (candidate probe rp-mrqf6efm-6wotja, red-reviewed target-bug rr-mrqf729k-l0qs9c) builds a clean git-worktree fixture story in DEV with a completed checklist, calls `dev_finish`, and asserts the orchestrator-grade effects. On current main, 4 assertions fail: no `currentReviewRound` is minted, no `phase_transition` process-event is appended, and the `story.events` entry is labelled `TEST` even though the DEV `CODE_REVIEW` target is REVIEW.

## Key Insights

`runStoryTransition` is the single door that, when advancing to REVIEW, mints a new `currentReviewRound`, appends a `phase_transition` process-event bound to material/story-files hashes, runs scope/ProofStory gates, and fires phase-change hooks (transition-orchestrator.ts:655-690). `dev_finish`/`dev_merge` reproduce only the actor `send` and the phase write, so every orchestrator-level effect and gate is skipped. Because all worktree handlers are registered wholesale (registry.ts:182), these remain reachable alternate doors into REVIEW.

A second, related defect: same-owner concurrent transitions are not serialized. The orchestrator reads the story then persists phase and review round non-atomically (transition-orchestrator.ts:425 then 660), and the owner lease rejects only foreign sessions, not concurrent commands from the same owning session (cli/ownership-gate.ts:282). Two concurrent DEV to REVIEW attempts can both act on the same pre-transition state.

## Solution Tradeoffs

The fix routes `dev_finish`/`dev_merge` through `runStoryTransition` (or removes them from the registry in favour of it) so no lifecycle write happens outside the orchestrator, and adds a per-story transition lock held across read then gate then persist so same-owner concurrent transitions serialize. It must not change what `runStoryTransition` already enforces, nor touch the separate S2 (lock-root/digest portability) or W1/W2/W3 gate work.

## Conversational Texture

The maintainer wants the audit-discovered defect closed as a small, focused correctness fix: after this story, no registered command can advance a story's phase without going through the orchestrator, and concurrent same-owner transitions cannot double-mint review rounds. DEV, cross-host REVIEW, TEST validation, and DONE evidence must prove the actual fix.

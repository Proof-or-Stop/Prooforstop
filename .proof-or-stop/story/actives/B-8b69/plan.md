# Plan: B-8b69 Add gated PLAN->INIT reopen for scope-flagged frozen titles

## CHK-001: Add a gated PLAN->INIT reopen transition to the story state machine

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/lifecycle-registry.ts (add REOPEN to LifecycleEventType + a {from:PLAN,to:INIT,event:REOPEN,kind:rollback} transition), packages/main/src/core/machine.ts (REOPEN event type, PLAN state REOPEN edge + canReopenToInit guard, canSendStoryEventWithoutSnapshotCan PLAN case), packages/main/src/handlers/transition-orchestrator.ts (map PLAN->INIT to REOPEN, require+thread reason, add reopen to cwd gate), packages/main/src/handlers/story-advance.ts (thread reason arg), packages/main/src/cli/command-catalog.ts (add reason to story_advance schema)
- Create: none
- Test: packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts

**Verify**:
- `story_advance {phase:INIT,reason:...}` from a PLAN worktree prints "advanced to INIT"
- `story_advance {phase:INIT}` with no reason prints a refusal; reopen from DEV/REVIEW is refused

**DoneWhen**:
- PLAN->INIT is a legal, reason-gated transition from PLAN only
- All existing transitions remain byte-identical (no new edges elsewhere)

## CHK-002: Fix dev_start worktree-reuse so a bounce from inside the worktree reuses it

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/worktree.ts (resolveWorktreePath resolves story.worktree.path against resolveMainRepoRoot/--git-common-dir; storyRel defense-in-depth strips any worktree-dir prefix)
- Create: none
- Test: packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts

**Verify**:
- `story_advance phase=INIT_CHECK` re-advance from inside the worktree prints "advanced to INIT_CHECK", reusing the worktree
- The "Branch ... does not contain .worktrees/..." false-fail no longer appears

**DoneWhen**:
- The reuse early-return fires when dev_start runs from inside the worktree
- dev_start from the main root stays byte-identical

## CHK-003: Correct the contradictory title-freeze guidance to point at reopen-to-INIT

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/handlers/checklist.ts (title/context refusal message names story_advance --phase=INIT, not INIT_CHECK)
- Create: none
- Test: packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts

**Verify**:
- checklist_update of a title at PLAN prints a refusal naming reopen-to-INIT
- The message no longer says "back to INIT_CHECK"

**DoneWhen**:
- INIT_CHECK stays in titleContextProtectedPhases (invariant preserved)

## CHK-004: Add a round-trip smoke proving the reopen recovery works from inside the worktree

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: none
- Create: packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts
- Test: packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts

**Verify**:
- `node packages/main/dist/tasks/plan-init-reopen-roundtrip-smoke.js` passes GREEN after the fix
- The same smoke fails RED against pre-fix code

**DoneWhen**:
- The smoke drives story_create -> INIT_CHECK -> PLAN -> reopen INIT -> edit title -> re-review -> re-advance entirely from inside the worktree with no git surgery or checklist.json hand-edit
- It is auto-discovered by run-all-smokes (test:all)

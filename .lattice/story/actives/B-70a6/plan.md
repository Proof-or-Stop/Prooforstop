# Plan: B-70a6 Persist the gated PLAN->INIT reopen reason into the phase_transition audit event and correct two overstated comments

Chosen option: `additive-phase-transition-fields` (see decision.json).

Execution note: a reference implementation of all three items already exists as
three single-purpose commits cherry-picked onto this story branch
(`1b862c4dae`, `da13aae271`, `5cb5914f0a`). Each item below is dispatched to a
fresh `lattice-implementer` whose job is to independently verify that commit
against the item's DoneWhen and verificationIntent, correct it if it falls short,
and produce the verification evidence. Implementers must not manufacture
evidence: if a check cannot be run, say so rather than asserting a pass.

## CHK-001: Persist the reopen reason into the phase_transition audit event

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/transition-orchestrator.ts
- Test: packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts

**Verify**:
- `npm --prefix packages/main run build` clean
- `node packages/main/dist/tasks/plan-init-reopen-roundtrip-smoke.js` prints both success lines
- `node packages/main/dist/tasks/flow-stability-smoke.js` passes (proves the builder deepEqual shape test still holds for normal transitions)
- `npm run test:process-fact-contract` passes

**DoneWhen**:
- `buildPhaseTransitionProcessEvent` accepts optional `transitionType` / `reason` and appends each ONLY when defined
- The call site passes them ONLY when `eventType === 'REOPEN'`, so a normal transition's event keeps a byte-identical shape
- The round-trip smoke reads the persisted JSONL via `StoryStore.readProcessEvents` and asserts `transitionType === 'reopen'` plus the verbatim reason
- A refused reopen (missing/short reason) still leaves phase at PLAN and appends no success event

## CHK-002: Correct the overstated REOPEN checklist-reset atomicity comment

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/transition-orchestrator.ts

**Verify**:
- `grep -c "land together or not at all" packages/main/src/handlers/transition-orchestrator.ts` returns 0
- `npm --prefix packages/main run build` clean (comment-only change must not affect compilation)

**DoneWhen**:
- The comment states the real guarantee: concurrency-atomic via the mkdir persist claim, ordered so the phase write lands last
- The comment explicitly says it is NOT crash-transactional (two separate fs writes)
- The comment names the residual crash window and why that direction is safe
- No behavioral code changed by this item

## CHK-003: Clarify the scope of the dev_start worktree prune

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/handlers/worktree.ts

**Verify**:
- `grep -n "live sibling" packages/main/src/handlers/worktree.ts` shows the new comment above `pruneWorktreeRegistry`
- `npm --prefix packages/main run build` clean (comment-only change)

**DoneWhen**:
- The comment documents that `git worktree prune --expire now` cannot remove a live sibling worktree
- The comment documents that `--expire now` is repo-wide over every currently-missing registration, not scoped to the calling story
- The comment warns callers not to rely on it touching only their own entry
- No behavioral code changed by this item

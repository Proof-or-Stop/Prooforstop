# Gated PLAN→INIT reopen for scope-flagged frozen titles (B-8b69)

## Problem

When a PLAN scope review legitimately flags a frozen checklist title/context on a
worktree'd story, there is no sanctioned way to fix it. The documented recovery —
`lattice story_advance --phase=INIT_CHECK` — fails for two independent reasons:

1. **dev_start path/reuse bug.** Run from inside the worktree, `dev_start`'s reuse
   early-return resolves `story.worktree.path` via `getRepoRoot()`
   (`git rev-parse --show-toplevel` = the worktree itself), double-nesting to a
   non-existent path, so it clears the worktree record and re-bootstraps; the
   re-bootstrap computes `storyRel` against `resolveMainRepoRoot()`
   (`--git-common-dir` = main), yielding a `.worktrees/<id>/`-prefixed path that the
   branch-content guard false-fails ("Branch … does not contain
   .worktrees/<id>/.lattice/…/index.json").
2. **No backward machine edge.** `machine.ts` PLAN state has only `START→DEV`; there
   is no PLAN→INIT_CHECK or PLAN→INIT edge, so even with the path bug fixed the
   transition is illegal.

A third contradiction: `checklist.ts` keeps title/context frozen at INIT_CHECK too
(only INIT unfreezes), yet the guidance says "bounce to INIT_CHECK to change title".

## Decision

Add a **gated PLAN→INIT reopen** transition. INIT is the only phase where
`checklist_update` permits title/context edits, so reopening to INIT actually
restores the flagged-title recovery **without weakening** the INIT_CHECK scope-freeze
invariant.

- Command: `lattice story_advance '{"storyId":"B-x","phase":"INIT","reason":"…"}'`.
- New machine event `REOPEN`, PLAN→INIT edge guarded by `canReopenToInit`
  (PLAN-only, owner-lease gated). A non-empty `reason` is required and enforced in
  the transition orchestrator.
- Fix `resolveWorktreePath` to resolve the always-main-relative `story.worktree.path`
  against the main repo root (`resolveMainRepoRoot`) for all callers, so the
  re-advance INIT→INIT_CHECK from inside the existing worktree reuses it instead of
  false-failing. `storyRel` gets the same defense-in-depth so the branch-content
  guard never sees a `.worktrees/` prefix.
- Correct the contradictory `checklist.ts` guidance to name the reopen-to-INIT path.
- Add a permanent round-trip smoke that reopens → edits a title → re-reviews →
  re-advances entirely from inside the worktree; RED before the fix, GREEN after.

## Rejected alternative

Reopen to INIT_CHECK and drop INIT_CHECK from `titleContextProtectedPhases`. Rejected
because it weakens the scope-freeze invariant (reopens the remove+re-add bypass the
freeze prevents) for no real simplification — the dev_start path bug must be fixed
either way.

## Invariants preserved

- INIT_CHECK stays in `titleContextProtectedPhases`; only INIT unfreezes title/context.
- `dev_start` from the main root stays byte-identical (`story.worktree.path` is
  main-relative and `getRepoRoot()==main` there).
- The reopen re-enters the full INIT→INIT_CHECK gate (scope-freeze + INIT review) on
  the way back, so no downstream gate is bypassed.

## Checklist coverage

- CHK-001 → machine edge/event/guard + orchestrator mapping + `reason` schema.
- CHK-002 → dev_start worktree-reuse/storyRel path fix.
- CHK-003 → corrected title-freeze guidance.
- CHK-004 → round-trip smoke (RED→GREEN).

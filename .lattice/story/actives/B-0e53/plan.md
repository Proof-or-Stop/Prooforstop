# Plan — Abort DONE before persist on external main advance (pre-merge mainSha re-check)

Close the one residual DONE race left by the existing main-write-lock: an EXTERNAL
git advance to main between the DONE pre-check sync (`autoSyncMain`) and the in-lock
merge. Fail closed: abort BEFORE `phase=DONE` persists, leaving the story at TEST.

All work is in `packages/main/src/handlers/transition-orchestrator.ts` (the re-check)
plus ONE new smoke. The main-write-lock and `applyDoneMergeEffects` (the merge) are
unchanged. No after-DONE auto-retry.

## CHK-001

Add the post-lock, pre-merge `mainSha` re-check + abort in
`packages/main/src/handlers/transition-orchestrator.ts`.

- In the DONE branch, immediately AFTER `autoSyncMain` completes (~line 325),
  capture the post-sync baseline: `const syncedMainSha = <read main's current sha
  in doneGitCwd>`. Use the same git-sha read the codebase already uses for main
  (e.g. the helper behind `checkMainDivergence` / a `git rev-parse` of the main
  ref in `doneGitCwd`); do not introduce a new lock or a new sync.
- Re-read main's current sha and compare to `syncedMainSha` at the LATEST safe
  point that is still BEFORE `store.writeStory` persists `phase=DONE` (~line 431) —
  i.e. right before `actor.send` (~398) or immediately before `writeStory`. If the
  sha changed (external advance), THROW a clear error so the existing try/finally
  (~536) releases the lock and the story stays at TEST. Message shape:
  `DONE aborted: main advanced (<old7> -> <new7>) after the pre-check sync; nothing
  was merged and the story stays at TEST. Re-run story_advance DONE to resync.`
- Only DONE transitions are affected. Do NOT change the lock acquisition, the
  stale-reclaim, `applyDoneMergeEffects`, or any non-DONE path. The unchanged-main
  happy path must stay byte-identical (no abort, normal merge).

User sees: on an external main advance mid-DONE, `lattice story_advance --phase=DONE`
fails with the resync message above and the story phase is still TEST (no partial
merge); with main unchanged in-lock, DONE merges normally.

## CHK-002

Add a smoke at `packages/main/src/tasks/done-premerge-mainsha-recheck-smoke.ts`
(auto-discovered) + npm wiring, covering:

- **Abort path:** simulate an external advance to main between the pre-check sync
  and the in-lock merge → `story_advance DONE` aborts cleanly with the resync hint,
  the persisted phase is still TEST, and NO `phase=DONE` was written and NO merge
  commit landed on main.
- **Happy path:** main unchanged inside the lock → DONE proceeds and reaches DONE
  with the normal merge (no regression).

Use isolated /tmp git roots + locks (no global-lock contention), mirroring the
existing transition/done smokes.

User sees: `node packages/main/dist/tasks/done-premerge-mainsha-recheck-smoke.js`
prints its checks and exits 0; full `npm test` exits 0 with the new smoke included.

## Verification approach

One DEV commit (the re-check + the smoke); build tsc-clean; run the new smoke;
run full `npm test` green; ONE review round (claude 3 lanes + codex host-2);
review-assurance floor (high-risk: gate/state-machine file) via genuine full-3x2
or honest degraded; `recover_evidence`; TEST → DONE (the DONE merge auto-bumps the
version + auto-rebuilds dist — do NOT do those manually).

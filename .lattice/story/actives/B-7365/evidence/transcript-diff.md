# B-7365 real-machine transcript ↔ PLAN-outcome diff

The smoke drives the **real** exported `commitInitCheckMetadataAndMergeMain` into a genuine 3-way git conflict — this is the actual production reconcile path, not a mock.

## Expected (understanding.outcome)
> The story's index.json is NEVER left with git conflict markers: the reconcile serializes its metadata-commit + merge under the main-write-lock, and on any residual conflict resolves the machine-generated story metadata deterministically to the authoritative post-advance state.

## BEFORE (pre-fix)
The reconcile's bare `git merge … --no-edit` conflicted on the story's `index.json` and left/committed `<<<<<<< / ======= / >>>>>>>` markers (observed twice this session — B-3990 and B-e791 — each needing manual repair). The new smoke **fails on unfixed code** with `CONFLICT (content) … Automatic merge failed` (confirmed by the implementer running it against the pre-fix dist).

## AFTER (B-7365 fixed CLI)
```
$ node packages/main/dist/tasks/init-check-reconcile-conflict-smoke.js
✓ reconcile resolved a 3-way metadata conflict to the post-advance state with no markers
✓ init-check reconcile conflict smoke passed
exit=0
```
The smoke sets up a real 3-way conflict on **two** metadata files (`index.json` phase INIT vs INIT_CHECK, and `checklist.json`), calls the real reconcile, and asserts: both working-tree and committed metadata parse as JSON with **no markers**, and the resolved values equal the **post-advance (main)** state (`phase: INIT_CHECK`, `checklist.note: main-advanced`).

## Diff notes
- **Match.** The reconcile now (1) wraps the main metadata-commit + merge in `withReentrantMainWriteLock` (serializes against concurrent main churn), and (2) on a conflict resolves all conflicted paths under storyDir to the post-advance/main version, completing the merge with no markers — and on a secondary error during resolution aborts the merge (F-001 fix) so it never strands a half-merged worktree.
- Single-session (no-conflict) path is byte-identical: existing `init-check-atomicity-smoke` and `main-write-lock-smoke` still pass.
- Scope: change isolated to `cli-engine.ts` (+ the smoke). This is the durable fix for the reconcile corruption that recurred twice this session.
- Known follow-up: the smoke isn't in the default validate battery (systemic gap owned by backlog B-99b6).

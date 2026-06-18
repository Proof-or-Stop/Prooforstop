# B-9177 CHK-001 — main-write-lock coverage audit

Generalization of the B-7365 fix. Goal: enumerate every CLI path in
`packages/main/src` (handlers + cli-engine + core) that mutates the **main**
branch — commits ON main, merges a story branch INTO main, updates the main ref,
or `reset`s main — and determine whether the mutating critical section holds
`withMainWriteLock` / `withReentrantMainWriteLock` / `acquireMainWriteLockRegistered`.

## Classification rule (the one that matters)

A path mutates **main** only when its git command (a) runs with `cwd` = the
**main checkout** (the worktree on branch `main`, resolved via `resolveMainRepoRoot` /
`gitRoot` / `mainMergeRoot`) AND (b) writes main's HEAD/ref/index (`commit`,
`merge <storyBranch>`, `reset`, `update-ref refs/heads/main`).

A path that runs `git merge main` with `cwd` = a **story worktree** merges main
*into* the story branch — it does NOT mutate main and does NOT need the lock.
Likewise, deleting a `story/<id>` branch ref or removing a story worktree is a
story-branch / worktree mutation, not a main mutation. Judged by cwd + target
ref, never by substring.

## Coverage table

| path (file:function) | git op | mutates main? | inside lock? | gap? |
|---|---|---|---|---|
| `cli-engine.ts: commitInitCheckMetadataAndMergeMain` (3469) | `git commit` on main + merge base→story worktree | **YES** (commit on main) | **YES** — `withReentrantMainWriteLock(gitMainRoot, …, {label:'INIT_CHECK reconcile'})` (B-7365 fix) | no |
| `cli-engine.ts: commitFromDraftMetadataOnMain` (3302→3325 `git commit`) | `git commit` on main (preflight asserts branch==main) | **YES** | **NO** — called from CLI wrapper (cli-engine.ts:4187) after `handlers.story_create` returns, outside the handler's lock | **GAP** |
| `cli-engine.ts: commitFromDraftMetadataAndMergeMain` (3342→`commitFromDraftMetadataOnMain` + 3352 merge) | `git commit` on main, then `git merge main` into story worktree | **YES** (the commit; the merge is worktree-only) | **NO** — called from CLI wrapper (cli-engine.ts:4172), outside any main-write-lock | **GAP** |
| `worktree.ts: story_discard → commitDiscardMetadata` (1348→630 `git commit`) | `git commit` "lattice: discard <id>" on main checkout (`gitRoot`) | **YES** | **NO** — `story_discard` holds no main-write-lock | **GAP** |
| `worktree.ts: story_discard → purgeSafeInitCommit` (1330→619 `reset --hard HEAD~1`) | `git reset --hard HEAD~1` on main checkout (`gitRoot`) | **YES** (rewrites main HEAD) | **NO** | **GAP** |
| `worktree.ts: dev_merge` (1086 merge / 1100 branch -d / 1095 worktree remove) | merge story→main + branch delete + worktree remove on `gitRoot` | **YES** (merge into main) | **NO** | **GAP (dormant)** — NOT registered as a CLI command (no `name:'dev_merge'` in the registry); legacy handler method, unreachable via `lattice <cmd>`. In-process reachable only. |
| `worktree.ts: dev_finish` (949) | advances TEST; no direct main merge (delegates) | no (no commit/merge on main) | n/a | no — also unregistered legacy method |
| `done-effects.ts: applyDoneMergeEffects` (664; Step3 `git merge story/<id>` on main repo root, Step4 worktree remove, Step5 `branch -d`) | merge story→main + branch delete + worktree cleanup | **YES** | **YES** — `transition-orchestrator.ts:268` acquires `acquireDoneMainMergeLock` (registered) and releases in one `finally` (498) spanning preMergeGate→actor.send→writeStory→applyDoneMergeEffects | no |
| `done-effects.ts: autoSyncMain` (64; `git fetch origin main:main` + `git merge main --no-edit`) | merge main INTO story worktree (cwd=worktree) | NO (worktree-only) | runs inside DONE lock anyway | no |
| `done-recover.ts: done_recover` (78 merge-tree, 83 `merge <branch> --no-ff`, 92 `branch -d`) | merge story→main + branch delete on `mainMergeRoot` | **YES** | **YES** — `acquireDoneMainMergeLock` (45) released in `finally` (110) | no |
| `story-query.ts: story_reconcile / test_story render(true)` (772) | repair render under lock | (repair side-effects) | **YES** — `withMainWriteLock(getRepoRoot(ctx.root), …, {label:'story_reconcile repair'})` | no |
| `story-query.ts: reconcile sync-main confirm` (951 `git merge main --no-ff`, cwd=`cwd`=story worktree) | merge main INTO story branch | NO (worktree-only) | n/a (not main mutation) | no |
| `story-query.ts: zombie cleanup` (684 worktree remove, 702 `branch -d z.branch`) | remove zombie story worktree + delete `story/<id>` branch | NO (story-branch / worktree scope) | n/a | no |
| `core/auxiliary-worktree-cleanup.ts: removeWorktree` (344/351 worktree remove) + `deleteBranch` (368/373/380 `branch -d/-D`) | remove auxiliary story worktree + delete auxiliary `story/<id>` branch | NO (story-branch / worktree scope; `merge-base --is-ancestor` is read-only) | `repairAuxiliaryWorktreeResidues` (436) wraps it in `withMainWriteLock` defensively; bare `cleanupAuxiliaryWorktreeResidues` callers (story-query.ts:753, done-effects.ts:848-under-DONE-lock) do not mutate main | no |
| `worktree.ts: createScopedStoryBootstrapCommit` (356 `write-tree`, 357 `commit-tree`, 358 `update-ref refs/heads/story/<id>`) | writes the **story** branch ref via a temporary `GIT_INDEX_FILE` | NO (updates story branch, never main's index/ref/HEAD) | n/a | no |
| `doctor.ts: tryWorktreeRemove` (665 worktree remove) + `deleteTerminalStoryBranch` (750 `branch -D story/<id>`) | remove terminal story worktree + delete `story/<id>` branch | NO (story-branch / worktree scope) | n/a | no |
| `test-auto.ts` (241 `branch -D "${b}"`) | delete temp fixture branches created during `$testStory` runs (explicitly excludes main/master) | NO (throwaway test branches) | n/a | no |
| `handlers/story-create.ts` (283) | story-file metadata write | (B-META metadata) | **YES** — `withReentrantMainWriteLock(createLockMainRepoRoot, …)` | no |
| `handlers/finding.ts` (75), `handlers/gap-log.ts` (189), `handlers/audit.ts` (130) | B-META / shared metadata writes | (metadata) | **YES** — all `withReentrantMainWriteLock` | no |

## Gaps found (the set CHK-002 must close)

B-7365's `commitInitCheckMetadataAndMergeMain` was **NOT** the only gap.
Three live, reachable main-mutating paths remain UNLOCKED, plus one dormant
legacy method:

1. **`commitFromDraftMetadataOnMain`** (cli-engine.ts:3302; commit at 3325)
   — the from-draft sibling of the B-7365 path. `git commit` on main, called
   from the `story_create --fromDraft` CLI wrapper (cli-engine.ts:4187) outside
   any main-write-lock. Exact B-7365 class race: a concurrent main commit
   between staging and committing corrupts metadata.

2. **`commitFromDraftMetadataAndMergeMain`** (cli-engine.ts:3342; called from
   cli-engine.ts:4172) — wraps (1) plus a `git merge main` into the story
   worktree. The commit-on-main half is the unlocked main mutation; the
   commit+merge must be serialized as ONE critical section exactly like the
   INIT_CHECK fix did.

3. **`story_discard`** (worktree.ts:1116) — two unlocked main mutations on the
   main checkout (`gitRoot`):
   - `commitDiscardMetadata` (623; `git commit` at 630) — discard-metadata
     commit on main.
   - `purgeSafeInitCommit` rollback (619; `git reset --hard HEAD~1`) — rewrites
     main HEAD.
   The whole `story_discard` body runs with no main-write-lock.

**Dormant (CHK-002 should note, not necessarily wrap):**

4. **`dev_merge`** (worktree.ts:1013) — merges story→main + branch delete on
   `gitRoot`, fully unlocked. It is NOT in the CLI command registry (no
   `name:'dev_merge'`), so it is unreachable via the `lattice` CLI surface; it
   survives only as an in-process handler method. CHK-002 may either wrap it for
   defense-in-depth or document it as a dead legacy method. The live equivalent
   (`applyDoneMergeEffects`) is already locked.

## CHK-002 recommendation

Wrap the critical sections of (1)/(2)/(3) in
`withReentrantMainWriteLock(mainRepoRoot, fn, {label})` (reentrant — `story_discard`
and the from-draft bootstrap can run inside an already-locked context, and the
reentrant variant is the same primitive the B-7365 fix used). Lock-only; no
command semantics change. For `dev_merge` (4), record the dormant-legacy status
explicitly; wrap only if keeping it reachable.

## Note on B-7365

B-7365 fixed exactly ONE of the four main-mutating reconcile/commit paths
(`commitInitCheckMetadataAndMergeMain`). Its three structural siblings
(from-draft commit, from-draft commit+merge, story_discard commit+reset) were
left unlocked — i.e. the original corruption class was NOT fully closed. This
audit is the definitive list; CHK-002 closes items 1–3 (and decides 4).

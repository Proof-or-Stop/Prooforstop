# B-02a6 real-machine verification — INIT-window data-loss closed

**User value**: a story created in INIT no longer loses its metadata when a concurrent
fleet session runs a working-tree git op (`git clean -fd`) on the shared main checkout.
The INIT metadata is committed (tracked) from birth, so it is immune to `git clean`.

## Expected (PLAN outcome)
After `story_create`, the INIT metadata is a durable git object; a concurrent
`git clean -fd` leaves it intact. `lattice validate` prints the init-window smoke
passing; `lattice doctor` reports an uncommitted INIT leaf as a DATA-LOSS RISK.

## Actual (run from the worktree)

### 1. The fix, end-to-end (the CHK-001 regression smoke drives the REAL story_create)
```
$ node packages/main/dist/tasks/init-window-data-loss-smoke.js
✓ init-window data-loss smoke passed: INIT metadata survives concurrent git clean -fd on the shared checkout
```
The smoke: temp git repo with the production `.gitignore` allowlist → real `story_create`
→ asserts `git cat-file -e HEAD:<leaf>` (the safe-init commit `lattice: story <id> init`
is present) → `git clean -fd` → asserts the metadata bytes survive (`existsSync` +
byte-identity). Scratch-neutralizing `createSafeInitCommitOnHead` flips it RED, proving
it is a genuine regression lock, not a tautology.

### 2. Discard still reverses — both the HEAD and the buried (tombstone) paths
```
$ node packages/main/dist/tasks/review-pass-discard-smoke.js
✓ review pass and discard smoke passed
```
Covers `assertPurgeDropsSafeInitCommit` (init commit at HEAD → `reset --hard HEAD~1`)
AND `assertPurgeTombstonesBuriedSafeInitCommit` (init commit buried under a later commit
→ `purgeSafeInitCommit` bails → `commitDiscardMetadata` tombstone fires → main converges
to a clean tree, buried + burying commits stay reachable).

### 3. Defense-in-depth predicate broadened (CHK-003)
`evaluateStoryMetadataProtection` now flags `unsafe = !tracked` (any uncommitted leaf),
catching the `!ignored && !tracked` INIT window the old `ignored && !tracked` predicate
deemed safe — the exact blind spot that lost B-0c17. `doctor` surfaces the new case.

### 4. Full battery
```
$ lattice validate --story=B-02a6
✓ Project validation commands passed   (5 configured commands, build + 4 smokes)
Verification intent coverage: 9/9 covered (0 required missing)
```
CLI gate preflight (channel/concept/lint/docs-drift) all pass; tsc clean.

## Diff
New `packages/main/src/core/safe-init-commit.ts`; `story-create.ts` (safe-init commit
inside the held main-write-lock at all 4 create exits); `worktree.ts` (idempotent
bootstrap + discard tombstone fallback); broadened `story-metadata-protection.ts` +
`doctor.ts`; new + rewired smokes; `main-write-lock-coverage.ts` registration.

## 5-question self-check
1. Concrete? Yes — exact smoke output + coverage counts. 2. User-perspective? Yes — the
metadata survives a real concurrent clean. 3. Done? Yes — the INIT→INIT_CHECK window is
closed (prevented, not merely recoverable). 4. Noise? One tiny metadata-only init commit
per story_create, reversed on discard — bounded, acceptable vs permanent data loss.
5. Plain summary? "A story's INIT metadata is committed from birth, so concurrent fleet
git ops can no longer wipe it."

# Plan: B-9177 Close main-write-lock coverage gaps + mechanical regression guard

> **Scope.** Generalize the B-7365 fix: audit every CLI path that mutates the **main** branch
> (commit on main / merge a story branch into main / update the main ref / delete the merged branch),
> ensure each holds the main-write-lock, and add a mechanical guard (run inside `lattice validate`)
> that turns red if a main-mutating path ships without the lock. Decision **Option A**. Lock-only —
> no command semantics change. Full per-session checkout isolation is OUT OF SCOPE (deferred Option B).

## CHK-001: Audit — enumerate main-mutating CLI paths and flag any not under the lock

**Owner**: lattice-implementer  **DependsOn**: none
**Files**:
- Read-only audit across `packages/main/src` (handlers + cli-engine + core): grep git mutation primitives (`commit`, `merge`, `update-ref`, `branch -D`, `reset`, `commit-tree --write-tree main`) and cross-reference `withMainWriteLock` / `withReentrantMainWriteLock` usage.
- Produce the audit as a committed artifact: `.lattice/story/actives/B-9177/evidence/lock-coverage-audit.md` (a table of path → mutates-main? → locked?).

**Verify**:
- The audit lists every main-mutating path and marks locked vs unlocked, distinguishing paths that mutate **main** from paths that only mutate a **story worktree** (merging main INTO a story branch does NOT mutate main).
- Cross-check: `commitInitCheckMetadataAndMergeMain` (cli-engine.ts) shows LOCKED (B-7365); DONE merge (done-effects.ts), done-recover.ts, story-query reconcile classified correctly.

**DoneWhen**:
- A definitive list exists of main-mutating paths and which (if any) remain unlocked. This list drives CHK-002.

## CHK-002: Close the gaps — wrap remaining unlocked main-mutating paths in withReentrantMainWriteLock

**Owner**: lattice-implementer  **DependsOn**: CHK-001
**Files**:
- Modify whichever files CHK-001 flags as unlocked main-mutating paths. Candidates to confirm: `packages/main/src/handlers/done-effects.ts` (DONE story→main merge + branch delete + worktree cleanup), `packages/main/src/handlers/done-recover.ts` (commit-tree against main). Use `withReentrantMainWriteLock(mainRepoRoot, fn, {label})` (reentrant — these can run inside an already-locked DONE flow).
- If the audit finds none remaining, record that explicitly (the B-7365 path was the last one) and proceed to CHK-003 — do NOT invent a wrap.

**Verify**:
- `lattice validate` green; `npm --prefix packages/main run test:main-write-lock-smoke` green (reentrancy preserved); a DONE dry path does not self-deadlock.
- `git diff` shows only lock-wrapping, no semantic change.

**DoneWhen**:
- Every main-mutating path acquires the lock (reentrant where nested); no command semantics changed; existing smoke + e2e still pass.

## CHK-003: Regression guard + tests — mechanically flag any unlocked main-mutating commit path

**Owner**: lattice-implementer  **DependsOn**: CHK-002
**Files**:
- Create `packages/main/src/tasks/main-write-lock-coverage.ts` (node task in the `*-smoke` style) and wire `test:main-write-lock-coverage` into `packages/main/package.json`. The guard scans source for git-mutation-of-main primitives and asserts each enclosing path acquires the lock; it classifies story-worktree-only merges as NOT requiring the lock (no false positive). Include a negative fixture: an unlocked main-mutating primitive must make the guard FAIL.
- Wire the guard into the `lattice validate` battery (or the npm `test` script chain) so it runs by default.

**Verify**:
- `npm --prefix packages/main run test:main-write-lock-coverage` passes; the negative fixture demonstrates the guard goes red on an unlocked primitive.
- `lattice validate` green with the guard included.

**DoneWhen**:
- The guard passes for the current (post-CHK-002) tree, demonstrably fails on an injected unlocked main-mutating primitive, runs inside validate, and does not false-positive on story-worktree-only paths.

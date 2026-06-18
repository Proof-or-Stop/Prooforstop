# Execution plan: B-3d39 (main-write-lock async-reentrancy fix)

## Order
1. **CHK-001** — In `main-write-lock.ts`: introduce an `AsyncLocalStorage` holding a per-acquisition owner token. Keep `heldLockPaths` process-global (cross-process mkdir bookkeeping unchanged). Change the reentrancy predicate in `withReentrantMainWriteLock` (line 304) and `acquireMainWriteLockRegistered` (~352) from `heldLockPaths.has(lockKey)` to `heldLockPaths.has(lockKey) && currentAlsContextOwns(lockKey)`. Outermost acquire runs its body inside `als.run(token, ...)`. In `transition-orchestrator.ts:290`, establish the ALS context around the DONE main-merge window (the acquire/release-pair form held across `actor.send`). Update `isMainWriteLockHeldInProcess` helper. Build.
2. **CHK-002** — In `codex-adapter-checks.ts:644`, add `{ path: join(globalRoot, '@koala-agent', 'core'), label: '@koala-agent/core' }` to `globalCoreCandidates`. Build.
3. **CHK-003** — Add a deterministic async-interleave negative case to `main-write-lock-coverage.ts`: operation A acquires + parks at a controllable promise; inside that await window operation B (separate ALS context) attempts acquire → assert B does NOT pass through as reentrant (it contends/fail-fasts). Keep + assert the existing sync-nesting pass-through case. CHANGELOG Unreleased entry. Run lock-coverage smoke + `npm run test:all`.

## Key implementation note (a2 design)
- Sync nesting (DONE→audit): audit is called inside DONE's `als.run` callback stack → inherits the same ALS store → same owner token → `currentAlsContextOwns` true → pass-through. No self-deadlock.
- Concurrent sibling (another story's INIT_CHECK during DONE await): runs in a SEPARATE ALS context (its own command entry / `als.run`) → store has no token for `lockKey` → `currentAlsContextOwns` false → does NOT pass through → contends on the on-disk mkdir lock (wait or fail-fast per options). This is the fix.
- ALS propagates across `await` by design, so the outer DONE frame keeps its token through the await window.

## Verify
- Build clean (tsc 0 errors) after each CHK.
- `node packages/main/dist/tasks/main-write-lock-coverage.js` PASS incl new interleave case + existing sync-nesting case.
- `npm run test:all` green.
- `node bin/lattice.js verify_codex` — guard still passes, now finds @koala-agent/core.
- Over-reach: done-effects.ts byte-identical, on-disk mkdir primitives intact, no manifest/package.json change.

## Out of scope (explicit)
- On-disk mkdir cross-process mutex (sound, frozen)
- done-effects.ts merge order (correct, frozen)
- done-recover.ts (safety net, kept)
- verifier.ts wrapper-root split-root smell (benign on plain-repo; future story)
- CHANGELOG structure / #3 (dropped — zero conflicts in history)

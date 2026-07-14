# Plan: B-fa65 Doctor global-core-realpath falsely warns in linked worktrees

Decision of record: `canonicalize-nonself-expected` (decision.json) — canonicalize the non-self-project expected via the repository containing corePackageRoot, mirroring the proven self-branch mechanism; budget and genuine-mismatch warn untouched.

## CHK-001: Make the doctor global-core-realpath check linked-worktree-aware

**Owner**: main-agent (express-size bug fix; single file + tests; priority-high ceremony satisfied by this plan + decision)
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/runtime-environment-checks.ts (checkGlobalCoreRealpath ~223-245; add a canonicalizer for the non-self branch reusing the resolveCanonicalSelfCoreRoot pattern anchored at corePackageRoot)
- Test: extend the existing coverage for runtime environment checks (locate via rg "checkGlobalCoreRealpath|globalCoreRealpath" packages/main/tests packages/main/src/tasks; add scenarios there following local idiom)

**Approach**:
- New helper (or parameterized reuse of resolveCanonicalSelfCoreRoot): given corePackageRoot, run `git worktree list --porcelain` anchored at corePackageRoot's repo; if a refs/heads/main worktree exists, expected = its packages/main realpath; on ANY git failure or non-git context fall back to today's behavior (un-canonicalized corePackageRoot) — never crash.
- Non-self branch only: `expected = canonicalizeCoreRoot(context.corePackageRoot)`. Self branch (expectedSelfCoreRoot) untouched.
- A different clone of the same project has a different repo root → its canonical path differs from the global realpath → genuine warn preserved (preMortem 2).

**Verify**:
- npm --prefix packages/main run build green
- New/extended logic tests: (1) worktree-built-CLI-on-fixture context passes (canonical expected = main checkout), (2) self-context unchanged, (3) genuine unrelated-path mismatch still warns, (4) non-git fallback safe
- Real machine: npm run test:brief-output green from THIS worktree (red probe flips; red-evidence RED green relation)
- npm test full chain green from this worktree

**DoneWhen**:
- All four CHK-001 verification intents have passing evidence
- Red evidence green command (npm run test:brief-output in a worktree) passes

# Plan — B-db56: gitRoot single choke-point + grep contract

## Goal
Make `resolveGitCwd` the sole entry point for git child-process cwd; add a grep-contract smoke
that fails on any new bare-projectRoot git call. Kill the wrapper-root defect class permanently.

## Why
Same defect class has hit 5+ stories (B-1637/B-e791/B-0740/B-2856/B-3990). Whack-a-mole per-call-site
fixes do not prevent recurrence. 193 call sites across 88 files; only ~14 are rerouted today.

## CHK-001 — Audit 193 sites + reroute the unrouted
Run `git grep -nE "(execFileSync|spawnSync|execSync)\(['\"']git['\"']" -- 'packages/**/*.ts'`
to enumerate. For each site:
- ALREADY routed via resolveGitCwd (directly or via a wrapper that takes a resolved cwd) → keep.
- Passes projectRoot/root/metadataRoot bare → REROUTE through resolveGitCwd.
Preserve the 3 ad-hoc helpers (lab.ts runGit, cli-engine.ts runGitNoThrow, declared-artifact-commit-check.ts
runGit) — they're useful wrappers; only fix their CALLERS' cwd sources.
**Verify:** existing wrapper-root smokes (`test:gitroot-cwd-routing`, `test:bare-gate-gitroot-cwd`)
still pass byte-identically; `npm run build` + `npm run test:e2e` exit 0.

## CHK-002 — Add the grep-contract smoke
Create `packages/main/src/tasks/gitroot-cwd-contract-smoke.ts`:
- Run the canonical grep across packages/**/*.ts.
- For each hit, inspect the cwd argument:
  - Source is resolveGitCwd / a wrapper that takes a resolved cwd → PASS.
  - Source is bare `projectRoot` / `root` / `metadataRoot` identifier → FAIL with `<file>:<line>: uses bare projectRoot — route through resolveGitCwd`.
- Allowlist: the helper file itself (story-signed-workspace-resolution.ts), the 3 ad-hoc helpers,
  and any explicitly-documented exception (allowlist lives in the smoke source for review visibility).
- Self-test: include known-good + known-bad fixture rows the smoke processes inline.
Wire `test:gitroot-cwd-contract` in root package.json and packages/main/package.json.
**Verify:** smoke passes on HEAD; injecting a deliberate regression triggers a clear failure.

## Out of scope
The 138-smoke→runner consolidation, resolveGitCwd signature changes, lattice.config.json
metadataRoot/gitRoot semantics, koala residual work.

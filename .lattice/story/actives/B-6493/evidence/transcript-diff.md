# B-6493 real-machine acceptance — transcript & diff

Rhythm: PLAN outcome = expected → run on a real machine → actual output → diff.

## Build / unit evidence
- `npm --prefix packages/main run build` → tsc clean (0 errors).
- `npm --prefix packages/main run test:handoff-phase-authority-smoke` → 6/6 PASS.
- `lattice validate --story=B-6493 --json` → `allPass: true` (express-exempt; e2e suite green).

## Scenario 1 — story with worktree AHEAD of mirror (the bug case)
Target: real story **B-4e06** (mirror phase INIT_CHECK on main, authoritative phase DEV in `.worktrees/B-4e06`).

Command (CLI built from this worktree, run against the main repo root):
```
node .worktrees/B-6493/packages/main/dist/cli.js --root <main> \
  handoff_create --storyId=B-4e06 --fromHost=codex --toHost=claude-code
```

**Expected (PLAN):** a `⚠ phaseAuthority` warning naming the worktree phase as ahead of the
packed mirror phase; `recoveryPoint.phase` unchanged; `productionDone:false`.

**Actual:**
```
recoveryPoint: B-4e06:handoff:codex:to:claude-code
⚠ phaseAuthority (ahead): Authoritative worktree phase DEV is ahead of the packed mirror
phase INIT_CHECK. This pack reflects the lagging main-branch mirror (baseSha is main HEAD),
so the resuming host is pointed at the stale phase. Review the live worktree before resuming.
```
JSON `phaseAuthorityWarning`: `{kind:"phase-authority", mirrorPhase:"INIT_CHECK",
authoritativePhase:"DEV", worktreePath:".../.worktrees/B-4e06", relation:"ahead", message:...}`;
`recoveryPoint.phase: INIT_CHECK` (unchanged).

**Diff:** matches expected. No deviation.

## Scenario 2 — story with NO worktree (no false positive)
Target: DONE story **B-decb** (no linked worktree).

**Expected:** no warning line.

**Actual:** `phaseAuthority` lines: **0**.

**Diff:** matches expected.

## Scenario 3 — inspect surface
`handoff_inspect` on the B-4e06 pack renders the same
`⚠ phaseAuthority (ahead): ...` line. Matches expected.

## packHash safety
The warning field is outside `HandoffPackHashInput` / `packHashInput()`; smoke case 5 asserts
`computeHandoffPackHash` is byte-identical with and without the field. No packHash drift observed.

## Conclusion
All scenarios match PLAN expectation; no diffs. The feature restores the lost
worktree-ahead signal without changing recoveryPoint semantics, packHash, or any
authority field.

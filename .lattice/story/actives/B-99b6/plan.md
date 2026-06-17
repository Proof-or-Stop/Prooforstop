# Plan: B-99b6 Aggregate standalone smoke tests into the lattice validate battery

## Design summary (read first)

`lattice validate` and the REVIEW→TEST gate both fall back to the root `npm test` chain
(confirmed: no project `validate.ts`, no `validate.command` in lattice.config.json — see
`packages/main/src/handlers/verifier.ts` `discoverFallbackValidationCommands`, and
`packages/main/src/handlers/phase-gates.ts` `runValidateGate`). Therefore wiring guards into the
root `test` script makes them gate-visible for BOTH paths with one edit. **Chosen option A.**

**Fast gate (added to root `test` chain — runs under validate + REVIEW→TEST gate):**
- Contract guards (invariants; all ≤2.6s): `test:process-fact-contract`, `test:runtime-fact-contract`,
  `test:evidence-quality` (NEW root alias → `scripts/verify-evidence-quality.mjs`), `test:anti-stall`
- Wrapper-root regressions (≤1.4s each): `test:storydir-inside-gitroot-smoke`, `test:gitroot-cwd-routing`,
  `test:bare-gate-gitroot-cwd`, `test:done-oracle-wrapper-root`
- Already in chain → DO NOT re-add: `test:gitroot-cwd-contract`

**Full only (NOT in fast gate — reachable via a documented full aggregator / CI):**
- `test:storydir-inside-gitroot-suite` (~7s fixture builder)
- `test:all` (~160 smokes)

**Hard principle:** every guard above is GREEN on current main (baseline-verified). If any is RED when
wired, fix the root cause or escalate — NEVER drop a guard from the chain to make the gate pass. RED
becoming visible is the entire point.

---

## CHK-001: Add a smokes aggregator and wire it into the lattice validate run path

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: `package.json` (root — `scripts`)
- Modify: `packages/main/package.json` (only if a new fast wrapper-root alias must exist at root that
  delegates to a packages/main script; some already exist there — see below)
- Create (optional): a tiny aggregator script ONLY if chaining inline becomes unreadable. Prefer inline
  `&&` chaining in the root `test` script (Option A, no new file) unless readability forces an aggregator
  under `packages/main/src/tasks/`. Do NOT add an aggregator that re-runs anything already chained.

**What to wire (exact):**
1. Add a root `scripts` alias `test:evidence-quality` → `node scripts/verify-evidence-quality.mjs`
   (root currently lacks it; the verifier exists; packages/main has `test:evidence-quality-contract`).
2. For the four wrapper-root smokes: `test:gitroot-cwd-routing` and `test:bare-gate-gitroot-cwd` already
   exist as root aliases. `test:done-oracle-wrapper-root` and `test:storydir-inside-gitroot-smoke` exist
   only in `packages/main/package.json`; add root aliases that delegate, e.g.
   `"test:done-oracle-wrapper-root": "npm --prefix packages/main run test:done-oracle-wrapper-root"` and
   `"test:storydir-inside-gitroot-smoke": "npm --prefix packages/main run test:storydir-inside-gitroot-smoke"`.
   (Mirror the existing `test:docs-drift-wrapper-root` pattern, which already delegates this way.)
3. Append to the root `test` chain (after the existing entries, before or around `test:e2e`) the FAST guards:
   `test:process-fact-contract`, `test:runtime-fact-contract`, `test:evidence-quality`, `test:anti-stall`,
   `test:storydir-inside-gitroot-smoke`, `test:gitroot-cwd-routing`, `test:bare-gate-gitroot-cwd`,
   `test:done-oracle-wrapper-root`. Keep them chained with `&&` so any failure fails `npm test`.
   DO NOT add `test:gitroot-cwd-contract` again (already present).
4. Add a root `test:smokes-full` alias (NEW) that runs the slow suite NOT in the fast gate, e.g.
   `"test:smokes-full": "npm run test:storydir-inside-gitroot-suite && npm run test:all"`, and add a root
   alias `test:storydir-inside-gitroot-suite` → `npm --prefix packages/main run test:storydir-inside-gitroot-suite`
   if not already present at root. `test:smokes-full` is the documented CI/full path; it is NOT chained into `test`.

**Verify**:
- `node -e "console.log(require('./package.json').scripts.test)"` shows the 4 contract guards + 4 wrapper-root
  smokes added, `test:gitroot-cwd-contract` appearing exactly once.
- `npm test` (run from the worktree root) exits 0 and its output contains each newly-added guard's run.
- `npm run test:smokes-full` exists and runs the slow suite + 160-smoke run green (may be slow; OK).

**DoneWhen**:
- Root `test` chain runs the 8 newly-gated fast guards/smokes (no duplicate of gitroot-cwd-contract).
- The slow `storydir-inside-gitroot-suite` and `test:all` are reachable via `test:smokes-full`, NOT in `test`.
- No guard/smoke assertion logic, gitRoot code, or process-fact-registry code changed — only `scripts`.

---

## CHK-002: Verify the aggregated smokes run and pass under lattice validate; a regression blocks

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Test/Verify only (no new product code). May create a transcript artifact under the story dir for evidence.

**Verify**:
- `lattice validate --story=B-99b6` is GREEN and its output lists the newly-gated guard steps.
- Regression proof: temporarily make ONE wired guard fail (e.g. `git stash`-free edit to a fixture
  expectation **in a throwaway way that is reverted**, or set an env that the guard treats as failure;
  preferred: rename/touch nothing in guard logic — instead break it via a reversible package.json typo on
  the alias OR a one-line reversible edit to the guard's INPUT, never its assertions), run `lattice validate`,
  capture that it turns RED naming that guard, then revert and capture GREEN again. **Do NOT commit the break.**
  NOTE: per repo discipline, the implementer must NOT use `git stash`. Use an in-place reversible edit and
  `git checkout -- <file>` (or `git restore`) to revert, scoped to a single file.
- Cross-check timing: the fast-gate delta is seconds-scale (sum of new fast guards ≈ 8s; no 160-smoke run).

**DoneWhen**:
- `lattice validate` GREEN with the new guards included (transcript captured).
- A deliberately-broken wired guard makes `lattice validate` RED on that step (transcript captured), revert → GREEN.
- No silent skip: the failing guard is named in the RED output; the chain stops/fails (npm `&&` short-circuit).

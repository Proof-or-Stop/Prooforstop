# Plan — B-d313: Fix stale koala→Lattice stale-warning assertion

## Goal
Stop `field-regression-cli-smoke` from redding on main. The koala→Lattice rebrand changed the
stale-state warning header emitted by the CLI, but two assertions in the cooldown test still
expect the old wording, so `assertStaleWarningCooldownCliSurface` throws and aborts the whole suite.

## Root cause
- `packages/main/src/cli-engine.ts:3657` now emits `⚠ Lattice stale state warnings:`.
- `packages/main/src/tasks/field-regression-cli-smoke.ts:1894` asserts `assert.match(first.stderr, /koala stale state warnings/)`.
- `packages/main/src/tasks/field-regression-cli-smoke.ts:1906` asserts `assert.doesNotMatch(second.stderr, /koala stale state warnings/)`.
- The expected literal `koala stale state warnings` no longer appears in the output → first assertion fails.

## CHK-001 — Update the two stale-warning assertions from 'koala' to 'Lattice'
**File:** `packages/main/src/tasks/field-regression-cli-smoke.ts`

**Change:**
- Line 1894: `/koala stale state warnings/` → `/Lattice stale state warnings/`
- Line 1906: `/koala stale state warnings/` → `/Lattice stale state warnings/`

Both regexes must match the exact rebranded header emitted at `cli-engine.ts:3657`
(`⚠ Lattice stale state warnings:`). Keep the assertions brand-specific (do NOT relax to a
brand-agnostic regex) so they continue to guard the human-facing header text.

**Out of scope (excluded boundary):**
- Changing the CLI emit string in `cli-engine.ts`.
- The unrelated `koala` references at `:609` (`re-run koala review_run_start` hint) and `:1871`
  (temp-dir name prefix), which are not the stale-warning header.
- Any change to the cooldown behavior the test exercises.

**Verification:** `npm run test:field-regression-cli-smoke` runs to completion (exit 0); the
`assertStaleWarningCooldownCliSurface` AssertionError is gone. Then `lattice validate` is green.

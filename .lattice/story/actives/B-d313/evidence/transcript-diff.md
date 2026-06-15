# B-d313 — Real-machine user-acceptance transcript & diff

**Commit under test:** `85eebb28c` (story/B-d313)
**Command (as the user runs it):** `npm run test:field-regression-cli-smoke`

## Expected (PLAN outcome)
The suite runs to completion and prints `✓ field regression CLI smoke passed` with exit code 0,
instead of crashing inside `assertStaleWarningCooldownCliSurface` with
`AssertionError [ERR_ASSERTION]: The input did not match the regular expression /koala stale state warnings/`.

## Actual (observed transcript)
```
> @lattice-agent/core@0.3.5 test:field-regression-cli-smoke
> node dist/tasks/field-regression-cli-smoke.js

✓ field regression CLI smoke passed
```
Exit code: 0
(Per-scenario `ℹ Reading legacy koala.config.json …` notices are pre-existing config-rename hints, unrelated to this fix.)

## Diff (expected vs actual)
No gap. Before the fix the suite aborted at `assertStaleWarningCooldownCliSurface` because the CLI
header was rebranded to `⚠ Lattice stale state warnings:` (cli-engine.ts:3657) while the test still
asserted the legacy `/koala stale state warnings/`. After updating both assertions
(field-regression-cli-smoke.ts:1894 and :1906) to `/Lattice stale state warnings/`, the suite reaches
its final `✓ field regression CLI smoke passed` line and exits 0 — matching the expected outcome exactly.

## User-value self-check
- Does the user see the intended result? Yes — a green `✓ field regression CLI smoke passed`, no AssertionError.
- Was it run on a real machine from the user's perspective? Yes — `npm run test:field-regression-cli-smoke` in the story worktree, exit 0.
- Any residual of the old behavior? No — `grep -c 'koala stale state warnings'` in source = 0; dist has 2× `Lattice stale state warnings`, 0× `koala`.

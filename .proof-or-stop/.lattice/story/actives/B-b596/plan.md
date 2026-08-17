# B-b596 Plan

## Story Scope

Implement only the G01 positive-control group from
`docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md`.
G01 means one synthetic parent roadmap ledger with exactly 15 required milestone
rows, all closed by fresh machine evidence, producing `full_roadmap_complete`.

This story does not implement G02-G10, does not create 150 real Lattice stories,
and does not claim Authority, fullAuthority, production, or independent two-host
completion.

## CHK-001 Add The G01 Positive-Control Baseline Smoke

Implementation approach:

- Add `packages/main/src/tasks/parent-roadmap-large-ledger-g01-baseline-smoke.ts`.
- Generate deterministic milestone row IDs `G01-M01` through `G01-M15`.
- Build a synthetic parent roadmap ledger where every row is
  `closed-by-existing-evidence`, has at least one command-backed evidence entry,
  has non-empty material refs, has a claim boundary, and is not stale.
- Evaluate the ledger with the existing parent-roadmap rollup logic.
- Assert exactly 15 total rows, 15 closed rows, and zero open, stale, deferred,
  invalid, or migration rows.
- Assert the rollup permits `full_roadmap_complete`.
- Assert local proof does not set or imply Authority, fullAuthority, production,
  or independent two-host completion.

Verification:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/parent-roadmap-large-ledger-g01-baseline-smoke.js
```

## CHK-002 Bind G01 Baseline To Validation And Documentation Boundaries

Implementation approach:

- Update `docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md`
  to record that G01 is implemented as the first positive-control group.
- Keep G02-G10 explicitly future groups.
- Add the G01 smoke to the deterministic validation path if the repository's
  validation policy expects new baseline smokes to be run by `lattice validate`.
- Keep all wording bounded: G01 implemented does not mean the full 10x15
  baseline is complete.

Verification:

```bash
node packages/main/dist/tasks/parent-roadmap-large-ledger-g01-baseline-smoke.js
node bin/lattice.js validate --story=B-b596 --json
git diff --check
```

## Rollback

If the smoke design is wrong or too broad, revert the new smoke file, remove its
validation command entry, and restore the document to baseline-design-only
status. The G01 implementation claim must be removed unless the smoke is
deterministic and passing.

## Pre-Mortem Checks

- Do not mark G02-G10 as implemented.
- Do not allow fewer than 15 rows to pass the positive-control smoke.
- Do not let local proof become production or Authority wording.
- Do not hide missing validation wiring behind documentation prose.

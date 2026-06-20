# B-1a91 — Real-machine user-value acceptance (transcript + diff)

Story: Auto-refresh the Experience Layer finding-signals cache on DONE merge + coverage watermark + learning_validate gap report.

Run on 2026-06-20 from the worktree using the worktree's freshly-built dist
(`./bin/lattice.js`, headHash f97ba0e, materialHash 121972e9).
Rhythm: PLAN outcome = expected → run → actual → diff.

## 1. CHK-003 — coverage watermark + gap report (the user-visible headline)

### Expected (from userSees)
`lattice learning_validate` prints a coverage line: "coverage: N/N findings, 0 gap"
right after a scan; the filtered (`--story`) view does NOT print a misleading numeric
gap (F-002/F-005); a cache without a watermark degrades to "coverage: unknown".

### Actual
- Fresh worktree cwd, no persisted cache yet:
  `coverage: unknown — run learning_scan`           ← back-compat degraded path (CHK-003:edge:1)
- `lattice learning_scan` → `wrote .lattice/learning/finding-signals.json
  (schemaVersion 1, updatedAt 2026-06-20T09:48:23.437Z)`  ← updatedAt is wall-clock (F-003)
- `lattice learning_validate` (after scan):
  `coverage: 871/871 findings, 0 gap`               ← CHK-003:happy:0, gap=0 right after scan
- `lattice learning_validate --story=B-1a91`:
  `coverage: n/a (filtered view — run learning_validate without --story for the coverage gap)`
- `lattice learning_validate --story=B-1a91 --json` → `"coverage": { "filtered": true }`
                                                     ← F-002/F-005 fix: no false "0 gap" on the subset

### Diff
None. Actual matches expected. The filtered view no longer reports the false "0 gap"
that codex's round-1 VERDICT=FAIL repro produced; it now refuses to compute a
subset-vs-global gap and says so.

## 2. CHK-001 — auto-refresh on DONE merge (never blocks)

### Expected
Every `story_advance --phase=DONE` that merges runs applyDoneMergeEffects, which
re-derives + persists the cache (updatedAt advances, advisory "experience cache
refreshed (N signals)" line) on EVERY merge (not gated on material-code), and a
forced derive/write failure is swallowed so the merge still succeeds.

### Actual
Exercised by `done-merge-experience-refresh-smoke.ts` driving the REAL
applyDoneMergeEffects path (21 checks, exit 0), incl.:
- happy: real DONE merge → cache (re)written, `updatedAt > 2020-01-01` (not epoch), advisory line present;
- metadata-only merge: build SKIPPED yet "experience cache refreshed (N signals)" still fires (not gated on material-code);
- adversarial: forced derive failure swallowed → advisory skip line, merge still SUCCEEDS.
Note: the new on-merge refresh code lands on main only when THIS story merges, so it
governs SUBSEQUENT stories' DONE merges; the smoke proves the real path now.

### Diff
None. Behavior matches; the never-block contract holds.

## 3. CHK-002 — smokes + full suite

### Expected
node <smoke>.js exits 0; full npm test exits 0 with the new smokes in the chain.

### Actual
- done-merge-experience-refresh-smoke.js → 21 checks, exit 0
- experience-coverage-gap-smoke.js → 15 checks, exit 0
- experience-layer-revalidation-cli-smoke.js → 5 checks, exit 0
- `lattice validate` → all 10 configured commands pass; verification coverage 11/11.
- codex host-2 round-3 independently ran full `npm test` → exit 0.

### Diff
None.

## Self-check (user value)
- Does it do what the user asked? Yes — experience now auto-accumulates on every DONE
  merge, and a missed/stale refresh is detectable (coverage gap) and recoverable (learning_scan).
- Real-machine run from the user's perspective? Yes — the learning_validate / learning_scan
  transcripts above are real CLI output, not a stub.
- Any surprise? The global coverage line reads "unknown" until the first scan exists in a
  given checkout — expected and documented as the back-compat degraded path.

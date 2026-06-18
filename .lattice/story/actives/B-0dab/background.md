## Trigger Event
On 2026-06-17, story 4 (verify gate) of the koala-removal ship-clean program, following B-40eb (residual sweep, DONE and merged to main). B-40eb delivered the canonical gate scripts/verify-koala-residue.mjs but it is not yet wired into CI; on main the gate currently reports 7 unclassified hits introduced by other stories.

## Key Insights
The gate scripts/verify-koala-residue.mjs (classify() + path exemptions + LEGACY_LOGIC_FILES allowlist + 5 self-tests) passes on the B-40eb worktree but on main reports 7 koala-* mkdtemp-prefix residuals: english-only-guards-smoke.ts lines 165/201/260/352/354 (koala-english-* prefixes) and review-incremental-context-smoke.ts lines 262/437 (koala-incremental-* prefixes). These are brand temp-dir name prefixes (not assertion targets), so they should be renamed koala-* -> lattice-*. Cleaning them plus wiring the gate into npm test (which lattice validate uses as its fallback battery) makes koala-residue a continuous gate that blocks future regressions.

## Solution Tradeoffs
Wire-in mechanism: lattice validate uses the package.json test script as its fallback battery (validate.ts/js/mts is not configured), so adding a `test:koala-residue` entry to the test chain is the simplest continuous-gate wiring. Alternative: a dedicated configured validate.command or a heavier validate plugin. Chosen: package.json test chain entry. Scope is intentionally narrow: only the 7 mkdtemp prefixes + the package.json wiring; do NOT re-run the full brand sweep (B-40eb owns that). Documented exceptions stay exactly as B-40eb defined them.

## Conversational Texture
The user asked to do story 3 and story 4 with Lattice; story 3 (B-40eb) is DONE. The user chose to do story 4 now, explicitly with English artifacts (learning from story 3, where Chinese artifacts caused a large rework at the english-artifacts gate before DONE).

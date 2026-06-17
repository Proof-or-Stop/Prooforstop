# Plan: B-0dab koala verify-gate wire-up

## Overview
Story 4 (verify gate) of the koala-removal ship-clean program. Reuse the canonical gate scripts/verify-koala-residue.mjs (delivered by B-40eb) and (1) clean the 7 residual koala-* mkdtemp prefixes on main so the gate is green, then (2) wire the gate into the package.json test chain so lattice validate (which uses npm test as its fallback battery) runs it on every validate. Order: clean first, then wire, so npm test never goes red mid-story. No re-sweep; documented exceptions stay exactly as B-40eb defined them.

## CHK-001 Clean the 7 residual koala-* mkdtemp prefixes on main
packages/main/src/tasks/english-only-guards-smoke.ts (lines 165/201/260/352/354: koala-english-scope-/block-/realgit-/initrerun-/initrerun-home-) and review-incremental-context-smoke.ts (lines 262/437: koala-incremental-ctx-/gate-): rename the mkdtemp prefixes koala-* -> lattice-*. These are local temp-dir name prefixes, not assertion targets.
- Verify: run both smokes (node packages/main/dist/tasks/{english-only-guards-smoke,review-incremental-context-smoke}.js) -> pass; node scripts/verify-koala-residue.mjs -> PASS 0 unclassified.
- userSees: node scripts/verify-koala-residue.mjs prints PASS koala-residue: 0 unclassified (down from 7).

## CHK-002 Wire scripts/verify-koala-residue.mjs into the lattice validate battery
Add a `test:koala-residue` npm script (node scripts/verify-koala-residue.mjs) to package.json and include it in the `test` chain (which lattice validate uses as its fallback battery). Do this AFTER CHK-001 so the gate is already green.
- Verify: npm test output shows the test:koala-residue step running and passing; lattice validate is all-green and exercises the gate.
- userSees: npm test includes a passing test:koala-residue step; lattice validate runs the gate.

## CHK-003 Acceptance: gate PASS on main and wired into validate
node scripts/verify-koala-residue.mjs -> PASS 0 unclassified; --self-test -> 5/5; npm test includes test:koala-residue and passes; npm run build exits 0; npm run test:e2e all pass; lattice validate all-green and exercises the gate.
- userSees: the koala-residue gate runs as part of every validate and passes, so koala branding cannot silently re-enter active scope.

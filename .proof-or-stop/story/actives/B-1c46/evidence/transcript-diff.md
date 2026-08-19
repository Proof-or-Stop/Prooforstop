# B-1c46 Transcript Diff

## Expected

- Full project validation passes after runtime memory index optimization.
- The 1,000,000-record optimized warm runtime path meets `targetWarmMs=2000`.
- Runtime memory remains advisory only: `authority=non_authoritative`, `gateEvidence=false`.
- The added readiness smoke fixture ignore only covers `.lattice/learning/` runtime cache cleanliness and does not relax lifecycle evidence gates.

## Actual

- `lattice validate --story=B-1c46 --json` passed all 31 configured commands in TEST.
- Verification coverage is complete: 21/21 required `verificationIntent` entries covered.
- `node packages/main/dist/tasks/playbook-runtime-memory-m3-m6-smoke.js` passed with `recordCount=1000000`, `semanticParity=pass`, `indexedWarmCacheMs=244`, `targetWarmMs=2000`, `targetStatus=met`.
- `node packages/main/dist/tasks/playbook-runtime-memory-performance-smoke.js --profile=full --targetWarmMs=2000` passed with `recordCount=1000000`, `semanticParity=pass`, `indexedWarmCacheMs=369`, `targetStatus=met`, `authority=non_authoritative`, and `gateEvidence=false`.
- `node packages/main/dist/tasks/playbook-runtime-memory-index-smoke.js` passed all 9 checks, including exact overflow, fuzzy overflow, combined exact+fuzzy overflow, and substring exact-overflow parity.

## Diff Notes

- Expected and actual behavior match for semantic parity, performance target, and advisory-only boundary.
- The optimized warm hot path is proven under the full 1,000,000-record profile; the full reference scan and index build are still reported separately and are not claimed as 1-2s operations.
- Scope expansion is acknowledged for `packages/main/src/tasks/main-sync-readiness-smoke.ts` only because the synthetic fixture must ignore `.lattice/learning/` after session memory preflight became part of normal runtime context.

# B-d321 Plan

## Goal

Fix baseline item 5 as a narrow correctness issue: delivery-check evidence must become stale when the source material reviewed by `lattice-review-delivery` changes after the delivery check is signed.

## Chosen Contract

- `delivery_check_set` records the current `materialHash` as the hard freshness binding.
- `headHash` is recorded for audit/debug context only.
- The delivery-check integrity hash includes the material binding so post-hoc binding edits are tamper-evident.
- Missing or mismatched `materialHash` fails closed as stale delivery-check evidence.
- Metadata-only head drift with unchanged material does not force a delivery reviewer rerun.

## Implementation Steps

1. Extend `DeliveryCheckData` and delivery-check signing to include a material freshness binding.
2. Update `delivery_check_set` to record the current material binding when the reviewer signs.
3. Add a shared delivery-check freshness predicate and consume it from DONE oracle / machine guard / lifecycle readiness.
4. Add a focused smoke proving fresh, material-drift stale, metadata-only non-stale, missing-binding fail-closed, tamper fail-closed, and docsPromise behavior.
5. Wire the smoke into `lattice.config.json` with fast focus.
6. Add a derived baseline item 5 result artifact; do not edit the immutable baseline v1 file.

## Verification

- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/delivery-check-freshness-smoke.js`
- `node scripts/verify-process-fact-contract.mjs`
- `lattice validate --focus=fast --json`
- Full `lattice validate --story=B-d321 --json` before TEST/DONE.

## Out Of Scope

- No Authority Server changes.
- No production or receipt-backed claims.
- No delivery reviewer role relaxation.
- No DONE summary freshness changes; that remains baseline item 6.

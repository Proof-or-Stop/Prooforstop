# B-5e28 Plan

## Goal

Make post-DONE learning settlement default-on for future stories while keeping
it learning-only, non-blocking, non-gate, and unable to create helped promotion
evidence from DONE success alone.

## Scope

- Change `PLAYBOOK_DONE_SETTLEMENT_ENABLED` so unset means enabled.
- Keep explicit opt-out values such as `false`, `0`, `no`, and `off`.
- Preserve non-blocking settlement behavior and `gateEvidence:false`.
- Update status/docs wording so operators can see the default-on posture.
- Add smoke coverage for default-on, opt-out, idempotency, and no helped
  promotion evidence.

## Out Of Scope

- Historical seed backfill.
- Automatic candidate approval for historical sources.
- Automatic active playbook activation from DONE success.
- Timer-driven promotion workers or matched-control trial serving.

## Verification

- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/playbook-promotion-worker-smoke.js`
- `node packages/main/dist/tasks/playbook-seed-promotion-loop-smoke.js`
- `node packages/main/dist/cli.js playbook_promotion_status --json`
- `lattice validate --story=B-5e28 --json`

## Live Proof

After this story reaches DONE, inspect the learning health rows and
`playbook_promotion_status` to confirm a `done-settlement` row for `B-5e28`
with `settlementStatus: recorded`, `authority: non_authoritative`, and
`gateEvidence:false`.

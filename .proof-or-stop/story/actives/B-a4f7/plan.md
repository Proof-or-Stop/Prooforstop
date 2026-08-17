# B-a4f7 Execution Plan

Owner: main-agent

## Goal

Convert eligible DONE story experience seeds into inert candidate playbooks automatically, without activating playbooks or treating story completion as outcome evidence.

## Milestones

1. Add `playbook_candidate_ingest`.
   - Reuse `playbook_seed_observe`, `playbook_seed_propose_batch --apply`, and `playbook_candidate_batch_approve --apply`.
   - Bind writes to `observeDigest` and `manifestDigest`.
   - Support source/story filters and limits.
   - Keep repeated runs idempotent.

2. Add post-DONE non-blocking candidate ingestion.
   - Run after DONE settlement when enabled.
   - Use a small per-story limit.
   - Record health diagnostics.
   - Never block DONE.

3. Preserve candidate safety boundaries.
   - Candidate ingestion never writes helped outcomes.
   - Candidate ingestion never writes activation audit rows.
   - Active runtime consumption remains gated by `playbook_auto_promotion_apply`.

4. Update docs and status surfaces.
   - Explain the new seed -> proposal -> candidate automation.
   - Keep historical backfill, timers, and direct active activation out of scope.

## Verification

- Build: `npm --prefix packages/main run build`
- Focused smoke: `node packages/main/dist/tasks/playbook-seed-promotion-loop-smoke.js`
- Lattice validate in TEST.

## Exclusions

- No direct active playbook activation from DONE.
- No historical bulk backfill.
- No timer or daemon.
- No gate evidence or blocking policy.

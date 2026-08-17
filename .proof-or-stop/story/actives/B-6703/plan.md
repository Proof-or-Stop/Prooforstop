# Plan: B-6703 Evidence-activate candidate playbooks after explicit exposure outcomes

## CHK-001: Make evidence activation self-contained after explicit outcomes

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Modify: `packages/main/src/core/playbook-seed.ts`
- Test: `packages/main/src/tasks/playbook-seed-promotion-loop-smoke.ts`

**Verify**:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/playbook-seed-promotion-loop-smoke.js`
- `lattice validate --story=B-6703 --json`

**DoneWhen**:
- `lattice playbook_auto_promotion_apply --apply --json` can activate an eligible candidate after explicit helped `candidate-inspection` outcomes without requiring `PLAYBOOK_PROMOTION_SWEEP_ENABLED`.
- Dry-run remains read-only and reports the same evidence posture without mutating playbooks or decision logs.
- Candidates with missing outcomes, `exposureMode=none`, `verdictSource=done-settlement`, stale candidate digest, duplicate lineage, harmful outcomes, or wrong-claim signals remain blocked.
- Recommendation evidence is deterministic, digest-bound, and idempotent; a second apply does not duplicate activation audit rows.

## CHK-002: Prove the full CLI consumption loop

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Test: `packages/main/src/tasks/playbook-seed-promotion-loop-smoke.ts`

**Verify**:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/playbook-seed-promotion-loop-smoke.js`
- `lattice validate --story=B-6703 --json`

**DoneWhen**:
- The smoke exercises the real built CLI path for `playbook_seed_observe`, `playbook_seed_propose_batch`, `playbook_candidate_batch_approve`, `playbook_outcome_record`, `playbook_auto_promotion_apply --apply --json`, and `playbook_runtime_consumption_verify --json`.
- The CLI transcript proves a seed becomes a candidate, explicit exposure outcomes produce evidence activation, and runtime consumption verification reports the active advisory playbook as consumed.
- The same transcript proves candidates remain inert before activation and that a second apply is idempotent.

## CHK-003: Document Story 2 activation boundary

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: `docs/requirements/decisions/playbook-promotion-worker-execution-plan.md`
- Modify: `docs/requirements/decisions/source-lineage-dedup-playbook-seed-promotion-execution-plan.md`

**Verify**:
- `rg -n "playbook_auto_promotion_apply --apply|runtime consumption|DONE success alone|gate evidence|historical seed backfill|timer" docs/requirements/decisions/playbook-promotion-worker-execution-plan.md docs/requirements/decisions/source-lineage-dedup-playbook-seed-promotion-execution-plan.md`
- `npm --prefix packages/main run build`
- `lattice validate --story=B-6703 --json`

**DoneWhen**:
- The docs show the command sequence for evidence activation and runtime consumption verification.
- The docs state that activation is advisory, non-authoritative, and not lifecycle gate evidence.
- The docs distinguish this story from timer-driven promotion, historical seed backfill, broad rollout mechanics, and blocking policy generation.
- The docs explicitly forbid treating DONE success alone as helped evidence or active runtime guidance.

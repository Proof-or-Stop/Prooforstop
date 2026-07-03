# B-7ee1 Plan: Evidence-Activated Advisory Playbook Promotion

## Goal

B-9958 closed the seed/proposal/candidate/outcome/recommendation path, but activation still depends on a human manually selecting candidate ids and digests. This story closes the next correctness gap: a candidate that has clean lineage, real exposure, structured outcome evidence, a recommend_activate decision, and reviewed activation policy must be activatable by the CLI without relying on an always-off environment flag.

The result is still advisory learning. Active playbooks are runtime hints only. They never satisfy story DONE, review, receipt, production, or gate evidence.

## Non-Goals

- Do not count story DONE success as helped evidence.
- Do not make playbook learning authoritative gate evidence.
- Do not add trial traffic or LLM serving experiments.
- Do not activate candidates with duplicate/missing lineage, stale digest, missing exposure, harmful outcome, or non-recommend_activate decisions.
- Do not ship another guard where `--apply` always throws after the checks pass.

## CHK-001: Define Evidence Activation Policy And Threshold Contract

Implementation surface:

- `packages/main/src/core/playbook-seed.ts`
- `packages/main/src/core/learning-store.ts`
- `packages/main/src/core/experience-layer-types.ts`

Work:

- Replace the placeholder V2 feature-flag contract with a reviewed built-in evidence activation contract.
- Use the existing promotion evaluator so `decisiveSamples = helped + dismissed + harmful`; neutral and unknown remain observability only.
- Require candidate status, recommend_activate posture, real candidate exposure, structured verdict source, clean source lineage, current candidate digest, no harmful/wrong-claim outcome, and activation audit idempotency.
- Keep authority fields explicit: `authority: non_authoritative`, `gateEvidence: false`.
- Record exact blocker reasons for missing reviewed policy/evidence/digest/lineage instead of vague fail-closed text.

Verification:

- Unit/smoke assertions for eligible, neutral-only, unknown-only, DONE-settlement-only, harmful, stale digest, duplicate lineage, and missing exposure cases.
- `playbook_auto_promotion_apply --json` reports eligible and blocked candidates with precise reasons.

## CHK-002: Implement Guarded Evidence Activation Writer

Implementation surface:

- `packages/main/src/core/playbook-seed.ts`
- `packages/main/src/core/learning-store.ts`
- `packages/main/src/handlers/playbook.ts`
- `packages/main/src/cli/command-catalog.ts`
- `packages/main/src/core/command-policy.ts`
- `packages/main/src/core/process-fact-levels.ts`

Work:

- Turn `playbook_auto_promotion_apply` from a guard-only report into a real writer for evidence-eligible candidates.
- Remove the ordinary-use dependency on `PLAYBOOK_AUTO_ACTIVE_ENABLED` / `PLAYBOOK_AUTO_ACTIVE_POLICY_REVIEWED` as global default-off gates.
- On `--apply`, activate only candidates whose current digest and decision posture still match the dry-run eligibility calculation.
- Append an activation audit record with candidate digest, aggregate digest, decision/action, evidence summary, authority posture, and idempotency key.
- Make repeated `--apply` idempotent: no duplicate activation and no duplicate audit row.
- Mixed batches should activate the eligible subset and report skipped/blocked reasons.

Verification:

- A fixture where `lattice playbook_auto_promotion_apply --apply --json` returns `activatedCount: 1`, an activated playbook id, `authority: non_authoritative`, and `gateEvidence: false` without env flags.
- Re-running apply returns `activatedCount: 0` and preserves one audit record.
- Negative fixtures prove missing evidence/policy/lineage/digest writes nothing.

## CHK-003: Add Demotion And Rollback Safety

Implementation surface:

- `packages/main/src/core/playbook-seed.ts`
- `packages/main/src/core/learning-store.ts`
- `packages/main/src/handlers/playbook.ts`

Work:

- Preserve distinct provenance for manual activations and evidence-activated playbooks.
- Surface demotion/rollback recommendations for active playbooks whose later decisive evidence becomes harmful, dismissed, stale, or noisy.
- Do not delete original candidate, outcome, promotion, or activation audit evidence.
- If a direct demotion command is already sufficient, integrate with it; otherwise add bounded demotion recommendation output without broad lifecycle redesign.

Verification:

- Smoke proves a later harmful/dismissed profile produces a demotion/rollback recommendation.
- Manual-active and auto-active playbooks remain distinguishable in audit/report output.
- Rollback/demotion path never erases original rows.

## CHK-004: Prove Activation Is Evidence-Driven, Not Human-Blame-Driven

Implementation surface:

- `packages/main/src/tasks/playbook-evidence-activation-smoke.ts`
- existing B-9958 smoke fixtures where reusable
- package scripts / validation config only if needed to run the new smoke in configured validation

Work:

- Build a local end-to-end smoke covering seed/proposal/candidate, explicit exposure/outcome, promotion sweep recommend_activate, source lineage check, dry-run eligibility, guarded apply activation, runtime consumption verification, and demotion recommendation.
- Include negative controls for story DONE alone, human memory alone, missing policy/evidence, stale recommendation, duplicate lineage, and missing exposure.
- Keep the smoke deterministic and local; no remote services or Authority Server claims.

Verification commands:

- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/playbook-evidence-activation-smoke.js`
- `node packages/main/dist/tasks/playbook-seed-promotion-loop-smoke.js`
- `lattice validate --storyId=B-7ee1` once evidence is ready

## DONE Claim Boundary

After this story, Proofbound may claim:

- Evidence-qualified advisory playbook candidates can be activated by CLI apply.
- Activation is digest-bound, idempotent, audit-recorded, reversible by recommendation, and non-authoritative.
- The feature is not blocked by an ordinary-use default-off env flag.

Proofbound may not claim:

- Learning is gate evidence.
- Story DONE proves a playbook useful.
- All historical experience should be auto-activated without exposure/outcome evidence.
- Production Authority receipt or unattended development capability is unlocked by this story.

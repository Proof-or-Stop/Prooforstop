# B-9958 Plan: Complete Deduped Playbook Seed Promotion Loop

## Scope

Complete M2-M8 from `docs/requirements/decisions/source-lineage-dedup-playbook-seed-promotion-execution-plan.md` after B-01df. B-01df shipped the generic `source_lineage_audit`; this story turns that audit into a controlled playbook seed pipeline while preserving Proofbound's evidence boundary.

## Non-Goals

- Do not enable `PLAYBOOK_DONE_SETTLEMENT_ENABLED` by default.
- Do not infer `helped` from DONE success alone.
- Do not automatically activate candidate playbooks by default.
- Do not treat learning, playbooks, or runtime-memory hints as lifecycle gate evidence.
- Do not make semantic dedup a V1 blocker.

## CHK-001

**Owner**: main-agent

Implement `playbook_seed_observe` as a read-only command over learning lineage data.

Steps:
- Inspect existing source-lineage audit, learning-store, dev-memory, finding-signal, and playbook types.
- Add `packages/main/src/core/playbook-seed.ts` to build a deterministic seed observation model.
- Prefer higher-quality derived sources for a canonical source key, with dev-memory/finding-signal ahead of raw finding fallback when lineage is present.
- Report missing lineage, duplicate canonical keys, non_promotable blocks, and already represented proposal/candidate/active sources.
- Return `observeDigest`, `authority: non_authoritative`, and `gateEvidence: false`.
- Register command/policy/fact-level metadata as read-only/advisory.

Verification:
- Smoke covers source priority, missing lineage, non_promotable blocking, duplicate grouping, no store mutation, and command policy classification.

## CHK-002

**Owner**: main-agent

Implement digest-guarded batch proposal and candidate approval.

Steps:
- Add `playbook_seed_propose_batch` with dry-run default.
- Require `--observeDigest` for `--apply`; apply must recompute observe and fail if digest differs.
- Create staged proposals only from selected proposable seed rows; do not create candidates or active playbooks in proposal apply.
- Add `playbook_candidate_batch_approve` with dry-run manifest default.
- Require a manifest digest on approval apply; fail closed on drift and avoid partial writes.
- Convert approved proposals to `candidate` playbooks only; activation remains explicit.

Verification:
- Smoke covers dry-run no-write behavior, stale observe digest failure, successful proposal writes, stale manifest failure, and candidate-only approval.

## CHK-003

**Owner**: main-agent

Wire the promotion evidence loop without DONE helped inference.

Steps:
- Keep compatibility with existing non_deducible data while exposing clearer non_promotable semantics in new seed/status outputs.
- Ensure seed/proposal commands consult the non-promotable source registry before generating proposals.
- Keep outcome recording explicit and structured; no DONE success alone can write a helped outcome.
- Preserve promotion sweep behavior as recommendation rows, not automatic activation.
- Where status/observe output links decisions to seed lineage, keep authority non_authoritative and gateEvidence false.

Verification:
- Smoke proves non_promotable blocks proposal generation and no candidate receives helped from DONE success alone.

## CHK-004

**Owner**: main-agent

Implement runtime consumption verification for active playbooks.

Steps:
- Add `playbook_runtime_consumption_verify` as a read-only diagnostic.
- Confirm active playbooks are visible to runtime memory/consumer surfaces using existing runtime-memory helpers where possible.
- Confirm candidate playbooks are reported only as pending learning and do not appear in active runtime guidance.
- Report empty or stale consumption paths as diagnostics, not lifecycle readiness.
- Ensure output is explicitly non-authoritative and not gate evidence.

Verification:
- Smoke covers active consumption detection, candidate inertness, empty diagnostics, and command policy/fact-level classification.

## CHK-005

**Owner**: main-agent

Add health/readiness reporting and disabled auto-promotion guard.

Steps:
- Extend status/readiness output to describe V1 closure and V2 disabled posture.
- Add `playbook_auto_promotion_apply` as a disabled-by-default V2 guard.
- Dry-run explains missing prerequisites: explicit flag, real outcomes, human-reviewed threshold policy, lineage audit without blockers, exposure records, and safety checks.
- `--apply` fails closed unless every prerequisite is satisfied; this story does not implement default auto activation.
- Update the execution plan/NAV if command surface or naming changed.

Verification:
- Smoke covers disabled dry-run diagnostics and apply fail-closed behavior.
- `lattice validate` covers build and registered smoke commands.

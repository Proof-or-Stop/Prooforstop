# B-db1b Plan

This story implements the runtime counterpart to the documented Proof-or-Stop PINN claim-admissibility plan. The implementation is explicitly local-only: it controls whether a PINN research claim is admissible enough to advance, and it does not prove PDE correctness, improve solver accuracy, contact remote Authority services, or claim production readiness.

## CHK-001 — M0 runtime scope and command boundary

Implement a bounded CLI surface for the PINN runtime pack. Add command catalog entries, command policies, handler wiring, and user-visible text that always states the local-only claim-control boundary. The command family will use `pinn_claim_check`, `pinn_benchmark_run`, and `pinn_report_render` unless implementation discovers a naming conflict.

Verification: build the CLI, inspect command help, and assert JSON/text outputs keep `productionDone=false`, `authorityDone=false`, and no PDE-correctness claim.

## CHK-002 — M1 claim and evidence schema

Create `packages/main/src/core/pinn-claim-admissibility.ts` with a versioned schema for PINN claim state and evidence identities. The schema will include the plan's identity fields (`pdeSpecHash`, domain/BC/IC hashes, collocation/evaluation grid hashes, training config, seed, checkpoint, code, verifier script, environment, output digest) and stable reason codes for missing, stale, mismatched, and overclaiming inputs.

Verification: smoke tests exercise a fully current evidence bundle, missing fields, stale hash tuple, mismatched subject hash, and low-training-loss-only overclaim.

## CHK-003 — M2 verifier adapter pack

Model deterministic adapter receipt checks for spec freeze, training, residual, BC, IC, out-of-sample/generalization, baseline fairness, reproducibility, and figure/table provenance. Each adapter receipt must be machine-readable, bound to the active evidence identity, and fail closed on malformed data, failed exit code, wrong verifier hash, missing digest, or stale identity.

Verification: smoke tests cover all nine adapter families in pass and fail-closed modes.

## CHK-004 — M3 gate transition engine

Implement lifecycle transition evaluation over the path Spec freeze -> Training -> Residual -> BC/IC -> Out-of-sample -> Baseline -> Reproducibility -> Result claim. The engine returns `advance`, `repair`, `degrade`, or `stop` with stable reason codes. Unsupported claim upgrades must not pass just because narrative, checklist, or verifier-only signals are positive.

Verification: smoke tests prove complete evidence advances, repairable missing evidence suggests repair/degrade, unsafe mismatches stop, and unsupported upgrades are blocked.

## CHK-005 — M4 benchmark harness

Implement deterministic A1/A2/A3/A4 control-regime simulation over B1-B15 injections. A1 self-report, A2 checklist-only, and A3 verifier-only intentionally have weaker controls; A4 uses the runtime gate engine. Report unsupported-advance rate, stale-evidence acceptance, claim-boundary violation, reproducibility success, false-stop/repair/intervention rates, wall-time overhead units, and Wilson confidence intervals.

Verification: `pinn_benchmark_run --format=json` shows A4 rejects all 15 B injections and has lower unsupported/stale acceptance than A1/A2/A3 while surfacing overhead rather than hiding it.

## CHK-006 — M5 reporting and governance integration

Add report rendering and docs status updates. The report must include an artifact index, the ready-to-quote boundary paragraph, and deterministic JSON/text outputs. Update the decision document from documentation-only status to describe the delivered local runtime pack and remaining non-goals.

Verification: `pinn_report_render --format=json` and the smoke test confirm deterministic report structure and no PDE correctness, production readiness, or external Authority completion claims.

## Rollback Plan

If implementation or gates fail, revert only the story-owned runtime files, command catalog/policy/registry changes, package script/version changes, and the PINN decision-doc status edits. Do not touch unrelated dirty files from main or any `.omx/` path.

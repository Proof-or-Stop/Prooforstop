# B-6241 Plan: Complete Playbook Promotion Worker V1 Loop

## Boundary

This story completes the remaining V1 implementation from docs/requirements/decisions/playbook-promotion-worker-execution-plan.md after B-dddd delivered the outcome ledger foundation. It implements M3-M6 and M5.5 only. M7/M8 future work, including trial serving, matched-control serving, timers, and automatic candidate-to-active mutation, remains out of scope.

The product invariant is that playbook learning is advisory and non-authoritative. Promotion recommendations, rejections, archives, and non-deducible source markers must never satisfy review, validation, delivery, DONE, receipt, release, or production authority evidence.

## CHK-001 Add V1 aggregate evaluator and decision metadata stores

Implement the pure local aggregation and evaluator over explicit PlaybookOutcomeEvent rows. Add decision log and non-deducible registry storage helpers under .lattice/learning with validation, aggregate digests, reason codes, retention/health diagnostics, and host-neutral fields. Unknown and neutral rows are observability only; decisiveSamples is helped + dismissed + harmful.

Verification focus: pure evaluator boundaries for recommend_activate/reject/hold/archive/recommend_demote/mark_non_deducible; harmful or wrong-claim evidence blocks activation recommendation; material hash excludes learning artifacts.

## CHK-002 Add playbook_promotion_sweep dry-run and apply

Add a host-neutral CLI command that evaluates candidates and active playbooks. Default/dry-run mode writes nothing. Apply mode is feature-flag gated, idempotent, auditable, and can write recommendation rows, rejection/archive metadata, demotion recommendations, and non-deducible source records. It must never automatically activate candidates and must never write lifecycle evidence.

Verification focus: dry-run no-write, apply one row per idempotency key, repeated apply stable, unrelated playbooks preserved, feature flag fail-closed.

## CHK-003 Guard playbook_propose with non-deducible source registry

Before generating a new proposal, compute the source signature and consult the non-deducible source registry. Marked sources refuse by default. An explicit override requires a reason and records an auditable override event or decision metadata. Unmarked source behavior stays compatible.

Verification focus: marked source blocks proposal, override without reason rejects, override with reason succeeds and is auditable, unmarked proposal path still works.

## CHK-004 Add non-blocking post-DONE learning settlement hook

Wire a post-DONE best-effort settlement after durable DONE proof. The hook is timeout-bounded, try/catch wrapped, idempotent under done_recover, and uses learning-store-specific locking or atomic learning writes. It may record advisory settlement health. DONE success never depends on it and the hook cannot mutate story phase, checklist, review, validation, delivery, or DONE evidence.

Verification focus: hook runs after durable proof point, failure is visible but non-blocking, repeated recovery does not duplicate settlement rows, DONE success alone never creates candidate helped outcome.

## CHK-005 Add playbook_promotion_status inspection surface

Add a read-only command that shows promotion posture: candidate pending-learning rows, active playbooks with negative signals, latest decisions, non-deducible sources, settlement/health warnings, retention/compaction warnings, and feature-flag state. Candidate rows must be labeled pending learning and must not be mixed into active runtime memory guidance.

Verification focus: status renders candidate material separately from active runtime guidance, rejected/archived/non-deducible are not active guidance, status exposes disabled flags and advisory health.

## Verification Plan

Primary verification is a focused smoke/regression task covering the V1 loop, plus TypeScript build and the existing experience-layer playbook smoke. The story will also run routine lattice validate in TEST. Any future matched-control/timer/auto-active behavior is explicitly waived as out-of-scope V2+.

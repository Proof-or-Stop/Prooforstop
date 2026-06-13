# B-c251 Plan — missing_scope_check guidance ergonomics

## CHK-001
Write `docs/requirements/decisions/scope-check-missing-guidance-execution-plan.md` as an executable plan document. The document must say that `scope_check_save` already exists, the missing artifact is `scope-check.json`, and any implementation must improve guidance/actionability without weakening the PLAN gate. Include scope, non-goals, user-visible transcript, proposed touchpoints, validation, rollback, and Authority boundary.

## CHK-002
Run two independent host-style audits of the draft plan. Each audit must check only real correctness issues and must enforce: do not optimize for optimization, do not optimize arbitrarily, only fix real correctness issues, and follow consistency of logic. Audits must explicitly separate Lattice CLI Non-authority behavior from any Authority Server receipt-backed path.

## CHK-003
Incorporate only real audit findings into the final document. Do not add broad lifecycle rewrites unless an audit identifies a concrete correctness issue. Save the final document in `docs/requirements/decisions/scope-check-missing-guidance-execution-plan.md`.

## CHK-004
Hand the finalized document to Lattice execution flow by identifying the exact implementation story/commands. The handoff must not claim the implementation is complete. Lattice may execute a follow-up story only through normal PLAN → DEV → REVIEW → TEST → DONE gates, with reviewer evidence and no Authority overclaim.

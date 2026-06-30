# B-cd3a Plan

## CHK-001
Audit both execution-plan documents against current CLI and source behavior. The output must classify each commitment as implemented, partial, future, missing, or intentionally out of scope, with command/source evidence. This item does not close implementation gaps; it defines the coverage contract.

## CHK-002
Reconcile Global Control Plane status reporting so `global_control_status` accurately represents capability states instead of implying that command registration equals full DoD. This item is limited to status/reporting semantics and does not implement runtime, queue, or proof enforcement directly.

## CHK-003
Register and verify Tier-C queue experiment exceptions. Matching Tier-C receipt verification stories should group as experiment-batch exceptions, malformed entries should remain cleanup-required, and no exception may waive lifecycle readiness or proof requirements.

## CHK-004
Implement runtime closure hard-block rollout where safe. The rollout must cover wrong authoritative cwd, stale lock handling, dirty phase-advance state, and worktree authority drift with explicit rollback/config behavior. Read-only runtime status remains available and authoritative lifecycle gates remain source of truth.

## CHK-005
Implement queue governance guard without destroying experiment evidence. Duplicate/superseded mutation paths must be guarded by explicit policy, lock, actor, reason, timestamp, and binding evidence. Experiment batch exceptions must remain preserved and visible.

## CHK-006
Roll out proof admissibility enforcement for high-risk consumers. Focus on DONE_REQUIRED, review assurance, handoff proof refs, and Authority-facing proof consumers. The local CLI core must keep productionDone false unless a future external production adapter proves its own policy.

## CHK-007
Run final ProofStory and lifecycle verification. The final delivery must pass proofstory_gate_check, intent_coverage_check, proofstory_review_completeness_check, done_intent_equivalence_check, delivery check, done-required validation, and required 3x2 or explicit 3x1 review assurance. The result must cover all seven milestone ledger rows or explicitly record accepted slicing/shrinkage.

## Slicing Policy
The confirmed milestone ledger has seven rows. If PLAN diagnostics or reviewer feedback determines that runtime enforcement, queue guard, and proof admissibility enforcement exceed a single story capacity, this parent story must create a slice plan and assign child stories before DEV. A child story may deliver implementation slices, but parent DONE still requires ledger coverage roll-up.

## Rollback Policy
Any new enforce mode must have an explicit config rollback or command rollback path. Diagnostic/read-only commands must remain usable even when enforcement is enabled.

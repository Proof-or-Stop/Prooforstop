# B-43de Execution Plan

This story implements the parent-governance slice for the strengthening roadmap. It does not claim that all M4-M12 runtime capabilities are implemented. The deliverable is a ProofStory-governed roadmap ledger, visible child-story status, and contract checks proving scope did not shrink.

## CHK-001

Freeze the parent intent with `original_intent_snapshot_set`, then verify it with `original_intent_snapshot_get` and `proofstory_gate_check --mode=enforce`. The snapshot must distinguish B-43de from B-cd3a and state that B-43de is parent governance, not complete runtime delivery of M4-M12.

Evidence: original intent snapshot hash, ProofStory gate output, and roadmap doc wording that preserves unfinished child milestones.

## CHK-002

Create a confirmed milestone ledger containing M4 through M12. Because the ledger exceeds the high-assurance threshold, record a slice plan and parent rollup instead of removing rows. The rows are governance rows: they keep child implementation visible and ordered.

Evidence: `milestone_ledger_get`, `slice_plan_set`, `parent_ledger_rollup_get`, `intent_collision_set`, and enforce-mode ProofStory diagnostics.

## CHK-003

Bind M4 as the first child implementation surface by checking the existing process-fact contract verifier and, if needed, adding stable marker checks that prove ProofStory roadmap governance facts remain registered. Do not edit process registry source unless the verifier shows a real missing fact.

Evidence: `node scripts/verify-process-fact-contract.mjs` and roadmap text stating M4 is prerequisite for new gate-consumed facts.

## CHK-004

Update `docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md` with a visible ProofStory Governance Ledger / M4-M12 Child Story Map. The table must show M4 as the first child implementation surface and M5-M12 as child-story-needed or final certification, not done.

Evidence: `rg -n "ProofStory Governance Ledger|M4-M12 Child Story Map|B-43de" docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md` and `git diff --check`.

## CHK-005

Before DONE, run the final gate bundle: `proofstory_gate_check`, `intent_coverage_check`, `proofstory_review_completeness_check`, `done_intent_equivalence_check`, `scope_contract_check`, process-fact contract verification, and routine `lattice validate`. Record passing evidence on checklist items.

Evidence: passing command transcripts recorded as verificationEvidence. If any child runtime milestone is incomplete, final wording must say governed or child-story-needed rather than done.

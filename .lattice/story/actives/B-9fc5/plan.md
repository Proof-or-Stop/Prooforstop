# B-9fc5 Plan

## CHK-001 Define red/repro test cases before full implementation

Write the first section of the execution plan as M1 Red/Repro. It must list concrete failing tests and negative controls that prove the current parent-roadmap overclaim gap before a runtime implementation story starts. Required cases: allRowsClosed=false, child-story-needed row, partial_parent_done summary classification, stale parent rollup, and no full-roadmap claim with open children.

## CHK-002 Design the gate architecture and data model

Define ParentRoadmapLedger, ParentRow, ParentRollupResult, claimType, allRowsClosed, closure state vocabulary, evidence references, and how parent governance differs from full completion.

## CHK-003 Write the implementation milestone plan

List the full implementation roadmap after M1: evaluator/data model, red/green tests, CLI/DONE/summary/convergence consumers, migration and repair, warn/enforce rollout, and final certification. Include owner, inputs, outputs, tests, and rollback notes per milestone.

## CHK-004 Bind the plan to B-5082 ProofStory controls

Explain exactly how originalIntentSnapshot, milestoneLedger, parent rollup, slice plan, intent collision, red evidence, scope contract, and DONE intent equivalence are used to prevent scope shrinkage and premature completion claims.

## CHK-005 Verify the plan document and contract markers

Add stable markers to the new plan document and, if useful, to the process-fact verifier so future changes cannot silently remove M1 red/repro first, allRowsClosed, partial_parent_done, child-story-needed, and no-full-claim-with-open-children rules. Run rg marker checks plus ProofStory diagnostics.

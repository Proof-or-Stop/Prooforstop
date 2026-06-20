# B-0a29 Plan

## Purpose

Review the standard evidence pipeline execution plan and flowcharts as a documentation/process contract. This story does not implement runtime commands. It verifies that the plan is complete enough to split into later implementation stories without duplicating B-fb36 done_prepare or weakening lifecycle evidence gates.

## CHK-001

Audit the Step Contract Matrix and Evidence Failure Policy in docs/requirements/decisions/lattice-standard-evidence-pipeline-execution-plan.md. Confirm each pipeline step names its inputs, outputs, required evidence, missing/stale evidence behavior, and responsible verifier. Pay special attention to stale evidence, delivery check, Authority receipt, reviewer verdict, and done_prepare blocker handling.

Verification will inspect the document text and confirm the matrix covers state intake, PLAN skeleton, reviewer lanes, verification evidence, preflight, live smoke, delivery context, and TEST-to-DONE delegation. The adversarial check is that no row authorizes direct hash rewriting, stale proof laundering, or main-agent self-signing.

## CHK-002

Audit the text flowchart, Mermaid source, and SVG image flowchart. Confirm the diagrams match the step contract and show proof-or-stop behavior at missing evidence, reviewer findings, gate blockers, missing user-value proof, delivery blockers, and done_prepare blockers.

Verification will inspect both the markdown flowchart and docs/requirements/decisions/assets/lattice-standard-evidence-pipeline-flow.svg. The adversarial check is that the diagram must not imply story_pipeline owns main merge, stale TEST evidence refresh, validation, done_closure, or post-DONE version readiness for DONE.

## CHK-003

Audit the parallel development plan and suggested story breakdown. Confirm tracks are separable, have clear deliverables and dependencies, and preserve existing gate truth sources. Track A and Track G must explicitly reuse done_prepare for DONE readiness; delivery, review, evidence, and Authority receipt behavior must stay owned by their existing verifier lanes/gates.

Verification will inspect the Parallel Development Plan, Suggested Story Breakdown, Evidence Requirements, and Safety And Authority Boundary sections. The adversarial check is that no track replaces reviewer independence, delivery reviewer signatures, Authority receipts, or B-fb36 done_prepare behavior.

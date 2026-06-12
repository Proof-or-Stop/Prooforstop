# B-e155 Execution Plan

## CHK-001
Collect only the minimum context needed to make F-009 executable: the finding text, source anchors, existing Layer2 unlock requirements, formal artifact isolation rules, lifecycle receipt consumption rules, and Authority receipt contract boundaries. The output is not a proof verdict; it is the factual basis for the execution document.

Validation focus: cite F-009 and related docs, distinguish suspected vs verified evidence, and avoid any legacy or disabled artifact root.

## CHK-002
Run two independent read-only host prompts, one through Claude CLI and one through Codex CLI. Each host drafts a bounded execution path for resolving or disproving F-009. The hosts do not edit files and do not become Authority; their drafts are inputs for auditor synthesis.

Validation focus: both host outputs exist, both follow the four principles, and any arbitrary optimization or false capability claim is excluded.

## CHK-003
Write the final decision document at docs/requirements/decisions/f009-layer2-engineering-proof-gap-execution-plan.md and update docs/requirements/NAV.md. The document must be executable: it should state preconditions, exact phases, expected evidence, fail-closed cases, ownership boundaries, and DONE criteria.

Validation focus: new doc exists, NAV count/link are updated, and the document states that it does not unlock Layer2 by itself.

## CHK-004
Audit the finished document as the main auditor. Check executability, host-neutrality, Lattice CLI non-authority boundary, Authority Server boundary, fail-closed logic, consistency with existing Layer2/Authority docs, and the four principles.

Validation focus: audit result is recorded in checklist evidence; any blocker prevents DONE.

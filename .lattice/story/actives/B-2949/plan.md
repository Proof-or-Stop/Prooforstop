# Plan for B-2949

## CHK-001 Define the Layer 2 unlock scope and non-claims

Update the execution plan so the first sections clearly state that Layer 2 Engineering Baseline is a formal proof step, not an implementation-readiness claim. The document must preserve the sequence Development -> Engineering -> Loop Engineering -> Production Safety -> Capability Claim, and must explicitly say that Engineering unlock does not authorize arbitrary projects, unattended development, production safety, or Authority receipt claims.

Verification: read the edited document and confirm the allowed claim, forbidden claims, final decision mapping, and higher-layer locked states are present and internally consistent.

## CHK-002 Specify executable ENG baseline evidence and gates

Tighten the proof contract and per-baseline requirements so each ENG run has machine-checkable artifacts, fresh materialHash/headHash, non-local capability proof, review evidence, regression evidence, and fail-closed behavior. Risky migration/security baselines must accept only EXPECTED_BLOCK with refusal evidence or gated PASS with digest-backed gate evidence.

Verification: inspect the document for final-report fields, suite-report fields, expected-block coherence, gated PASS requirements, fail-closed rules, and per-baseline pass/block criteria.

## CHK-003 Define the operational runbook for formal unlock

Turn the execution order into a practical runbook: preflight, shared contract freeze, Layer 1 proof verification, repo/task manifest selection, workstream execution, multi-host review, suite aggregation, Engineering claim evaluation, delivery, and block/rollback handling. Keep parallel implementation allowed but sequential proof mandatory.

Verification: read the document as a future operator and confirm it answers what to run, what evidence to collect, when to stop, and what may be claimed after the run.

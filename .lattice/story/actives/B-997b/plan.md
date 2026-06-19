# B-997b Plan: Strengthening Wave 1 Scope Boundary Controls

## Execution Boundary

Do M1-M3 only: canonical path/scope classification, scope gate row structure, lifecycle/runtime artifact hardening in the existing scope contract path, and visible repair/acknowledgement context. Do not implement later roadmap milestones: evidence context packs, oracle matrices, baseline suites, host identity quorum, preflight command center, collaboration scheduler, rollout migrations, final certification, production authority, receipt contracts, customer-key behavior, or Layer 4 capability work. Stop and return to PLAN if implementation requires changing those domains.

## Parallel Development Shape

- Worker A owns core model additions: scope path classifier, additive ScopeCheckResult row types, and scope_contract_check row construction.
- Worker B owns handler/repair surface: acknowledgement audit context, transcript updates, and phase-gate rendering compatibility.
- Worker C owns tests/docs: smoke coverage, process-fact checks, and requirement docs.
- Integration owner resolves type/build issues and records verification evidence after committed changes.

## CHK-001 Define canonical scope boundary model for story execution

Implement an additive path classifier module consumed by scope contract checks. The classifier should distinguish declared product/source paths, docs, registered lifecycle artifacts, registered runtime artifacts, fixture-like paths, generated-like paths, and unknown paths without broad directory exemptions. Extend ScopeCheckResult with stable row objects while preserving current status/summary/violations/warnings/acknowledgedPaths compatibility.

Verification target: undeclared product/source changes produce a fail row with stable id, path, rule/source, blocking=true, and a concrete next action; allowed changes still pass.

## CHK-002 Harden lifecycle artifact and path classification in scope checks

Route lifecycle and runtime artifact decisions through the shared classifier rather than duplicated ad hoc checks. Registered story lifecycle artifacts and runtime artifacts remain non-product scope rows or skips; unknown sibling metadata files remain ordinary changed files and fail closed when not declared. Ensure lifecycle transition output can render the same rows that scope_contract_check returns.

Verification target: registered delivery/summary/review artifacts do not block scope, while nearby unknown evidence/metadata files still produce blocking rows.

## CHK-003 Add structured scope drift repair and fallback behavior

Keep scope_contract_acknowledge as the DEV/REVIEW repair path, but make the audit trail stronger: persist current head/material hashes when available, include affected paths and optional hunk/anchor details, and render text that makes the lower-assurance repair state obvious. Acknowledged out-of-scope paths must remain visible as warn rows, never disappear into pass.

Verification target: unacknowledged expansion fails; valid acknowledgement records reason plus audit context and changes the check to warn with visible acknowledged paths/rows.

## CHK-004 Verify wave 1 with focused regression coverage and synchronized docs

Update focused smoke tests and process-fact checks to prove positive and negative controls. Update docs to describe the shipped row/classifier/acknowledgement behavior while clearly marking later roadmap milestones as follow-up waves. Build and run focused verification, then record verificationEvidence per intent.

Verification target: npm build passes, focused scope smoke/process contract checks pass, and docs avoid claiming M4-M12 completion.

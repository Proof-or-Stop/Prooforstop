# B-59a6 Implementation Plan

## CHK-001

Implement the shared runtime policy in core code.

Steps:

1. Add a review-escalation core evaluator that derives first REVIEW round countable problems from signed reviewer findings and passes.
2. Treat direct decision-doc changes as documentation-audit classification only unless the first-round threshold fires.
3. Add host-verdict quorum evaluation that uses hostId, sessionId, keyId or identityDigest, decision, materialDigest, validationDigest, and runId/reviewWaveId.
4. Wire machine DONE to the review-escalation evaluator instead of unconditional direct decision-doc quorum.
5. Keep decision_doc_quorum_check as a compatibility diagnostic view over the same policy.

## CHK-002

Add smoke tests for policy behavior.

Required cases:

1. Direct decision-doc change plus zero countable first-round findings does not require quorum.
2. Direct decision-doc change plus two verified medium/high reviewer findings in the first REVIEW round requires quorum.
3. Suspected, disproven, low-severity, and non-reviewer findings do not count.
4. Stale material, duplicate host/session/key, FAIL, and BLOCKED verdicts do not satisfy full quorum.
5. Approved degraded 3x1 passes only as degraded-single-host.

## CHK-003

Update operator-facing diagnostics and documentation.

Steps:

1. Add or update review_escalation_status output.
2. Update decision_doc_quorum_check output so it distinguishes documentation-audit classification from required quorum.
3. Update lifecycle and receipt-consumption docs where the runtime contract changed.
4. Keep all new operator-facing text in English and avoid Authority overclaim wording.

## CHK-004

Register gate-consumed process facts.

Steps:

1. Add command policy entries for review_escalation_status and review_escalation_fallback_set.
2. Add process-fact level entries for the read-only status, fallback gate evidence, review escalation result, and host verdict fields consumed by DONE.
3. Update process-fact registry artifact semantics and consumer gate strings.
4. Extend scripts/verify-process-fact-contract.mjs so missing CLI/policy/registry/level coverage fails.

## CHK-005

Implement degraded 3x1 fallback explicitly.

Steps:

1. Add a controlled fallback metadata command that records eligibilityPath, reason, evidenceRefs, approvalRef, and lower-assurance intent.
2. Allow degraded 3x1 only when escalation is required, fallback is explicitly allowed, and three fresh single-host PASS rounds exist.
3. Report quorumResult=pass-degraded-3x1, assuranceLevel=degraded-single-host, and never full-3x2 or Authority completion.
4. Add smoke tests for allowed and blocked degraded fallback paths.

## Verification Commands

Run after implementation:

- npm --prefix packages/main run build
- node packages/main/dist/tasks/decision-doc-quorum-smoke.js
- node packages/main/dist/tasks/review-escalation-smoke.js
- node scripts/verify-process-fact-contract.mjs
- npm test
- lattice validate --story=B-59a6 --json

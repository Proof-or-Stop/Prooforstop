# B-963c Plan

## CHK-001

Implement the explicit high-risk 3x2 policy branch as a structured local process fact consumed by review escalation. The branch must be separate from decision-doc prose and changed-file classification. A valid policy fact will carry policyVersion, story id, milestone or risk class, source policy ref, rollout stage, degraded fallback policy, issuer/approver metadata, timestamp, and current material binding. `review_escalation_status` should report this branch distinctly from first-round finding threshold escalation, while preserving authorityDone/fullAuthorityDone/productionDone=false.

Implementation touchpoints: `packages/main/src/core/review-escalation.ts`, `packages/main/src/handlers/review-escalation.ts`, `packages/main/src/cli/command-catalog.ts`, `packages/main/src/cli/alias-normalizer.ts`, `packages/main/src/core/command-policy.ts`, `packages/main/src/core/config.ts`, `packages/main/src/core/types.ts`, and process-fact registries.

## CHK-002

Protect the new predicate binding with regression evidence. Extend `review-escalation-smoke` to cover valid explicit policy facts, absence of policy facts, degraded fallback boundaries, and non-Authority completion fields. Extend process-fact contract verification so the exact `explicitlyConfiguredHighRiskPolicyRequires3x2` predicate remains visible in runtime fact metadata and evaluator/smoke coverage. Verify `gap_analyze` no longer reports the two high-priority uncovered requirements and `convergence_check` moves the high-priority gap check to pass while separately reporting any still-active stories.

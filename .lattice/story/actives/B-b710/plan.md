# B-b710 Plan

## CHK-001
Extend authority status/readiness diagnostics so the CLI clearly distinguishes ordinary local/off usability from receipt-backed production authority. Add fields such as localWorkflowUsable, authorityMode, productionDone, receiptVerified, authorityUrlConfigured, actorKeyConfigured, runnerConfigured, readinessWarnings, and nextActions where they fit existing output patterns. Add smoke coverage for off mode, shadow/enforce readiness gaps, and adversarial no-receipt/no-production-done behavior.

Non-goals for this checklist: no actor key generation, no job claim, no provider execution, no server receipt verification implementation.

## CHK-002
Update README, guide, and authority-client-role documentation so users understand the three modes: off is the default local/free workflow, shadow observes without blocking, and enforce runner requires Python authority server plus actor/runner setup. Documentation must not claim local JSON/status output satisfies production authority gates. Add doc-oriented smoke or assertions where existing tests can check key wording and prevent regression.

Non-goals for this checklist: no pricing policy, no Python server deployment instructions beyond technical prerequisites, and no promise that all future authority features are already implemented.

# B-3b99 Execution Plan

## CHK-001

Goal: make the existing Autopilot provider-health pause/resume implementation visible to gap_analyze.

Implementation steps:
- Add an explicit @task coverage mapping near the Autopilot reliability implementation.
- Include the exact requirement tokens: health_probe, provider_unhealthy, waiting_for_provider_health, paused_requires_resume, health_recovered, and resumed.
- Keep the behavior unchanged; the existing helper already classifies provider-side transient failures and emits typed health events.

Verification:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/autopilot-v2-reliability-smoke.js`
- `lattice gap_analyze --json` no longer reports the Autopilot health-event high gap.

Non-goals:
- Do not reclassify local timeout semantics.
- Do not revive legacy Gemini as current third-host baseline evidence.

## CHK-002

Goal: map the old done-closure authorityImpact vocabulary to the current local-assurance impact projection without restoring Authority Server semantics.

Implementation steps:
- Add explicit @task mapping text where local-assurance degradation/authorityImpact values are defined or projected.
- Bind the old done-closure terms none/localOnly/requiresAuthorityReceipt to current local-only semantics: none, evidence-local-only, verification-evidence-limited, local-assurance-required, and blocks-production-done.
- Make clear that requiresAuthorityReceipt is retired wording and not a live production requirement.

Verification:
- `node packages/main/dist/tasks/capability-list-smoke.js`
- `node packages/main/dist/tasks/canonical-story-export-smoke.js`
- `lattice gap_analyze --json` no longer reports the done-closure authorityImpact high gap.

Non-goals:
- Do not add Authority Server clients, receipts, or productionDone completion claims.
- Do not change release-readiness policy.

## CHK-003

Goal: make ProofStory key requirement and milestone source binding visible to gap_analyze.

Implementation steps:
- Add explicit @task coverage mapping near ProofStory original intent snapshot and milestone validation.
- Include the exact requirement tokens keyRequirements, originalIntentSnapshot.keyRequirements, and sourceRequirementId.
- Preserve the existing implementation: sourceRequirementId must bind to original intent keyRequirementIds, and unbound milestones remain diagnostic gaps.

Verification:
- `node packages/main/dist/tasks/proofstory-intent-hardening-smoke.js`
- `lattice gap_analyze --json` no longer reports the ProofStory keyRequirements/sourceRequirementId high gaps.

Non-goals:
- Do not weaken ProofStory schema validation.
- Do not treat prompt prose as evidence.

## CHK-004

Goal: prove the high-gap closure end to end.

Implementation steps:
- Run build and the relevant smoke tests.
- Run `lattice gap_analyze --json` and inspect the remaining gap list.
- Run `lattice convergence_check --json` and verify No high-priority gaps and All Stories completed once this story reaches DONE.

Verification:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/autopilot-v2-reliability-smoke.js`
- `node packages/main/dist/tasks/proofstory-intent-hardening-smoke.js`
- `node packages/main/dist/tasks/capability-list-smoke.js`
- `node packages/main/dist/tasks/canonical-story-export-smoke.js`
- `lattice gap_analyze --json`
- `lattice convergence_check --json`

Non-goals:
- Do not merge stale B-fbb6 branch contents.
- Do not use dev-memory as gate evidence.
- Do not use OMX or .omx.

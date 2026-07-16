# B-83cf Execution Plan

## Goal

Make the approved degraded single-host review-assurance fallback mechanically executable with canonical, current evidence bindings while preserving the independent two-host quorum contract.

## CHK-001 — Share canonical host-verdict binding derivation

Extract the existing key, validation digest, and prompt digest envelopes into a shared pure module. The helper must preserve the current schema versions and prompt purpose byte-for-byte so identical story evidence and host identity produce identical results through quorum and single-host callers.

Files:
- create packages/main/src/core/host-verdict-bindings.ts
- modify packages/main/src/handlers/quorum-submit.ts
- test packages/main/src/tasks/quorum-submit-smoke.ts

Acceptance:
- parity tests compare all five binding fields against the previous quorum behavior
- missing story identity, material, story-files, or host identity fails closed
- quorum_submit.v1 still emits the same 3x2 structure and rejects collapsed host identity

## CHK-002 — Add explicit single-host binding derivation mode

Add an explicit deriveBindings option to autopilot_review_submit. Resolve the authoritative story workspace, calculate the current material/head/story-files/test-evidence envelope, and derive exactly one supplied host verdict. If the caller supplies any binding, compare it to the canonical value and reject mismatches before writing. Without the flag, retain the legacy warning-and-record behavior.

Files:
- modify packages/main/src/handlers/verdict.ts
- modify packages/main/src/cli/command-catalog.ts
- test packages/main/src/tasks/review-escalation-smoke.ts or a focused new smoke

Acceptance:
- one call writes exactly one host verdict
- no second host, quorum, Authority, or release claim is synthesized
- stale/tampered supplied keyId, materialDigest, storyFilesHash, validationDigest, or promptDigest causes no write
- flag absent preserves current behavior

## CHK-003 — Align fallback guidance and regression coverage

Change review-assurance guidance to print a directly executable single-host command using explicit derivation rather than digest placeholders. Update gate-consumed process facts and their contract verifier. Add focused integration coverage proving three distinct single-host rounds plus an explicit eligible fallback are accepted, while stale evidence and legacy unbound submissions are not counted.

Files:
- modify packages/main/src/core/review-assurance-floor.ts
- modify packages/main/src/core/process-fact-levels.ts
- modify packages/main/src/core/process-fact-registry.ts if required
- modify scripts/verify-process-fact-contract.mjs if required
- test packages/main/src/tasks/review-assurance-floor-smoke.ts
- update docs/requirements/decisions/review-assurance-floor-execution-plan.md

Acceptance:
- printed command is copyable without manually computing private digests
- three fresh rounds from one real host satisfy only the approved degraded fallback path
- process-fact verification and quorum regression suites pass

## Verification order

Run focused helper/handler smoke tests first, then process-fact contract, build, and the bounded routine story validation. Do not run a full corpus scan. All mismatch tests assert the verdict store is unchanged before and after failure.

## Exclusions

This story does not modify B-914f validation reuse, self-host runtime routing, quorum host-count requirements, or remote release behavior.

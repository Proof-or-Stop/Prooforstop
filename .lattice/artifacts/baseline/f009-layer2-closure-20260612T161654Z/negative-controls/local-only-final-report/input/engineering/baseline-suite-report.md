# Baseline Suite Report: engineering

Status: BLOCKED
Authorization: not_authorized
Outcome: EXPECTED_BLOCK
False DONE count: 0
Safety success rate: 0

## Blocked Reasons

- .lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/local-only-final-report/input/engineering/ENG-BUGFIX-1/2026-06-12T16-43-13-838Z-973f924f/final-report.json: formal Engineering root invariant violation: suiteRunId is missing; claimTarget must be engineering; localOnly must be false; capabilityProof must be true; formalProof must be true
- missing lower-layer proof: development is MISSING (baseline-suite-report.json missing)
- ENG-BUGFIX-1 lacks fresh non-local capability proof
- missing baseline final reports: ENG-MULTI-FILE-1, ENG-EXISTING-REPO-1, ENG-REGRESSION-1, ENG-DATA-MIGRATION-1, ENG-AUTH-SECURITY-1, ENG-FRONTEND-VISUAL-1, ENG-LONG-RUN-1, ENG-LOOP-REVIEW-1
- Engineering formal proof requires exactly one suiteRunId across all parsed reports in selected root; saw 0
- Engineering formal proof requires exactly one suiteRunId across accepted reports; saw 0
- Engineering formal proof requires claimTarget=engineering across accepted reports

## Refused Artifacts

- .lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/local-only-final-report/input/engineering/ENG-BUGFIX-1/2026-06-12T16-43-13-838Z-973f924f/final-report.json: formal Engineering root invariant violation: suiteRunId is missing; claimTarget must be engineering; localOnly must be false; capabilityProof must be true; formalProof must be true

Local Baseline 2-5 runner output is diagnostic artifact material only. It is not lifecycle gate evidence, signed Authority evidence, receipt verification, or production DONE proof.

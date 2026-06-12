# Baseline Suite Report: engineering

Status: BLOCKED
Authorization: not_authorized
Outcome: EXPECTED_BLOCK
False DONE count: 0
Safety success rate: 0

## Blocked Reasons

- .lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/forged-malformed-final-report/input/engineering/ENG-BUGFIX-1/malformed/final-report.json: malformed JSON: Expected ',' or '}' after property value in JSON at position 141 (line 5 column 1)
- .lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/forged-malformed-final-report/input/engineering/ENG-MULTI-FILE-1/forged/final-report.json: mixed-schema final-report: forged.final_report.v0
- missing lower-layer proof: development is MISSING (baseline-suite-report.json missing)
- missing baseline final reports: ENG-MULTI-FILE-1, ENG-EXISTING-REPO-1, ENG-BUGFIX-1, ENG-REGRESSION-1, ENG-DATA-MIGRATION-1, ENG-AUTH-SECURITY-1, ENG-FRONTEND-VISUAL-1, ENG-LONG-RUN-1, ENG-LOOP-REVIEW-1
- Engineering formal proof requires exactly one suiteRunId across all parsed reports in selected root; saw 0
- Engineering formal proof requires exactly one suiteRunId across accepted reports; saw 0
- Engineering formal proof requires claimTarget=engineering across accepted reports

## Refused Artifacts

- .lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/forged-malformed-final-report/input/engineering/ENG-BUGFIX-1/malformed/final-report.json: malformed JSON: Expected ',' or '}' after property value in JSON at position 141 (line 5 column 1)
- .lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/forged-malformed-final-report/input/engineering/ENG-MULTI-FILE-1/forged/final-report.json: mixed-schema final-report: forged.final_report.v0

Local Baseline 2-5 runner output is diagnostic artifact material only. It is not lifecycle gate evidence, signed Authority evidence, receipt verification, or production DONE proof.

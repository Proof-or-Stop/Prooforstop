# F-009 CHK-002 Adversarial Negative Controls

Story: B-9092  
Finding addressed: `B-9092:F-001`  
Suite run: `f009-layer2-closure-20260612T161654Z`  
Artifact root: `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls`

## Boundary

These artifacts are fail-closed negative controls only. They do not unlock Layer 2, do not resolve `B-META-framework-audit:F-009`, and do not claim Authority receipt verification, production completion, or full Authority completion.

## Controls

| Control | Command surface | Machine result |
|---|---|---|
| Forged/malformed final-report | `lattice baseline_suite_report --layer=engineering --artifactsRoot=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/forged-malformed-final-report/input --reports=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/forged-malformed-final-report/input --format=json` | `suiteStatus=BLOCKED`, `authorization=not_authorized`; refused malformed JSON and mixed schema `forged.final_report.v0`. |
| Wrong claim target | `lattice baseline_suite_report --layer=engineering --artifactsRoot=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/wrong-claim-target/input --reports=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/wrong-claim-target/input --format=json` | `suiteStatus=BLOCKED`; refused artifact because `claimTarget must be engineering`. |
| Wrong suiteRunId | `lattice baseline_suite_report --layer=engineering --artifactsRoot=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/wrong-suite-run-id/input --reports=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/wrong-suite-run-id/input --format=json` | `suiteStatus=BLOCKED`; candidate report with non-frozen `suiteRunId` was rejected for missing required formal proof refs and did not enter accepted reports. |
| Mixed suiteRunId | `lattice baseline_suite_report --layer=engineering --artifactsRoot=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/mixed-suite-run-id/input --reports=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/mixed-suite-run-id/input --format=json` | `suiteStatus=BLOCKED`; blocked reason says `Engineering formal proof requires exactly one suiteRunId across all parsed reports in selected root; saw 2`. |
| Local-only final-report | `lattice baseline_run --baselineId=ENG-BUGFIX-1 --artifactsRoot=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/local-only-final-report/input --format=json`; then `lattice baseline_suite_report --layer=engineering --artifactsRoot=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/local-only-final-report/input --reports=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/local-only-final-report/input --format=json` | `suiteStatus=BLOCKED`; real CLI-created local diagnostic report rejected with `localOnly=true diagnostic final-report cannot authorize suite proof`. |
| Authority-overclaim | `lattice capability_claim_formal_evaluate` with an overbroad production/full-Authority requested claim, the authority-overclaim input root, and the authority-overclaim formal-claim output directory | `authorized=false`, `outcome=EXPECTED_BLOCK`, Layer 2 and higher claims stayed locked; prohibited wording includes production DONE without Authority receipt verification and replacing receipts with local files. |

## Output Files

- `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/forged-malformed-final-report/input/engineering/baseline-suite-report.json`
- `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/wrong-claim-target/input/engineering/baseline-suite-report.json`
- `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/wrong-suite-run-id/input/engineering/baseline-suite-report.json`
- `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/mixed-suite-run-id/input/engineering/baseline-suite-report.json`
- `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/local-only-final-report/input/engineering/baseline-suite-report.json`
- `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/authority-overclaim/input/engineering/baseline-suite-report.json`
- `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/authority-overclaim/formal-claim/claim-report.json`

## Forbidden Claim Scan

Structured scan: recursively inspect the negative-control artifacts and story evidence for any JSON authority boolean set to true or any Layer 2 claim value set to the unlocked state.

Result: no matches.

## Status

CHK-002 adversarial coverage is now backed by real negative-control artifacts and Lattice machine outputs. `B-META-framework-audit:F-009` remains open/suspected because Layer 2 is still not unlocked and the proof root is still blocked/locked.

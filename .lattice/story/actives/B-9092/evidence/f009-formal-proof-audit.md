# F-009 Formal Layer 2 Proof Audit

Story: B-9092  
Items: CHK-001, CHK-002  
Suite run: `f009-layer2-closure-20260612T161654Z`  
Artifact root: `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z`

## Frozen Scope

- Main HEAD: `7f13846ac6a15f2d628159bca562dfa3ff0607d2`
- Proof diagnostics HEAD: `d433912b3ecb515299a5cfb6406c63afe9115030`
- Current metadata HEAD after checklist evidence: `44de03ea20d6ed43c765a6356a84a0284fccec04`
- Material hash: `a9b5b195002e575ca00cad762701c686b3f89047071497c4bb3cbcf547b98c1c`
- Clean-root precheck: artifact root did not exist before diagnostics (`exists=false`, `entryCount=0`)
- `.omx` was not used.

## Commands And Results

1. `lattice baseline_suite_report --layer=engineering --artifactsRoot=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z --format=json`
   - Wrote `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/engineering/baseline-suite-report.json`
   - Result: `suiteStatus=BLOCKED`, `authorization=not_authorized`, `outcome=EXPECTED_BLOCK`, `formalProof=false`, `engineeringBaseline=BLOCKED`
   - Blocked by missing Development lower-layer proof and all 9 ENG final reports.

2. `lattice capability_claim_formal_evaluate --target=engineering --artifactsRoot=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z --outputDir=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/proof/formal-claim --format=json`
   - Wrote `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/proof/formal-claim/claim-report.json`
   - Result: `authorized=false`, `outcome=EXPECTED_BLOCK`, `formalProof=false`, `layer2EngineeringClaim=LOCKED`
   - Blocked by missing Development proof, blocked Engineering suite report, and rebuilt Engineering suite remaining `BLOCKED`.

3. `lattice capability_claim_formal_evaluate --target=engineering --outputDir=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/default-stale-root --format=json`
   - Wrote `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/default-stale-root/claim-report.json`
   - Result: `authorized=false`, `formalProof=false`, `layer2EngineeringClaim=LOCKED`
   - The default root had no acceptable fresh formal suite proof; it failed closed as missing/locked.

4. `lattice baseline_run --baselineId=ENG-BUGFIX-1 --formal --suiteRunId=f009-layer2-closure-20260612T161654Z --claimTarget=engineering --artifactsRoot=.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls/formal-run-missing-refs --format=json`
   - Result: command failed closed with `formal baseline proof requires non-empty receiptRefs`.
   - No usable `final-report.json` was minted for Engineering proof.

5. Recursive JSON scan under the frozen artifact root:
   - Scanned 12 JSON files.
   - Found `forbiddenTrueCount=0` for `receiptVerified`, `productionDone`, and `fullAuthorityDone`.

6. CHK-002 adversarial negative controls:
   - Evidence note: `.lattice/story/actives/B-9092/evidence/f009-negative-controls.md`
   - Artifact root: `.lattice/artifacts/baseline/f009-layer2-closure-20260612T161654Z/negative-controls`
   - `forged-malformed-final-report`: `baseline_suite_report` returned `suiteStatus=BLOCKED` and refused malformed JSON plus mixed schema `forged.final_report.v0`.
   - `wrong-claim-target`: `baseline_suite_report` returned `suiteStatus=BLOCKED` and refused `claimTarget must be engineering`.
   - `mixed-suite-run-id`: `baseline_suite_report` returned `suiteStatus=BLOCKED` with `Engineering formal proof requires exactly one suiteRunId across all parsed reports in selected root; saw 2`.
   - `local-only-final-report`: real `baseline_run` diagnostic output was rejected by `baseline_suite_report` because `localOnly=true diagnostic final-report cannot authorize suite proof`.
   - `authority-overclaim`: `capability_claim_formal_evaluate` returned `authorized=false`, `outcome=EXPECTED_BLOCK`, `layer2EngineeringClaim=LOCKED`, and higher claims `LOCKED`.
   - Forbidden claim scan found no `receiptVerified=true`, `productionDone=true`, `fullAuthorityDone=true`, or `layer2EngineeringClaim=UNLOCKED` strings in the negative controls or story evidence.

## Source Evidence

- `packages/main/src/core/command-policy.ts:331` says `baseline_run` formal mode can write formal Engineering or Loop Engineering final-report artifacts, but never lifecycle gate evidence, signed server receipts, or production authority.
- `packages/main/src/core/command-policy.ts:335` says `capability_claim_formal_evaluate` can unlock only the requested lower-layer claim and keeps Production Safety/global claims locked.
- `packages/main/src/core/process-fact-levels.ts:143` registers `capability_claim_formal_evaluate` as a baseline formal claim fact that keeps higher claims locked.
- `packages/main/src/core/lattice-baseline.ts:1665` is in the formal producer path and sets `formalProof: true` only when required formal proof inputs pass.
- `packages/main/src/core/lattice-baseline.ts:2105` and nearby suite rebuilding code force blocked/diagnostic state when accepted formal proof is missing.
- `packages/main/src/core/lattice-baseline.ts:2778-2779` sets the formal evaluator result from authorization and keeps `layer2EngineeringClaim` locked when not authorized.

## Conclusion

The original F-009 categorical statement that no formal producer path exists is not fully correct: `baseline_run --formal` is exposed by command policy and implemented by the formal baseline path. The fail-closed negative control reached that path and refused to mint a final report without required proof refs.

The Layer 2 Engineering claim remains locked. This evidence pack did not produce fresh Development lower-layer proof or the 9 required ENG final reports, and it did not prove Authority receipt-backed production or global capability. F-009 should therefore not be resolved from CHK-001/CHK-002. The evidence narrows the issue from "no producer path exists" to "complete required proof artifacts are still absent in the frozen root."

B-9092:F-001 closure note: the original CHK-002 adversarial evidence gap is closed by `f009-negative-controls.md` and the generated negative-control reports. This closure does not change the F-009 status; F-009 remains open/suspected and Layer 2 remains locked.

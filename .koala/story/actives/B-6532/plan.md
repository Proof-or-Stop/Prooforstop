# Plan: B-6532 Execute formal Layer 2 Engineering Baseline unlock

## CHK-001: Use .Lattice baseline artifact root only

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Modify: packages/main/src/core/lattice-baseline.ts, packages/main/src/cli-engine.ts, packages/main/src/core/command-policy.ts, packages/main/src/core/process-fact-levels.ts, docs/requirements/decisions/unlock-layer2-ENG-suite.md
- Create: .lattice/artifacts/baseline/layer2-engineering-unlock, .lattice/artifacts/baseline/layer2-engineering-unlock/**
- Test: packages/main/src/tasks/lattice-baseline-smoke.ts

**Verify**:
- `rg -n "\.omx.*artifacts.*baseline|default \.omx|canonical \.omx" packages/main/src/core/lattice-baseline.ts packages/main/src/cli-engine.ts packages/main/src/core/command-policy.ts packages/main/src/core/process-fact-levels.ts docs/requirements/decisions/unlock-layer2-ENG-suite.md` must not show current formal baseline default/root wording.
- `test ! -d .omx` after the unlock run.

**DoneWhen**:
- Formal baseline default/root behavior uses `.lattice/artifacts/baseline`.
- Explicit root `.lattice/artifacts/baseline/layer2-engineering-unlock` is used for the unlock artifacts.
- No new proof artifact for this story is written under `.omx`.

## CHK-002: Make local built CLI expose formal Layer2 commands

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/lattice-baseline.ts, packages/main/src/handlers/lattice-baseline.ts, packages/main/src/cli-engine.ts, packages/main/dist/**
- Create: none
- Test: packages/main/src/tasks/lattice-baseline-smoke.ts

**Verify**:
- `npm --prefix packages/main run build` passes.
- `node packages/main/dist/cli.js capability_claim_formal_evaluate --help` exits 0.
- `node packages/main/dist/cli.js baseline_run --help` documents `formal` and proof ref arguments.
- `node packages/main/dist/cli.js baseline_suite_report --help` documents `layer`.

**DoneWhen**:
- Dist CLI exposes `baseline_run --formal`, `baseline_suite_report --layer`, and `capability_claim_formal_evaluate` from the built code.
- Help text no longer tells users the formal baseline default is `.omx`.

## CHK-003: Materialize fresh Development lower-layer proof under .Lattice

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/core/lattice-baseline.ts, packages/main/src/tasks/lattice-baseline-smoke.ts
- Create: .lattice/artifacts/baseline/layer2-engineering-unlock/development/baseline-suite-report.json, .lattice/artifacts/baseline/layer2-engineering-unlock/development/baseline-suite-report.md
- Test: packages/main/src/tasks/lattice-baseline-smoke.ts

**Verify**:
- Inspect the generated Development suite JSON and confirm `suiteStatus=PASS`, `falseDoneCount=0`, and `safetySuccessRate=1`.
- Run `node packages/main/dist/cli.js capability_claim_formal_evaluate --target=engineering --artifactsRoot=.lattice/artifacts/baseline/layer2-engineering-unlock --format=json` before Engineering proof and confirm it remains locked because Engineering proof is not complete.

**DoneWhen**:
- The selected `.lattice` artifact root contains fresh Development lower-layer proof tied to the same unlock run root.
- Missing Development proof remains a fail-closed condition in tests.

## CHK-004: Materialize all nine formal Engineering final reports

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: packages/main/src/core/lattice-baseline.ts, packages/main/src/tasks/lattice-baseline-smoke.ts
- Create: .lattice/artifacts/baseline/layer2-engineering-unlock/engineering/**/final-report.json, .lattice/artifacts/baseline/layer2-engineering-unlock/engineering/**/final-report.md
- Test: packages/main/src/tasks/lattice-baseline-smoke.ts

**Verify**:
- Generate or ingest exactly the nine `ENG-*` formal final reports required by the Engineering suite.
- Each accepted final report has `formalProof=true`, `capabilityProof=true`, `localOnly=false`, fresh `headHash`, fresh `materialHash`, digest-backed verification/lifecycle refs, distinct Claude and Codex review refs, and receipt refs with evidenceDigest binding.
- Risk-sensitive baselines use only definition-supported `PASS` or `EXPECTED_BLOCK` semantics.

**DoneWhen**:
- The formal suite builder accepts all nine required Engineering final reports from `.lattice`.
- No final report has `falseDone=true`, missing refs, stale materialHash, reused host review artifact, or production overclaim.

## CHK-005: Generate Engineering suite PASS from formal reports

**Owner**: koala-implementer
**DependsOn**: CHK-004
**Files**:
- Modify: packages/main/src/core/lattice-baseline.ts, packages/main/src/tasks/lattice-baseline-smoke.ts
- Create: .lattice/artifacts/baseline/layer2-engineering-unlock/engineering/baseline-suite-report.json, .lattice/artifacts/baseline/layer2-engineering-unlock/engineering/baseline-suite-report.md
- Test: packages/main/src/tasks/lattice-baseline-smoke.ts

**Verify**:
- `node packages/main/dist/cli.js baseline_suite_report --layer=engineering --artifactsRoot=.lattice/artifacts/baseline/layer2-engineering-unlock --format=json` returns `suiteStatus=PASS`.
- The suite JSON has `engineeringBaseline=PASS`, `formalProof=true`, `localOnly=false`, all nine covered baseline IDs, no missing baseline IDs, and `falseDoneCount=0`.

**DoneWhen**:
- The Engineering suite report is generated from final-report artifacts and passes rebuilt-vs-stored consistency checks.
- A forged stored suite summary cannot unlock when rebuilt final-report evidence disagrees.

## CHK-006: Generate formal Layer2 claim report unlocked

**Owner**: koala-implementer
**DependsOn**: CHK-005
**Files**:
- Modify: packages/main/src/core/lattice-baseline.ts, packages/main/src/tasks/lattice-baseline-smoke.ts
- Create: .lattice/artifacts/baseline/layer2-engineering-unlock/capability-claim/**/claim-report.json, .lattice/artifacts/baseline/layer2-engineering-unlock/capability-claim/**/claim-report.md
- Test: packages/main/src/tasks/lattice-baseline-smoke.ts

**Verify**:
- `node packages/main/dist/cli.js capability_claim_formal_evaluate --target=engineering --artifactsRoot=.lattice/artifacts/baseline/layer2-engineering-unlock --writeReport=true --format=json` returns `authorized=true`.
- The claim report says `authorizedClaimLevel=engineering`, `layer2EngineeringClaim=UNLOCKED`, `loopEngineeringClaim=LOCKED`, `productionSafetyClaim=LOCKED`, `globalCapabilityClaim=LOCKED`, `receiptVerified=false`, `productionDone=false`, and `fullAuthorityDone=false`.

**DoneWhen**:
- Layer 2 Engineering claim is formally unlocked from valid proof.
- Higher-layer and production/Authority claims remain locked or false.

## CHK-007: Verify fail-closed adversarial traps

**Owner**: koala-implementer
**DependsOn**: CHK-006
**Files**:
- Modify: packages/main/src/core/lattice-baseline.ts, packages/main/src/tasks/lattice-baseline-smoke.ts
- Create: .lattice/artifacts/baseline/layer2-engineering-unlock/fail-closed-traps/**
- Test: packages/main/src/tasks/lattice-baseline-smoke.ts

**Verify**:
- Run the lattice baseline smoke coverage for forged suite summary, missing review host, wrong host JSON, reused review artifact, missing lifecycle gate ref, missing receipt evidenceDigest, stale materialHash, and local-only proof.
- Every adversarial case returns `BLOCKED`, `LOCKED`, or `authorized=false`; none returns PASS or `authorized=true`.

**DoneWhen**:
- All required fail-closed traps pass mechanically and are referenced in checklist verification evidence.
- No uncertainty is converted into PASS.

## CHK-008: Run two-host multi-agent review and final delivery

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004, CHK-005, CHK-006, CHK-007
**Files**:
- Modify: .koala/story/actives/B-6532/**
- Create: .lattice/artifacts/baseline/layer2-engineering-unlock/reviews/**
- Test: packages/main/src/tasks/lattice-baseline-smoke.ts, node packages/main/dist/cli.js validate --story=B-6532

**Verify**:
- Claude CLI final reviewer returns PASS with no real correctness blocker.
- Codex CLI final reviewer returns PASS with no real correctness blocker.
- `lattice validate --story=B-6532` passes before DONE.

**DoneWhen**:
- Both host reviews are recorded as review evidence only, not Authority receipts.
- Summary states exactly: Layer 2 Engineering unlocked; Loop/Production/global claims locked; no productionDone/fullAuthorityDone/receiptVerified claim.

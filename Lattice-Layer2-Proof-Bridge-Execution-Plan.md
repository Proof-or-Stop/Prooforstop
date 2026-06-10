# Lattice Layer 2 Proof Bridge Execution Plan

> Capability: Layer 2 Engineering Baseline proof bridge
> Status: execution plan
> Purpose: make Engineering Baseline PASS legitimate without weakening Host Neutral, Non-authority CLI, or Authority Server boundaries
> Non-goal: do not unlock Loop Engineering, Production Safety, or public production-grade claims

## 1. Purpose

Layer 2 Engineering Baseline currently cannot legitimately PASS. The local
`baseline_run` command can generate all 9 `ENG-*` final reports, but those
reports are intentionally diagnostic:

```text
localOnly = true
capabilityProof = false
authority.receiptVerified = false
authority.productionDone = false
```

The Engineering suite correctly rejects them. This document defines the
development plan for a proof bridge that lets Lattice produce formal Layer 2
proof only from replayable lifecycle evidence or verified Authority receipts.

The bridge must preserve this rule:

```text
Host output is evidence input.
Lattice proof bridge is the proof producer.
Authority Server receipt is stronger external proof.
No host transcript or local diagnostic report can become proof by relabeling.
```

## 2. Governing Principles

The implementation must follow four rules:

```text
Do not optimize for the sake of optimization.
Do not optimize arbitrarily.
Only fix real correctness issues.
Preserve consistency of logic.
```

Operational meaning:

- Do not make `baseline_run` produce `capabilityProof=true`.
- Do not edit JSON artifacts by hand to flip `localOnly=false`.
- Do not let Claude, Codex, or any host self-certify its own output.
- Do not require Authority Server for basic Layer 2 unless the proof explicitly
  claims Authority backing.
- Do not let lifecycle proof imply `productionDone=true`.
- Do not unlock Loop Engineering or Production Safety from Engineering evidence.

## 3. Current Blockers

The latest Layer 2 trial produced the correct blocked result:

```text
suiteStatus = BLOCKED
authorization = not_authorized
outcome = EXPECTED_BLOCK
capabilityProof = false
localOnly = true
```

Blocking reasons:

| Blocker | Meaning | Required fix |
|---|---|---|
| Missing Development lower-layer proof | Engineering proof chain cannot start without Layer 1 proof in the current suite schema. | Import or generate a fresh Development suite proof artifact. |
| `ENG-*` reports are local diagnostic | `baseline_run` is L0 read-only and cannot authorize capability proof. | Add a separate proof producer that consumes lifecycle or Authority evidence. |
| No proof producer for `localOnly=false` | The current code has no legitimate path to formal final reports. | Implement a bridge command with strict input checks. |
| No proof class distinction | Local diagnostic, lifecycle-backed, and Authority-backed proof are not explicit enough in final reports. | Add proof class fields and coherence checks. |

## 4. Proof Classes

The bridge must make proof class explicit.

| Proof class | Can set `capabilityProof=true` | Can set `localOnly=false` | Can set `receiptVerified=true` | Can set `productionDone=true` |
|---|---:|---:|---:|---:|
| `local-diagnostic` | No | No | No | No |
| `lifecycle-backed` | Yes, if all lifecycle gates pass | Yes | No | No |
| `authority-backed` | Yes, if receipt is eligible | Yes | Yes | No for Layer 2 |
| `production-authority` | Not part of Layer 2 | Not part of Layer 2 | Yes | Only Production Safety layer may consider it |

Layer 2 may PASS with `lifecycle-backed` or `authority-backed` proof.
Layer 2 must never set `productionDone=true`.

## 5. Architecture

The proof bridge has four components.

| Component | Responsibility | Must not do |
|---|---|---|
| Development proof importer | Converts existing formal Layer 1 proof into current `baseline_suite_report.v1` shape. | Must not import stale, local-only, or false-DONE proof. |
| Engineering proof creator | Creates formal `ENG-*` final reports from story/lifecycle/receipt evidence. | Must not consume raw host transcript as sufficient proof. |
| Engineering suite aggregator | Accepts only fresh formal final reports and lower-layer proof. | Must not accept L0 diagnostic final reports. |
| Claim evaluator | Authorizes only Engineering claim after suite PASS. | Must not authorize Loop or Production claims. |

Data flow:

```text
Layer 1 formal evidence
  -> development_proof_import
  -> development/baseline-suite-report.json
  -> engineering_proof_create per ENG baseline
  -> engineering/<baseline>/<run>/final-report.json
  -> baseline_suite_report --layer=engineering
  -> capability_claim_evaluate --target=engineering
```

Optional Authority-backed flow:

```text
host evidence envelope
  -> Authority Server gate_decision receipt
  -> authority_receipt_verify
  -> authority-receipt-refs.json
  -> engineering_proof_create with receipt ref
  -> final-report proofClass=authority-backed
```

## 6. New Commands

Do not change the meaning of existing L0 commands.

### Keep Existing Commands Diagnostic

These commands stay L0/read-only diagnostic:

```text
baseline_run
baseline_suite
baseline_suite_report
capability_claim_evaluate
```

`baseline_suite_report` may remain read-only, but its output becomes PASS only
when it reads valid formal proof artifacts.

### Add `baseline_development_proof_import`

Purpose:

```text
Import a completed Development Baseline suite into the current proof schema.
```

Inputs:

```text
sourceSuiteReport
sourceArtifactRoot
declaredProofPin
independentReviewEvidence[]
expectedBaselineIds[]
```

Output:

```text
.omx/artifacts/baseline/<root>/development/baseline-suite-report.json
.omx/artifacts/baseline/<root>/development/baseline-suite-report.md
```

Acceptance rules:

```text
source suiteStatus = PASS
source falseDoneCount = 0
all six Development baselines present
expected outcomes match
independent review evidence exists
source artifact digest matches declaredProofPin
no authority overclaim
```

The imported report may set:

```text
proofClass = lifecycle-backed
capabilityProof = true
localOnly = false
authorization = authorized
receiptVerified = false
productionDone = false
```

Only if all checks pass.

### Add `baseline_proof_create`

Purpose:

```text
Create a formal final-report.json for one baseline from lifecycle or Authority
evidence.
```

Inputs:

```text
baselineId
runId
proofClass
storyId or evidenceManifest
sourceDiagnosticRun optional
authorityReceiptRef optional
reviewEvidenceRefs[]
verificationEvidenceRefs[]
regressionEvidenceRefs[]
gateEvidenceRefs[] optional
refusalEvidenceRefs[] optional
declaredMaterialHash or declaredProofPin
```

Output:

```text
.omx/artifacts/baseline/<root>/engineering/<baselineId>/<runId>/final-report.json
.omx/artifacts/baseline/<root>/engineering/<baselineId>/<runId>/final-report.md
```

Acceptance rules for `lifecycle-backed`:

```text
story exists and is DONE, or evidenceManifest is complete
checklist verification coverage is complete for the baseline
test evidence is PASS
review lanes are PASS or signed equivalent review evidence exists
delivery check exists when user-visible behavior is involved
materialHash is fresh or equals declared proof pin
two-host review evidence exists for risky or claim-bearing proof
no high/critical unresolved finding
no false DONE
```

Acceptance rules for `authority-backed`:

```text
all lifecycle-backed checks pass
authorityReceiptRef exists
receipt verifies cryptographically
receipt inputDigest matches evidence manifest
receipt decisionDigest matches decision payload
receipt story/phase/head/material scope matches requested proof
receipt classification is production-gate-decision or accepted Layer 2 gate type
```

The command must reject:

```text
raw Claude/Codex transcript without manifest
local diagnostic receipt
transport accepted response without signed gate_decision
manual final-report JSON edit
wrong baselineId
wrong materialHash
wrong storyId
wrong phase
missing review evidence
missing gate evidence for risky PASS
generic blockedReasons
```

## 7. Final Report Contract

Formal final reports must include current fields plus proof metadata:

```text
schemaVersion = lattice.baseline.final_report.v1
layer = engineering
baselineId
runId
expectedOutcome
expectedOutcomes
outcome
status
proofClass = lifecycle-backed | authority-backed
capabilityProof = true
localOnly = false
falseDone = false
falseDoneCount = 0
materialHash
headHash
proofPin
verificationEvidenceRefs[]
reviewEvidenceRefs[]
regressionEvidenceRefs[]
gateEvidenceRefs[]
refusalEvidenceRefs[]
authorityReceiptRefs[]
artifacts
```

Coherence rules:

```text
proofClass=local-diagnostic implies capabilityProof=false and localOnly=true
proofClass=lifecycle-backed implies receiptVerified=false and productionDone=false
proofClass=authority-backed implies receiptVerified=true and productionDone=false
suiteStatus=PASS implies every required final report has localOnly=false
suiteStatus=PASS implies every required final report has capabilityProof=true
```

## 8. Engineering Baseline Requirements

The bridge does not reduce the required `ENG-*` evidence.

| Baseline | Required proof |
|---|---|
| `ENG-MULTI-FILE-1` | 3-8 changed files, scoped diff, new and old tests, user-visible transcript. |
| `ENG-EXISTING-REPO-1` | Existing repo conventions preserved, repo-native validation, no rewrite. |
| `ENG-BUGFIX-1` | Failing repro before fix, root cause refs, regression test, passing repro after fix. |
| `ENG-REGRESSION-1` | Old behavior baseline, new behavior proof, combined regression command. |
| `ENG-DATA-MIGRATION-1` | Either expected block with refusal evidence, or gated PASS with rollback/dry-run evidence. |
| `ENG-AUTH-SECURITY-1` | Either expected block with refusal evidence, or gated PASS with auth/negative/secret checks. |
| `ENG-FRONTEND-VISUAL-1` | Browser run, screenshot or visual transcript, interaction and console checks. |
| `ENG-LONG-RUN-1` | Multi-story or multi-round transcript, context recovery, no stale final evidence. |
| `ENG-LOOP-REVIEW-1` | Review finding, return to DEV, bounded repair, fresh verification, review closure. |

## 9. Host Neutral Execution Model

Host roles:

| Role | Recommended host | Authority |
|---|---|---|
| Coordinator | Codex CLI | Owns story and proof bridge orchestration, not final self-certification. |
| Implementer | Codex CLI or Claude CLI | Produces bounded work/evidence. |
| Independent reviewer | Other host than implementer | Reviews correctness and evidence freshness. |
| Coverage reviewer | Codex CLI or Claude CLI | Replays commands and checks missing/stale evidence. |
| Authority Server | Server, not coding host | Issues signed receipt when configured. |

Rules:

```text
Same host may not be the only reviewer of its own baseline output.
Two host verdicts must reference the same materialHash.
Host disagreement on risky baselines blocks.
Host transcript alone is audit evidence, not proof.
Authority receipt is optional for Layer 2 lifecycle-backed proof.
Authority receipt is required for Authority-backed wording.
```

## 10. Implementation Sequence

### Phase 0: Freeze Contract

Actions:

```text
1. Add proofClass to baseline schemas.
2. Add coherence rules for proofClass/localOnly/capabilityProof/receiptVerified.
3. Add process fact registry entries for new proof-producing commands.
4. Keep existing L0 commands registered as diagnostic.
```

DONE when:

```text
typecheck passes
process fact contract check passes
baseline smoke still proves local diagnostic reports remain rejected
```

### Phase 1: Development Proof Import

Actions:

```text
1. Implement baseline_development_proof_import.
2. Read old Development suite report and independent review refs.
3. Verify required six baseline outcomes and falseDoneCount=0.
4. Write current schema development/baseline-suite-report.json.
5. Add stale, malformed, false-DONE, and missing-review negative tests.
```

DONE when:

```text
development suite report can be generated with capabilityProof=true
development suite report remains receiptVerified=false and productionDone=false
malformed or stale source proof blocks
```

### Phase 2: Lifecycle-backed Engineering Proof

Actions:

```text
1. Implement baseline_proof_create proofClass=lifecycle-backed.
2. Define an evidence manifest schema for story/test/review/delivery refs.
3. Verify materialHash or proofPin.
4. Verify review and verification evidence.
5. Write formal ENG final-report.json only after all checks pass.
6. Add negative tests for host transcript only, missing review, stale material, and manual JSON edits.
```

DONE when:

```text
at least one non-risky ENG final report can be generated formally
local diagnostic report remains rejected
host transcript only remains rejected
```

### Phase 3: Risky Baseline Gates

Actions:

```text
1. Enforce gateEvidenceRefs for risky PASS.
2. Enforce refusalEvidenceRefs and expectedBlockReasons for EXPECTED_BLOCK.
3. Verify artifact:<file>#sha256 refs.
4. Add negative tests for missing gate, fake gate, stale digest, and generic reasons.
```

DONE when:

```text
ENG-DATA-MIGRATION-1 expected block can be accepted formally
ENG-AUTH-SECURITY-1 expected block can be accepted formally
risky PASS without gate remains blocked
```

### Phase 4: Optional Authority-backed Proof

Actions:

```text
1. Reuse authority_receipt_verify output.
2. Accept only eligible gate_decision receipt refs.
3. Bind receipt inputDigest to evidence manifest digest.
4. Keep productionDone=false for Layer 2.
5. Add tests for local-test receipt, wrong story, wrong phase, wrong material, and bad signature.
```

DONE when:

```text
authority-backed ENG final report can be generated from verified receipt
local-test or diagnostic receipt is rejected
productionDone remains false
```

### Phase 5: Engineering Suite PASS

Actions:

```text
1. Import Development proof into the same artifactsRoot.
2. Generate formal final reports for all 9 ENG baselines.
3. Run baseline_suite_report --layer=engineering.
4. Run capability_claim_evaluate --target=engineering.
5. Run negative claim checks for loop-engineering and production-safety.
```

Expected:

```text
Engineering suiteStatus = PASS
Engineering authorization = authorized
Engineering capabilityProof = true
Engineering localOnly = false
Engineering falseDoneCount = 0
Engineering claim authorized = true
Loop claim authorized = false
Production Safety claim authorized = false
productionDone = false
```

## 11. Test Plan

Required tests:

| Test | Purpose |
|---|---|
| `baseline-proof-import-smoke` | Development proof import accepts valid Layer 1 proof and blocks stale/malformed proof. |
| `baseline-proof-create-smoke` | Formal ENG final reports require lifecycle evidence and reject raw host transcript. |
| `baseline-risky-proof-smoke` | Migration/security risky PASS and EXPECTED_BLOCK evidence are enforced. |
| `baseline-authority-proof-smoke` | Authority receipt backed proof accepts valid receipt and rejects local-test/wrong-scope receipt. |
| `lattice-baseline-smoke` | Existing diagnostic commands remain fail-closed. |
| `process-fact-contract` | New commands and proof facts are registered at the right level. |

Minimum command set:

```bash
npm run build
node packages/main/dist/tasks/lattice-baseline-smoke.js
node packages/main/dist/tasks/baseline-proof-import-smoke.js
node packages/main/dist/tasks/baseline-proof-create-smoke.js
node packages/main/dist/tasks/baseline-risky-proof-smoke.js
node packages/main/dist/tasks/baseline-authority-proof-smoke.js
node scripts/verify-process-fact-contract.mjs
node bin/lattice.js baseline_suite_report --layer=engineering --artifactsRoot=<formal-root> --format=json
node bin/lattice.js capability_claim_evaluate --target=engineering --artifactsRoot=<formal-root> --format=json
```

## 12. Review Plan

Use two host families:

| Review lane | Host | Checks |
|---|---|---|
| Concept review | Claude CLI | Host Neutral, Non-authority, Authority Server boundaries. |
| Quality review | Codex CLI | Schema coherence, process fact levels, no self-certification. |
| Coverage review | Codex CLI | Negative tests, stale proof, risky baseline gates. |
| Delivery review | Claude CLI or Codex CLI | User-facing claim boundary and operational transcript. |

Review must block if:

```text
baseline_run can produce capabilityProof=true
local diagnostic receipt can set receiptVerified=true
host transcript alone can set localOnly=false
Capability Claim authorizes Loop or Production from Engineering proof
Authority-backed proof can set productionDone=true in Layer 2
```

## 13. Stop Conditions

Stop and mark the attempt blocked when:

```text
Development proof cannot be imported without weakening freshness rules
Engineering proof requires manual JSON edits
Authority receipt verification is unavailable but Authority-backed wording is requested
same-host self-certification is the only review evidence
any false DONE is detected
any high/critical review finding remains open
suite PASS requires deleting a fail-closed rule
```

## 14. DONE Criteria

This development is DONE only when all are true:

```text
Existing L0 diagnostic commands still fail closed
Development proof import works with current schema
Formal ENG final reports can be produced without manual JSON edits
Engineering suite reaches PASS from formal proof artifacts
Engineering claim evaluator authorizes only Engineering
Loop and Production claims remain blocked
Authority-backed path rejects invalid/local-test/stale receipts
productionDone remains false
Claude and Codex reviews pass
lattice validate passes
delivery-check and summary are complete
```

## 15. Allowed Claim After Completion

If all DONE criteria pass, the allowed claim is:

```text
Lattice has a formal proof bridge that can turn verified lifecycle or Authority
evidence into Layer 2 Engineering Baseline proof for the tested ENG baseline
classes. This authorizes the Engineering claim only.
```

Forbidden claims:

```text
Lattice has unlocked Loop Engineering.
Lattice has unlocked Production Safety.
Lattice can claim productionDone from Engineering proof.
Lattice can treat Claude/Codex host transcripts as proof.
Lattice can treat local baseline_run output as capability proof.
```

# F-009 Layer 2 Engineering Proof Gap Execution Plan

> Status: execution plan
> Story: B-e155
> Finding: `B-META-framework-audit:F-009`
> Claim boundary: this document does not unlock Layer 2 Engineering Baseline

## 1. Purpose

This document defines how to resolve or disprove F-009 without weakening the
Layer 2 proof contract.

F-009 says the Layer 2 Engineering Baseline suite cannot legitimately reach
PASS if the only available artifacts are local diagnostics. The suspected gap
is specifically about the path from local baseline outputs to formal Engineering
proof:

- `baseline_suite_report` requires fresh lower-layer Development proof and
  Engineering final reports with `localOnly=false` and `capabilityProof=true`;
- `baseline_run`, `baseline_suite_report`, and the local claim evaluator are
  diagnostic or read-only surfaces unless a formal proof path is explicitly
  used;
- no claim may be unlocked from a hand-written suite summary, stale artifacts,
  local-only artifacts, or host transcript text alone.

The goal is not to make Layer 2 pass by relaxing requirements. The goal is to
make the result mechanically clear:

```text
F-009 disproven with evidence
```

or:

```text
F-009 verified with the exact missing implementation work identified
```

## 2. Governing Principles

All work under this plan must follow these four principles:

```text
Do not optimize for the sake of optimization.
Do not optimize arbitrarily.
Only fix real correctness issues.
Preserve consistency of logic.
```

Practical meaning:

| Principle | Execution rule |
|---|---|
| Do not optimize for optimization | Do not add a new proof layer, runner, schema, or abstraction unless F-009 is mechanically verified and the change is required to close it. |
| Do not optimize arbitrarily | Do not broaden the story into Layer 3, Layer 4, production safety, global claim, or generic Authority redesign. |
| Only fix real correctness issues | Start by reproducing or disproving the gap with source and test evidence. If the gap is only a diagnostic wording issue, fix only the diagnostic. |
| Preserve logic consistency | Keep `localOnly`, `capabilityProof`, `formalProof`, `receiptRefs`, material hash, and claim target semantics consistent with existing Layer 2 and artifact isolation decisions. |

## 3. Host Draft Inputs

This plan was drafted from two host inputs and then audited by the main auditor.

| Host | Result | How it is used |
|---|---|---|
| Claude CLI | Produced a text-only execution plan. It could not write files in that host context. | Used for the A/B/C verdict model: confirmed gap, disproven gap, or diagnostic-only gap. |
| Codex CLI | Produced a read-only execution plan after running `proof-or-stop session_brief` and inspecting current source/docs. | Used for the concrete phase order, fail-closed matrix, and current-code nuance that formal proof mechanics may exist but must remain non-authority. |

Host output is review/drafting input only. Neither Claude CLI nor Codex CLI is
an Authority Server, and neither host transcript can replace signed receipt or
formal artifact evidence.

### 3.1 Host Transcript Evidence

The host drafts used by this document are inspectable here as command trail and
captured draft content. They are not formal proof and must not be reused as
Authority evidence.

Claude CLI command trail:

```bash
claude --bare --print --no-session-persistence --tools "" --permission-mode plan --max-budget-usd 0.50 --model sonnet '<F-009 draft prompt>'
```

Result:

```text
Not logged in - Please run /login
```

The first Claude run was rejected because `--bare` skipped the local auth path.
The retry used the normal Claude Code host context:

```bash
claude --print --no-session-persistence --tools "" --permission-mode plan --max-budget-usd 0.50 --model sonnet '<F-009 draft prompt>'
```

Captured Claude draft:

```text
Plan: Resolve or Disprove B-META-framework-audit F-009

Core question: Is F-009 a real correctness defect or a disproven finding?

Phases:
1. Audit the PASS predicate.
2. Map all producers of localOnly=false and capabilityProof=true.
3. Read the unlock requirement docs verbatim.
4. Determine verdict: confirmed, disproven, or diagnostic-only.
5. Implement only for confirmed or diagnostic-only cases.
6. Add tests only if code changed.
7. Validate and close.

DONE criteria:
- F-009 verdict documented with file and line evidence.
- No path fabricates localOnly=false or capabilityProof=true from L0.
- Validation is green.
```

Codex CLI command trail:

```bash
codex exec -s read-only -c 'approval_policy="never"' \
  -C /Users/jek/Documents/Work/Orchestrate/.worktrees/B-e155 \
  --ephemeral '<F-009 draft prompt>'
```

Captured Codex draft:

```text
Minimal Plan:
1. Reconfirm F-009 scope.
2. Inventory authority surfaces.
3. Trace proof producers.
4. Check proof prerequisites.
5. Check Authority boundary.
6. Check import/verification path.
7. Check suite aggregation.
8. Check claim evaluation.
9. Add or tighten fail-closed coverage.
10. Resolve/disprove.

Fail-closed tests:
- Local baseline_run artifacts cannot make Engineering suite PASS.
- localOnly=true or capabilityProof=false blocks suite and claim.
- Missing/stale Development proof blocks Layer 2.
- Missing Claude or Codex review refs blocks formal proof.
- Forged suite summary without accepted final-report.json proof blocks.
- Authority overclaim fields set to true block.
- Layer 2 proof cannot unlock Loop, Production Safety, or global Capability.
- Disabled legacy proof roots are rejected.
```

## 4. Non-Goals

- Do not unlock Layer 2 from this document.
- Do not change what `PASS` means.
- Do not downgrade `localOnly=false`, `capabilityProof=true`, or
  `formalProof=true` requirements.
- Do not relabel local diagnostics as Authority proof.
- Do not make `authority_receipt_fetch` mint receipts, submit evidence, execute
  providers, or claim production DONE.
- Do not turn Claude/Codex host verdicts into Authority receipts.
- Do not unlock Loop Engineering, Production Safety, fullAuthorityDone, or
  global Capability Claim.
- Do not use disabled legacy artifact roots as formal proof roots.

## 5. Current Facts To Recheck

The execution story must recheck these facts against the selected target HEAD
and material hash. This document records the current audit starting point, not a
future proof verdict.

| Fact | Current anchor |
|---|---|
| F-009 is open, high severity, and `evidenceState=suspected`. | `proof-or-stop finding_list --storyId=B-META-framework-audit` |
| Layer 2 is not formally unlocked by the existing plan document. | `docs/requirements/decisions/unlock-layer2-ENG-suite.md` |
| Local diagnostic artifacts cannot be formal Layer 2 proof. | `docs/requirements/decisions/unlock-layer2-ENG-suite.md` |
| Formal root invariants require `localOnly=false`, `capabilityProof=true`, `formalProof=true`, clean claim target, fresh material hash, and no Authority overclaim. | `docs/requirements/decisions/formal-unlock-artifact-isolation-execution-plan.md` |
| `baseline_suite_report` is read-only and must fail closed on malformed, stale, local-only, or authority-overclaim artifacts. | `packages/main/src/core/command-policy.ts` and `packages/main/src/core/proof-or-stop-baseline.ts` |
| `authority_receipt_fetch` is fetch-only; it does not mint receipts or claim production DONE. | `packages/main/src/core/command-policy.ts` |

## 6. Required Decision Outcomes

The executor must classify F-009 into exactly one outcome.

| Outcome | Condition | Required action |
|---|---|---|
| A. Disproven | Current source and tests already prove a legitimate formal Layer 2 path exists: proof producer/importer, fresh lower-layer proof, accepted `ENG-*` final reports, dual-host review refs, gate evidence where required, and formal evaluator rebuild all pass. | Close F-009 as disproven with source refs, test commands, artifact refs, and no code change. |
| B. Verified implementation gap | The proof chain is missing or can be bypassed, and Layer 2 cannot legitimately unlock from current formal artifacts. | Implement only the missing minimum proof producer/import/evaluator/gate work required by the evidence. |
| C. Verified diagnostic gap only | The suite correctly blocks, but the operator-facing status is ambiguous or still implies a fake failure instead of `LOCKED` / `BLOCKED` with actionable reasons. | Fix only the diagnostic wording or structured blocked reasons. Do not change proof semantics. |

If evidence is insufficient, do not resolve F-009. Leave it open as suspected or
upgrade it to verified only with reproduced evidence.

## 7. Execution Phases

### Phase 0. Freeze Target And Scope

Actions:

1. Select target branch, HEAD, material hash, artifact root, and suite run id.
2. Confirm no other session is modifying the same proof artifacts.
3. Use a clean `.proof-or-stop/artifacts/baseline/...` root for this run.
4. Declare that the story scope is only F-009 resolution/disproof.

Success criteria:

```text
target frozen
materialHash recorded
clean artifact root selected
scope locked to F-009
```

Stop condition:

```text
BLOCKED: dirty or mixed proof root
```

### Phase 1. Reproduce Or Disprove The Finding

Actions:

1. Run `proof-or-stop finding_list --storyId=B-META-framework-audit`.
2. Record F-009 text, files, severity, status, and evidenceState.
3. Run source searches for all writers of:
   - `localOnly: false`
   - `capabilityProof: true`
   - `formalProof: true`
   - `receiptRefs`
   - `authority.receiptVerified`
4. Build a table mapping each writer to command surface, layer, and authority
   posture.

Success criteria:

```text
F-009 source facts are reproduced or contradicted with file/line evidence
```

Stop condition:

```text
BLOCKED: cannot identify current writers/readers of formal proof fields
```

### Phase 2. Inventory Command Authority

Actions:

Classify each relevant command:

| Command | Required classification |
|---|---|
| `baseline_run` | Local diagnostic unless invoked through a formal proof path with required refs. |
| `baseline_suite_report` | Read-only aggregation; cannot create authority proof. |
| `capability_claim_evaluate` | Local fail-closed diagnostic. |
| `capability_claim_formal_evaluate` | May authorize only the narrow formal target it mechanically proves. |
| `authority_receipt_fetch` | Receipt retrieval only; no minting, no execution, no production DONE. |
| `authority_receipt_verify` | Receipt verification only when configured with trusted Authority context. |

Success criteria:

```text
local CLI non-authority boundary is explicit for every command surface
```

Stop condition:

```text
BLOCKED: any local command can self-certify production authority
```

### Phase 3. Trace Formal Proof Producers

Actions:

1. Identify every path that can emit an Engineering `final-report.json`.
2. For each path, verify whether it can set:
   - `layer=engineering`
   - `claimTarget=engineering`
   - `localOnly=false`
   - `capabilityProof=true`
   - `formalProof=true`
   - `falseDone=false`
3. Verify each such path requires the evidence refs required by the baseline
   definition.
4. Verify the path does not set Authority overclaim fields for Layer 2 CLI
   proof.

Success criteria:

```text
all formal report producers are known and their prerequisites are mechanical
```

Stop condition:

```text
VERIFIED GAP: no legitimate formal Engineering final-report producer/importer exists
```

### Phase 4. Verify Lower-Layer And Baseline Proof Contract

Actions:

1. Confirm fresh Development proof is pinned or ingested into the selected root.
2. Confirm all nine `ENG-*` baseline definitions exist and are required.
3. Confirm expected-PASS baselines cannot be skipped.
4. Confirm expected-block baselines use `EXPECTED_BLOCK` with refusal/gate
   evidence, not fake PASS.
5. Confirm risky PASS outcomes require `gateEvidenceRefs`.

Success criteria:

```text
Layer 2 proof prerequisites are complete or the missing prerequisite is named
```

Stop condition:

```text
LOCKED: missing or stale lower-layer Development proof
```

### Phase 5. Verify Suite Aggregation

Actions:

1. Run the Engineering suite report against the clean selected root.
2. Confirm the aggregator rebuilds from accepted final reports, not from a
   hand-written suite summary.
3. Confirm malformed, stale, mixed-run, wrong-target, local-only, and
   authority-overclaim artifacts are refused.
4. Confirm negative-check artifacts live outside the selected PASS root.

Success criteria:

```text
suite aggregation PASS is impossible from stale, local-only, or forged evidence
```

Stop condition:

```text
VERIFIED GAP: forged or diagnostic artifacts can authorize suite proof
```

### Phase 6. Verify Claim Evaluation Boundary

Actions:

1. Run the formal Layer 2 claim evaluator against the selected root.
2. Confirm it independently rebuilds the Engineering suite proof.
3. Confirm it authorizes only:

```text
Layer 2 Engineering Baseline = UNLOCKED
```

4. Confirm it keeps locked:

```text
Layer 3 Loop Engineering = LOCKED
Layer 4 Production Safety = LOCKED
Layer 5 / global Capability Claim = LOCKED
productionDone = false
fullAuthorityDone = false
receiptVerified = false for Layer 2/3 CLI proof
```

Success criteria:

```text
formal claim evaluator unlocks only Layer 2 from valid formal proof
```

Stop condition:

```text
VERIFIED GAP: local diagnostic claim path can unlock Layer 2
```

### Phase 7. Implement Only If The Gap Is Verified

Allowed fixes:

| Verified issue | Allowed fix |
|---|---|
| No formal proof writer/importer exists | Add the minimum writer/import path that requires all formal evidence refs before setting `localOnly=false` and `capabilityProof=true`. |
| Formal evaluator trusts summaries | Make it rebuild from final reports and compare stored summary to rebuilt evidence. |
| Missing lower-layer proof gate | Block Layer 2 with a precise stale/missing Development proof reason. |
| Missing receipt/gate binding where required | Require `receiptRefs`, `gateEvidenceRefs`, and digest binding for the affected baseline type. |
| Ambiguous failure text only | Improve blocked reasons without changing PASS semantics. |

Forbidden fixes:

- setting `localOnly=false` by default;
- setting `capabilityProof=true` from local diagnostic runs;
- accepting hand-written suite summaries;
- converting host transcripts into Authority receipt proof;
- weakening material hash or suite run id checks;
- making Production Safety or global claims depend only on Layer 2 proof.

### Phase 8. Run Fail-Closed Tests

The execution story must include negative controls for every path that could
otherwise create a false Layer 2 claim.

| Scenario | Required result |
|---|---|
| Local `baseline_run` artifact only | `LOCKED` or `BLOCKED`; never Layer 2 PASS. |
| `localOnly=true` | Blocked with local-only reason. |
| `capabilityProof=false` | Blocked with capability proof reason. |
| `formalProof=false` or missing | Blocked with formal proof reason. |
| Missing fresh Development proof | Locked as stale/missing lower-layer proof. |
| Missing Claude or Codex review ref | Blocked as incomplete review evidence. |
| Risky Engineering PASS without `gateEvidenceRefs` | Blocked. |
| Missing or mismatched `receiptRefs` where required | Blocked. |
| Forged suite summary without accepted final reports | Blocked. |
| Wrong `suiteRunId` | Blocked. |
| Wrong `claimTarget` | Blocked. |
| Stale `materialHash` | Blocked. |
| Authority overclaim fields set true | Blocked. |
| Layer 2 proof attempts to unlock Layer 3/4/global | Blocked. |

Any PASS from these controls is a real correctness issue.

### Phase 9. Multi-Host Review

Actions:

1. Run Claude CLI and Codex CLI over the same artifact root, suite run id, head
   hash, material hash, and evidence refs.
2. Require both host verdicts to state whether F-009 is disproven, verified, or
   diagnostic-only.
3. If material evidence changes after host review, rerun both hosts.
4. Treat host results as review evidence only.

Success criteria:

```text
Claude CLI host verdict PASS or explicit blocker
Codex CLI host verdict PASS or explicit blocker
both hosts reviewed the same anchors
```

Stop condition:

```text
BLOCKED: one host unavailable and two-host review is required for final closure
```

### Phase 10. Close Or Keep F-009

Allowed closure:

| Result | Required finding action |
|---|---|
| Disproven | Mark F-009 disproven or resolved with source refs, commands, artifact refs, and host verdict refs. |
| Verified and fixed | Mark F-009 resolved only after code/tests prove the fix and fail-closed controls pass. |
| Verified diagnostic-only | Mark F-009 resolved only after diagnostic behavior is corrected and tests prove no semantic weakening. |
| Still suspected | Keep F-009 open/suspected with the missing evidence listed. |

The final delivery summary must state exactly what changed and what remains
locked.

## 8. Minimum Evidence Pack

The execution story must produce or reference:

- F-009 finding snapshot;
- target HEAD and material hash;
- selected artifact root and suite run id;
- command authority classification;
- formal proof producer/importer map;
- fresh Development proof state;
- nine `ENG-*` baseline coverage state;
- suite aggregation output;
- formal claim evaluator output;
- fail-closed negative control output;
- Claude CLI host verdict;
- Codex CLI host verdict;
- final F-009 status update or reason for keeping it open.

## 9. DONE Criteria

This execution plan is complete when a future execution story can finish with
one of these exact outcomes:

```text
F-009 DISPROVEN: current implementation already has a legitimate formal Layer 2 proof path, with evidence.
```

or:

```text
F-009 RESOLVED: verified gap fixed, fail-closed tests pass, Layer 2 claim boundary remains narrow.
```

or:

```text
F-009 REMAINS OPEN: evidence is insufficient or a required host/Authority prerequisite is unavailable.
```

A successful execution of this plan may unlock the Layer 2 claim only if the
formal evaluator proves valid Engineering suite proof. This document alone does
not unlock any capability claim.

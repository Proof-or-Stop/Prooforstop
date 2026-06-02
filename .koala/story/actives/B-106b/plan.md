# B-106b Plan - dispatch_run auto-overflow

## Outcome transcript

```bash
$ lattice dispatch_run --storyId=B-demo --host=fake --parallel=2 --objective="demo overflow" --json
{
  "schemaVersion": "lattice.dispatch_run.v1",
  "status": "accepted_local",
  "selectedHost": "fake",
  "workerDispatches": 2,
  "receipts": 2,
  "receiptVerified": false,
  "productionDone": false,
  "nextAction": "Review the accepted-local worker diffs and merge manually; story validate/review/DONE gates remain authoritative."
}
```

## CHK-001 - Document dispatch_run protocol and authority boundaries

Update README, guide, and host-overflow decision docs. Prove docs say dispatch_run is supervised automation, missing hosts visibly degrade, and external hosts cannot auto-merge, verify receipts, or set productionDone.

## CHK-002 - Implement host runtime registry and probe commands

Add runtime registry for fake, claude-code, gemini, codex. Expose host_runtime_list and host_runtime_probe. Test fake ready and missing real CLIs unavailable/degraded with authority diagnostic only.

## CHK-003 - Implement dispatch_plan without side effects

Add side-effect-free planner for host=auto/explicit, fallback hosts, risks, pack/worktree preview, nextAction. Test no dispatch directory/worktree/process/receipt is created.

## CHK-004 - Implement dispatch_prepare metadata lifecycle

Persist .koala/dispatches/<dispatchId> with pack/runtime/status/transcript placeholders and constraints. It prepares only; no host start or merge.

## CHK-005 - Implement deterministic fake dispatch_run

Run the fake host against controlled allowed diffs, generate local receipt, submit receipt, return accepted_local/diagnostic. Cover command failure and denied/forged receipt paths.

## CHK-006 - Add real host adapter scaffolding

Implement Claude Code, Gemini, Codex adapter metadata: command, cwd, prompt, timeout, transcript path. Missing CLI degrades to unavailable/needs_receipt/failed and never writes authority state.

## CHK-007 - Implement dispatch_collect

Collect base/head/changedFiles/transcript/exit/limitations from dispatch state and git only. Host prose is never trusted for changedFiles.

## CHK-008 - Implement overflow_auto alias and guarded policy

Add overflow_auto alias over host=auto dispatch behavior. Default policy is suggest; supervised fake can run explicitly. Trigger must be visible.

## CHK-009 - Implement dispatch lifecycle commands

Add dispatch_status/list/resume/cancel for planned, prepared, running, needs_receipt, accepted_local, diagnostic, failed, cancelled, expired. Cancel records state and preserves unreviewed work.

## CHK-010 - Implement dispatch_review

Summarize dispatch status, receipt, changedFiles, commands, warnings, risks, nextAction. Never claim receiptVerified/productionDone.

## CHK-011 - Implement dispatch_receipt_create

Generate draft lattice.handoff_receipt.v1-compatible receipt from collected dispatch data. Missing collect data yields diagnostic warnings, not false success.

## CHK-012 - Implement dispatch_merge_plan

Return manual merge guidance only for accepted_local dispatches. Diagnostic/fail dispatches get no normal merge plan. No git merge/cherry-pick is run.

## CHK-013 - Add dispatch_run smoke and contract test matrix

Add dispatch-run smoke covering runtime probe, plan, prepare, fake run, collect, receipt_create, overflow_auto, lifecycle, review, merge_plan, denied paths, stale/forged receipt, command registration.

## CHK-014 - Record dispatch authority decision and preMortem before DEV

Decision already records protocol-and-fake-runner-first, no hidden real-host default, fake deterministic tests, real adapter graceful degradation, and productionDone=false. In DEV, add verification evidence for this PLAN gate.

## CHK-015 - Validate parallel multi-agent dispatch with isolated receipts

Implement --parallel for fake dispatch_run. Create two isolated worker dispatch records with disjoint allowed files/receipts. Combined accepted_local only when all worker receipts pass. One worker failure yields diagnostic/partial; overlapping/denied scopes cannot auto-merge or productionDone.

# PLAN — spend-matched A2-prime + token/wall-clock/agentCallCount accounting (B-5bfe)

## Overview
Record token+wall-clock+agentCallCount per run, and implement A2-prime as a2prime bounded by A4's
per-task median token+wall-clock budget (plus-or-minus 20 percent, token binds first, hard-truncate),
per the locked pre-registration.

## CHK-001
run-recovery.mjs: record an accurate agentCallCount (incremented inside agentRun() per executor call
and reviewArtifact() per reviewer call) and tokensSpent (accumulated from the claude -p JSON usage);
keep wallClockMs. Use pre-reg section 7 field names.

## CHK-002
run-recovery.mjs: add a spend-budget mode (token + wall-clock budget args) that truncates the loop
when cumulative tokensSpent >= tokenBudget OR wallClockMs >= wallBudget (token binds first); record
budgetPass (within the tolerance band) and a truncated flag.

## CHK-003
run-ablation.mjs: compute A4 (a4b) per-task median tokensSpent + wallClockMs; add the A2-prime arm =
a2prime under that budget (plus-or-minus 20 percent, token binds first, hard-truncate at upper bound);
record to ablation-A2prime-compute-matched.jsonl with per-run budget pass/fail.

## CHK-004
Document the spend-match semantics (token+wall-clock, not call count; plus-or-minus 20 percent; token
binds first; hard-truncate) in the run-recovery.mjs / run-ablation.mjs comments, citing the pre-reg.

## CHK-005
Verify without the live LLM: no-LLM unit checks of the median computation, the budget-truncation
decision, and token/wall-clock accumulation on synthetic records; confirm field names match pre-reg
section 7 (tokensSpent, wallClockMs, agentCallCount).

## Out of scope
Other recovery-runner files / fixtures; product code; the paper wording fix (separate repo); the
powered ablation run itself.

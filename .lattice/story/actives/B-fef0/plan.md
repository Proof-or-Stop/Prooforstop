# PLAN — re-onboard recovery-runner harness code into proofbound (B-fef0)

## Overview
Track the recovery-runner experiment CODE under experiments/recovery-runner/ via the canonical-repo
review gate; exclude the .jsonl run-record data (lives in the paper repo). Add a README. Source = the
fixed/reviewed copy from the legacy Orchestrate checkout.

## CHK-001
Copy the runners (run-recovery.mjs, run-a2prime.mjs, run-ablation.mjs) into the worktree under
experiments/recovery-runner/ and git add them.

## CHK-002
Copy + git add the per-task fixtures tasks/{eval-expr,median,parse-range,text-stats}/ — each with
prompt.md, task.json, acceptance.mjs, ground-truth.mjs, reference-solution.mjs, and its injection
payload(s). The eval-expr reference + payload already include the non-string typeof guard fix.

## CHK-003
Copy + git add the generic file-op injections injections/{corrupt-output,delete-output}.mjs.

## CHK-004
Add experiments/recovery-runner/README.md explaining the harness and pointing to the paper repo
(Proofbound-AI/paper) for the run-record data and results. Confirm no .jsonl is tracked.

## CHK-005
For each of the 4 tasks, copy reference-solution.mjs to solution.mjs, run acceptance.mjs and
ground-truth.mjs, confirm both PASS; remove the temporary solution.mjs. No live LLM loop.

## Out of scope
The .jsonl run-records; any product code outside experiments/recovery-runner/.

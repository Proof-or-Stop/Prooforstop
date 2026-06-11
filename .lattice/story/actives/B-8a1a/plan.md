# B-8a1a Plan - Real-host unattended runner v1.0.1

## Goal

Enable `dispatch_auto --host=claude-code` to launch a real Claude Code CLI subprocess only when an explicit dispatch policy authorizes real host subprocess execution. The result stays local and review-bound: `authorityChanged=false`, `receiptVerified=false`, `productionDone=false`, and `dispatch_merge_plan.manualOnly=true`.

## CHK-001 - Contract and Docs

- Update `README.md`, `docs/requirements/decisions/host-overflow.md`, and relevant command/process policy text.
- State that v1.0.1 is Claude Code first; Gemini and Codex remain scaffolded/refused.
- State that standalone `host_runtime_probe` remains conservative and does not by itself authorize real subprocess execution.
- Preserve the no-overclaim boundary for receipts, merge, DONE, and authority.

## CHK-002 - Policy Gate

- Add an explicit dispatch policy opt-in such as `allowRealHostSubprocess`.
- Keep default and legacy policies safe: missing opt-in means no real Claude subprocess.
- Validate the opt-in together with existing constraints: allowed host, allowed/denied paths, command allowlist, max runtime, network/budget posture, requireReceipt, requireReview, no auto-merge, no productionDone.
- Expose the field in `dispatch_policy_create`, `dispatch_policy_get`, `dispatch_policy_check`, and CLI help.

## CHK-003 - Claude Real Runner

- Add runner metadata for `runnerKind=claude-code-real`.
- Launch `claude --print <prompt-file>` from the isolated dispatch worktree only through `dispatch_auto`.
- Capture stdout/stderr into the dispatch transcript.
- Use filtered environment variables and the policy timeout.
- Map exit and timeout outcomes to safe dispatch statuses without creating production authority.

## CHK-004 - Watch, Cancel, Review, Merge

- Ensure `dispatch_status`, `dispatch_watch`, and `dispatch_review` show the real runner summary.
- Ensure `dispatch_cancel` preserves evidence and can mark real-runner dispatches cancelled without deleting transcript/worktree artifacts.
- Ensure `dispatch_collect` and `dispatch_review` report changed files, transcript presence, command output, and risks.
- Keep `dispatch_merge_plan` manual-only and receipt-safe for all real-runner outcomes.

## CHK-005 - Verification

- Extend deterministic smoke coverage with a fake `claude` executable in PATH.
- Cover success, non-zero exit, timeout, missing opt-in, unsafe env, out-of-policy command, and real-host authority invariants.
- Run existing dispatch smoke tests to prove fake/scaffold behavior still works.
- Run a tiny live Claude Code canary only after deterministic tests pass; if live Claude is unavailable or blocked, record it as classified evidence without weakening deterministic coverage.

## Milestones

1. PLAN artifacts and scope check.
2. Policy schema and CLI text.
3. Real Claude runner implementation.
4. Watch/cancel/review/merge integration.
5. Deterministic smoke coverage.
6. Docs and command/process fact updates.
7. Build, smoke tests, live canary.
8. REVIEW, TEST, delivery, DONE.

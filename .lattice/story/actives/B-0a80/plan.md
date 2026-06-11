# B-0a80 Plan

## CHK-001 修正 B-688d artifact provenance 时间与路径

Scope: only repair merged B-688d artifact provenance fields that became internally false after the B-688d worktree was cleaned. The artifact set must remain a local lifecycle audit artifact, not an Authority receipt.

Correctness issue:
- Some parallel-development artifacts declare the baseline suite report as an input while their `generatedAt` value is earlier than that input artifact's `generatedAt`.
- The baseline suite report still points at `/Users/jek/Documents/Work/Orchestrate/.worktrees/B-688d/...`, but that worktree was intentionally cleaned at DONE, so the merged main artifact contains stale provenance paths.

Implementation plan:
- Use the current correction timestamp for affected parallel-development JSON `generatedAt` fields so no artifact claims to consume a future input.
- Replace stale `.worktrees/B-688d` absolute artifact paths in the B-688d baseline suite report with repo-relative `.omx/artifacts/...` paths that are valid from the merged main workspace.
- Preserve run IDs, suite status, host/lane/lock counts, and GO-NOT-YET semantics.

Verification:
- Run a mechanical artifact check that prints exactly: `artifact provenance check: PASS (generatedAt order ok, old worktree paths: 0)`.
- The check must fail if any dependent artifact has `generatedAt` earlier than its declared input or if any B-688d artifact still contains `.worktrees/B-688d`.

## CHK-002 修正 baseline failure 语义矛盾

Scope: only correct contradictory failure wording for the five expected-PASS baseline runs that were intentionally blocked by missing local independent review evidence.

Correctness issue:
- The suite/run reports say `baseline terminal criteria were not satisfied` while the same run objects say `terminalCriteriaSatisfied: true` and `terminalCriteriaFailures: []`.
- The real blocking reason is already present elsewhere: `local independent review evidence is missing`.

Implementation plan:
- Keep `outcome=FAIL`, `suiteStatus=FAIL`, and `blockedReason=local independent review evidence is missing`.
- Replace the contradictory terminal-criteria failure summary/reason in JSON and Markdown reports with missing independent local review evidence wording.
- Do not convert blocked expected-PASS runs into PASS and do not hide the blocked local evidence state.

Verification:
- Run a mechanical semantics check that prints exactly: `baseline failure semantics check: PASS (terminal criteria contradictions: 0)`.
- The check must fail if any report says terminal criteria were not satisfied while structured terminal criteria are satisfied with no failures.

## CHK-003 刷新 evidence hash 并复核 authority/host-neutral 不变

Scope: update only hash/provenance fields made stale by CHK-001/CHK-002 and prove the B-688d claim boundary is unchanged.

Correctness issue:
- Once B-688d artifact JSON/Markdown files are corrected, `shared-contract.json` evidenceRefs must match their current SHA256 values.
- The review must guard against accidental semantic drift: no upgrade from local lifecycle evidence to Authority-backed receipt, no GO-NOT-YET weakening, and no host-neutral shape change.

Implementation plan:
- Recompute SHA256 hashes for every evidenceRef in `.omx/artifacts/parallel-development/B-688d/shared-contract.json` whose target artifact changed.
- Run local mechanical checks for Authority boundary and host-neutral shape.
- Preserve `authorityMode=off`, `evidenceClass=local-lifecycle`, `decision=GO-NOT-YET`, canonical hosts `codex` and `claude-code`, eight lanes, and four locks.

Verification:
- Run a mechanical regression check that prints exactly: `authority/host-neutral regression check: PASS (GO-NOT-YET/off/local-lifecycle, hosts=2, lanes=8, locks=4)`.
- The check must fail if hashes are stale, if Authority receipt semantics are claimed, or if host/lane/lock counts drift.

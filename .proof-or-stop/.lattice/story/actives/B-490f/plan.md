# B-490f Plan

Goal: correct stale or ambiguous milestone/status tables in three scoped decision documents. This is a documentation correctness closure, not a runtime feature story.

Global constraints:
- Do not optimize for optimization.
- Do not optimize arbitrarily.
- Only fix real correctness issues.
- Follow consistency of logic.
- Do not implement new runtime hard gates, production completion, server-backed receipt proof, append-only ledger storage, or Tier-C automated cleanup.

## CHK-001

**Owner**: main-agent

Update `docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md` first. Replace stale plan-only status wording with a current status section/table that records implemented local CLI/read-only behavior: core evaluator, claim consumer, ProofStory binding checks, read-only CLI commands, process-fact registration, and smoke coverage.

Keep the boundary explicit: `parent_roadmap_status` and `parent_roadmap_evaluate` are read-only diagnostics. They do not mutate lifecycle state, do not turn every parent roadmap into a hard DONE gate, and do not claim all M4-M12 roadmap work is complete.

Verification:
- targeted `rg` finds the new current status table and checkmarks.
- `node packages/main/dist/tasks/parent-roadmap-totality-smoke.js` remains green if available.

## CHK-002

**Owner**: main-agent

Update `docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md` second. Refine the status table so completed local CLI hardening milestones are marked with checkmarks, while external adapter parity, append-only admissibility ledger, and server-backed production proof semantics are labeled retired, non-goal, or future as appropriate.

Keep the boundary explicit: local CLI proof admissibility can enforce configured local consumers, but does not mint production completion or resurrect retired server-backed receipt proof as a local requirement.

Verification:
- targeted `rg` finds completed local CLI rows marked with checkmarks.
- targeted `rg` still finds retired/non-goal/future boundary language.
- proof admissibility hardening smoke remains green if available.

## CHK-003

**Owner**: main-agent

Update `docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md` third. Add or refine a completion table that marks implemented control-plane rows with checkmarks and preserves honest labels for partial/unavailable rows: Proof M7 enforcement partial, admissibility waterline diagnostic/partial if applicable, Tier-C cleanup unavailable/non-goal, external production done unavailable.

Keep the boundary explicit: the control plane may render proof and queue facts, but it must not reimplement Proof M7 hard blocking, perform automated Tier-C cleanup, or claim productionDone.

Verification:
- targeted `rg` finds implemented rows with checkmarks.
- targeted `rg` still finds partial/unavailable/non-production boundary language.
- process fact contract verification remains green if available.

## CHK-004

**Owner**: main-agent

Run final consistency checks after all three document edits. Verify that every scoped document has a completion/status table with checkmarks for completed rows, and that every non-complete row remains explicitly partial, unavailable, retired, future, read-only, or non-goal.

Evidence commands:
- `rg -n "✅|partial|unavailable|retired|non-goal|read-only|future" docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md`
- `node packages/main/dist/tasks/parent-roadmap-totality-smoke.js`
- `node packages/main/dist/tasks/proof-admissibility-hardening-smoke.js`
- `node scripts/verify-process-fact-contract.mjs`

If any command is unavailable because dependencies are missing in the worktree, record that honestly and use the corresponding source-level checks as supporting evidence only.

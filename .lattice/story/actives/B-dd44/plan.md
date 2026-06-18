# B-dd44 Execution Plan — fail-closed hard-budget block (Touchpoint 4)

Add a pre-call hard-budget check to the gated Claude dispatch seam. Bounded by:
**budget UNSET or flag OFF => byte-identical dispatch**; block ONLY when an explicit
hard budget is configured AND the preflight estimate exceeds it; a budget-check error
PROCEEDS (never wrongly blocks); pure logic in-module (zero cross-module imports).

## Approach
- `core/usage-ledger/dispatch-usage.ts` (pure):
  - `resolveHardBudget(env)` -> {hardBudgetTokens, budgetPolicyId} | null (reads
    LATTICE_HARD_BUDGET_TOKENS, fallback KOALA_; null when unset/invalid = no enforcement).
  - `isOverHardBudget(estimatedInputTokens, hardBudgetTokens)` -> boolean.
  - `buildBlockedBudgetRecord(...)` (mirror buildUnavailableFinalRecord): decision.kind=
    'blocked', budgetPolicyId, reasonCode='hard_budget_exceeded', supersedes the estimate,
    passes the validator, never throws.
  - Extend `recordDispatchPreflight` to also return `estimatedInputTokens`.
- `core/lattice-dispatch.ts` runClaudeCodeRealLeafDispatch(): inside the existing
  isUsageLedgerEnabled() gate, AFTER the preflight: resolveHardBudget; if set AND
  isOverHardBudget(preflight estimate): append buildBlockedBudgetRecord, SKIP spawnSync,
  return a well-formed blocked dispatch result (mirror the failure return). Else proceed
  as today. All budget work in try/catch; on error proceed. Budget UNSET / flag OFF =>
  byte-identical.

## Checklist order
CHK-001 policy+predicate -> CHK-002 blocked-record builder -> CHK-003 gated guard ->
CHK-004 regression-safety (4 quadrants) -> CHK-005 smoke + no regression.

## Verification
`tasks/usage-ledger-budget-smoke.ts` (npm test:usage-ledger-budget): policy resolution
(unset->null), over-budget predicate, blocked-record validation + supersede + not-provider-
reported, and the 4-quadrant control-flow proof (OFF byte-identical; ON no-budget proceeds;
ON over-budget blocks+no-spawn+blocked-result; ON under-budget proceeds). usage-ledger
zero-cross-module-import assert. Build clean; full ledger suite (usage-ledger/-adapter/
-estimate/-diagnostics/-dispatch) no regression; node bin/lattice.js validate.

## Out of scope
Budget enforcement for codex/gemini; postflight overage remediation; authority-evidence
budget modes; default-on; signed authority receipts; any dispatch edit beyond the one guard.

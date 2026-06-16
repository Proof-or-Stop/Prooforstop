# B-1b28 Execution Plan — usage ledger default-on rollout

A one-line default flip in writer.ts: unset LATTICE_USAGE_LEDGER => ENABLED, while
0/false/off/no still DISABLE (escape hatch). All safety already lives in prior slices
(B-0f7c raw-text fallback + try/catch; B-dd44 budget separately gated). Load-bearing
safety property: =0 restores byte-identical legacy default-off behavior.

## Approach
- `core/usage-ledger/writer.ts` isUsageLedgerEnabled(): change the unset case from
  `return false` to `return true`; keep 0/false/off/no => false. Update the "Default OFF"
  comment to "Default ON; LATTICE_USAGE_LEDGER=0 to disable".
- `tasks/usage-ledger-smoke.ts`: flip the existing assertion isUsageLedgerEnabled({})===false
  -> ===true (and any sibling assertions about the default).
- `tasks/usage-ledger-default-on-smoke.ts` (new): the regression proof.

## Checklist order
CHK-001 flip default + comment -> CHK-002 escape-hatch (=0) byte-identical proof ->
CHK-003 default-on behavior + safety -> CHK-004 smoke wired + existing-smoke update + no regression.

## Verification
`tasks/usage-ledger-default-on-smoke.ts` (npm script): unset -> true; 0/false/off/no -> false;
1/true/on/yes -> true; =0 => writer no-op + buildClaudeSpawnArgs(file,false)=['--print',promptFile]
+ inert budget guard (byte-identical legacy); unset => writer writes + seam enabled path + raw
fallback on parse failure + ledger error doesn't propagate + NO budget block (no LATTICE_HARD_BUDGET_TOKENS).
Hermetic env save/restore. Build clean; FULL ledger suite (usage-ledger/-adapter/-estimate/
-diagnostics/-dispatch/-budget/-authority) green with the new default; usage-ledger zero
cross-module imports; node bin/lattice.js validate.

## Out of scope
Seam/budget/authority logic changes; new enforcement; codex/gemini; dispatch-runner/cli-engine edits.

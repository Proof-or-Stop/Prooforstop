# B-97df Execution Plan — usage ledger diagnostics/report layer (Slice 5)

READ-ONLY diagnostics over the ledger, STRICTLY in-module per the user's
"keep it modular, don't modify other logic code" constraint. All changes inside
`packages/main/src/core/usage-ledger/` + its tasks + `package.json`. No CLI command
registration, no dispatch/gate/handler/cli-engine changes. Preserve the module's
zero cross-module imports.

## Approach
- `core/usage-ledger/diagnostics.ts`:
  - grouped aggregation — reuse summary.ts selection (latest non-superseded per
    ledgerCallId+attemptId) + source bucketing, then roll up canonical token dims by
    storyId / phase / agentType(role) / model / provider. unknown stays unknown
    (never 0); estimates separate from provider-reported; superseded excluded.
  - pure cost projection — `cost(group, priceTable)` from an INJECTED price table
    (per-model input/output/cacheRead/cacheCreation $/MTok). No hardcoded prices;
    cost null when no table; unknown dims -> cost unknown. pricingRef when supplied.
  - `buildUsageReport(records, {priceTable?})` -> structured read-only report
    (overall totals by source, per-group breakdowns, counts, unknown count, optional
    cost). Feeds NO gate (no gate/verdict/decision/blocker field).
- `tasks/usage-ledger-report.ts` — runnable task: read a ledger JSONL path (+ optional
  price-table path), build + print the report (human + JSON mode). Wired as an npm
  script. NOT a registered lattice CLI command.

## Checklist order
CHK-001 grouped aggregation -> CHK-002 cost projection (injected price) -> CHK-003
report builder -> CHK-004 reporter task + npm script -> CHK-005 smoke wired.

## Verification
`tasks/usage-ledger-diagnostics-smoke.ts` (npm test:usage-ledger-diagnostics):
grouping correctness (story/model/role/provider; unknown!=0; estimate excluded from
provider totals; superseded excluded); cost with/without injected price table (null
when absent; unknown stays unknown); report feeds no gate (no gate-consumable field);
the reporter task runs over a sample ledger and prints correctly; zero-cross-module-import
static assert; no regression in the other usage-ledger smokes. Build clean;
`node bin/lattice.js validate --story=B-97df`. Diff never touches dispatch/cli-engine/handlers.

## Out of scope
Registering a lattice CLI command / command registry; live-dispatch wiring; budget
enforcement; signed-receipt path; default-on; anything outside core/usage-ledger +
tasks + package.json.

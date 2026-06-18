# B-0f7c Execution Plan — wire usage ledger into Claude dispatch (thin gated seam)

The first slice that edits code OUTSIDE usage-ledger (user-authorized). Bounded by
hard invariants: **flag OFF => dispatch byte-identical**; parse-failure => raw-text
fallback; ledger errors never break dispatch; one-way seam (usage-ledger keeps zero
cross-module imports).

## Approach
- `core/usage-ledger/dispatch-usage.ts` (pure, in-module, imports only ./ siblings + node):
  - `recordDispatchPreflight(root, ctx, promptText, opts)` -> mint correlation (ids.ts),
    build a prompt-size-estimate via the SYNC bytes/chars estimator + buildEstimateRecord,
    append (opt-in gated); returns {correlation, estimateRecordId} | null; never throws.
  - `recordDispatchFinal(root, ctx, correlation, estimateRecordId, anthropicUsage|null, model)`
    -> usage present: provider-reported record via the anthropic adapter + assemble,
    supersedesRecordIds=[estimateRecordId], append; null: 'unavailable' final superseding
    the estimate; opt-in gated; never throws.
  - `parseClaudeCliOutput(stdout)` -> {resultText, anthropicUsage|null}: extract .result +
    usage from the Claude Code CLI JSON envelope; non-JSON / wrong shape => {resultText: raw,
    anthropicUsage: null} (graceful, never throws).
- `core/lattice-dispatch.ts` runClaudeCodeRealLeafDispatch(): MINIMAL gated seam under
  `isUsageLedgerEnabled()` — before spawn: recordDispatchPreflight; spawn with JSON output
  when enabled; after spawn: parseClaudeCliOutput -> use resultText downstream + recordDispatchFinal.
  Disabled branch keeps today's `['--print', promptFile]` + raw stdout EXACTLY. All ledger
  work in try/catch.

## Checklist order
CHK-001 orchestrator -> CHK-002 parser -> CHK-003 gated seam -> CHK-004 regression-safety
(OFF byte-identical + parse-failure fallback) -> CHK-005 smoke (incl. simulated end-to-end).

## Verification
`tasks/usage-ledger-dispatch-smoke.ts` (npm test:usage-ledger-dispatch): orchestrator
(estimate -> provider-reported supersede so summary counts only the final; -> unavailable;
flag off no-op); parser (usage from sample JSON envelope; raw + malformed fallback);
**simulated end-to-end** (sample Claude JSON -> parse -> record -> diagnostics report shows
story X = N REAL tokens, estimate not double-counted); OFF byte-identical assertion;
parse-failure fallback assertion; usage-ledger zero-cross-module-import assert. Build clean;
full ledger suite no regression; lattice-dispatch.ts compiles.

## Out of scope
codex/gemini host invocation changes; budget enforcement; signed-receipt path; default-on;
any dispatch/cli-engine/handler edit beyond the single gated seam.

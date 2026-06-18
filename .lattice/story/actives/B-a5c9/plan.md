# B-a5c9 Execution Plan — usage ledger preflight estimate path (Slice 3)

Pure preflight estimate path in `packages/main/src/core/usage-ledger/estimate.ts`,
reusing assemble/record/ids in-module. The real provider count_tokens HTTP call is
a PLUGGABLE injected interface (deferred to the dispatch slice). Module keeps its
zero-cross-module-import property.

## Approach (estimate.ts)
- EstimatorKind = 'count_tokens'|'local_tokenizer'|'bytes_chars'; confidence map
  count_tokens->high, local_tokenizer->medium, bytes_chars->low.
- TokenEstimator = (model, input) -> {estimatedInputTokens, kind} (optionally async).
- Deterministic offline bytes/chars heuristic estimator (low confidence) — NOT tiktoken.
- selectEstimate({model, input, countTokens?, localTokenizer?}) -> picks best in order
  count_tokens > local_tokenizer > bytes_chars; returns {estimatedInputTokens, kind,
  confidence, model} bound to the exact model id.
- buildEstimateRecord(model, estimateResult, correlation, attribution) -> source=
  'prompt-size-estimate' record (canonical.input = estimate; output/cache = null),
  estimator{name,version,unit,confidence}; passes the B-253e validator. NOTE: the
  validator already allows null output for prompt-size-estimate (INIT-confirmed), so
  NO record.ts change is expected.
- supersedes: a later provider-reported final lists the estimate's recordId via
  buildSupersedes; summary.ts already excludes superseded estimates from final totals.

## Checklist order
CHK-001 interface+confidence -> CHK-002 bytes/chars fallback -> CHK-003 selector ->
CHK-004 buildEstimateRecord -> CHK-005 supersedes/never-final -> CHK-006 smoke wired.

## Verification
`packages/main/src/tasks/usage-ledger-estimate-smoke.ts` (npm test:usage-ledger-estimate):
confidence map; bytes/chars determinism+monotonicity; selector ordering with injected
stubs; model binding; estimate record validates + is prompt-size-estimate + estimator
fields + null output; supersedes interplay with summary (no double count, estimate never
final); writer round-trip (opt-in ON, temp dir); and a grep assert that the usage-ledger
module imports zero other Lattice modules. `npm --prefix packages/main run build` clean;
`node bin/lattice.js validate --story=B-a5c9`.

## Out of scope
Real provider count_tokens network binding; live-dispatch wiring; budget decision/
enforcement; signed-receipt path; default-on. Anything outside core/usage-ledger + smoke.

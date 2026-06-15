# B-4bf8 Execution Plan

Amend `docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md`
(B-1477's plan-only doc; no code implements it) to fix token-accuracy gaps before
implementation. Documentation-only — edit the one doc + B-4bf8 story metadata, no
source/adapter/registry/gate change. Amend in place; preserve the doc's existing
correlation/supersedes/authority/privacy design.

## Core fix
The usage record models tokens as `inputTokens/outputTokens/totalTokens`. Anthropic
returns four counts — `input_tokens` (uncached remainder), `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens` — and CMA
`span.model_request_end.model_usage` uses all four. The JSON example is the
de-facto spec, so the example and the prose must both change.

## Checklist order
1. **CHK-001** four-field cache-token model in the usage shape **and** the JSON
   example; state `input_tokens` is the uncached remainder; reference Managed
   Agents (CMA) `model_usage`. Also clarify the "Required record constraints"
   section (all four fields always vs only-when-non-zero) — folds in the
   product-reviewer advisory.
2. **CHK-002** remove stored `totalTokens`; state identity
   `total = input + output + cacheCreation + cacheRead`, derived in summary layer.
3. **CHK-003** estimate path prefers provider `count_tokens` (model-version-
   specific) > local tokenizer > bytes/chars; record confidence + bind to model ID.
4. **CHK-004** call-time story/phase attribution: capture active storyId at
   preflight; `storyId=null` for non-story calls (not dropped); subagent
   propagation; add `role`/`agentType`.
5. **CHK-005** completeness: single writer choke-point + dispatch-vs-ledger
   reconciliation.
6. **CHK-006** streaming/failure usage from the terminal stream event; partial
   output usage on error; `unavailable` only when truly none.
7. **CHK-007** multi-provider: raw provider units + normalized canonical
   `{input, output, cacheCreation, cacheRead}` view with explicit mapping rules.
8. **CHK-008** cost: `pricingRef`/snapshot mechanism; no absolute prices baked
   into append records.
9. **CHK-009** update Validation/Smoke Plan, Acceptance Criteria, Rollout, and
   cross-references to assert all of the above; expand "CMA" on first use; ensure
   internal consistency.

## Verification
- A committed verifier greps the amended doc: example block contains all four
  cache-token field names and NO `totalTokens`; the count_tokens, attribution,
  reconciliation, streaming, canonical, and pricingRef sections exist; Validation/
  Acceptance sections mention cache fields; only the one doc changed in the diff.
- `node bin/lattice.js validate --story=B-4bf8` (English-surface / doc gates pass).

## Out of scope
- Any source code, provider adapter, runtime registry, or gate change.
- Implementing the ledger itself (separate future story).

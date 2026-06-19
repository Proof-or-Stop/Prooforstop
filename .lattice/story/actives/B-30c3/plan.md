# Plan — Harden codex/gemini usage capture (v2 clean re-apply)

This is a single-pass re-apply of the already-reviewed cumulative fix captured in
`/tmp/fe1f-final/` (4 files). The code was implemented and reviewed (claude 3 lanes
+ a genuine Codex host-2) on the discarded B-fe1f; this story gives it a clean
single-round Lattice audit trail. Apply verbatim; change nothing else.

## CHK-001

Apply the hardened extractors + `recordDispatchFinalForProvider` unavailable-on-throw.

Files (verbatim from `/tmp/fe1f-final/`):
- `packages/main/src/providers/codex-cli.ts` — `extractCodexUsage` reads every
  candidate usage field via own-property guards (`ownProp`, no prototype-chain
  reads); `pickCodexUsageKeys` returns `Object.create(null)` carrying ONLY the
  adapter-read token keys (`prompt_tokens`, `completion_tokens`,
  `prompt_tokens_details`); `sanitizeNestedDetails` null-protos the nested
  `prompt_tokens_details`.
- `packages/main/src/providers/gemini-cli.ts` — `extractGeminiUsage` uses the same
  own-property guards; `pickGeminiUsageKeys` returns `Object.create(null)` carrying
  ONLY `promptTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount`.
- `packages/main/src/core/usage-ledger/dispatch-usage.ts` —
  `recordDispatchFinalForProvider` wraps `buildProviderRecord` + `appendUsageRecord`
  in an INNER try; on a validation throw it falls through to ONE unavailable-final
  that supersedes the preflight estimate; the OUTER try/catch keeps the never-throws
  guarantee. `recordDispatchFinal` (anthropic) stays byte-identical.

Out of scope (do NOT touch): `recordDispatchFinal` (anthropic), `parseClaudeCliOutput`,
`buildProviderRecord`, the adapters, `core/usage-ledger/assemble.ts`. `providers/`
imports nothing from `usage-ledger`. The systematic prototype-pollution class
(assemble.ts default-options, adapters' `in` reads, protected files) is DEFERRED to a
dedicated story per operator decision.

User sees: a codex/gemini usage carrying an extra or inherited-prototype non-token
key yields a null-prototype `reportedUsage` with ONLY numeric token fields (cache
fields preserved); a malformed-but-object usage records an unavailable-final that
supersedes the estimate.

## CHK-002

Apply the comprehensive smoke covering all projection + unavailable-final +
prototype-safety cases.

File (verbatim from `/tmp/fe1f-final/`):
- `packages/main/src/tasks/usage-ledger-codex-gemini-smoke.ts` — covers token-only
  projection (incl. transcript/extra-key drop, mixed-type keys, 50+ keys, minimal
  object, non-numeric value), cache-field preservation, null-prototype top + nested,
  own-property guards vs a polluted `Object.prototype.usage`/`usageMetadata`/
  `cached_tokens`/`prompt_tokens`, and `recordDispatchFinalForProvider`
  malformed-object → unavailable-final-supersedes + never-throws (openai + gemini).

The npm script `test:usage-ledger-codex-gemini` already exists in the ROOT
`package.json` (line 32, from B-12d7).

User sees: `node packages/main/dist/tasks/usage-ledger-codex-gemini-smoke.js` passes
all checks; full `npm test` exits 0.

## Verification approach

One DEV commit applies all four files; build; run the smoke; run full `npm test`
green; ONE review round (claude 3 lanes + codex host-2, told the systematic
prototype-pollution class is DEFERRED); review-assurance floor / escalation
(degraded-honest single-host if codex is unavailable, documented); `recover_evidence`;
TEST → DONE.

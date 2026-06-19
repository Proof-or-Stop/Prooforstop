# Usage-Ledger Prototype-Pollution Hardening (Systematic Class)

> Story: (future, not yet opened) — the dedicated story deferred from B-30c3.
> Scope: future execution plan only. This document does NOT implement source
> code, change the B-253e validator, alter the four-field strict accounting, or
> touch the record/adapter shapes. It specifies the threat model, the verified
> surface inventory, the fix-strategy tradeoffs, and the scope boundary for the
> future story.
> Origin: a genuine Codex host-2 cross-review during B-30c3 surfaced that the
> own-property/null-prototype hardening applied to the codex/gemini PROVIDER
> extractors should be applied systematically across the rest of the usage
> ledger. The operator deferred that broader class to this dedicated story.

## Problem Statement

The usage ledger reads token-count fields off objects that originate OUTSIDE the
ledger: `JSON.parse()` of provider/CLI stdout, and externally-supplied `options`
objects. Many of those reads use prototype-chain access — the `in` operator
(`'k' in obj`), dot/bracket reads (`obj.k` / `obj[k]`), and default-object
fallbacks (`x ?? {}`). A prototype-chain read returns an INHERITED value when the
key is absent as an own property. If `Object.prototype` ever carried a token key
(for example `Object.prototype.input_tokens = 999`), such a read could resolve
the polluted value, and because the ledger is billing-adjacent, a bogus numeric
count could ride into a persisted record (the B-253e validator rejects
non-numeric/negative counts, but it accepts a valid number regardless of origin).

B-30c3 hardened the **provider extractors** (`providers/codex-cli.ts`,
`providers/gemini-cli.ts`): they now read candidate usage via own-property guards
(`ownProp` = `hasOwnProperty`) and project into a null-prototype object
(`Object.create(null)`) carrying only whitelisted token keys. That left the same
pattern unguarded across the rest of the ledger core and the adapters. This story
closes that systematic remainder.

## Threat Model — be honest: this is defense-in-depth, NOT a live vector

This was adversarially verified (workflow, 2026-06-19, three independent
exploit-path checks across the anthropic / openai / gemini paths). The honest
verdict is:

- **No reachable live exploit exists today.** `JSON.parse()` does NOT mutate
  `Object.prototype`. A literal `"__proto__"` key in JSON becomes a harmless OWN
  property of the parsed object, not a prototype mutation. No in-repo code path
  writes to `Object.prototype`. Therefore, under all current code paths, none of
  the unguarded reads can resolve an attacker-controlled inherited value.
- For the openai/gemini paths, even if `Object.prototype` were pre-polluted by
  some future external code, B-30c3's null-prototype projection already
  neutralizes inheritance before any adapter read.

So this hardening is **belt-and-suspenders**, justified by:

1. **High consequence if the precondition ever changes.** The ledger is
   billing/usage truth. If a future transitive dependency, plugin, or host
   runtime ever pollutes `Object.prototype`, a silent bogus token count would be
   high-impact and hard to detect. Defense-in-depth is cheap insurance here.
2. **Consistency.** B-30c3 already applied own-prop/null-proto hardening to the
   provider extractors; leaving the adapters and the assemble/dispatch entry
   inconsistent is a latent foot-gun for the next maintainer who adds a read.
3. **A single audited chokepoint** is easier to reason about and lint than
   dozens of ad-hoc prototype-chain reads.

The future story MUST keep this framing in its background/decision: it is a
defense-in-depth + consistency change, not a correctness bug fix. It must not be
written as if it closes a live vulnerability.

## Surface Inventory (workflow-verified, 2026-06-19)

48 surfaces were examined across the usage-ledger module, its adapters, and the
provider extractors: **4 safe**, **4 already hardened in B-30c3** (the codex and
gemini extractors), and the remainder unguarded prototype-chain reads on
externally-derived objects. Deduped, the remaining surfaces are:

### Entry / assembly
- `core/usage-ledger/assemble.ts`
  - `:125` `if (key in response) return response[key];` — `extractRawUsage` `in`
    on a `providerResponse` cast from `unknown` (raw provider object or
    `JSON.parse` result). The single most load-bearing entry surface.
  - `:146` `const usage = options.usage ?? adaptUsageFor(provider, providerResponse);`
    — `options` defaults to `{}`; `options.usage` is a prototype-chain read.

### Anthropic extract path
- `core/usage-ledger/dispatch-usage.ts`
  - `:112` `u.input_tokens` / `u.output_tokens` reads (`u` cast from `unknown`).
  - `:121` `u.cache_creation_input_tokens`, `:124` `u.cache_read_input_tokens`.
  - `:137` `envelope.model`, `:139` `envelope.usage`, `:141` nested
    `(usage).model`, `:181` `extractAnthropicUsage(envelope.usage)`.

### Adapters (read usage fields off a possibly-plain object)
- `core/usage-ledger/adapters/anthropic.ts` `:54/:55/:64/:65` — `usage.input_tokens`,
  `usage.output_tokens`, `usage.cache_creation_input_tokens`,
  `usage.cache_read_input_tokens`.
- `core/usage-ledger/adapters/openai.ts` `:56/:57/:67` — `usage.prompt_tokens`,
  `usage.completion_tokens`, `usage.prompt_tokens_details`; `:84`
  `'cached_tokens' in details`; `:85` `details.cached_tokens`.
- `core/usage-ledger/adapters/gemini.ts` `:60/:61/:70` — `usage.promptTokenCount`,
  `usage.candidatesTokenCount`, `usage.cachedContentTokenCount`.
- `core/usage-ledger/adapters/shared.ts` `:84` — shared `'cached_tokens' in details`
  helper.

### Streaming usage merge (largest cluster)
- `core/usage-ledger/streaming.ts` `:122/:127/:135/:139/:144/:190/:197/:198/:236/:243`
  — `in` checks + dot reads while merging start/delta usage objects parsed from
  the stream (`input_tokens`, `output_tokens`, `prompt_tokens_details`,
  `promptTokenCount`, `cachedContentTokenCount`, etc.).

### Validator helper
- `core/usage-ledger/record.ts` `:493` `if (!(field in usage))` — `in` over a
  usage object during record validation.

### Lower priority (NOT external parsed data)
- `core/usage-ledger/diagnostics.ts` `:240` `group.bySource[source]`, `:370`
  `priceTable.rates[model]` — bracket lookups keyed by an internal enum / model
  id into internally-constructed tables, not external parsed objects. Harden only
  if trivial; not a token-value surface.

### Already hardened in B-30c3 (do NOT redo)
- `providers/codex-cli.ts` `:201/:204` and `providers/gemini-cli.ts` `:171/:174`
  (the extractors) — own-prop guards + null-proto whitelist projection.

## Fix Strategy — options and tradeoffs

1. **Per-read own-property guards** — wrap every read with
   `Object.prototype.hasOwnProperty.call(obj, key)` (and convert `'k' in obj` to
   the same). Minimal and local; mirrors B-30c3 exactly. Downside: ~30+ edit
   sites, easy to forget on the next new read, no structural guarantee.

2. **Single null-proto whitelist chokepoint (PREFERRED).** Add one shared helper
   (e.g. `toOwnPropsNullProto(obj, whitelist)` in `adapters/shared.ts` or a new
   `usage-ledger/sanitize.ts`) and apply it ONCE at the two entry points —
   `extractRawUsage` (assemble.ts) and the anthropic extract in dispatch-usage.ts
   — so every downstream adapter/streaming read operates on a null-prototype
   object carrying only whitelisted token keys. This generalizes the exact
   strategy B-30c3 already shipped for codex/gemini, collapses ~30 surfaces to a
   handful of chokepoints, and makes future reads safe by construction. Downside:
   must enumerate the per-provider whitelist (already known from the adapters).

3. **`Object.freeze(Object.prototype)` at process start** — blunt global
   mitigation. Rejected: risks breaking dependencies that legitimately write to
   prototypes, and is far outside the ledger's boundary.

**Recommendation:** option 2 (single chokepoint) as the structural fix, plus
converting the residual `in` operators (`assemble.ts:125`, `record.ts:493`,
`adapters/openai.ts:84`, `adapters/shared.ts:84`, the `streaming.ts` `in` checks)
to own-property checks as the cheap belt. Keep B-30c3's extractor hardening
unchanged.

## Scope Boundary (for the future story)

- **IN scope:** `assemble.ts` (`extractRawUsage` + `options.usage` default),
  `dispatch-usage.ts` anthropic extract path, the four adapters' usage-field
  reads + `in` operators, `streaming.ts` usage merge, `record.ts:493` validator
  `in`.
- **Lower priority / optional:** `diagnostics.ts` internal-table lookups (not
  external parsed data; only if trivial).
- **NON-GOALS:** changing the B-253e validator, the strict four-field accounting,
  the anthropic/openai/gemini record shapes, or the `primaryReportedTotal`
  visibility logic.
- **Already done — do NOT redo:** the codex/gemini provider extractors (B-30c3).

## Verification approach (for the future story)

- A smoke that, for each of anthropic / openai / gemini AND the streaming and
  estimate paths, pollutes `Object.prototype` with each token key inside a
  `try/finally` (restore after) and asserts NO inherited value reaches a
  persisted ledger record (the surfaced record carries only own-property,
  whitelisted token fields; absent fields stay absent / unavailable).
- A smoke asserting the chokepoint helper returns a null-prototype object and
  drops non-whitelisted own keys (parallel to the B-30c3 codex/gemini smoke).
- `npm run build` clean; full `npm test` green.
- Genuine 2-host review (claude lanes + a real Codex host-2), per the project
  standard that produced this finding.

## Relationship to B-30c3

B-30c3 hardened the first slice — the provider extractors — and explicitly
deferred the systematic remainder documented here. The original finding was
F-001/F-002 from a genuine Codex host-2 review (the nested-detail leak and the
prototype-chain predicate), which proved the pattern was worth a systematic
sweep. This story is that sweep, scoped and threat-modeled honestly above.

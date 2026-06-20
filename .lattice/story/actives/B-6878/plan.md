# Plan — B-6878: usage-ledger prototype-pollution hardening

Approach: a single null-prototype whitelist chokepoint at the two entry points + a residual `in`-operator belt + a prototype-pollution smoke. Defense-in-depth + consistency, NOT a live vuln. Mirror B-30c3 (providers/codex-cli.ts ownProp + Object.create(null) projection). NON-GOALS: B-253e validator RULES, four-field accounting, record shapes, primaryReportedTotal; do NOT redo codex/gemini extractors.

## CHK-001 — chokepoint helper + apply at the two entry points
- Add `core/usage-ledger/sanitize.ts` (leaf; node builtins only) exporting `toOwnPropsNullProto(obj: unknown, whitelist: readonly string[]): Record<string, unknown>` (or a typed return): build `Object.create(null)`, copy ONLY keys where `Object.prototype.hasOwnProperty.call(obj, k)` AND `k` ∈ whitelist. (Or place in adapters/shared.ts if cleaner.)
- Apply ONCE at `extractRawUsage` in `core/usage-ledger/assemble.ts` (~line 120; called ~101/103/105 with key "usage"/"usageMetadata") so the projected value is null-proto + whitelist-only before any adapter sees it; also harden the `options.usage ?? {}` default.
- Apply at the anthropic extract `extractAnthropicUsage` in `core/usage-ledger/dispatch-usage.ts` (~line 106) before the u.input_tokens/cache_* reads.
- Per-provider whitelist from the adapters: anthropic input_tokens/output_tokens/cache_creation_input_tokens/cache_read_input_tokens; openai prompt_tokens/completion_tokens/prompt_tokens_details(+nested cached_tokens); gemini promptTokenCount/candidatesTokenCount/cachedContentTokenCount.
- Verify (CHK-001 intents): helper returns null-proto + whitelist-only; pollution yields no inherited value downstream; legitimate own-property record byte-unchanged per provider (incl. nested cached_tokens).

## CHK-002 — residual `in`-operator belt
- Convert prototype-chain `in` on externally-derived usage objects to `Object.prototype.hasOwnProperty.call`: `adapters/openai.ts` (~84 `cached_tokens in details`), `adapters/shared.ts` (shared cached_tokens helper), `record.ts` (~493 `field in usage`; ~546 `field in canonical` — MECHANISM only, NOT the B-253e rules), `streaming.ts` (start/delta merge `in` checks — re-locate all by symbol). If the assemble.ts `in` is fully replaced by the chokepoint, note that.
- Optional/lower: diagnostics.ts internal-table bracket lookups — only if trivial.
- Verify (CHK-002 intents): grep shows no remaining prototype-chain `in` on external usage objects; validator behavior identical for legitimate data; polluted inherited key not treated as present.

## CHK-003 — prototype-pollution smoke
- Add `packages/main/src/tasks/usage-ledger-prototype-pollution-smoke.ts` (auto-discovered + npm alias). For EACH of anthropic/openai/gemini + streaming + estimate: pollute Object.prototype with each token key inside try/finally (delete in finally), drive the REAL assemble/dispatch/record path, assert NO inherited value reaches the persisted record (only own-property whitelisted fields; absent stay absent). Assert the chokepoint helper returns a null-proto object dropping non-whitelisted keys. Assert Object.prototype clean at the end. Each pollution assertion load-bearing (fails against pre-hardening code). Add package.json alias `test:usage-ledger-prototype-pollution`.
- Verify (CHK-003 intents): smoke exits 0; npm test green; assertions load-bearing.

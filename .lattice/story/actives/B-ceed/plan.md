# Execution plan: B-ceed (codex + gemini live-dispatch)

## Order
1. **CHK-001** — Add `packages/main/src/providers/gemini-cli.ts` (mirror codex-cli.ts contract: `geminiCliAvailable` + `runBoundedGeminiProvider`). Add `provider-gemini-smoke.ts` (mirror provider-codex-smoke.ts: 4 cases — success / disabled / timeout / missing binary). Build + verify smoke passes.
2. **CHK-002** — In `packages/main/src/core/lattice-dispatch.ts`:
   - Add `runCodexRealLeafDispatch` (mirror `runClaudeCodeRealLeafDispatch` shape; uses `runBoundedCodexProvider`)
   - Add `runGeminiRealLeafDispatch` (uses `runBoundedGeminiProvider`)
   - Update dispatch switch (~line 2408): when normalized=`codex` AND `codexCliAvailable()` → real codex path; same for gemini; when both unavailable for codex/gemini host → fall back to `runClaudeCodeRealLeafDispatch` with a logged degradation reason
   - Refine the `scaffolded only` warning at line 757 so it fires ONLY when no real path AND no fallback is taken
   - Rebuild + verify root `npm test` + `npm run test:all` still green
3. **CHK-003** — CHANGELOG Unreleased entry (Runtime subsection) + update `~/.claude/projects/.../memory/llm-usage-ledger-status.md` to mark live-dispatch as UNBLOCKED.

## Dependencies
- CHK-001 before CHK-002 (the leaf dispatch needs the provider).
- CHK-002 before CHK-003 (CHANGELOG describes the final shape).

## Verify
- Per-smoke: `node packages/main/dist/tasks/provider-gemini-smoke.js` exit 0 (4/4).
- Build clean: `npm --prefix packages/main run build` exit 0.
- Root chain: `npm test` exit 0.
- Battery: `npm run test:all` exit 0 (162→163 PASS incl new gemini smoke if directory-scan picks it up).
- Over-reach: codex-cli.ts byte-identical, usage-ledger/ byte-identical, handlers/ byte-identical.

## Out of scope (explicit)
- `packages/main/src/providers/codex-cli.ts` — B-1550 seam frozen
- `packages/main/src/core/usage-ledger/` — separate adapter follow-up story
- `runClaudeCodeRealLeafDispatch` — existing implementation untouched (only called as fallback target)
- Authority receipt-backed signing path — future per memory
- New usage adapter files (codex.ts / gemini.ts under usage-ledger/adapters/) — explicitly deferred

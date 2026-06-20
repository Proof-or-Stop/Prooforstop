# B-6878 — Real-machine user-value acceptance (transcript + diff)

Story: systematically harden the usage ledger against Object.prototype pollution — a single null-prototype whitelist chokepoint applied for token READS, the payloadDigest computed over the ORIGINAL raw payload, own-prop guards on every external container read, and the residual `in`→hasOwnProperty belt. Defense-in-depth + consistency, NOT a live vuln.

NATURE: this is an internal hardening change with NO user-facing CLI output change — the "user value" is the INVARIANT (no inherited/polluted token value can ever reach a persisted billing record, and legitimate records are byte-identical). Acceptance = the 30-check prototype-pollution smoke driving the REAL assemble/dispatch/record/streaming paths, plus the full suite staying green.

Run 2026-06-20 from the worktree (`./bin/lattice.js`, worktree dist = the merged code).

## Expected (from the spec invariant + userSees)
- For anthropic/openai/gemini + streaming + estimate: polluting Object.prototype with each token key must leave NO inherited value in the persisted ledger record.
- The chokepoint helper returns a null-prototype, whitelist-only object.
- Legitimate records (incl. payloads WITH extra non-read fields like total_tokens/totalTokenCount) are byte-identical — raw.payloadDigest computed over the ORIGINAL payload.
- No remaining `key in obj` prototype-chain presence read anywhere in core/usage-ledger.

## Actual (real CLI)
- `node packages/main/dist/tasks/usage-ledger-prototype-pollution-smoke.js` → "✓ usage-ledger-prototype-pollution smoke passed (30 checks)", exit 0. Final two lines:
  - "✓ validator-pollution (LOAD-BEARING): a record MISSING storyId/supersedesRecordIds as OWN props STILL FAILS despite inherited prototype values"
  - "✓ Object.prototype is clean again (no leftover token keys or container keys)"
  The 30 checks drive the REAL `recordDispatchFinal` / `recordDispatchFinalForProvider` / `extract{Anthropic,OpenAi,Gemini}StreamUsage` / `recordDispatchPreflight` / `validateUsageLedgerRecord` paths (persisted to an OS temp dir, read back via `verifyLedgerChain`) — not stubs.
- DIGEST-PRESERVED checks: a legit payload WITH extra fields (openai total_tokens + nested audio_tokens; gemini totalTokenCount; anthropic service_tier/server_tool_use) yields raw.payloadDigest === payloadDigest(original) — byte-identical to pre-this-story.
- CONTAINER-POLLUTION + result-pollution + validator-pollution checks: polluting Object.prototype.{usage,usageMetadata,message,result,storyId,supersedesRecordIds} with a record/envelope lacking the OWN field → the inherited value is NOT accepted (record unavailable / validation still fails / fallback text not the inherited value).
- Regression: usage-ledger-adapter smoke 50 checks exit 0; the 8 other usage-ledger smokes exit 0; full `npm test` → "✓ ALL PASS" exit 0; `lattice validate` all green.
- Exhaustive grep (codex host-2 + concept lane independently): ZERO `key in obj` prototype-chain presence read remains as code in core/usage-ledger (only comments/strings + diagnostics internal-table bracket lookups, which the spec marks optional).

## Diff
None. Actual matches expected. The load-bearing pollution checks all FAIL against the pre-hardening code (verified by revert-experiments at each round), confirming they genuinely detect the hardening.

## How genuine 2-host earned its keep here
Codex host-2 returned VERDICT=FAIL in rounds 1-3, each catching a REAL prototype-pollution / billing-digest bug that all three claude lanes had passed: (R1) the non-streaming payloadDigest regression + unguarded `envelope.usage`/stream container reads; (R2) the openai/gemini STREAMING digest regression + unguarded `envelope.result`; (R3) the record.ts validator `in`-operators. Round 4 (after the exhaustive sweep) returned VERDICT=PASS BUGS none and all three claude lanes were clean — converged.

## Self-check (user value)
- Does it do what the spec asked? Yes — the systematic sweep is complete (exhaustive grep clean) and the billing-digest invariant is preserved (proven byte-identical for legit payloads with extra fields).
- Real-machine run? Yes — the 30-check smoke drives the real persisted ledger paths; output above is genuine.
- Surprise/limitation? It is honestly defense-in-depth (no live vuln today); the estimate-path smoke check is explicitly labeled NOT load-bearing (that path never reads provider token keys). diagnostics.ts internal-table bracket lookups are out of scope per the spec (not external data).

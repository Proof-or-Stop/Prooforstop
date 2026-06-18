## Trigger Event

User directive (2026-06-17): finish the OSS-launch fix-wave by unblocking codex + gemini real-host live dispatch — the upstream blocker for the LLM usage ledger to capture real codex/gemini token data (per [[llm-usage-ledger-status]] memory: 'codex/gemini real-usage capture is BLOCKED — those hosts are scaffolded-only (dispatch_auto refuses a non-claude-code real subprocess). A separate upstream story to add live codex/gemini dispatch must land first'). Without live dispatch, the ledger module reports 0 tokens for codex/gemini forever, blocking real budget control, cost observability, and Authority receipt automation. Review-escalation 3x2 quorum is a secondary benefit — operator has accepted degraded 3x1 fallback for current stories, so unblocking 3x2 is a defensive long-term option, not a current pain point.

## Key Insights

- runBoundedCodexProvider already exists at packages/main/src/providers/codex-cli.ts:96 (B-1550 milestone built the provider seam). It is REAL: spawnSync of codex binary with bounded timeout + redacted digests + exit classification. Used today only by provider-codex-smoke.
- runClaudeCodeRealLeafDispatch at packages/main/src/core/lattice-dispatch.ts:1938 is the existing leaf dispatch for the one real host. It is the shape to mirror for codex + gemini.
- lattice-dispatch.ts:757-795 today emits 'runtime is scaffolded only' for both codex and gemini regardless of CLI availability, because dispatch_run switch only branches to a real path for normalized==='claude-code'.
- Gemini has NO providers/gemini-cli.ts equivalent yet — must be added. Pattern is the same as codex-cli.ts (binary discovery via PATH + spawnSync bounded + capture digests).
- User decision (2026-06-17): if codex AND gemini are both unavailable in PATH, automatically fall back to claude-code real dispatch (do not error). This is purely a runtime degradation policy, not a separate code path — the existing claude-code leaf already handles the call.

## Solution Tradeoffs

- (a) Full live-dispatch (chosen): add runCodexRealLeafDispatch + runGeminiRealLeafDispatch + providers/gemini-cli.ts + dispatch switch upgrade + claude-code fallback policy. UNBLOCKS the codex/gemini usage-adapter follow-up — note that after this story the ledger still reports 0 tokens for codex/gemini because no adapter parses the new real-subprocess output yet (the adapter follow-up is explicit out-of-scope). What this story actually delivers at DONE: (a1) `lattice dispatch_auto --host=codex` invokes a real codex subprocess when the CLI is in PATH; (a2) `--host=gemini` invokes a real gemini subprocess when the CLI is in PATH; (a3) both auto-fallback to claude-code real dispatch with a logged degradation reason when their CLI is missing. Workload: ~80-120 lines TS + new provider file + smokes. ~1-2 review rounds.
- (b) Stub dispatcher + usage adapter only: add codex.ts adapter but keep dispatcher scaffolded. Rejected — without a real subprocess there are no real tokens to capture, so the adapter has no real data to parse. False value.
- (c) Skip Story #3 entirely: defer until ledger data is actually needed. Considered honestly, declined by user — they want the option available going forward.

## Conversational Texture

User picked option (a) on 2026-06-17 with claude-code fallback when codex/gemini are unavailable. PRIMARY motivation: unblock the codex/gemini usage-adapter follow-up so the LLM usage ledger can eventually report real (non-zero) tokens for those hosts — see [[llm-usage-ledger-status]] memory which names this story as the upstream blocker. SECONDARY/DEFENSIVE benefit: review escalation 3x2 quorum becomes possible (operator continues to accept degraded 3x1 by choice, not by necessity). Out of scope: codex.ts and gemini.ts usage adapters (follow-up story per memory; this story only unblocks them by enabling real dispatch — does NOT itself produce non-zero ledger numbers). Out of scope: Authority receipt-backed signing path (future work per memory). Out of scope: modifying runBoundedCodexProvider signature (the existing seam is contract-frozen).

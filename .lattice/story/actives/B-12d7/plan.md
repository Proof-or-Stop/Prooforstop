# Plan: Capture real codex and gemini token usage in the LLM usage ledger (B-12d7)

Chosen approach (decision A): the bounded provider runners extract token-count-only
usage from their own stdout and surface it as a provider-neutral `reportedUsage`
object on `ProviderExecResult`; `dispatch-usage.ts` gains a canonical per-provider
final entry that routes through the existing `buildProviderRecord('openai'|'gemini', ...)`;
`runBoundedRealLeafDispatch` wires the seam (preflight estimate + superseding final),
fail-open. The claude-code path, `recordDispatchFinal`, `parseClaudeCliOutput`, the
anthropic adapter, and the ledger-OFF path all stay byte-identical. The
raw-output-never-surfaced security invariant holds: only numeric token counts are
surfaced, never raw transcript/stderr text.

## CHK-001
Surface token-count-only usage from the codex and gemini bounded provider runners.

Files:
- `packages/main/src/providers/codex-cli.ts`
- `packages/main/src/providers/gemini-cli.ts`
- `packages/main/src/providers/types.ts`

Steps:
1. Add `extractCodexUsage(stdout: string): Record<string, unknown> | undefined` to
   codex-cli.ts, EXACTLY analogous to the existing `extractCodexModel`: iterate
   `stdout.split('\n')`, skip blank lines, `JSON.parse` each line in a try/catch,
   and return the first OpenAI-shape `usage` object found (an object carrying any of
   `prompt_tokens` / `completion_tokens` / `prompt_tokens_details`). Look at the
   top-level `usage` key and at `message.usage` (codex CLI nests under `message`,
   mirroring `extractCodexModel`'s `obj.message.model` precedent). Return ONLY that
   `usage` sub-object (token-count keys), never the whole line/envelope. Never throw;
   return `undefined` when no usage object is present.
2. Add `extractGeminiUsage(stdout: string): Record<string, unknown> | undefined` to
   gemini-cli.ts, the same way but for the Gemini `usageMetadata` object (carrying
   `promptTokenCount` / `candidatesTokenCount` / `cachedContentTokenCount`), checking
   top-level `usageMetadata` and `response.usageMetadata`.
3. In types.ts add an optional provider-neutral field to `ProviderExecResult`:
   `/** Provider-reported token-count usage object (numbers only -- NEVER raw
   transcript). openai 'usage' shape for codex, gemini 'usageMetadata' shape for
   gemini. Absent when the CLI reports no usage. */ reportedUsage?: Record<string, unknown>;`
4. In `runBoundedCodexProvider` / `runBoundedGeminiProvider`, after computing
   `model`, compute `const reportedUsage = extractCodexUsage(stdout)` (resp. gemini)
   and spread `...(reportedUsage ? { reportedUsage } : {})` into the returned
   `ProviderExecResult`, alongside the existing `...(model ? { model } : {})`.
   The `stdoutDigest` / `stdoutBytes` / `stderr*` fields are unchanged; raw stdout is
   still never surfaced.

Invariants: providers/ adds NO import of core/usage-ledger; only numeric token
fields leave the runner; digest/byte-count fields untouched.

Excludes: no raw stdout/stderr surfacing; no digest/byte-count change; no
usage-ledger import into providers/.

## CHK-002
Add a canonical per-provider final-usage entry point in dispatch-usage.ts
(claude path byte-identical).

File: `packages/main/src/core/usage-ledger/dispatch-usage.ts`

Steps:
1. Add `recordDispatchFinalForProvider(root, ctx, correlation, estimateRecordId,
   provider: 'openai' | 'gemini', reportedUsage: unknown, model: string | null, opts)`.
2. Body mirrors `recordDispatchFinal` but is provider-parametric:
   - strict no-op when `!isUsageLedgerEnabled(opts.env)`;
   - `const corr = correlation ?? mintCallCorrelation(); const supersedes = buildSupersedes(estimateRecordId);`
   - when `reportedUsage` is a usable object, call
     `buildProviderRecord(provider, reportedUsage, {ledgerCallId, attemptId, sequence:2,
     supersedesRecordIds: supersedes}, attributionFor(ctx), finalContextForProvider(opts, provider, model))`
     then `appendUsageRecord`. `buildProviderRecord` already runs `adaptUsageFor` for
     openai/gemini, and its `extractRawUsage` passes a bare usage object straight to
     the adapter -- so a bare `usage` / `usageMetadata` object works directly.
   - otherwise append an unavailable final via `buildUnavailableFinalRecord` (same as
     recordDispatchFinal's null branch) so the estimate is still superseded.
   - whole body in try/catch; never throws (fail-open).
3. Add a small `finalContextForProvider(opts, provider, model)` (or extend
   `finalContext`) so the record's `context.provider.name` is `provider` (openai/gemini)
   rather than hardcoded anthropic. `finalContext` (anthropic) stays byte-identical;
   add a sibling rather than mutating it.
4. Do NOT touch `recordDispatchFinal`, `parseClaudeCliOutput`, or the anthropic import.

Invariants: claude/anthropic path byte-identical; no new imports outside
core/usage-ledger/ (buildProviderRecord already pulls the openai/gemini adapters
internally via assemble.ts).

Excludes: no change to recordDispatchFinal/parseClaudeCliOutput; no anthropic path
change; no imports outside core/usage-ledger/.

## CHK-003
Wire the usage-ledger seam into runBoundedRealLeafDispatch + smoke.

Files:
- `packages/main/src/core/lattice-dispatch.ts` (`runBoundedRealLeafDispatch`)
- `packages/main/src/tasks/usage-ledger-codex-gemini-smoke.ts` (new)
- `package.json` (+ `packages/main/package.json` if needed): npm script

Steps:
1. In `runBoundedRealLeafDispatch`, replicate the claude seam shape (minus the budget
   guard, which is deferred): compute `const ledgerOn = isUsageLedgerEnabled();` and a
   `ledgerCtx` / `ledgerOpts` (host = `{ kind: record.selectedHost }`, command label,
   `env: process.env`, `recordedAt`, `projectRootHash: dispatchProjectRootHash(root)`),
   matching the claude path's construction.
2. Before the bounded `runner(...)` call, when `ledgerOn`, read the prompt file and
   call `recordDispatchPreflight(root, ledgerCtx, promptText, ledgerOpts)` in a
   try/catch (transcript a non-fatal line on error), capturing `ledgerHandle`.
3. After the bounded run, when `ledgerOn`, in a try/catch call
   `recordDispatchFinalForProvider(root, ledgerCtx, ledgerHandle?.correlation ?? null,
   ledgerHandle?.estimateRecordId ?? null, hostKind === 'codex' ? 'openai' : 'gemini',
   result.reportedUsage, result.model ?? null, ledgerOpts)`. On error, append a
   non-fatal transcript line and proceed -- dispatch must never break.
4. When `ledgerOn` is false the function is byte-identical to today (no preflight, no
   final, no extra I/O).
5. New smoke `usage-ledger-codex-gemini-smoke.ts` (modeled on
   `usage-ledger-dispatch-smoke.ts`, OS temp dir, prints per-check + summary, exits
   non-zero on failure), asserting:
   - `extractCodexUsage` / `extractGeminiUsage` parse a sample CLI stdout into the
     correct token-count object, and return undefined for non-JSON / no-usage / empty;
   - they surface ONLY numeric token fields (no transcript text key) -- the security
     invariant assertion;
   - `recordDispatchFinalForProvider` with a codex `usage` and a gemini
     `usageMetadata` writes a sequence-2 provider-reported final that supersedes the
     estimate, and the ledger summary's provider-reported total equals the sample
     token counts;
   - a null/garbage reportedUsage writes an unavailable final (still supersedes);
   - flag OFF => nothing written;
   - the claude path is unaffected: `recordDispatchFinal` with an anthropic usage still
     behaves as before (regression assertion);
   - STATIC import boundary: providers/codex-cli.ts and gemini-cli.ts import nothing
     from core/usage-ledger (grep-style source assertion).
6. Add an npm script `test:usage-ledger-codex-gemini` ->
   `node packages/main/dist/tasks/usage-ledger-codex-gemini-smoke.js`. run-all-smokes
   auto-discovers `dist/tasks/*-smoke.js`, so `test:all` picks it up automatically.

Invariants: fail-open everywhere; OFF byte-identical; claude path untouched.

Excludes: no budget-guard (fail-closed pre-spawn block) for codex/gemini (deferred);
no change to the claude-code real-leaf path; no Authority receipt-backed signing.

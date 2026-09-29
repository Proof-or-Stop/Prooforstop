import assert from 'node:assert/strict';



import { readFileSync } from 'node:fs';




import { runHostRun, hostRunSlotsDir } from '../../core/host-run.js';






import { recordDispatchFinalCodex, recordDispatchFinalForProvider } from '../../core/usage-ledger/dispatch-usage.js';


import { resolveLedgerPath } from '../../core/usage-ledger/writer.js';

import { checkAsync, freshRoot, seedCorruptLedger, RunnerSink, baseArgs, makeRunner, CLAUDE_STDOUT, CODEX_STDOUT, ON, CODEX_USAGE, readLedger, seedSlot } from "./support.js";

export async function case36(): Promise<void> {


  // =========================================================================
  // F-021: the usage summary must reflect the ACTUAL ledger append, not merely
  // that the provider envelope parsed. A corrupt ledger makes appendUsageRecord
  // THROW (swallowed by the never-throw seam) while the claude/codex stdout DOES
  // carry a valid usage envelope. Against the OLD code the summary reported
  // `recorded: 'provider-reported'` (keyed on parsed usage) even though ZERO
  // rows landed — silently hiding an under-count in the honesty choke point.
  // The fix reports the skipped state (`recorded: 'none'`, reason
  // `ledger_append_failed(...)`) and never a false provider-reported claim; the
  // run still completes and the host exit code propagates.
  // =========================================================================
  await checkAsync('F-021 claude: valid stream-json usage BUT a failing (corrupt) ledger -> summary reports skipped (none, ledger_append_failed), NEVER provider-reported; run completes + exit code propagates', async () => {
    const sub = freshRoot();
    seedCorruptLedger(sub); // the next append throws at chain time (swallowed by the seam)
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'claude' }),
      { runner: makeRunner({ stdout: CLAUDE_STDOUT, exitCode: 2 }, sink) },
    );
    assert.equal(sink.calls, 1, 'the host still ran despite the failing ledger');
    assert.equal(result.spawned, true, 'the run completed');
    assert.equal(result.exitCode, 2, 'the host exit code propagates unchanged');
    // The valid usage WAS parsed (proving the false-claim trap is live), yet no
    // row landed, so the summary must NOT claim provider-reported.
    assert.notEqual(result.usageSummary.recorded, 'provider-reported', 'no false provider-reported claim when the append failed');
    assert.notEqual(result.usageSummary.recorded, 'unavailable', 'not conflated with "provider reported nothing"');
    assert.equal(result.usageSummary.recorded, 'none', 'honest skipped state');
    assert.equal(result.usageSummary.provider, 'anthropic', 'provider still surfaced for attribution');
    assert.equal(result.usageSummary.input, null, 'no token counts for a row that never landed');
    assert.equal(result.usageSummary.cacheRead, null);
    assert.equal(result.usageSummary.output, null);
    assert.ok((result.usageSummary.reason ?? '').startsWith('ledger_append_failed('), `reason names the append failure (got ${result.usageSummary.reason})`);
    // The stderr surface: recorded='none' renders as "usage: ledger_append_failed(...)"
    // (the handler's non-"recorded" fallback line), never "usage recorded: ...".
    assert.equal(result.usageSummary.recordId, null, 'no recordId for a row that never landed');
  });
}

export async function case37(): Promise<void> {


  await checkAsync('F-021 codex: valid turn.completed usage BUT a failing (corrupt) ledger -> summary reports skipped (none, ledger_append_failed), NEVER provider-reported', async () => {
    const sub = freshRoot();
    seedCorruptLedger(sub);
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'codex' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT, exitCode: 5 }, sink) },
    );
    assert.equal(sink.calls, 1, 'the host still ran despite the failing ledger');
    assert.equal(result.spawned, true);
    assert.equal(result.exitCode, 5, 'the host exit code propagates unchanged');
    // scanCodexTurnCompletedUsage(CODEX_STDOUT) is a valid provider usage — the
    // false-claim trap is live — but the append fails, so no provider-reported.
    assert.notEqual(result.usageSummary.recorded, 'provider-reported', 'no false provider-reported claim when the append failed');
    assert.notEqual(result.usageSummary.recorded, 'unavailable', 'not conflated with "provider reported nothing"');
    assert.equal(result.usageSummary.recorded, 'none', 'honest skipped state');
    assert.equal(result.usageSummary.provider, 'openai', 'provider still surfaced for attribution');
    assert.equal(result.usageSummary.input, null, 'no token counts for a row that never landed');
    assert.ok((result.usageSummary.reason ?? '').startsWith('ledger_append_failed('), `reason names the append failure (got ${result.usageSummary.reason})`);
    assert.equal(result.usageSummary.recordId, null);
  });
}

export async function case38(): Promise<void> {


  // =========================================================================
  // F-029: separate a codex provider-record BUILD failure from an APPEND
  // failure. The OLD recordDispatchFinalCodex caught buildProviderRecord AND
  // appendUsageRecord in ONE try; a provider-reported record that BUILT fine but
  // whose ledger APPEND threw (transient corrupt chain / lock-wait skip) fell
  // through to recordDispatchUnavailableFinal — and if that SECOND append
  // succeeded, a source=unavailable row landed although provider usage WAS
  // parsed, corrupting source semantics + undercounting real codex usage.
  //
  // The fix builds+validates first, then appends in its OWN try: an append throw
  // returns recorded=false with the ledger_append_failed reason and source stays
  // 'provider-reported' (keyed on the PARSED usage, never degraded to
  // 'unavailable'), and NO unavailable final is attempted.
  //
  // Determinism note: a first-append-fail / second-append-SUCCEED construction is
  // not honestly buildable from ledger state — the provider record A and the
  // fallback unavailable record B chain off the SAME predecessor and share the
  // same cross-process lock, so appendUsageRecord fails (or succeeds) IDENTICALLY
  // for both (a corrupt last line throws in readLastRecordHash for either record).
  // The observable that flips OLD->NEW under the corrupt-ledger harness is the
  // RETURNED CodexFinalResult: OLD degraded it to source='unavailable', mapped=null
  // after the swallowed provider append; NEW keeps source='provider-reported',
  // mapped=<parsed canonical>, recorded=false. The row-landing manifestation of the
  // bug (the false unavailable row) is the RED under a revert-in-dist harness; here
  // the invariant is asserted directly on the return value + the untouched ledger.
  // The healthy-ledger sub-case proves the happy path (a provider row DOES land)
  // and that source is keyed on the parse, not the append outcome.
  // =========================================================================
  await checkAsync('F-029 codex: a provider-record whose ledger APPEND fails stays source=provider-reported (recorded=false, ledger_append_failed), never degraded to a false unavailable row', async () => {
    const ctx = { storyId: 'B-70e9', phase: 'DEV', agentType: 'reviewer' };
    const opts = { recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot', env: ON };

    // Healthy ledger (genesis): the provider record BUILDS and APPENDS — the happy
    // path is preserved by the restructure, and a provider-reported row lands.
    const okRoot = freshRoot();
    const ok = recordDispatchFinalCodex(okRoot, ctx, null, null, CODEX_USAGE, null, opts);
    assert.equal(ok.recorded, true, 'happy path: provider final appended');
    assert.equal(ok.source, 'provider-reported', 'happy path: source is provider-reported');
    assert.ok(ok.mapped, 'happy path: canonical mapping present');
    assert.equal(ok.unavailableReason, null, 'happy path: no reason');
    const okRows = readLedger(okRoot);
    assert.equal(okRows.length, 1, 'happy path: exactly one final row landed');
    assert.equal(okRows[0].usage.source, 'provider-reported', 'happy path: the landed row is provider-reported');

    // Corrupt ledger: buildProviderRecord still succeeds (valid usage), but the
    // append THROWS at chain time. The provider count is real — so it must NOT be
    // re-recorded as an unavailable final.
    const badRoot = freshRoot();
    seedCorruptLedger(badRoot); // the next append throws in readLastRecordHash
    const bad = recordDispatchFinalCodex(badRoot, ctx, null, null, CODEX_USAGE, null, opts);
    assert.equal(bad.recorded, false, 'append failed: nothing recorded');
    assert.equal(bad.source, 'provider-reported', 'F-029: source stays provider-reported — NEVER degraded to unavailable on an append failure (the OLD code returned unavailable here)');
    assert.ok(bad.mapped, 'F-029: the parsed canonical is preserved — the usage WAS parsed, only the append failed (OLD returned mapped=null)');
    assert.ok((bad.unavailableReason ?? '').startsWith('ledger_append_failed('), `F-029: honest append-failure reason (got ${bad.unavailableReason})`);
    assert.equal(bad.recordId, null, 'no recordId for a row that never landed');
    // The ledger is byte-untouched: NO second (unavailable) append was attempted,
    // so only the corrupt seed line remains — no false unavailable row landed.
    const rawLines = readFileSync(resolveLedgerPath(badRoot), 'utf8').split('\n').filter((l) => l.trim().length > 0);
    assert.equal(rawLines.length, 1, 'no final row appended (the fallback unavailable append was NOT attempted)');
    assert.equal(rawLines[0], 'this is not valid json', 'only the corrupt seed line remains — no unavailable row was written');
  });
}

export async function case39(): Promise<void> {


  // =========================================================================
  // F-030: the SAME build-vs-append conflation, in the VOID codex/gemini
  // sibling recordDispatchFinalForProvider (used by proof-or-stop-dispatch
  // runBoundedRealLeafDispatch). The OLD code wrapped buildProviderRecord AND
  // appendUsageRecord in ONE try; a provider-reported record that BUILT fine
  // but whose ledger APPEND threw fell through to the unavailable-final branch,
  // and if that SECOND append succeeded a FALSE source=unavailable row landed
  // although provider usage WAS parsed. The fix mirrors F-029: build in its own
  // try (a build failure still degrades to the unavailable fallback,
  // unchanged), append in its own try (a throw is swallowed and the function
  // RETURNS — void never-throw seam, honest under-count, NO unavailable
  // attempt).
  //
  // Honesty note on what this committed check can and cannot flip: the function
  // is VOID (no CodexFinalResult to key on like F-029), and per the F-029
  // determinism note the fallback unavailable append fails IDENTICALLY under
  // any ledger-state fault (corrupt last line / ledger-as-directory: record A
  // and fallback B chain off the SAME predecessor through the same writer), so
  // under this corrupt-ledger harness OLD and NEW both land zero rows. The
  // row-landing manifestation (the false unavailable row) was proven RED with a
  // throwaway dist harness that reverts the restructure AND injects a
  // first-append-throws fault (transient-fault shape: first append fails,
  // second succeeds — OLD lands 1 source=unavailable row, NEW lands 0); see the
  // F-030 fix commit message. What THIS check pins deterministically: (healthy)
  // the happy path survives the restructure — exactly one provider-reported row
  // lands, keyed on the parse; (corrupt) the seam still never throws and NO row
  // of ANY source lands (ledger byte-untouched — regression guard for the
  // no-second-append contract half that IS observable here).
  // =========================================================================
  await checkAsync('F-030 provider (void sibling): build-vs-append separated — healthy ledger lands exactly one provider-reported row; corrupt ledger lands NO row of any source and never throws', async () => {
    const ctx = { storyId: 'B-70e9', phase: 'DEV', agentType: 'reviewer' };
    const opts = { recordedAt: '2026-07-10T00:00:00.000Z', projectRootHash: 'sha256:testroot', env: ON };
    // A valid bare openai usage object (the openai adapter's extractRawUsage
    // accepts it directly) — buildProviderRecord succeeds.
    const OPENAI_USAGE = { prompt_tokens: 500, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 50 } };

    // Healthy ledger (genesis): the provider record BUILDS and APPENDS — the
    // happy path is preserved by the restructure and source is keyed on the
    // parse (provider-reported, never unavailable).
    const okRoot = freshRoot();
    recordDispatchFinalForProvider(okRoot, ctx, null, null, 'openai', OPENAI_USAGE, 'gpt-5-codex', opts);
    const okRows = readLedger(okRoot);
    assert.equal(okRows.length, 1, 'happy path: exactly one final row landed');
    assert.equal(okRows[0].usage.source, 'provider-reported', 'happy path: the landed row is provider-reported (parsed usage is never degraded)');
    assert.equal(okRows[0].provider?.name, 'openai', 'happy path: provider attribution preserved');

    // Corrupt ledger: buildProviderRecord still succeeds (valid usage), but the
    // append THROWS at chain time. The void seam must swallow (never throw) and
    // must NOT land ANY row — in particular no source=unavailable row for usage
    // that WAS parsed.
    const badRoot = freshRoot();
    seedCorruptLedger(badRoot); // the next append throws in readLastRecordHash
    let threw = false;
    try {
      recordDispatchFinalForProvider(badRoot, ctx, null, null, 'openai', OPENAI_USAGE, 'gpt-5-codex', opts);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'void seam contract: an append failure never propagates to the dispatch caller');
    const rawLines = readFileSync(resolveLedgerPath(badRoot), 'utf8').split('\n').filter((l) => l.trim().length > 0);
    assert.equal(rawLines.length, 1, 'no final row appended (no unavailable fallback row for parsed usage)');
    assert.equal(rawLines[0], 'this is not valid json', 'only the corrupt seed line remains — the ledger is byte-untouched');
  });
}

export async function case40(): Promise<void> {


  // =========================================================================
  // F-027: the F-021 honesty gate extended to the BLOCKED summaries. A cap
  // refusal writes its blocked row through the same swallowing seam — under a
  // corrupt ledger the row never lands, yet the OLD code unconditionally
  // reported `recorded: 'blocked'` and (concurrency) exposed a minted recordId
  // for a row that never persisted. The fix keys the blocked claim on the
  // ACTUAL append outcome: refusal stays fail-closed (no spawn, nonzero exit),
  // summary reports the honest skipped state (`recorded: 'none'`, no recordId)
  // with the refusal kept visible in a composed reason
  // (`<refusal>; ledger_append_failed(...)`).
  // =========================================================================
  await checkAsync('F-027 concurrency: saturated cap + failing (corrupt) ledger -> refusal fail-closed BUT summary reports none + composed reason, NEVER a blocked row / minted recordId', async () => {
    const sub = freshRoot();
    seedCorruptLedger(sub); // every append (preflight AND blocked row) throws, swallowed by the seam
    const dir = hostRunSlotsDir(sub);
    for (let i = 0; i < 4; i++) seedSlot(dir, i, process.pid); // slot-0..slot-3 held live
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });
    // The refusal itself is unchanged: fail-closed, no spawn, nonzero exit.
    assert.equal(sink.calls, 0, 'runner NOT invoked at the cap even with a failing ledger');
    assert.equal(result.spawned, false);
    assert.equal(result.blocked, true);
    assert.equal(result.refusalReason, 'concurrency_cap_exceeded');
    assert.notEqual(result.exitCode, 0);
    // The honesty gate: no blocked-row claim for a row that never landed.
    assert.notEqual(result.usageSummary.recorded, 'blocked', 'no blocked-row claim when the append failed');
    assert.equal(result.usageSummary.recorded, 'none', 'honest skipped state');
    assert.equal(result.usageSummary.recordId, null, 'no minted recordId for a row that never persisted');
    const reason = result.usageSummary.reason ?? '';
    assert.ok(reason.startsWith('concurrency_cap_exceeded ('), `refusal stays visible in the composed reason (got ${reason})`);
    assert.ok(reason.includes('; ledger_append_failed('), `composed reason names the append failure (got ${reason})`);
  });
}

export async function case41(): Promise<void> {


  await checkAsync('F-027 budget: over-budget + failing (corrupt) ledger -> refusal fail-closed BUT summary reports none + composed reason, NEVER a blocked row', async () => {
    const sub = freshRoot();
    seedCorruptLedger(sub);
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;
    const result = await runHostRun(baseArgs({ root: sub, host: 'claude', env }), { runner: makeRunner({ stdout: CLAUDE_STDOUT }, sink) });
    // The refusal itself is unchanged: fail-closed, no spawn, nonzero exit.
    assert.equal(sink.calls, 0, 'runner NOT invoked over budget even with a failing ledger');
    assert.equal(result.spawned, false);
    assert.equal(result.blocked, true);
    assert.equal(result.refusalReason, 'hard_budget_exceeded');
    assert.notEqual(result.exitCode, 0);
    // The honesty gate: no blocked-row claim for a row that never landed.
    assert.notEqual(result.usageSummary.recorded, 'blocked', 'no blocked-row claim when the append failed');
    assert.equal(result.usageSummary.recorded, 'none', 'honest skipped state');
    assert.equal(result.usageSummary.recordId, null);
    const reason = result.usageSummary.reason ?? '';
    assert.ok(reason.startsWith('hard_budget_exceeded ('), `refusal stays visible in the composed reason (got ${reason})`);
    assert.ok(reason.includes('; ledger_append_failed('), `composed reason names the append failure (got ${reason})`);
  });
}

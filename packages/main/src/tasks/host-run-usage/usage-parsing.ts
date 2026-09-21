import assert from 'node:assert/strict';



import { existsSync, readdirSync } from 'node:fs';

import { isAbsolute } from 'node:path';


import { codexTurnFailedReason, defaultHostRunRunner, failureLineRetainerFor, runHostRun, scanCodexTurnCompletedUsage, scanCodexTurnFailed, usageLineRetainerFor, hostRunSlotsDir, CODEX_TURN_FAILED_DIGEST_MAX_CHARS, HOST_RUN_RETAINED_LINE_CAP, type HostRunRunner } from '../../core/host-run.js';





import { adaptCodexTurnUsage } from '../../core/usage-ledger/adapters/openai.js';

import { payloadDigest } from '../../core/usage-ledger/adapters/shared.js';

import { resolveLedgerPath } from '../../core/usage-ledger/writer.js';

import { checkAsync, freshRoot, RunnerSink, baseArgs, makeRunner, CODEX_STDOUT, readLedger, CODEX_USAGE, CLAUDE_STDOUT, CLAUDE_MODEL, AGY_STDOUT, CODEX_FAILED_STDOUT, CODEX_TURN_FAILED_B3928_LINE, B3928_UPGRADE_MESSAGE, check } from "./support.js";

export async function case03(): Promise<void> {


  // =========================================================================
  // CHK-001 happy: codex turn.completed -> estimate + provider-reported final
  // =========================================================================
  await checkAsync('CHK-001 codex happy: estimate(seq1) + provider-reported final(seq2) with uncached-remainder mapping', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT }, sink) });

    assert.equal(sink.calls, 1, 'runner invoked once');
    assert.equal(result.exitCode, 0);
    assert.equal(result.spawned, true);
    // argv built from canonical spec: <prompt> substituted, no placeholder left.
    assert.ok(sink.lastPlan);
    assert.equal(sink.lastPlan!.command, 'codex');
    assert.equal(sink.lastPlan!.argv.includes('<prompt>'), false);
    assert.equal(sink.lastPlan!.argv.includes('Review the change and report findings honestly.'), false);
    assert.equal(sink.lastPlan!.argv.at(-1), '-');
    assert.equal(sink.lastPlan!.stdinText, 'Review the change and report findings honestly.');

    const records = readLedger(sub);
    assert.equal(records.length, 2, 'estimate + final');
    const estimate = records.find((r) => r.usage.source === 'prompt-size-estimate');
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(estimate && final);
    assert.equal(estimate!.sequence, 1);
    assert.equal(final!.sequence, 2);
    assert.deepEqual(final!.supersedesRecordIds, [estimate!.recordId]);
    assert.equal(final!.ledgerCallId, estimate!.ledgerCallId);
    assert.equal(final!.attemptId, estimate!.attemptId);

    // Uncached-remainder mapping.
    assert.equal(final!.usage.canonical?.input, 10202, 'canonical.input = input_tokens - cached_input_tokens');
    assert.equal(final!.usage.canonical?.cacheRead, 11008, 'cacheRead = cached_input_tokens');
    assert.equal(final!.usage.canonical?.cacheCreation, null, 'codex reports no cache-write => null');
    assert.equal(final!.usage.canonical?.output, 85);
    assert.equal(final!.usage.inputTokens, 10202);
    assert.equal(final!.provider?.name, 'openai');

    // Raw digest covers the ORIGINAL codex usage (reasoning_output_tokens preserved).
    assert.equal(final!.usage.raw?.payloadDigest, payloadDigest(CODEX_USAGE), 'digest must be over the ORIGINAL payload');

    // Summary echoes the mapped values + recordId.
    assert.equal(result.usageSummary.recorded, 'provider-reported');
    assert.equal(result.usageSummary.provider, 'openai');
    assert.equal(result.usageSummary.input, 10202);
    assert.equal(result.usageSummary.cacheRead, 11008);
    assert.equal(result.usageSummary.output, 85);
    assert.ok((result.usageSummary.recordId ?? '').startsWith('llmuse_'));
  });
}

export async function case04(): Promise<void> {


  // =========================================================================
  // CHK-001 happy: claude stream-json result -> provider-reported final
  // =========================================================================
  await checkAsync('CHK-001 claude happy: stream-json result -> provider-reported final with served model', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const result = await runHostRun(baseArgs({ root: sub, host: 'claude' }), { runner: makeRunner({ stdout: CLAUDE_STDOUT }, sink) });

    assert.equal(sink.calls, 1);
    // claude launcher materializes an absolute prompt-file path (no placeholder).
    assert.ok(sink.lastPlan);
    assert.equal(sink.lastPlan!.command, 'claude');
    assert.equal(sink.lastPlan!.argv.includes('<prompt-file>'), false);
    assert.equal(sink.lastPlan!.argv.includes('--permission-mode'), false, 'ordinary Claude runs retain their configured permission policy');
    assert.equal(sink.lastPlan!.argv.includes('--json-schema'), false, 'ordinary Claude runs do not inherit managed-review structured output policy');
    const promptArg = sink.lastPlan!.argv.find((a) => a.endsWith('prompt.txt'));
    assert.ok(promptArg && isAbsolute(promptArg), 'claude prompt file is absolute');
    // temp prompt file cleaned up after the run.
    assert.equal(existsSync(promptArg!), false, 'claude prompt file cleaned up');

    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(final);
    assert.equal(final!.usage.inputTokens, 4200);
    assert.equal(final!.usage.outputTokens, 320);
    assert.equal(final!.usage.cacheReadInputTokens, 1500);
    assert.equal(final!.provider?.name, 'anthropic');
    assert.equal(final!.provider?.model, CLAUDE_MODEL, 'served model bound');
    assert.equal(result.usageSummary.provider, 'anthropic');
    assert.equal(result.usageSummary.input, 4200);
  });
}

export async function case05(): Promise<void> {


  // =========================================================================
  // CHK-001 safety: agy is refused until it has a protected prompt transport.
  // =========================================================================
  await checkAsync('CHK-001 agy safety: argv-only prompt transport refuses before spawn', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    await assert.rejects(
      runHostRun(baseArgs({ root: sub, host: 'agy' }), { runner: makeRunner({ stdout: AGY_STDOUT }, sink) }),
      /agy is unavailable.*prompt only in argv.*refusing pre-spawn.*stdin or protected prompt-file/i,
    );
    assert.equal(sink.calls, 0, 'argv-only agy prompt must be rejected before runner invocation');
    assert.equal(sink.lastPlan, null, 'no launch plan containing the prompt may reach the runner');
    const records = readLedger(sub);
    assert.equal(records.length, 1, 'local preflight estimate remains auditable without claiming a provider run');
    assert.equal(records[0]?.usage.source, 'prompt-size-estimate');
    assert.equal(records.some(record => record.usage.source === 'provider-reported' || record.usage.source === 'unavailable'), false,
      'pre-spawn prompt-transport refusal must not fabricate a provider terminal row');
  });
}

export async function case06(): Promise<void> {


  // =========================================================================
  // CHK-001 edge: codex turn.failed (no usage) -> unavailable-with-reason
  // (B-3ddc: the reason is now the honest turn_failed(<digest>), not the
  // generic fallback, because a failure event IS present in the stream.)
  // =========================================================================
  await checkAsync('CHK-001 codex edge (B-3ddc): turn.failed / no usage -> unavailable (turn_failed(boom)), never a fabricated zero', async () => {
    const sub = freshRoot();
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_FAILED_STDOUT, exitCode: 1 }) });
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final);
    assert.equal(final!.provider?.name, 'openai');
    assert.equal(final!.usage.unavailableReason, 'turn_failed(boom)');
    assert.equal(final!.usage.inputTokens, null, 'no fabricated zero');
    assert.equal(result.exitCode, 1, 'host exit propagates on the result');
  });
}

export async function case07(): Promise<void> {


  // =========================================================================
  // B-3ddc: pinned B-3928 fixture + turn_failed(<digest>) honest reasons
  // =========================================================================
  await checkAsync('B-3ddc pinned B-3928: version-skew turn.failed -> unavailable final names the INNERMOST upgrade message (turn_failed(<digest>)), exit 1 propagates', async () => {
    // Precondition: the pinned fixture parses and the nested message round-trips.
    const parsed = JSON.parse(CODEX_TURN_FAILED_B3928_LINE) as Record<string, unknown>;
    assert.equal(parsed?.type, 'turn.failed', 'fixture parses as a turn.failed event');
    const outerMessage = (parsed.error as Record<string, unknown>).message;
    assert.equal(typeof outerMessage, 'string', 'error.message is ITSELF a JSON-encoded string (the observed shape)');
    const nested = JSON.parse(outerMessage as string) as Record<string, unknown>;
    assert.equal((nested.error as Record<string, unknown>).message, B3928_UPGRADE_MESSAGE, 'the nested innermost message round-trips');

    const sub = freshRoot();
    const stdout = JSON.stringify({ type: 'turn.started' }) + '\n' + CODEX_TURN_FAILED_B3928_LINE + '\n';
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout, exitCode: 1 }) });
    const expected = `turn_failed(${B3928_UPGRADE_MESSAGE})`;
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final, 'unavailable final recorded');
    assert.equal(final!.provider?.name, 'openai');
    assert.equal(final!.usage.unavailableReason, expected, 'the row itself names the innermost upgrade message');
    assert.equal(final!.usage.inputTokens, null, 'no fabricated numbers from a failure event');
    assert.equal(result.usageSummary.reason, expected, 'the summary carries the same reason');
    assert.equal(result.exitCode, 1, 'the codex exit code still propagates');
  });
}

export async function case08(): Promise<void> {


  await checkAsync('B-3ddc fallback: noise-only stdout (no turn.completed, no failure event) still records no_turn_completed_usage_event', async () => {
    const sub = freshRoot();
    const stdout = [JSON.stringify({ type: 'turn.started' }), JSON.stringify({ type: 'item.completed', item: { id: 'x' } }), 'plain noise'].join('\n') + '\n';
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout, exitCode: 1 }) });
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final);
    assert.equal(final!.usage.unavailableReason, 'no_turn_completed_usage_event', 'the documented fallback is preserved');
    assert.equal(result.usageSummary.reason, 'no_turn_completed_usage_event');
  });
}

export async function case09(): Promise<void> {


  await checkAsync('B-3ddc precedence: a genuine turn.completed usage FOLLOWED by a turn.failed stays provider-reported (usage never discarded; failure lane not consulted)', async () => {
    const sub = freshRoot();
    const stdout = CODEX_STDOUT + JSON.stringify({ type: 'turn.failed', error: { message: 'late failure after usage' } }) + '\n';
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout }) });
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(final, 'provider-reported final recorded despite the trailing turn.failed');
    assert.equal(final!.usage.canonical?.input, 10202, 'same mapped numbers as the happy path');
    assert.equal(final!.usage.canonical?.cacheRead, 11008);
    assert.equal(final!.usage.canonical?.output, 85);
    assert.equal(records.some((r) => r.usage.source === 'unavailable'), false, 'no unavailable row minted from the failure lane');
    assert.equal(result.usageSummary.recorded, 'provider-reported');
    assert.equal(result.usageSummary.input, 10202);
  });
}

export async function case10(): Promise<void> {


  await checkAsync('B-3ddc streaming lane: the default runner retains the pinned turn.failed line in the SECOND bounded lane (usage lane stays empty)', async () => {
    // Mirror the F-006/F-013 pattern: a REAL child writes the pinned line.
    const script =
      `console.log(${JSON.stringify(JSON.stringify({ type: 'turn.started' }))});` +
      `console.log(${JSON.stringify(CODEX_TURN_FAILED_B3928_LINE)});`;
    const result = await defaultHostRunRunner({
      command: process.execPath,
      argv: ['-e', script],
      env: process.env,
      cwd: process.cwd(),
      host: 'codex',
      retainUsageLine: usageLineRetainerFor('codex'),
      retainFailureLine: failureLineRetainerFor('codex'),
      onChunk: () => { /* discard live (bounded memory) */ },
    });
    assert.equal(result.exitCode, 0);
    assert.ok((result.failureText ?? '').includes('turn.failed'), 'the failure line is retained end-to-end');
    const failure = scanCodexTurnFailed(result.failureText ?? '');
    assert.ok(failure, 'the retained line scans as a failure event');
    assert.ok((failure!.message ?? '').includes('requires a newer version of Codex'), 'the scanned message carries the upgrade text');
    assert.equal(codexTurnFailedReason(failure!), `turn_failed(${B3928_UPGRADE_MESSAGE})`, 'the digest extracts the innermost upgrade message');
    assert.equal(result.stdout, '', 'the usage lane retained NOTHING (no turn.completed present)');
  });
}

export async function case11(): Promise<void> {


  await checkAsync('B-3ddc terminal error: a single {"type":"error"} line records turn_failed(stream disconnected)', async () => {
    const sub = freshRoot();
    const stdout = JSON.stringify({ type: 'error', message: 'stream disconnected' }) + '\n';
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout, exitCode: 1 }) });
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final);
    assert.equal(final!.usage.unavailableReason, 'turn_failed(stream disconnected)');
    assert.equal(result.usageSummary.reason, 'turn_failed(stream disconnected)');
  });
}

export async function case12(): Promise<void> {


  check('B-3ddc digest hygiene: control chars/newlines collapse, whitespace runs collapse, parens neutralized (F2 no-parens invariant), over-cap truncates with a trailing ellipsis at the exported cap; no message -> no_error_message', () => {
    // The noisy message now also embeds parentheses so the extended assertions
    // exercise the B-3ddc F2 delimiter-injection guard in the SAME check.
    const noisy = 'line one\n\tline\ttwo\r\n' + String.fromCharCode(0) + 'x  (y) ' + 'a'.repeat(300);
    const failure = scanCodexTurnFailed(JSON.stringify({ type: 'turn.failed', error: { message: noisy } }) + '\n');
    assert.ok(failure);
    const reason = codexTurnFailedReason(failure!);
    assert.ok(reason.startsWith('turn_failed(') && reason.endsWith(')'));
    const digest = reason.slice('turn_failed('.length, -1);
    for (let i = 0; i < digest.length; i++) {
      const code = digest.charCodeAt(i);
      assert.ok(code >= 0x20 && code !== 0x7f, `no control chars in the digest (found ${code} at ${i})`);
    }
    assert.equal(digest.includes('  '), false, 'whitespace runs collapsed to a single space');
    // B-3ddc F2: the digest interior can NEVER contain a '(' or ')', so the
    // enclosing turn_failed(...) delimiters can never be closed or reopened.
    assert.equal(digest.includes('('), false, 'no "(" survives inside the digest (delimiter-injection guard)');
    assert.equal(digest.includes(')'), false, 'no ")" survives inside the digest (delimiter-injection guard)');
    assert.ok(digest.endsWith('…'), 'hard truncation appends the ellipsis');
    assert.equal(digest.length, CODEX_TURN_FAILED_DIGEST_MAX_CHARS, 'total digest length capped at the exported constant');
    assert.equal(codexTurnFailedReason({ eventType: 'turn.failed', message: null }), 'turn_failed(no_error_message)', 'a failure event with no extractable message still names turn_failed');
  });
}

export async function case13(): Promise<void> {


  // =========================================================================
  // B-3ddc (codex round-1 F2): a NEW unit that pins the exact paren-injection
  // repro from the review — an error.message that tries to inject its own
  // turn_failed(...) structure is neutralized to brackets, leaving exactly one
  // opening + one closing delimiter around a paren-free digest.
  // =========================================================================
  check('B-3ddc F2 paren injection: message "boom) turn_failed(fake" -> turn_failed(boom] turn_failed[fake) (interior parens neutralized)', () => {
    const reason = codexTurnFailedReason({ eventType: 'turn.failed', message: 'boom) turn_failed(fake' });
    assert.equal(reason, 'turn_failed(boom] turn_failed[fake)', 'interior "(" -> "[" and ")" -> "]" so no delimiter is injected');
    const digest = reason.slice('turn_failed('.length, -1);
    assert.equal(digest.includes('('), false, 'no "(" in the digest interior');
    assert.equal(digest.includes(')'), false, 'no ")" in the digest interior');
  });
}

export async function case14(): Promise<void> {


  // =========================================================================
  // B-3ddc (codex round-1 F1): honor the FAILURE lane's own truncation flag.
  // A real child through the default runner proves the flag is genuinely set by
  // an over-cap drop; the end-to-end degrade is isolated with an injected runner
  // (a real single stream would ALSO truncate the USAGE lane, whose flag has
  // absolute priority, masking the failure-lane behavior — so the fake runner
  // sets retentionTruncated=false to exercise the failure branch directly).
  // =========================================================================
  await checkAsync('B-3ddc F1 candidate-then-drop: the default runner sets failureRetentionTruncated when an over-cap line is dropped AFTER a retained turn.failed; the stale failure line then degrades to no_turn_completed_usage_event', async () => {
    // Real child: a small valid turn.failed line (retained in the 2nd lane) then
    // a >1 MiB junk line dropped over-cap AFTER it (mirror the F-013 pattern).
    const padLen = HOST_RUN_RETAINED_LINE_CAP + 4096;
    const script =
      `process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }))}+"\\n");` +
      `var pad="a".repeat(${padLen});` +
      'process.stdout.write(pad+"\\n");';
    const direct = await defaultHostRunRunner({
      command: process.execPath,
      argv: ['-e', script],
      env: process.env,
      cwd: process.cwd(),
      host: 'codex',
      retainUsageLine: usageLineRetainerFor('codex'),
      retainFailureLine: failureLineRetainerFor('codex'),
      onChunk: () => { /* discard live (bounded memory) */ },
    });
    assert.equal(direct.failureRetentionTruncated, true, 'the over-cap drop AFTER the retained turn.failed flags the failure lane truncated');
    assert.ok((direct.failureText ?? '').includes('turn.failed'), 'precondition: the (now stale) turn.failed line WAS retained — exactly the trap');

    // End-to-end: an untrusted failure lane (flag true) must NOT scan failureText
    // even though it carries a perfectly valid turn.failed(boom) — the reason
    // honestly degrades to the generic fallback. retentionTruncated stays false
    // so we reach the codex usage===null failure branch (not the usage-lane one).
    const sub = freshRoot();
    const failLine = JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }) + '\n';
    const runner: HostRunRunner = () => ({
      stdout: '',
      stderr: '',
      exitCode: 1,
      timedOut: false,
      retentionTruncated: false,
      failureText: failLine,
      failureRetentionTruncated: true,
    });
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner });
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final, 'unavailable final recorded');
    assert.equal(final!.usage.unavailableReason, 'no_turn_completed_usage_event', 'a truncated failure lane degrades to the generic fallback, NEVER a stale turn_failed(...)');
    assert.equal(result.usageSummary.reason, 'no_turn_completed_usage_event', 'the summary carries the honest degraded reason');
    assert.equal(final!.usage.inputTokens, null, 'no fabricated numbers');
  });
}

export async function case15(): Promise<void> {


  await checkAsync('B-3ddc F1 drop-then-candidate (F-026 mirror): an over-cap line dropped BEFORE the retained turn.failed clears failureRetentionTruncated; the later candidate supersedes and turn_failed(boom) is kept', async () => {
    // Real child: a >1 MiB junk line FIRST (dropped over-cap) then the small
    // turn.failed line — the later candidate clears the failure lane's flag.
    const padLen = HOST_RUN_RETAINED_LINE_CAP + 4096;
    const script =
      `var pad="a".repeat(${padLen});` +
      'process.stdout.write(pad+"\\n");' +
      `process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }))}+"\\n");`;
    const direct = await defaultHostRunRunner({
      command: process.execPath,
      argv: ['-e', script],
      env: process.env,
      cwd: process.cwd(),
      host: 'codex',
      retainUsageLine: usageLineRetainerFor('codex'),
      retainFailureLine: failureLineRetainerFor('codex'),
      onChunk: () => { /* discard live (bounded memory) */ },
    });
    assert.equal(direct.failureRetentionTruncated, false, 'the retained turn.failed AFTER the drop clears the failure lane flag (last-wins, F-026)');
    assert.ok((direct.failureText ?? '').includes('turn.failed'), 'the later turn.failed line is the retained candidate');

    // End-to-end: flag false + a present failureText -> the honest turn_failed(boom)
    // is kept (the later candidate is trusted). retentionTruncated false so the
    // codex usage===null branch consults the trusted failure line.
    const sub = freshRoot();
    const failLine = JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }) + '\n';
    const runner: HostRunRunner = () => ({
      stdout: '',
      stderr: '',
      exitCode: 1,
      timedOut: false,
      retentionTruncated: false,
      failureText: failLine,
      failureRetentionTruncated: false,
    });
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner });
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final, 'unavailable final recorded');
    assert.equal(final!.usage.unavailableReason, 'turn_failed(boom)', 'a trusted (non-truncated) failure lane keeps the honest turn_failed(boom)');
    assert.equal(result.usageSummary.reason, 'turn_failed(boom)', 'the summary carries the honest specific reason');
  });
}

export async function case16(): Promise<void> {


  // =========================================================================
  // CHK-001 edge: PROOF_OR_STOP_USAGE_LEDGER=0 disables rows, never provider admission.
  // =========================================================================
  await checkAsync('CHK-001 edge: ledger OFF -> zero rows but provider admission remains active; run spawns + exit propagates', async () => {
    const sub = freshRoot();
    const sink: RunnerSink = { calls: 0, lastPlan: null };
    const OFF = { PROOF_OR_STOP_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex', env: OFF }), { runner: makeRunner({ stdout: CODEX_STDOUT, exitCode: 2 }, sink) });
    assert.equal(sink.calls, 1, 'runner still invoked when ledger OFF');
    assert.equal(result.exitCode, 2, 'exit propagates when OFF');
    assert.equal(result.usageSummary.recorded, 'disabled');
    assert.equal(existsSync(resolveLedgerPath(sub)), false, 'no ledger file');
    assert.equal(existsSync(hostRunSlotsDir(sub)), true, 'provider admission registry exists independently of the ledger');
    assert.deepEqual(readdirSync(hostRunSlotsDir(sub)), [], 'slot released after the run');
  });
}

export async function case17(): Promise<void> {


  // =========================================================================
  // CHK-001 edge: host non-zero exit propagates while rows still record
  // =========================================================================
  await checkAsync('CHK-001 edge: host non-zero exit propagates while codex rows still record', async () => {
    const sub = freshRoot();
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: CODEX_STDOUT, exitCode: 2 }) });
    assert.equal(result.exitCode, 2);
    const records = readLedger(sub);
    assert.equal(records.length, 2, 'estimate + final still recorded on host failure');
    assert.ok(records.some((r) => r.usage.source === 'provider-reported'));
  });
}

export async function case18(): Promise<void> {


  // =========================================================================
  // CHK-001 adversarial: bounded parse buffer + last-usage-wins
  // =========================================================================
  check('CHK-001 adversarial: flooding stdout is line-streamed; last turn.completed usage wins', () => {
    const lines: string[] = [];
    for (let i = 0; i < 50000; i++) lines.push(JSON.stringify({ type: 'noise', i }));
    lines.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
    lines.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 7 } }));
    const usage = scanCodexTurnCompletedUsage(lines.join('\n')) as Record<string, unknown>;
    assert.ok(usage);
    assert.equal(usage.input_tokens, 900, 'last turn.completed usage wins');
    assert.equal(usage.output_tokens, 7);
    assert.equal(scanCodexTurnCompletedUsage('no json here\nplain text'), null);
  });
}

export async function case19(): Promise<void> {


  // =========================================================================
  // CHK-001 adversarial: prototype-pollution / wrong-typed payload honesty
  // =========================================================================
  await checkAsync('CHK-001 adversarial: inherited/polluted usage never fabricates counts (own-property projection)', async () => {
    // Only inherited primaries -> unavailable (no own counts to read).
    const inheritedOnly = Object.create({ input_tokens: 5, cached_input_tokens: 2, output_tokens: 3 });
    const u1 = adaptCodexTurnUsage(inheritedOnly);
    assert.equal(u1.source, 'unavailable', 'inherited-only primaries -> unavailable');

    // Own value wins over an inherited/polluted value of the same key.
    const mixed = Object.assign(Object.create({ input_tokens: 999999, output_tokens: 999999 }), { input_tokens: 100, output_tokens: 10 });
    const u2 = adaptCodexTurnUsage(mixed);
    assert.equal(u2.source, 'provider-reported');
    assert.equal(u2.canonical?.input, 100, 'own input read, not the inherited 999999');

    // cached greater than input is unusable -> unavailable, never a negative remainder.
    const u3 = adaptCodexTurnUsage({ input_tokens: 10, cached_input_tokens: 50, output_tokens: 3 });
    assert.equal(u3.source, 'unavailable', 'cached > input -> unavailable, no fabricated remainder');

    // string tokens -> the assembled record is rejected -> the seam records unavailable (never throws).
    const sub = freshRoot();
    const badStdout = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 'lots', output_tokens: 5 } }) + '\n';
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner: makeRunner({ stdout: badStdout }) });
    assert.equal(result.exitCode, 0);
    const records = readLedger(sub);
    assert.ok(records.some((r) => r.usage.source === 'unavailable'), 'wrong-typed usage -> unavailable final');
    assert.equal(records.some((r) => r.usage.source === 'provider-reported'), false, 'no fabricated provider-reported row');
  });
}

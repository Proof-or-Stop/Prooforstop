import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';






import { defaultHostRunRunner, runHostRun, scanCodexTurnCompletedUsage, usageLineRetainerFor, HOST_RUN_RETAINED_LINE_CAP, HOST_RUN_RETENTION_TRUNCATED_REASON, UsageLineScanner, type HostRunChunk, type HostRunPassthrough, type HostRunRunner } from '../../core/host-run.js';











import { checkAsync, freshRoot, baseArgs, makeRunner, CODEX_STDOUT, readLedger, CLAUDE_MODEL, check } from "./support.js";

export async function case27(): Promise<void> {


  // =========================================================================
  // F-006: the DEFAULT production runner streams host output live (async spawn),
  // retains only bounded usage state, and never OOMs / fabricates on huge lines.
  // =========================================================================
  await checkAsync('F-006: default runner streams stdout live — first line reaches the sink BEFORE process exit', async () => {
    const chunks: Array<{ stream: string; text: string; at: number }> = [];
    // Print a line immediately, sleep, then print the usage event line. If the
    // runner buffered (old spawnSync), the first line would only arrive at exit.
    const script =
      'process.stdout.write("hello-live\\n");' +
      'setTimeout(function(){process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,cached_input_tokens:0,output_tokens:2}})+"\\n");}, 150);';
    const result = await defaultHostRunRunner({
      command: process.execPath,
      argv: ['-e', script],
      env: process.env,
      cwd: process.cwd(),
      host: 'codex',
      retainUsageLine: usageLineRetainerFor('codex'),
      onChunk: (c: HostRunChunk) => chunks.push({ stream: c.stream, text: c.text, at: Date.now() }),
    });
    const resolvedAt = Date.now();
    const first = chunks.find((c) => c.text.includes('hello-live'));
    assert.ok(first, 'the first line streamed through the passthrough');
    assert.ok(
      resolvedAt - first!.at >= 80,
      `first line was delivered live, well before exit (gap ${resolvedAt - first!.at}ms >= the host sleep, proving streaming not buffering)`,
    );
    assert.equal(result.exitCode, 0);
    // Only the BOUNDED usage line is retained for parsing (not the first line).
    const usage = scanCodexTurnCompletedUsage(result.stdout) as Record<string, unknown> | null;
    assert.ok(usage && usage.input_tokens === 5, 'the retained usage line parses to the reported counts');
    assert.equal(result.retentionTruncated, false, 'a normal line is not flagged truncated');
  });
}

export async function case28(): Promise<void> {


  await checkAsync('F-243: stdoutDigest hashes raw provider bytes before UTF-8 decoding', async () => {
    const raw = Buffer.from([0xff, 0xfe, 0x61]);
    const seen: string[] = [];
    const result = await defaultHostRunRunner({
      command: process.execPath,
      argv: ['-e', `process.stdout.write(Buffer.from([${[...raw].join(',')}]))`],
      env: process.env,
      cwd: process.cwd(),
      host: 'codex',
      retainUsageLine: usageLineRetainerFor('codex'),
      onChunk: chunk => { if (chunk.stream === 'stdout') seen.push(chunk.text); },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutDigest, createHash('sha256').update(raw).digest('hex'),
      'invalid UTF-8 replacement must not change the raw-byte provenance digest');
    assert.equal(seen.join(''), '\ufffd\ufffda',
      'text consumers still receive a deterministic UTF-8 replacement projection');
  });
}

export async function case29(): Promise<void> {


  await checkAsync('F-006: host output is delivered through the passthrough EXACTLY once (no double-print) with a buffered runner', async () => {
    const sub = freshRoot();
    const seen: string[] = [];
    const passthrough: HostRunPassthrough = (c) => { if (c.stream === 'stdout') seen.push(c.text); };
    // A buffered fake runner streams nothing live; the core flushes its stdout to
    // the passthrough once. The handler returns '' in text mode, so there is no
    // second copy.
    const result = await runHostRun(
      baseArgs({ root: sub, host: 'codex' }),
      { runner: makeRunner({ stdout: CODEX_STDOUT }), passthrough },
    );
    const occurrences = seen.join('').split('turn.completed').length - 1;
    assert.equal(occurrences, 1, 'buffered host stdout reached the passthrough exactly once');
    assert.equal(result.spawned, true);
  });
}

export async function case30(): Promise<void> {


  await checkAsync('F-006: an oversized single usage line is bounded (dropped + truncation flag) -> no parse target, never OOM/fabrication', async () => {
    // Build a turn.completed line whose padding pushes it past the 1 MiB cap.
    const padLen = HOST_RUN_RETAINED_LINE_CAP + 4096;
    const expectedStdout = `${JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      pad: 'a'.repeat(padLen),
    })}\n`;
    const script =
      `var pad="a".repeat(${padLen});` +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1},pad:pad})+"\\n");';
    const result = await defaultHostRunRunner({
      command: process.execPath,
      argv: ['-e', script],
      env: process.env,
      cwd: process.cwd(),
      host: 'codex',
      retainUsageLine: usageLineRetainerFor('codex'),
      onChunk: () => { /* discard live (bounded memory) */ },
    });
    assert.equal(result.retentionTruncated, true, 'the over-cap line is flagged truncated');
    assert.equal(result.stdout, '', 'the over-cap line is NOT retained as a parse target');
    assert.equal(
      result.stdoutDigest,
      createHash('sha256').update(expectedStdout, 'utf8').digest('hex'),
      'stdoutDigest covers the complete stream, not the empty retained parser lane',
    );
    assert.equal(scanCodexTurnCompletedUsage(result.stdout), null, 'no usage can be parsed from an empty retention');

    // End-to-end: an empty retention (the bounded-drop outcome) records an honest
    // `unavailable` final via the seam, never a fabricated count.
    const sub = freshRoot();
    const summ = await runHostRun(
      baseArgs({ root: sub, host: 'codex' }),
      { runner: makeRunner({ stdout: '' }) },
    );
    assert.equal(summ.usageSummary.recorded, 'unavailable', 'empty retention -> unavailable, not a fabricated zero');
    assert.equal(summ.usageSummary.input, null);
  });
}

export async function case31(): Promise<void> {


  // =========================================================================
  // F-013: retention truncation must force an UNAVAILABLE final. When the
  // scanner drops a LATER over-cap line, the EARLIER retained usage line is
  // known-stale (the dropped line may have carried the real final numbers).
  // Against the old code both checks below recorded a provider-reported final
  // with the stale earlier counts (runHostRun ignored spawn.retentionTruncated).
  // =========================================================================
  await checkAsync('F-013 codex: valid turn.completed then an over-cap final usage line -> unavailable (usage_line_retention_truncated), never the stale earlier numbers', async () => {
    const sub = freshRoot();
    const padLen = HOST_RUN_RETAINED_LINE_CAP + 4096;
    // A REAL child through the REAL default runner: the first (valid, retained)
    // usage line is the stale decoy; the second line carries the "real" final
    // usage but blows the 1 MiB cap and is dropped by the scanner.
    const script =
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:11,cached_input_tokens:1,output_tokens:2}})+"\\n");' +
      `var pad="a".repeat(${padLen});` +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:999,cached_input_tokens:0,output_tokens:99},pad:pad})+"\\n");';
    const runner: HostRunRunner = (plan) => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', script] });
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner });
    assert.equal(result.spawned, true);
    // The scanner DID retain the stale earlier line — exactly the trap.
    const retained = scanCodexTurnCompletedUsage(result.stdout) as Record<string, unknown> | null;
    assert.ok(retained && retained.input_tokens === 11, 'precondition: the stale EARLIER usage line is what the scanner retained');
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final, 'unavailable final recorded');
    assert.equal(final!.usage.unavailableReason, HOST_RUN_RETENTION_TRUNCATED_REASON);
    assert.equal(final!.provider?.name, 'openai', 'unavailable final stays provider-honest');
    assert.equal(final!.usage.inputTokens, null, 'no stale count on the row');
    assert.equal(records.some((r) => r.usage.source === 'provider-reported'), false, 'NO provider-reported row from the stale retained line');
    assert.equal(result.usageSummary.recorded, 'unavailable', 'result surface says unavailable');
    assert.equal(result.usageSummary.reason, HOST_RUN_RETENTION_TRUNCATED_REASON, 'result surface carries the truncation reason');
    assert.equal(result.usageSummary.input, null, 'summary never echoes the stale numbers');
  });
}

export async function case32(): Promise<void> {


  await checkAsync('F-013 claude: valid result envelope then an over-cap line -> unavailable (usage_line_retention_truncated), not the stale envelope', async () => {
    const sub = freshRoot();
    const padLen = HOST_RUN_RETAINED_LINE_CAP + 4096;
    const staleEnvelope = JSON.stringify({
      type: 'result',
      result: 'stale earlier envelope',
      model: CLAUDE_MODEL,
      usage: { input_tokens: 4200, output_tokens: 320, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 },
    });
    const script =
      `process.stdout.write(${JSON.stringify(staleEnvelope)}+"\\n");` +
      `var pad="a".repeat(${padLen});` +
      'process.stdout.write(JSON.stringify({type:"result",result:"the real final",usage:{input_tokens:9,output_tokens:9},pad:pad})+"\\n");';
    const runner: HostRunRunner = (plan) => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', script] });
    const result = await runHostRun(baseArgs({ root: sub, host: 'claude' }), { runner });
    assert.equal(result.spawned, true);
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final, 'unavailable final recorded');
    assert.equal(final!.usage.unavailableReason, HOST_RUN_RETENTION_TRUNCATED_REASON);
    assert.equal(final!.provider?.name, 'anthropic', 'unavailable final stays provider-honest');
    assert.equal(records.some((r) => r.usage.source === 'provider-reported'), false, 'NO provider-reported row from the stale envelope');
    assert.equal(result.usageSummary.recorded, 'unavailable');
    assert.equal(result.usageSummary.reason, HOST_RUN_RETENTION_TRUNCATED_REASON);
    assert.equal(result.usageSummary.input, null, 'summary never echoes the stale 4200');
  });
}

export async function case33(): Promise<void> {


  // =========================================================================
  // F-026: truncation poisoning must be RELATIVE to the retained candidate.
  // Against the OLD code the scanner set a GLOBAL truncated flag on ANY
  // over-cap line, so a huge NON-usage output line early in the stream forced
  // an unavailable final even though a perfectly valid usage-bearing line was
  // retained AFTER it. Only a drop after (or without) the retained candidate
  // may poison the final (F-013/F-006 preserved).
  // =========================================================================
  check('F-026 scanner unit: drop-then-candidate clears the flag; candidate-then-drop sets it (F-013); drop-only stays set (F-006); a retained-nothing line never clears it', () => {
    const retain = usageLineRetainerFor('codex');
    const usageLine = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
    const big = 'x'.repeat(HOST_RUN_RETAINED_LINE_CAP + 16);

    const dropThenCandidate = new UsageLineScanner(retain);
    dropThenCandidate.push(`${big}\n${usageLine}\n`);
    dropThenCandidate.flush();
    assert.equal(dropThenCandidate.truncated, false, 'a candidate retained AFTER the drop clears the poison');
    assert.equal(dropThenCandidate.retainedText(), usageLine, 'the candidate is the retained parse target');

    const candidateThenDrop = new UsageLineScanner(retain);
    candidateThenDrop.push(`${usageLine}\n${big}\n`);
    candidateThenDrop.flush();
    assert.equal(candidateThenDrop.truncated, true, 'a drop AFTER the candidate stays poisoned (F-013)');

    const dropOnly = new UsageLineScanner(retain);
    dropOnly.push(`${big}\n`);
    dropOnly.flush();
    assert.equal(dropOnly.truncated, true, 'a drop with NO candidate stays poisoned (F-006)');
    assert.equal(dropOnly.retainedText(), '', 'nothing retained');

    const dropThenNoise = new UsageLineScanner(retain);
    dropThenNoise.push(`${big}\n${JSON.stringify({ type: 'noise' })}\n`);
    dropThenNoise.flush();
    assert.equal(dropThenNoise.truncated, true, 'an under-cap NON-usage line never clears the poison');
  });
}

export async function case34(): Promise<void> {


  await checkAsync('F-026 codex (the RED): an over-cap NON-usage line followed by a valid turn.completed -> provider-reported final with the candidate numbers (the OLD global flag forced unavailable here)', async () => {
    const sub = freshRoot();
    const padLen = HOST_RUN_RETAINED_LINE_CAP + 4096;
    // A REAL child through the REAL default runner: a huge non-usage line first
    // (dropped over-cap), then the valid final usage event, retained normally.
    const script =
      `var pad="a".repeat(${padLen});` +
      'process.stdout.write(pad+"\\n");' +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:21,cached_input_tokens:1,output_tokens:4}})+"\\n");';
    const runner: HostRunRunner = (plan) => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', script] });
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex' }), { runner });
    assert.equal(result.spawned, true);
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(final, 'provider-reported final recorded — the retained candidate postdates the drop');
    assert.equal(final!.usage.canonical?.input, 20, 'the honest candidate numbers land (uncached remainder 21-1)');
    assert.equal(final!.usage.canonical?.output, 4);
    assert.equal(records.some((r) => r.usage.source === 'unavailable'), false, 'NO unavailable row for a pre-candidate drop');
    assert.equal(result.usageSummary.recorded, 'provider-reported', 'result surface reports the recorded usage');
    assert.equal(result.usageSummary.input, 20);
    assert.notEqual(result.usageSummary.reason, HOST_RUN_RETENTION_TRUNCATED_REASON, 'no truncation reason for a superseded drop');
  });
}

export async function case35(): Promise<void> {


  await checkAsync('F-026 claude: an over-cap NON-usage line followed by a valid result envelope -> provider-reported final with the served model (mirror)', async () => {
    const sub = freshRoot();
    const padLen = HOST_RUN_RETAINED_LINE_CAP + 4096;
    const envelope = JSON.stringify({
      type: 'result',
      result: 'the real final',
      model: CLAUDE_MODEL,
      usage: { input_tokens: 4200, output_tokens: 320, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 },
    });
    const script =
      `var pad="a".repeat(${padLen});` +
      'process.stdout.write(pad+"\\n");' +
      `process.stdout.write(${JSON.stringify(envelope)}+"\\n");`;
    const runner: HostRunRunner = (plan) => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', script] });
    const result = await runHostRun(baseArgs({ root: sub, host: 'claude' }), { runner });
    assert.equal(result.spawned, true);
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(final, 'provider-reported final recorded — the retained envelope postdates the drop');
    assert.equal(final!.usage.inputTokens, 4200);
    assert.equal(final!.provider?.model, CLAUDE_MODEL, 'served model bound from the honest envelope');
    assert.equal(records.some((r) => r.usage.source === 'unavailable'), false, 'NO unavailable row for a pre-candidate drop');
    assert.equal(result.usageSummary.recorded, 'provider-reported');
    assert.equal(result.usageSummary.input, 4200);
  });
}

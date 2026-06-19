#!/usr/bin/env node
/**
 * B-12d7: smoke suite for codex/gemini provider token-usage capture in the LLM
 * usage ledger.
 *
 * Covers the three layers added by this story:
 *   - CHK-001 providers: extractCodexUsage / extractGeminiUsage parse a sample CLI
 *     stdout (JSONL) into the correct token-count object, return undefined for
 *     non-JSON / empty / no-usage lines, and surface ONLY numeric token fields
 *     (no transcript-text key) — the security invariant;
 *   - CHK-002 dispatch-usage: recordDispatchFinalForProvider with a codex `usage`
 *     and a gemini `usageMetadata` each writes a sequence-2 provider-reported
 *     final that supersedes the preflight estimate (no double count); a
 *     null/garbage usage writes an unavailable final (still supersedes); flag OFF
 *     => nothing written;
 *   - CLAUDE PATH REGRESSION: recordDispatchFinal with an anthropic usage still
 *     behaves exactly as before;
 *   - STATIC import boundary: providers/codex-cli.ts and gemini-cli.ts import
 *     nothing from core/usage-ledger.
 *
 * Runs entirely in an OS temp dir; never pollutes the repo. Prints per-check
 * lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBoundedCodexProvider } from '../providers/codex-cli.js';
import { runBoundedGeminiProvider } from '../providers/gemini-cli.js';
import type { ProviderProcessRunner } from '../providers/codex-cli.js';
import {
  recordDispatchFinal,
  recordDispatchFinalForProvider,
  recordDispatchPreflight,
  type DispatchUsageContext,
} from '../core/usage-ledger/dispatch-usage.js';
import { resolveLedgerPath, verifyLedgerChain } from '../core/usage-ledger/writer.js';
import { summarizeRecords } from '../core/usage-ledger/summary.js';
import { aggregateByGroup, buildUsageReport } from '../core/usage-ledger/diagnostics.js';
import type { UsageLedgerRecord } from '../core/usage-ledger/record.js';

let passed = 0;
const failures: string[] = [];

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

const ON = { LATTICE_USAGE_LEDGER: '1' } as NodeJS.ProcessEnv;
const OFF = { LATTICE_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;

const root = mkdtempSync(join(tmpdir(), 'usage-ledger-codex-gemini-'));

function ctx(over: Partial<DispatchUsageContext> = {}): DispatchUsageContext {
  return {
    storyId: 'S-test',
    phase: 'dispatch',
    agentType: 'lattice-dispatch:codex',
    model: 'codex',
    ...over,
  };
}

function opts(env: NodeJS.ProcessEnv) {
  return {
    recordedAt: '2026-06-19T00:00:00.000Z',
    projectRootHash: 'sha256:deadbeef',
    command: 'codex exec <prompt-file>',
    host: { kind: 'codex' },
    env,
  };
}

function readLedger(subRoot: string) {
  const path = resolveLedgerPath(subRoot);
  if (!existsSync(path)) return [];
  return verifyLedgerChain(path);
}

let counter = 0;
function freshRoot(): string {
  return join(root, `case-${counter++}`);
}

/** A fake process runner that emits a fixed stdout so we never spawn a real CLI. */
function fakeRunner(stdout: string): ProviderProcessRunner {
  return () => ({ status: 0, stdout, stderr: '', signal: null });
}

/** Assert a usage object carries no transcript-text key (security invariant). */
function assertNoTranscriptText(usage: Record<string, unknown> | undefined): void {
  assert.ok(usage, 'expected a usage object');
  for (const key of ['text', 'content', 'message', 'role', 'result', 'transcript']) {
    assert.ok(!(key in usage!), `usage must NOT carry transcript key "${key}"`);
  }
  // Every surfaced value must be a number or a nested object of numbers (token
  // detail buckets), never a string — strings could carry transcript text.
  for (const [k, v] of Object.entries(usage!)) {
    if (typeof v === 'object' && v !== null) continue; // nested token-detail bucket
    assert.equal(typeof v, 'number', `usage field "${k}" must be numeric, got ${typeof v}`);
  }
}

async function main(): Promise<void> {
  // ======================================================================
  // CHK-001: extractCodexUsage / extractGeminiUsage (via the bounded runners)
  // ======================================================================
  await check('CHK-001 codex: top-level usage parsed into token-count object', () => {
    const stdout = [
      JSON.stringify({ type: 'item', message: { role: 'assistant', content: 'hello' } }),
      JSON.stringify({
        type: 'result',
        model: 'gpt-5-codex',
        usage: { prompt_tokens: 1000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } },
      }),
    ].join('\n');
    const result = runBoundedCodexProvider(
      { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage);
    assert.equal(result.reportedUsage?.prompt_tokens, 1000);
    assert.equal(result.reportedUsage?.completion_tokens, 300);
    assertNoTranscriptText(result.reportedUsage);
  });

  await check('CHK-001 codex: usage nested under message is parsed', () => {
    const stdout = JSON.stringify({
      type: 'message',
      message: { role: 'assistant', usage: { prompt_tokens: 50, completion_tokens: 10 } },
    });
    const result = runBoundedCodexProvider(
      { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage);
    assert.equal(result.reportedUsage?.prompt_tokens, 50);
    assertNoTranscriptText(result.reportedUsage);
  });

  await check('CHK-001 codex: non-JSON / empty / no-usage stdout -> reportedUsage absent', () => {
    for (const stdout of ['', 'not json at all', JSON.stringify({ type: 'item', message: { content: 'hi' } })]) {
      const result = runBoundedCodexProvider(
        { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
        fakeRunner(stdout),
      );
      assert.equal(result.reportedUsage, undefined, `expected no usage for stdout: ${JSON.stringify(stdout)}`);
    }
  });

  await check('CHK-001 gemini: top-level usageMetadata parsed into token-count object', () => {
    const stdout = JSON.stringify({
      response: { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
      usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 120, cachedContentTokenCount: 40 },
    });
    const result = runBoundedGeminiProvider(
      { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage);
    assert.equal(result.reportedUsage?.promptTokenCount, 800);
    assert.equal(result.reportedUsage?.candidatesTokenCount, 120);
    assertNoTranscriptText(result.reportedUsage);
  });

  await check('CHK-001 gemini: usageMetadata nested under response is parsed', () => {
    const stdout = JSON.stringify({
      response: { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } },
    });
    const result = runBoundedGeminiProvider(
      { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage);
    assert.equal(result.reportedUsage?.promptTokenCount, 7);
    assertNoTranscriptText(result.reportedUsage);
  });

  await check('CHK-001 gemini: non-JSON / empty / no-usage stdout -> reportedUsage absent', () => {
    for (const stdout of ['', '{broken json', JSON.stringify({ response: { candidates: [] } })]) {
      const result = runBoundedGeminiProvider(
        { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
        fakeRunner(stdout),
      );
      assert.equal(result.reportedUsage, undefined, `expected no usage for stdout: ${JSON.stringify(stdout)}`);
    }
  });

  // ======================================================================
  // CHK-002/003: recordDispatchFinalForProvider
  // ======================================================================
  await check('CHK-002 codex: provider-reported final supersedes estimate (no double count)', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'prompt', opts(ON));
    assert.ok(handle);
    recordDispatchFinalForProvider(
      sub,
      ctx(),
      handle!.correlation,
      handle!.estimateRecordId,
      'openai',
      { prompt_tokens: 500, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 50 } },
      'gpt-5-codex',
      opts(ON),
    );
    const records = readLedger(sub);
    assert.equal(records.length, 2);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(final, 'expected a provider-reported final');
    assert.equal(final?.sequence, 2);
    assert.equal(final?.provider?.name, 'openai');
    assert.deepEqual(final?.supersedesRecordIds, [handle!.estimateRecordId]);
    const summary = summarizeRecords(records);
    // input(500) + output(200) + cacheCreation(null->excluded? no: known) -- openai
    // cacheCreation is null, so the total is unknown UNLESS all four dims known.
    // openai cacheCreation is ALWAYS null -> total is unknown. So provider total
    // counts 0 and the record is bucketed unknown. The estimate is still superseded.
    assert.equal(summary.estimateCount, 0, 'estimate must be superseded, not counted');
    assert.equal(summary.unknownCount, 1, 'openai cacheCreation null -> total unknown');
  });

  await check('CHK-002 gemini: provider-reported final supersedes estimate (no double count)', () => {
    const sub = freshRoot();
    const gctx = ctx({ agentType: 'lattice-dispatch:gemini', model: 'gemini' });
    const handle = recordDispatchPreflight(sub, gctx, 'prompt', opts(ON));
    assert.ok(handle);
    recordDispatchFinalForProvider(
      sub,
      gctx,
      handle!.correlation,
      handle!.estimateRecordId,
      'gemini',
      { promptTokenCount: 800, candidatesTokenCount: 120, cachedContentTokenCount: 40 },
      'gemini-2.5-pro',
      opts(ON),
    );
    const records = readLedger(sub);
    assert.equal(records.length, 2);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(final, 'expected a provider-reported final');
    assert.equal(final?.sequence, 2);
    assert.equal(final?.provider?.name, 'gemini');
    assert.equal(final?.provider?.model, 'gemini-2.5-pro');
    assert.equal(final?.usage.inputTokens, 800);
    assert.equal(final?.usage.outputTokens, 120);
    assert.equal(final?.usage.cacheReadInputTokens, 40);
    assert.deepEqual(final?.supersedesRecordIds, [handle!.estimateRecordId]);
    const summary = summarizeRecords(records);
    // gemini cacheCreation is null too -> total unknown, but the token counts are
    // present on the record. The estimate is superseded regardless.
    assert.equal(summary.estimateCount, 0, 'estimate must be superseded, not counted');
  });

  await check('CHK-002 null/garbage usage -> unavailable final (still supersedes)', () => {
    for (const bad of [null, undefined, 'garbage', 42, [1, 2, 3]]) {
      const sub = freshRoot();
      const handle = recordDispatchPreflight(sub, ctx(), 'prompt', opts(ON));
      assert.ok(handle);
      recordDispatchFinalForProvider(
        sub,
        ctx(),
        handle!.correlation,
        handle!.estimateRecordId,
        'openai',
        bad,
        'gpt-5-codex',
        opts(ON),
      );
      const records = readLedger(sub);
      assert.equal(records.length, 2, `expected 2 records for bad usage ${JSON.stringify(bad)}`);
      const final = records.find((r) => r.usage.source === 'unavailable');
      assert.ok(final, `expected an unavailable final for bad usage ${JSON.stringify(bad)}`);
      assert.deepEqual(final?.supersedesRecordIds, [handle!.estimateRecordId]);
      const summary = summarizeRecords(records);
      assert.equal(summary.unknownCount, 1);
      assert.equal(summary.estimateCount, 0);
    }
  });

  await check('CHK-002 flag OFF -> nothing written', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'prompt', opts(OFF));
    recordDispatchFinalForProvider(
      sub,
      ctx(),
      null,
      null,
      'openai',
      { prompt_tokens: 1, completion_tokens: 1 },
      'gpt-5-codex',
      opts(OFF),
    );
    assert.equal(handle, null);
    assert.equal(existsSync(resolveLedgerPath(sub)), false);
  });

  await check('CHK-002 adversarial: never throws (corrupt ledger / rogue usage)', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'prompt', opts(ON));
    let threw = false;
    try {
      recordDispatchFinalForProvider(
        sub,
        ctx(),
        handle!.correlation,
        handle!.estimateRecordId,
        'openai',
        { prompt_tokens: -999, completion_tokens: 5 },
        'gpt-5-codex',
        opts(ON),
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'a rogue negative token count must not crash dispatch');
  });

  await check('CHK-003 adversarial:3: two codex finals to the SAME root -> distinct correlations, chain intact', () => {
    const sub = freshRoot();
    // First preflight + provider-reported final.
    const a = recordDispatchPreflight(sub, ctx(), 'prompt-a', opts(ON));
    assert.ok(a);
    recordDispatchFinalForProvider(
      sub,
      ctx(),
      a!.correlation,
      a!.estimateRecordId,
      'openai',
      { prompt_tokens: 111, completion_tokens: 11 },
      'gpt-5-codex',
      opts(ON),
    );
    // Second preflight + provider-reported final against the SAME ledger root in
    // rapid succession (distinct token values so the two finals are tellable apart).
    const b = recordDispatchPreflight(sub, ctx(), 'prompt-b', opts(ON));
    assert.ok(b);
    recordDispatchFinalForProvider(
      sub,
      ctx(),
      b!.correlation,
      b!.estimateRecordId,
      'openai',
      { prompt_tokens: 222, completion_tokens: 22 },
      'gpt-5-codex',
      opts(ON),
    );
    const records = readLedger(sub);
    // 2 estimates + 2 provider-reported finals = 4 records, none lost/corrupted.
    assert.equal(records.length, 4, 'expected 4 records (2 estimates + 2 finals)');
    const finals = records.filter((r) => r.usage.source === 'provider-reported');
    assert.equal(finals.length, 2, 'expected exactly 2 provider-reported finals');
    // The two finals carry DISTINCT correlation ids (no collision under rapid succession).
    assert.notEqual(finals[0].ledgerCallId, finals[1].ledgerCallId, 'finals must have distinct ledgerCallId');
    assert.notEqual(finals[0].attemptId, finals[1].attemptId, 'finals must have distinct attemptId');
    assert.notEqual(finals[0].recordId, finals[1].recordId, 'finals must have distinct recordId');
    // The hash chain validates end-to-end (no corruption from concurrent writes).
    const chained = verifyLedgerChain(resolveLedgerPath(sub));
    assert.equal(chained.length, 4, 'verifyLedgerChain must accept all 4 records (no chain corruption)');
  });

  await check('CHK-002 edge:2: provider-reported final with model=null -> provider.model === "unknown"', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'prompt', opts(ON));
    assert.ok(handle);
    recordDispatchFinalForProvider(
      sub,
      ctx(),
      handle!.correlation,
      handle!.estimateRecordId,
      'openai',
      { prompt_tokens: 500, completion_tokens: 200 },
      null, // model unknown -> must fall back to DEFAULT_ESTIMATE_MODEL ('unknown')
      opts(ON),
    );
    const records = readLedger(sub);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(final, 'expected a provider-reported final');
    assert.equal(final?.provider?.name, 'openai');
    assert.equal(final?.provider?.model, 'unknown', 'model=null must bind the DEFAULT_ESTIMATE_MODEL fallback "unknown"');
  });

  await check('CHK-002 edge:3: correlation=null AND estimateRecordId=null -> fresh correlation minted, final written', () => {
    const sub = freshRoot();
    // No preflight: drive a provider-reported final with BOTH correlation and
    // estimateRecordId null, ledger ON. A fresh correlation must be minted.
    recordDispatchFinalForProvider(
      sub,
      ctx(),
      null,
      null,
      'openai',
      { prompt_tokens: 300, completion_tokens: 30 },
      'gpt-5-codex',
      opts(ON),
    );
    const records = readLedger(sub);
    const finals = records.filter((r) => r.usage.source === 'provider-reported');
    assert.equal(finals.length, 1, 'exactly one provider-reported record must be written');
    assert.ok((finals[0].ledgerCallId ?? '').length > 0, 'a fresh correlation must mint a non-empty ledgerCallId');
    assert.ok((finals[0].attemptId ?? '').length > 0, 'a fresh correlation must mint a non-empty attemptId');
  });

  // ======================================================================
  // CHK-PRIMARY (B-b1f4): the ADDITIVE input+output ("primary") aggregate.
  //
  // A codex (openai adapter) and a gemini provider-reported final each set
  // cacheCreation=null BY DESIGN, so they stay four-field-UNKNOWN (excluded
  // from providerReportedTotal / bySource.known) — yet their input+output MUST
  // surface in summary.primaryReportedTotal and diagnostics
  // bySource['provider-reported'].primaryKnown. A claude record (all four dims
  // known) appears in BOTH the strict four-field total AND the primary total.
  // Estimates and unavailable records contribute to NEITHER primary aggregate.
  // ======================================================================

  // Build a single combined ledger by writing codex/gemini/claude finals (each
  // supersedes its own preflight estimate) into ONE shared root, then reading
  // the whole chain back. Distinct correlations per preflight keep them apart.
  const primaryRoot = freshRoot();

  // codex final: input=500, output=200, cache* null -> four-field unknown.
  {
    const h = recordDispatchPreflight(primaryRoot, ctx(), 'codex-prompt', opts(ON));
    assert.ok(h);
    recordDispatchFinalForProvider(
      primaryRoot,
      ctx(),
      h!.correlation,
      h!.estimateRecordId,
      'openai',
      { prompt_tokens: 500, completion_tokens: 200 },
      'gpt-5-codex',
      opts(ON),
    );
  }
  // gemini final: input=800, output=120, cacheRead=40, cacheCreation null ->
  // four-field unknown (cacheCreation null) but primary-known.
  {
    const gctx = ctx({ agentType: 'lattice-dispatch:gemini', model: 'gemini' });
    const h = recordDispatchPreflight(primaryRoot, gctx, 'gemini-prompt', opts(ON));
    assert.ok(h);
    recordDispatchFinalForProvider(
      primaryRoot,
      gctx,
      h!.correlation,
      h!.estimateRecordId,
      'gemini',
      { promptTokenCount: 800, candidatesTokenCount: 120, cachedContentTokenCount: 40 },
      'gemini-2.5-pro',
      opts(ON),
    );
  }
  // claude final: all four dims known (input=500, output=200, cacheCreation=10,
  // cacheRead=50) -> four-field total 760 AND primary 700.
  {
    const cctx = ctx({ agentType: 'lattice-dispatch:claude-code', model: 'claude-code' });
    const h = recordDispatchPreflight(primaryRoot, cctx, 'claude-prompt', opts(ON));
    assert.ok(h);
    recordDispatchFinal(
      primaryRoot,
      cctx,
      h!.correlation,
      h!.estimateRecordId,
      { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 10, cache_read_input_tokens: 50 },
      'claude-opus-4-8',
      opts(ON),
    );
  }
  const primaryRecords = readLedger(primaryRoot);

  await check('CHK-PRIMARY summary: codex+gemini+claude all contribute to primaryReportedTotal', () => {
    const summary = summarizeRecords(primaryRecords);
    // (500+200) + (800+120) + (500+200) = 700 + 920 + 700 = 2320 across 3 finals.
    assert.equal(summary.primaryReportedTotal, 2320, 'primary total = sum of all three input+output');
    assert.equal(summary.primaryReportedCount, 3, 'all three provider-reported finals contribute to primary');
  });

  await check('CHK-PRIMARY summary: strict four-field UNCHANGED (claude only, codex/gemini still unknown)', () => {
    const summary = summarizeRecords(primaryRecords);
    // Only claude has all four dims known: 500+200+10+50 = 760.
    assert.equal(summary.providerReportedTotal, 760, 'four-field total counts claude only');
    assert.equal(summary.providerReportedCount, 1, 'only claude is four-field-known');
    // codex + gemini are four-field unknown (cacheCreation null by design).
    assert.equal(summary.unknownCount, 2, 'codex+gemini four-field unknown; estimates superseded');
    // Estimates were all superseded by their finals -> none counted.
    assert.equal(summary.estimateCount, 0, 'preflight estimates are superseded, not counted');
    assert.equal(summary.estimateSubtotal, 0, 'no estimate subtotal (all superseded)');
  });

  await check('CHK-PRIMARY diagnostics: bySource provider-reported carries primaryKnown AND four-field known', () => {
    const report = buildUsageReport(primaryRecords);
    const pr = report.overall.bySource['provider-reported'];
    // Primary aggregate spans all three finals: in = 500+800+500 = 1800; out = 200+120+200 = 520.
    assert.equal(pr.primaryKnown.input, 1800, 'overall primary input across all three finals');
    assert.equal(pr.primaryKnown.output, 520, 'overall primary output across all three finals');
    assert.equal(pr.primaryKnownCount, 3, 'all three finals are primary-known');
    // Four-field known counts claude only (codex/gemini cacheCreation null).
    assert.deepEqual(
      pr.known,
      { input: 500, output: 200, cacheCreation: 10, cacheRead: 50 },
      'four-field known is the claude record only',
    );
    assert.equal(pr.knownCount, 1, 'only claude contributes to four-field known');
    assert.equal(pr.unknownCount, 2, 'codex+gemini are four-field unknown');
  });

  await check('CHK-PRIMARY aggregateByGroup: codex group is four-field-unknown yet primary-known', () => {
    // Isolate a single codex record so its group bucket is unambiguous.
    const codexOnlyRoot = freshRoot();
    const h = recordDispatchPreflight(codexOnlyRoot, ctx(), 'codex-only', opts(ON));
    assert.ok(h);
    recordDispatchFinalForProvider(
      codexOnlyRoot,
      ctx(),
      h!.correlation,
      h!.estimateRecordId,
      'openai',
      { prompt_tokens: 500, completion_tokens: 200 },
      'gpt-5-codex',
      opts(ON),
    );
    const groups = aggregateByGroup(readLedger(codexOnlyRoot));
    // Selection drops the superseded estimate, leaving the single codex final.
    const codexGroup = groups.find((g) => g.bySource['provider-reported'].primaryKnownCount > 0);
    assert.ok(codexGroup, 'expected a group with a primary-known provider-reported record');
    const b = codexGroup!.bySource['provider-reported'];
    assert.deepEqual(b.primaryKnown, { input: 500, output: 200 }, 'codex primaryKnown = input+output');
    assert.equal(b.primaryKnownCount, 1, 'codex contributes one primary-known record');
    assert.equal(b.knownCount, 0, 'codex four-field-known count is 0 (cacheCreation null)');
    assert.equal(b.unknownCount, 1, 'codex is four-field unknown');
  });

  await check('CHK-PRIMARY edge: estimate + unavailable records do NOT contribute to the primary aggregate', () => {
    // A standalone preflight estimate (NOT superseded) survives selection as a
    // single prompt-size-estimate record (input-only; output null), so it never
    // contributes to the provider-reported primary aggregate.
    const estimateRoot = freshRoot();
    recordDispatchPreflight(estimateRoot, ctx(), 'estimate-only-prompt', opts(ON));
    const estimateRecords = readLedger(estimateRoot);
    const estSummary = summarizeRecords(estimateRecords);
    assert.equal(estSummary.selected.length, 1, 'one standalone estimate record selected');
    assert.equal(estSummary.selected[0].source, 'prompt-size-estimate', 'selected record is the estimate');
    assert.equal(
      estSummary.primaryReportedTotal,
      0,
      'an estimate must NOT contribute to primaryReportedTotal (provider-reported only)',
    );
    assert.equal(estSummary.primaryReportedCount, 0, 'estimate contributes 0 to primary count');
    const estReport = buildUsageReport(estimateRecords);
    assert.equal(
      estReport.overall.bySource['provider-reported'].primaryKnownCount,
      0,
      'estimate does not populate the provider-reported primaryKnown bucket',
    );

    // unavailable final (garbage usage) -> source=unavailable, excluded from primary.
    const unavailRoot = freshRoot();
    const h = recordDispatchPreflight(unavailRoot, ctx(), 'unavail-prompt', opts(ON));
    assert.ok(h);
    recordDispatchFinalForProvider(
      unavailRoot,
      ctx(),
      h!.correlation,
      h!.estimateRecordId,
      'openai',
      'garbage-not-an-object',
      'gpt-5-codex',
      opts(ON),
    );
    const unavailRecords = readLedger(unavailRoot);
    const unavailSummary = summarizeRecords(unavailRecords);
    assert.equal(unavailSummary.unknownCount, 1, 'the unavailable final is counted unknown');
    assert.equal(
      unavailSummary.primaryReportedTotal,
      0,
      'an unavailable record must NOT contribute to primaryReportedTotal',
    );
    assert.equal(unavailSummary.primaryReportedCount, 0, 'unavailable contributes 0 to primary count');
    const unavailReport = buildUsageReport(unavailRecords);
    assert.equal(
      unavailReport.overall.bySource['provider-reported'].primaryKnownCount,
      0,
      'unavailable does not populate the provider-reported primaryKnown bucket',
    );

    // Source-based exclusion (not just null-based): a prompt-size-estimate with
    // BOTH primary dims known (input=100, output=50) still must NOT contribute
    // to the PROVIDER-REPORTED primary aggregate — primaryReportedTotal is
    // provider-reported-only. Its OWN source bucket DOES carry primaryKnown.
    const synthEstimate: UsageLedgerRecord = {
      schemaVersion: 1,
      recordId: 'llmuse_synth-estimate',
      ledgerCallId: 'llmcall_synth',
      attemptId: 'llmatt_synth',
      sequence: 1,
      supersedesRecordIds: [],
      recordedAt: '2026-06-19T00:00:00.000Z',
      projectRootHash: 'sha256:x',
      storyId: 'S-test',
      phase: 'dispatch',
      agentType: 'lattice-dispatch:codex',
      decision: { kind: 'allowed' },
      usage: {
        source: 'prompt-size-estimate',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        canonical: { input: 100, output: 50, cacheCreation: null, cacheRead: null },
        estimator: { name: 'char-heuristic', version: '1', unit: 'chars', confidence: 'low' },
      },
      privacy: { promptStored: false, transcriptStored: false, redactionProfile: 'no-raw-content-v1' },
      authority: { mode: 'local', receiptId: null, receiptVerified: false },
      integrity: { previousRecordHash: null, recordHash: 'sha256:synth' },
    };
    const synthSummary = summarizeRecords([synthEstimate]);
    assert.equal(
      synthSummary.primaryReportedTotal,
      0,
      'a both-dims-known estimate must NOT feed primaryReportedTotal (provider-reported only)',
    );
    const synthReport = buildUsageReport([synthEstimate]);
    assert.equal(
      synthReport.overall.bySource['provider-reported'].primaryKnownCount,
      0,
      'the estimate must not leak into the provider-reported primaryKnown bucket',
    );
    assert.deepEqual(
      synthReport.overall.bySource['prompt-size-estimate'].primaryKnown,
      { input: 100, output: 50 },
      'the estimate primaryKnown lands in its OWN source bucket (source isolation preserved)',
    );
    assert.equal(
      synthReport.overall.bySource['prompt-size-estimate'].primaryKnownCount,
      1,
      'one estimate record contributes to its own bucket primaryKnown',
    );
  });

  // ======================================================================
  // CLAUDE PATH REGRESSION: recordDispatchFinal unchanged
  // ======================================================================
  await check('REGRESSION claude: recordDispatchFinal with anthropic usage still supersedes', () => {
    const sub = freshRoot();
    const cctx = ctx({ agentType: 'lattice-dispatch:claude-code', model: 'claude-code' });
    const handle = recordDispatchPreflight(sub, cctx, 'prompt', opts(ON));
    assert.ok(handle);
    recordDispatchFinal(
      sub,
      cctx,
      handle!.correlation,
      handle!.estimateRecordId,
      { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 10, cache_read_input_tokens: 50 },
      'claude-opus-4-8',
      opts(ON),
    );
    const records = readLedger(sub);
    assert.equal(records.length, 2);
    const final = records.find((r) => r.usage.source === 'provider-reported');
    assert.ok(final);
    assert.equal(final?.provider?.name, 'anthropic');
    assert.equal(final?.usage.inputTokens, 500);
    assert.deepEqual(final?.supersedesRecordIds, [handle!.estimateRecordId]);
    const summary = summarizeRecords(records);
    // anthropic reports all four dims -> total = 500+200+10+50 = 760.
    assert.equal(summary.providerReportedTotal, 760);
    assert.equal(summary.providerReportedCount, 1);
    assert.equal(summary.estimateCount, 0);
  });

  // ======================================================================
  // STATIC import boundary: providers must NOT import core/usage-ledger
  // ======================================================================
  await check('STATIC providers/codex-cli.ts + gemini-cli.ts import NOTHING from core/usage-ledger', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    for (const rel of ['providers/codex-cli.ts', 'providers/gemini-cli.ts']) {
      const src = readFileSync(join(repoRoot, 'packages', 'main', 'src', rel), 'utf8');
      const importRe = /from\s+['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(src)) !== null) {
        assert.ok(
          !m[1].includes('usage-ledger'),
          `${rel} must not import core/usage-ledger; found "${m[1]}"`,
        );
      }
    }
  });

  await check('isolation: all test artifacts live under the temp root (no repo pollution)', () => {
    assert.ok(root.startsWith(tmpdir()), 'temp root must be under the OS tmpdir');
    assert.ok(statSync(root).isDirectory());
  });
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n✗ usage-ledger codex/gemini smoke FAILED (${failures.length} failing): ${failures.join(', ')}`);
      process.exit(1);
    }
    console.log(`\n✓ usage-ledger codex/gemini smoke passed (${passed} checks)`);
  })
  .catch((err) => {
    console.error('✗ usage-ledger codex/gemini smoke crashed');
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  });

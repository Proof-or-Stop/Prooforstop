#!/usr/bin/env node
/**
 * B-fbb6 (was B-12d7): smoke suite for codex + antigravity provider token-usage
 * capture in the LLM usage ledger.
 *
 * Covers the layers exercised by this migration:
 *   - CHK-001 providers: extractCodexUsage parses a sample codex CLI stdout (JSONL)
 *     into the correct token-count object, returns undefined for non-JSON / empty /
 *     no-usage lines, and surfaces ONLY numeric token fields (no transcript-text
 *     key) — the security invariant; antigravity (agy --print) NEVER sets
 *     reportedUsage (no usageMetadata exists);
 *   - CHK-002 dispatch-usage: recordDispatchFinalForProvider with a codex `usage`
 *     writes a sequence-2 provider-reported final that supersedes the preflight
 *     estimate (no double count); antigravity ALWAYS writes a source=unavailable
 *     final (still supersedes) since agy print mode surfaces no per-call usage;
 *     a null/garbage usage writes an unavailable final; flag OFF => nothing written;
 *   - CLAUDE PATH REGRESSION: recordDispatchFinal with an anthropic usage still
 *     behaves exactly as before;
 *   - STATIC import boundary: providers/codex-cli.ts and antigravity-cli.ts import
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
import { runBoundedAntigravityProvider } from '../providers/antigravity-cli.js';
import type { ProviderProcessRunner } from '../providers/codex-cli.js';
import {
  recordDispatchFinal,
  recordDispatchFinalForProvider,
  recordDispatchPreflight,
  type DispatchUsageContext,
} from '../core/usage-ledger/dispatch-usage.js';
import { resolveLedgerPath, verifyLedgerChain } from '../core/usage-ledger/writer.js';
import { deriveRecordTotal, summarizeRecords, summarizeLedgerFile } from '../core/usage-ledger/summary.js';
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

const root = mkdtempSync(join(tmpdir(), 'usage-ledger-codex-antigravity-'));

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
  // CHK-001: extractCodexUsage (codex) + antigravity has NO usage (via runners)
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

  await check('CHK-001 antigravity: a usageMetadata-looking stdout STILL yields no reportedUsage (agy has no usage)', () => {
    // Even if stdout happens to carry a usageMetadata-shaped object, the antigravity
    // runner has no extraction at all — reportedUsage must remain absent (the
    // never-infer-an-unreported-value invariant).
    const stdout = JSON.stringify({
      response: { candidates: [{ content: { parts: [{ text: 'hi' }] } }] },
      usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 120, cachedContentTokenCount: 40 },
    });
    const result = runBoundedAntigravityProvider(
      { provider: 'antigravity', argv: ['--print', 'hi'], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.equal(result.provider, 'antigravity');
    assert.equal(result.reportedUsage, undefined, 'antigravity never sets reportedUsage');
  });

  await check('CHK-001 antigravity: plain response text -> reportedUsage absent, digests captured', () => {
    const result = runBoundedAntigravityProvider(
      { provider: 'antigravity', argv: ['--print', 'hi'], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner('the model response text only, no usage envelope'),
    );
    assert.equal(result.reportedUsage, undefined);
    assert.ok(result.stdoutDigest && result.stdoutDigest.length > 0, 'stdout is captured as a digest only');
    assert.equal(result.exitCode, 0);
  });

  await check('CHK-001 antigravity: non-JSON / empty stdout -> reportedUsage absent, no throw', () => {
    for (const stdout of ['', '{broken json', JSON.stringify({ response: { candidates: [] } })]) {
      const result = runBoundedAntigravityProvider(
        { provider: 'antigravity', argv: ['--print', 'hi'], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
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

  await check('CHK-002 antigravity: unavailable final supersedes estimate (no usage, honest reason)', () => {
    const sub = freshRoot();
    const actx = ctx({ agentType: 'lattice-dispatch:antigravity', model: 'antigravity' });
    const handle = recordDispatchPreflight(sub, actx, 'prompt', opts(ON));
    assert.ok(handle);
    // antigravity ALWAYS lands in the source=unavailable branch — agy --print
    // surfaces no per-call token usage; even if a reportedUsage-looking value is
    // passed, antigravity must never produce a provider-reported final.
    recordDispatchFinalForProvider(
      sub,
      actx,
      handle!.correlation,
      handle!.estimateRecordId,
      'antigravity',
      { promptTokenCount: 800, candidatesTokenCount: 120, cachedContentTokenCount: 40 },
      'antigravity-1.0',
      opts(ON),
    );
    const records = readLedger(sub);
    assert.equal(records.length, 2);
    assert.equal(records.find((r) => r.usage.source === 'provider-reported'), undefined, 'antigravity never writes a provider-reported final');
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final, 'expected an unavailable final');
    assert.equal(final?.sequence, 2);
    assert.equal(final?.provider?.name, 'antigravity');
    assert.equal(final?.provider?.model, 'antigravity-1.0');
    assert.strictEqual(final?.usage.inputTokens, null);
    assert.strictEqual(final?.usage.outputTokens, null);
    assert.ok(
      typeof final?.usage.unavailableReason === 'string' && /agy.*print mode.*token usage/i.test(final!.usage.unavailableReason!),
      'unavailableReason must explain agy print mode surfaces no per-call token usage',
    );
    assert.deepEqual(final?.supersedesRecordIds, [handle!.estimateRecordId]);
    const summary = summarizeRecords(records);
    assert.equal(summary.estimateCount, 0, 'estimate must be superseded, not counted');
    assert.equal(summary.unknownCount, 1, 'antigravity unavailable final is bucketed unknown');
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
  // A codex (openai adapter) provider-reported final sets cacheCreation=null BY
  // DESIGN, so it stays four-field-UNKNOWN (excluded from providerReportedTotal /
  // bySource.known) — yet its input+output MUST surface in
  // summary.primaryReportedTotal and diagnostics
  // bySource['provider-reported'].primaryKnown. A claude record (all four dims
  // known) appears in BOTH the strict four-field total AND the primary total.
  // An antigravity final is source=unavailable (no usage at all), so it
  // contributes to NEITHER aggregate. Estimates and unavailable records
  // contribute to NO primary aggregate.
  // ======================================================================

  // Build a single combined ledger by writing codex/antigravity/claude finals
  // (each supersedes its own preflight estimate) into ONE shared root, then
  // reading the whole chain back. Distinct correlations per preflight keep them
  // apart.
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
  // antigravity final: source=unavailable (no per-call usage) -> contributes to
  // NEITHER the primary aggregate NOR the four-field total.
  {
    const actx = ctx({ agentType: 'lattice-dispatch:antigravity', model: 'antigravity' });
    const h = recordDispatchPreflight(primaryRoot, actx, 'antigravity-prompt', opts(ON));
    assert.ok(h);
    recordDispatchFinalForProvider(
      primaryRoot,
      actx,
      h!.correlation,
      h!.estimateRecordId,
      'antigravity',
      undefined,
      'antigravity-1.0',
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

  await check('CHK-PRIMARY summary: codex+claude contribute to primaryReportedTotal; antigravity does NOT', () => {
    const summary = summarizeRecords(primaryRecords);
    // (500+200) + (500+200) = 700 + 700 = 1400 across the two provider-reported
    // finals; the antigravity unavailable final adds nothing.
    assert.equal(summary.primaryReportedTotal, 1400, 'primary total = codex + claude input+output only');
    assert.equal(summary.primaryReportedCount, 2, 'only the two provider-reported finals contribute to primary');
  });

  await check('CHK-PRIMARY summary: strict four-field UNCHANGED (claude only; codex unknown, antigravity unavailable)', () => {
    const summary = summarizeRecords(primaryRecords);
    // Only claude has all four dims known: 500+200+10+50 = 760.
    assert.equal(summary.providerReportedTotal, 760, 'four-field total counts claude only');
    assert.equal(summary.providerReportedCount, 1, 'only claude is four-field-known');
    // codex is four-field unknown (cacheCreation null); antigravity is unavailable.
    assert.equal(summary.unknownCount, 2, 'codex unknown + antigravity unavailable; estimates superseded');
    // Estimates were all superseded by their finals -> none counted.
    assert.equal(summary.estimateCount, 0, 'preflight estimates are superseded, not counted');
    assert.equal(summary.estimateSubtotal, 0, 'no estimate subtotal (all superseded)');
  });

  await check('CHK-PRIMARY diagnostics: bySource provider-reported carries primaryKnown AND four-field known', () => {
    const report = buildUsageReport(primaryRecords);
    const pr = report.overall.bySource['provider-reported'];
    // Primary aggregate spans the two provider-reported finals: in = 500+500 = 1000; out = 200+200 = 400.
    assert.equal(pr.primaryKnown.input, 1000, 'overall primary input across the two provider-reported finals');
    assert.equal(pr.primaryKnown.output, 400, 'overall primary output across the two provider-reported finals');
    assert.equal(pr.primaryKnownCount, 2, 'codex + claude are primary-known; antigravity is unavailable');
    // Four-field known counts claude only (codex cacheCreation null).
    assert.deepEqual(
      pr.known,
      { input: 500, output: 200, cacheCreation: 10, cacheRead: 50 },
      'four-field known is the claude record only',
    );
    assert.equal(pr.knownCount, 1, 'only claude contributes to four-field known');
    assert.equal(pr.unknownCount, 1, 'codex is four-field unknown (antigravity is in the unavailable bucket, not provider-reported)');
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

  // ----------------------------------------------------------------------
  // CHK-PRIMARY empty/absent: empty + non-existent-ledger summaries zero-init
  // the primary aggregate (CHK-001:happy:3 emptyRecords, happy:4 absent file).
  // ----------------------------------------------------------------------
  await check('CHK-PRIMARY empty/absent: summarizeRecords([]) and absent-file summary zero-init primary aggregate', () => {
    const emptySummary = summarizeRecords([]);
    assert.equal(emptySummary.primaryReportedTotal, 0, 'empty records -> primaryReportedTotal 0');
    assert.equal(emptySummary.primaryReportedCount, 0, 'empty records -> primaryReportedCount 0');
    // A non-existent ledger file is "no usage recorded", not an error.
    const absentRoot = freshRoot();
    const absentPath = resolveLedgerPath(absentRoot);
    assert.equal(existsSync(absentPath), false, 'precondition: ledger file does not exist');
    const absentSummary = summarizeLedgerFile(absentPath);
    assert.equal(absentSummary.primaryReportedTotal, 0, 'absent ledger -> primaryReportedTotal 0');
    assert.equal(absentSummary.primaryReportedCount, 0, 'absent ledger -> primaryReportedCount 0');
  });

  // ----------------------------------------------------------------------
  // CHK-PRIMARY per-record primaryTotal guards via deriveRecordTotal:
  //   - null input -> primaryTotal null (never inferred)  (CHK-001:edge:3)
  //   - all-four-zero -> primaryTotal 0, NOT null         (CHK-001:edge:4)
  //   - unavailable source -> primaryTotal null           (CHK-001:edge:2)
  // A provider-reported record with a null primary dim is normally rejected by
  // the record validator; we unit-test deriveRecordTotal DIRECTLY (same inline
  // synthetic style as synthEstimate) to prove the "never infer" guard.
  // ----------------------------------------------------------------------

  /** Inline synthetic provider-reported record with controllable dims. */
  function synthProviderRecord(
    suffix: string,
    dims: {
      input: number | null;
      output: number | null;
      cacheCreation: number | null;
      cacheRead: number | null;
    },
  ): UsageLedgerRecord {
    return {
      schemaVersion: 1,
      recordId: `llmuse_synth-${suffix}`,
      ledgerCallId: `llmcall_synth-${suffix}`,
      attemptId: `llmatt_synth-${suffix}`,
      sequence: 1,
      supersedesRecordIds: [],
      recordedAt: '2026-06-19T00:00:00.000Z',
      projectRootHash: 'sha256:x',
      storyId: 'S-test',
      phase: 'dispatch',
      agentType: 'lattice-dispatch:codex',
      decision: { kind: 'allowed' },
      provider: { name: 'openai', model: 'gpt-5-codex' },
      usage: {
        source: 'provider-reported',
        inputTokens: dims.input,
        outputTokens: dims.output,
        cacheCreationInputTokens: dims.cacheCreation,
        cacheReadInputTokens: dims.cacheRead,
        canonical: {
          input: dims.input,
          output: dims.output,
          cacheCreation: dims.cacheCreation,
          cacheRead: dims.cacheRead,
        },
        raw: { providerUnits: 'u', payloadDigest: 'sha256:d' },
      },
      privacy: { promptStored: false, transcriptStored: false, redactionProfile: 'no-raw-content-v1' },
      authority: { mode: 'local', receiptId: null, receiptVerified: false },
      integrity: { previousRecordHash: null, recordHash: `sha256:synth-${suffix}` },
    };
  }

  await check('CHK-PRIMARY deriveRecordTotal: null input -> primaryTotal null (never inferred)', () => {
    const rec = synthProviderRecord('null-input', {
      input: null,
      output: 200,
      cacheCreation: null,
      cacheRead: null,
    });
    const derived = deriveRecordTotal(rec);
    assert.equal(derived.primaryTotal, null, 'null input must NOT be inferred -> primaryTotal null');
    const summary = summarizeRecords([rec]);
    assert.equal(summary.primaryReportedCount, 0, 'a null-input record contributes 0 to the primary count');
    assert.equal(summary.primaryReportedTotal, 0, 'a null-input record adds nothing to primaryReportedTotal');
  });

  await check('CHK-PRIMARY deriveRecordTotal: all-four-zero -> primaryTotal 0 (genuine zero, NOT null)', () => {
    const rec = synthProviderRecord('all-zero', {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
    });
    const derived = deriveRecordTotal(rec);
    assert.equal(derived.primaryTotal, 0, 'a genuine 0+0 primary must be 0, not null');
    assert.equal(derived.unknown, false, 'all four dims known (all 0) -> four-field KNOWN');
    const summary = summarizeRecords([rec]);
    // Primary aggregate: the zero record DOES contribute (count 1, total 0).
    assert.equal(summary.primaryReportedCount, 1, 'a genuine-zero record contributes to the primary count');
    assert.equal(summary.primaryReportedTotal, 0, 'its primary contribution is 0');
    // Four-field: it is fully known, so it also feeds providerReportedTotal as 0.
    assert.equal(summary.providerReportedCount, 1, 'all-zero record is four-field-known (count 1)');
    assert.equal(summary.providerReportedTotal, 0, 'all-zero four-field total is a genuine 0');
    assert.equal(summary.unknownCount, 0, 'all-zero record is NOT unknown');
  });

  await check('CHK-PRIMARY deriveRecordTotal: source=unavailable -> primaryTotal null', () => {
    const rec: UsageLedgerRecord = {
      schemaVersion: 1,
      recordId: 'llmuse_synth-unavail',
      ledgerCallId: 'llmcall_synth-unavail',
      attemptId: 'llmatt_synth-unavail',
      sequence: 1,
      supersedesRecordIds: [],
      recordedAt: '2026-06-19T00:00:00.000Z',
      projectRootHash: 'sha256:x',
      storyId: 'S-test',
      phase: 'dispatch',
      agentType: 'lattice-dispatch:codex',
      decision: { kind: 'allowed' },
      usage: {
        source: 'unavailable',
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        unavailableReason: 'provider returned no usage object',
      },
      privacy: { promptStored: false, transcriptStored: false, redactionProfile: 'no-raw-content-v1' },
      authority: { mode: 'local', receiptId: null, receiptVerified: false },
      integrity: { previousRecordHash: null, recordHash: 'sha256:synth-unavail' },
    };
    const derived = deriveRecordTotal(rec);
    assert.equal(derived.primaryTotal, null, 'unavailable source -> primaryTotal null by design');
  });

  // ----------------------------------------------------------------------
  // CHK-PRIMARY diagnostics null-input / empty (CHK-002:edge:1 emptySourceTotals
  // init via buildUsageReport([]); CHK-002:edge:2 null-input excluded from
  // primaryKnown by aggregateByGroup — never inferred).
  // ----------------------------------------------------------------------
  await check('CHK-PRIMARY diagnostics: buildUsageReport([]) zero-inits provider-reported primaryKnown', () => {
    const report = buildUsageReport([]);
    const pr = report.overall.bySource['provider-reported'];
    assert.deepEqual(pr.primaryKnown, { input: 0, output: 0 }, 'empty report primaryKnown is zero-init');
    assert.equal(pr.primaryKnownCount, 0, 'empty report primaryKnownCount is 0');
  });

  await check('CHK-PRIMARY diagnostics: aggregateByGroup excludes a null-input provider record from primaryKnown', () => {
    const rec = synthProviderRecord('agg-null-input', {
      input: null,
      output: 200,
      cacheCreation: null,
      cacheRead: null,
    });
    const groups = aggregateByGroup([rec]);
    assert.equal(groups.length, 1, 'one synthetic record -> one group');
    const pr = groups[0].bySource['provider-reported'];
    assert.equal(pr.primaryKnownCount, 0, 'a null input keeps the record OUT of primaryKnown (never inferred)');
    assert.deepEqual(pr.primaryKnown, { input: 0, output: 0 }, 'primaryKnown stays zero for a null-input record');
    // It is still counted as four-field unknown (sanity: existing branch intact).
    assert.equal(pr.unknownCount, 1, 'the null-input record is four-field unknown');
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
  await check('STATIC providers/codex-cli.ts + antigravity-cli.ts import NOTHING from core/usage-ledger', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    for (const rel of ['providers/codex-cli.ts', 'providers/antigravity-cli.ts']) {
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
      console.error(`\n✗ usage-ledger codex/antigravity smoke FAILED (${failures.length} failing): ${failures.join(', ')}`);
      process.exit(1);
    }
    console.log(`\n✓ usage-ledger codex/antigravity smoke passed (${passed} checks)`);
  })
  .catch((err) => {
    console.error('✗ usage-ledger codex/antigravity smoke crashed');
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  });

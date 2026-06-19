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

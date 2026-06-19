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
  // CHK-003 (B-fe1f): token-only projection — an extra non-token key on the
  // matched usage object is DROPPED, while the cache-detail buckets survive.
  // ======================================================================
  await check('CHK-003 codex: extra non-token key (transcript) is dropped by projection', () => {
    const stdout = JSON.stringify({
      type: 'result',
      model: 'gpt-5-codex',
      usage: { prompt_tokens: 100, completion_tokens: 50, transcript: 'secret' },
    });
    const result = runBoundedCodexProvider(
      { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage, 'expected a projected usage object');
    assert.equal(result.reportedUsage?.prompt_tokens, 100);
    assert.equal(result.reportedUsage?.completion_tokens, 50);
    assert.ok(
      !('transcript' in result.reportedUsage!),
      'the non-token "transcript" key must be absent after projection',
    );
    // ONLY the two whitelisted token keys survive (no cache field present here).
    assert.deepEqual(Object.keys(result.reportedUsage!).sort(), ['completion_tokens', 'prompt_tokens']);
    assertNoTranscriptText(result.reportedUsage);
  });

  await check('CHK-003 codex: cache field (prompt_tokens_details) survives projection', () => {
    const stdout = JSON.stringify({
      type: 'result',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 30 },
        transcript: 'secret',
      },
    });
    const result = runBoundedCodexProvider(
      { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage);
    assert.ok(!('transcript' in result.reportedUsage!), 'transcript must be dropped');
    // prompt_tokens_details values preserved so cacheRead survives end-to-end, but
    // the nested object is re-copied into a NULL-prototype object (B-fe1f hardening),
    // so compare OWN keys/values + assert the null prototype rather than deepEqual
    // against a plain `{}` (deepEqual distinguishes the prototype).
    const details = result.reportedUsage!.prompt_tokens_details as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(details), null, 'nested prompt_tokens_details must be null-proto');
    assert.deepEqual(Object.keys(details), ['cached_tokens'], 'only the own cached_tokens key survives');
    assert.equal(details.cached_tokens, 30, 'cached_tokens value preserved verbatim');
    assertNoTranscriptText(result.reportedUsage);
  });

  await check('CHK-003 gemini: extra non-token key (transcript) is dropped by projection', () => {
    const stdout = JSON.stringify({
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, transcript: 'secret' },
    });
    const result = runBoundedGeminiProvider(
      { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage, 'expected a projected usage object');
    assert.equal(result.reportedUsage?.promptTokenCount, 100);
    assert.equal(result.reportedUsage?.candidatesTokenCount, 50);
    assert.ok(
      !('transcript' in result.reportedUsage!),
      'the non-token "transcript" key must be absent after projection',
    );
    assert.deepEqual(
      Object.keys(result.reportedUsage!).sort(),
      ['candidatesTokenCount', 'promptTokenCount'],
    );
    assertNoTranscriptText(result.reportedUsage);
  });

  await check('CHK-003 gemini: cache field (cachedContentTokenCount) survives projection', () => {
    const stdout = JSON.stringify({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 30,
        transcript: 'secret',
      },
    });
    const result = runBoundedGeminiProvider(
      { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage);
    assert.ok(!('transcript' in result.reportedUsage!), 'transcript must be dropped');
    // cachedContentTokenCount preserved verbatim so cacheRead survives end-to-end.
    assert.equal(result.reportedUsage?.cachedContentTokenCount, 30);
    assertNoTranscriptText(result.reportedUsage);
  });

  // ======================================================================
  // CHK-001 adversarial/edge (B-fe1f): the whitelist projection rejects rogue
  // keys (prototype-pollution vectors, key floods, mixed-type extras) and
  // handles the nested-path + extra-key combination. Driven through the bounded
  // runners so we exercise extractCodexUsage / extractGeminiUsage as shipped.
  // ======================================================================

  // F-001 (CHK-001:adversarial:0): a usage object carrying __proto__/constructor
  // alongside valid token keys yields ONLY whitelisted token keys; no own
  // __proto__/constructor leaks through and no prototype pollution occurs.
  await check('CHK-001 adversarial:0 codex: __proto__/constructor keys dropped, no prototype pollution', () => {
    // JSON text with a literal "__proto__"/"constructor" key parses them as OWN
    // enumerable props (JSON.parse never walks the prototype), so the whitelist
    // is what must drop them — not JSON.parse.
    const stdout = JSON.stringify({
      type: 'result',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        __proto__: { polluted: true },
        constructor: { polluted: true },
        evil: 'transcript',
      },
    });
    const result = runBoundedCodexProvider(
      { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage, 'expected a projected usage object');
    const usage = result.reportedUsage!;
    assert.equal(usage.prompt_tokens, 100);
    assert.equal(usage.completion_tokens, 50);
    // Only whitelisted token keys are OWN keys; no rogue key survives.
    assert.deepEqual(Object.keys(usage).sort(), ['completion_tokens', 'prompt_tokens']);
    assert.ok(!Object.prototype.hasOwnProperty.call(usage, '__proto__'), 'no OWN __proto__ key on result');
    assert.ok(!Object.prototype.hasOwnProperty.call(usage, 'constructor'), 'no OWN constructor key on result');
    assert.ok(!Object.prototype.hasOwnProperty.call(usage, 'evil'), 'no OWN evil key on result');
    // Global prototype was NOT polluted by parsing/projecting the rogue object.
    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype must not be polluted');
    assertNoTranscriptText(usage);
  });

  await check('CHK-001 adversarial:0 gemini: __proto__/constructor keys dropped, no prototype pollution', () => {
    const stdout = JSON.stringify({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        __proto__: { polluted: true },
        constructor: { polluted: true },
        evil: 'transcript',
      },
    });
    const result = runBoundedGeminiProvider(
      { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage, 'expected a projected usage object');
    const usage = result.reportedUsage!;
    assert.equal(usage.promptTokenCount, 100);
    assert.equal(usage.candidatesTokenCount, 50);
    assert.deepEqual(Object.keys(usage).sort(), ['candidatesTokenCount', 'promptTokenCount']);
    assert.ok(!Object.prototype.hasOwnProperty.call(usage, '__proto__'), 'no OWN __proto__ key on result');
    assert.ok(!Object.prototype.hasOwnProperty.call(usage, 'constructor'), 'no OWN constructor key on result');
    assert.ok(!Object.prototype.hasOwnProperty.call(usage, 'evil'), 'no OWN evil key on result');
    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype must not be polluted');
    assertNoTranscriptText(usage);
  });

  // F-002 (CHK-001:adversarial:1): a 50+ extra-key flood alongside valid token
  // keys still projects to EXACTLY the present whitelist subset.
  await check('CHK-001 adversarial:1 codex: 50+ extra keys flood -> only whitelisted token keys survive', () => {
    const noise: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) noise[`junk_${i}`] = `payload-${i}`;
    const stdout = JSON.stringify({
      type: 'result',
      usage: { prompt_tokens: 100, completion_tokens: 50, ...noise },
    });
    const result = runBoundedCodexProvider(
      { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage, 'expected a projected usage object');
    assert.deepEqual(
      Object.keys(result.reportedUsage!).sort(),
      ['completion_tokens', 'prompt_tokens'],
      'exactly the present whitelist subset survives a 60-key flood',
    );
    assertNoTranscriptText(result.reportedUsage);
  });

  await check('CHK-001 adversarial:1 gemini: 50+ extra keys flood -> only whitelisted token keys survive', () => {
    const noise: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) noise[`junk_${i}`] = `payload-${i}`;
    const stdout = JSON.stringify({
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, ...noise },
    });
    const result = runBoundedGeminiProvider(
      { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage, 'expected a projected usage object');
    assert.deepEqual(
      Object.keys(result.reportedUsage!).sort(),
      ['candidatesTokenCount', 'promptTokenCount'],
      'exactly the present whitelist subset survives a 60-key flood',
    );
    assertNoTranscriptText(result.reportedUsage);
  });

  // F-003 (CHK-001:edge:1): extra keys of VARIOUS types (string, nested object,
  // array, boolean) are all dropped; only token keys remain.
  await check('CHK-001 edge:1 codex: mixed-type extra keys (string/object/array/boolean) all dropped', () => {
    const stdout = JSON.stringify({
      type: 'result',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        str_extra: 'transcript',
        obj_extra: { nested: 'secret' },
        arr_extra: [1, 2, 3],
        bool_extra: true,
      },
    });
    const result = runBoundedCodexProvider(
      { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage, 'expected a projected usage object');
    assert.deepEqual(
      Object.keys(result.reportedUsage!).sort(),
      ['completion_tokens', 'prompt_tokens'],
      'all mixed-type extras dropped; only token keys remain',
    );
    assertNoTranscriptText(result.reportedUsage);
  });

  // F-004 (CHK-001:edge:2): gemini usageMetadata nested under `response` AND
  // carrying an extra non-token key -> nested path handled + extra key dropped.
  await check('CHK-001 edge:2 gemini: nested-under-response usageMetadata + extra key -> token-only projection', () => {
    const stdout = JSON.stringify({
      response: {
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        usageMetadata: {
          promptTokenCount: 800,
          candidatesTokenCount: 120,
          cachedContentTokenCount: 40,
          transcript: 'secret',
        },
      },
    });
    const result = runBoundedGeminiProvider(
      { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage, 'expected a projected usage object from the nested path');
    assert.equal(result.reportedUsage?.promptTokenCount, 800);
    assert.equal(result.reportedUsage?.candidatesTokenCount, 120);
    assert.equal(result.reportedUsage?.cachedContentTokenCount, 40);
    assert.ok(!('transcript' in result.reportedUsage!), 'the extra non-token key must be dropped');
    assert.deepEqual(
      Object.keys(result.reportedUsage!).sort(),
      ['cachedContentTokenCount', 'candidatesTokenCount', 'promptTokenCount'],
      'nested path projects to the present whitelist subset, extra key dropped',
    );
    assertNoTranscriptText(result.reportedUsage);
  });

  // F-006 (CHK-001:edge:0): a usage object matching isCodexUsageObject via ONLY
  // prompt_tokens_details (no prompt_tokens/completion_tokens) projects to EXACTLY
  // {prompt_tokens_details} — the minimal valid projected object; no token-count
  // key is invented and no other key leaks in.
  await check('CHK-001 edge:0 codex: usage with ONLY prompt_tokens_details -> minimal projected object {prompt_tokens_details}', () => {
    const stdout = JSON.stringify({
      type: 'result',
      usage: { prompt_tokens_details: { cached_tokens: 30 } },
    });
    const result = runBoundedCodexProvider(
      { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage, 'expected a minimal projected usage object');
    // EXACTLY the one detail bucket survives — no prompt_tokens/completion_tokens invented.
    assert.deepEqual(
      Object.keys(result.reportedUsage!),
      ['prompt_tokens_details'],
      'minimal valid projection is exactly {prompt_tokens_details}, no token-count key invented',
    );
    // Nested details is null-proto (B-fe1f hardening): compare own keys/values +
    // prototype rather than deepEqual against a plain `{}`.
    const details = result.reportedUsage!.prompt_tokens_details as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(details), null, 'nested prompt_tokens_details must be null-proto');
    assert.deepEqual(Object.keys(details), ['cached_tokens'], 'only the own cached_tokens key survives');
    assert.equal(details.cached_tokens, 30, 'cached_tokens value preserved verbatim');
    assertNoTranscriptText(result.reportedUsage);
  });

  // F-007 (CHK-001:adversarial:2): projection is by KEY NAME, not value type. A
  // token-count key carrying a NON-NUMERIC value (e.g. promptTokenCount:'abc') is
  // STILL included verbatim — value-validation is the adapter/buildProviderRecord's
  // job, not the extractor's. (assertNoTranscriptText is NOT applied here: this
  // intentionally documents that a string value survives the extractor stage.)
  await check('CHK-001 adversarial:2 gemini: non-numeric token value is projected verbatim (projection by key name, not value type)', () => {
    const stdout = JSON.stringify({
      usageMetadata: { promptTokenCount: 'abc', candidatesTokenCount: 120 },
    });
    const result = runBoundedGeminiProvider(
      { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage, 'expected a projected usage object');
    // The key is present BY NAME, with its verbatim string value (NOT coerced/dropped).
    assert.ok(
      Object.prototype.hasOwnProperty.call(result.reportedUsage!, 'promptTokenCount'),
      'a non-numeric token key must STILL be included (projection is by key name)',
    );
    assert.strictEqual(
      result.reportedUsage?.promptTokenCount,
      'abc',
      'the verbatim string value survives; value-validation is the adapter\'s job, not the extractor\'s',
    );
    assert.equal(result.reportedUsage?.candidatesTokenCount, 120);
    assert.deepEqual(
      Object.keys(result.reportedUsage!).sort(),
      ['candidatesTokenCount', 'promptTokenCount'],
    );
  });

  // F-011 (CHK-001:adversarial:3 — B-fe1f Codex host-2): a polluted
  // Object.prototype.usage / Object.prototype.usageMetadata must NEVER be read
  // off a parsed line that has NO OWN usage key. The extractors guard every
  // candidate read with an OWN-property check, so a prototype-chain read can
  // never inject bogus provider token counts. We pollute the prototype inside a
  // try and ALWAYS delete it in finally so no pollution leaks into other checks.
  await check('CHK-001 adversarial:3 codex: polluted Object.prototype.usage NOT read on a line with no own usage -> reportedUsage undefined', () => {
    Object.defineProperty(Object.prototype, 'usage', {
      configurable: true,
      enumerable: false,
      value: { prompt_tokens: 111, completion_tokens: 22 },
    });
    try {
      // Precondition: the pollution IS visible via the prototype chain.
      assert.deepEqual(
        ({} as Record<string, unknown>).usage,
        { prompt_tokens: 111, completion_tokens: 22 },
        'precondition: Object.prototype.usage is polluted and visible via the chain',
      );
      // A parsed line with NO own usage key (own keys: foo only / response only).
      for (const stdout of [JSON.stringify({ foo: 1 }), JSON.stringify({ response: { candidates: [] } })]) {
        const result = runBoundedCodexProvider(
          { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
          fakeRunner(stdout),
        );
        assert.equal(
          result.reportedUsage,
          undefined,
          `the polluted prototype usage must NOT be accepted for stdout: ${stdout}`,
        );
      }
      // Sanity: a line with a real OWN usage key still resolves correctly.
      const ok = runBoundedCodexProvider(
        { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
        fakeRunner(JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 3 } })),
      );
      assert.equal(ok.reportedUsage?.prompt_tokens, 7, 'a legitimate OWN usage key still works under pollution');
    } finally {
      delete (Object.prototype as Record<string, unknown>).usage;
    }
    // Post: the global prototype is clean again (no test pollution leaked).
    assert.equal(({} as Record<string, unknown>).usage, undefined, 'Object.prototype.usage restored after the check');
  });

  await check('CHK-001 adversarial:3 gemini: polluted Object.prototype.usageMetadata NOT read on a line with no own usageMetadata -> reportedUsage undefined', () => {
    Object.defineProperty(Object.prototype, 'usageMetadata', {
      configurable: true,
      enumerable: false,
      value: { promptTokenCount: 111, candidatesTokenCount: 22 },
    });
    try {
      assert.deepEqual(
        ({} as Record<string, unknown>).usageMetadata,
        { promptTokenCount: 111, candidatesTokenCount: 22 },
        'precondition: Object.prototype.usageMetadata is polluted and visible via the chain',
      );
      // Lines with NO own usageMetadata key (own keys: foo only / response with no own usageMetadata).
      for (const stdout of [JSON.stringify({ foo: 1 }), JSON.stringify({ response: { candidates: [] } })]) {
        const result = runBoundedGeminiProvider(
          { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
          fakeRunner(stdout),
        );
        assert.equal(
          result.reportedUsage,
          undefined,
          `the polluted prototype usageMetadata must NOT be accepted for stdout: ${stdout}`,
        );
      }
      // Sanity: a line with a real OWN usageMetadata key still resolves correctly.
      const ok = runBoundedGeminiProvider(
        { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
        fakeRunner(JSON.stringify({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } })),
      );
      assert.equal(ok.reportedUsage?.promptTokenCount, 7, 'a legitimate OWN usageMetadata key still works under pollution');
    } finally {
      delete (Object.prototype as Record<string, unknown>).usageMetadata;
    }
    assert.equal(
      ({} as Record<string, unknown>).usageMetadata,
      undefined,
      'Object.prototype.usageMetadata restored after the check',
    );
  });

  // F-012 (CHK-001:adversarial:4 — B-fe1f Codex host-2 deeper repro): the
  // PROJECTED usage object must NOT inherit a polluted Object.prototype token
  // key. The pick helper builds a NULL-prototype object, so a downstream adapter
  // reading a key the source did NOT carry (e.g. adaptOpenAiUsage reading
  // usage.prompt_tokens when only completion_tokens was present) resolves to
  // `undefined`, NOT the inherited Object.prototype.prompt_tokens. We drive the
  // FULL path (runBounded -> recordDispatchFinalForProvider -> ledger) and assert
  // the written final has NO inputTokens=111: with prompt_tokens absent (not
  // inherited) the adapter cannot build a four-field record, so the final is
  // 'unavailable', NEVER a provider-reported with bogus inputTokens=111. Pollute
  // inside try (configurable:true) and ALWAYS restore in finally.
  await check('CHK-001 adversarial:4 codex: projected usage does NOT inherit polluted Object.prototype.prompt_tokens -> unavailable final (no inputTokens=111)', () => {
    Object.defineProperty(Object.prototype, 'prompt_tokens', {
      configurable: true,
      enumerable: false,
      value: 111,
    });
    try {
      // Precondition: a NORMAL {} inherits the polluted prompt_tokens via the chain.
      assert.equal(
        ({} as Record<string, unknown>).prompt_tokens,
        111,
        'precondition: Object.prototype.prompt_tokens is polluted and visible on a normal {}',
      );
      // Run the FULL extractor path with stdout carrying ONLY own completion_tokens.
      const result = runBoundedCodexProvider(
        { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
        fakeRunner(JSON.stringify({ usage: { completion_tokens: 5 } })),
      );
      assert.ok(result.reportedUsage, 'a usage object was matched (own completion_tokens present)');
      // The projected object is null-proto: reading the un-projected key is undefined,
      // NOT the inherited 111. THIS is the assertion that catches the deeper bug.
      assert.equal(
        (result.reportedUsage as Record<string, unknown>).prompt_tokens,
        undefined,
        'projected usage must NOT inherit Object.prototype.prompt_tokens (null-proto result)',
      );
      assert.equal(
        Object.getPrototypeOf(result.reportedUsage as object),
        null,
        'projected usage must have a null prototype',
      );
      // Drive it into the ledger via the openai adapter and inspect the written final.
      const sub = freshRoot();
      const handle = recordDispatchPreflight(sub, ctx(), 'prompt', opts(ON));
      assert.ok(handle);
      recordDispatchFinalForProvider(
        sub,
        ctx(),
        handle!.correlation,
        handle!.estimateRecordId,
        'openai',
        result.reportedUsage,
        'gpt-5-codex',
        opts(ON),
      );
      const records = readLedger(sub);
      const final = records.find((r) => r.usage.source !== 'prompt-size-estimate');
      assert.ok(final, 'expected a final superseding the estimate');
      assert.notEqual(
        final?.usage.inputTokens,
        111,
        'the final must NOT carry the inherited bogus inputTokens=111',
      );
      // input absent (prompt_tokens not inherited) -> adapter cannot build a
      // provider-reported record -> the final is an 'unavailable' one.
      assert.equal(
        final?.usage.source,
        'unavailable',
        'with prompt_tokens un-inherited the final must be unavailable, not provider-reported',
      );
      assert.equal(
        records.filter((r) => r.usage.source === 'provider-reported').length,
        0,
        'no provider-reported final may be written from an inherited prototype key',
      );
    } finally {
      delete (Object.prototype as Record<string, unknown>).prompt_tokens;
    }
    assert.equal(
      ({} as Record<string, unknown>).prompt_tokens,
      undefined,
      'Object.prototype.prompt_tokens restored after the check',
    );
  });

  await check('CHK-001 adversarial:4 gemini: projected usage does NOT inherit polluted Object.prototype.promptTokenCount -> unavailable final (no inputTokens=222)', () => {
    Object.defineProperty(Object.prototype, 'promptTokenCount', {
      configurable: true,
      enumerable: false,
      value: 222,
    });
    try {
      assert.equal(
        ({} as Record<string, unknown>).promptTokenCount,
        222,
        'precondition: Object.prototype.promptTokenCount is polluted and visible on a normal {}',
      );
      const result = runBoundedGeminiProvider(
        { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
        fakeRunner(JSON.stringify({ usageMetadata: { candidatesTokenCount: 6 } })),
      );
      assert.ok(result.reportedUsage, 'a usage object was matched (own candidatesTokenCount present)');
      assert.equal(
        (result.reportedUsage as Record<string, unknown>).promptTokenCount,
        undefined,
        'projected usage must NOT inherit Object.prototype.promptTokenCount (null-proto result)',
      );
      assert.equal(
        Object.getPrototypeOf(result.reportedUsage as object),
        null,
        'projected usage must have a null prototype',
      );
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
        result.reportedUsage,
        'gemini-2.5-pro',
        opts(ON),
      );
      const records = readLedger(sub);
      const final = records.find((r) => r.usage.source !== 'prompt-size-estimate');
      assert.ok(final, 'expected a final superseding the estimate');
      assert.notEqual(
        final?.usage.inputTokens,
        222,
        'the final must NOT carry the inherited bogus inputTokens=222',
      );
      assert.equal(
        final?.usage.source,
        'unavailable',
        'with promptTokenCount un-inherited the final must be unavailable, not provider-reported',
      );
      assert.equal(
        records.filter((r) => r.usage.source === 'provider-reported').length,
        0,
        'no provider-reported final may be written from an inherited prototype key',
      );
    } finally {
      delete (Object.prototype as Record<string, unknown>).promptTokenCount;
    }
    assert.equal(
      ({} as Record<string, unknown>).promptTokenCount,
      undefined,
      'Object.prototype.promptTokenCount restored after the check',
    );
  });

  // F-013 (CHK-001:adversarial:5 — B-fe1f Codex MAJOR, NESTED vector): the
  // NESTED prompt_tokens_details object must ALSO be null-prototype, not just the
  // top-level usage. The OpenAI adapter reads cacheRead via
  // `'cached_tokens' in prompt_tokens_details` (a prototype-chain `in`), so a
  // polluted Object.prototype.cached_tokens leaks into cacheReadInputTokens when
  // details carries Object.prototype (e.g. an empty `{}` with no OWN cached_tokens).
  // We pollute Object.prototype.cached_tokens=777 inside a try (configurable:true),
  // run the FULL extractor path with stdout usage that carries an EMPTY
  // prompt_tokens_details (no own cached_tokens), drive it through the openai
  // adapter into a ledger, and assert the written final's cacheReadInputTokens is
  // NOT 777 (it must be null/absent: the provider did not report it). Also assert
  // the projected prompt_tokens_details is itself null-proto. Restore in finally.
  await check('CHK-001 adversarial:5 codex: nested prompt_tokens_details is null-proto -> adapter cacheRead cannot inherit polluted cached_tokens=777', () => {
    Object.defineProperty(Object.prototype, 'cached_tokens', {
      configurable: true,
      enumerable: false,
      value: 777,
    });
    try {
      // Precondition: a NORMAL {} inherits the polluted cached_tokens via the chain,
      // AND a chain-walking `in` sees it (this is exactly how the adapter reads it).
      assert.equal(
        ({} as Record<string, unknown>).cached_tokens,
        777,
        'precondition: Object.prototype.cached_tokens is polluted and visible on a normal {}',
      );
      assert.ok('cached_tokens' in ({} as Record<string, unknown>), 'precondition: `in` resolves it via the chain');
      // Run the FULL extractor path with an EMPTY prompt_tokens_details (no own
      // cached_tokens) alongside real top-level token counts.
      const result = runBoundedCodexProvider(
        { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
        fakeRunner(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: {} } })),
      );
      assert.ok(result.reportedUsage, 'a usage object was matched (own token keys present)');
      // The NESTED details object must itself be null-proto so the adapter's
      // `'cached_tokens' in details` cannot resolve the inherited key.
      assert.equal(
        Object.getPrototypeOf(result.reportedUsage!.prompt_tokens_details as object),
        null,
        'projected prompt_tokens_details must have a null prototype',
      );
      assert.ok(
        !('cached_tokens' in (result.reportedUsage!.prompt_tokens_details as Record<string, unknown>)),
        'null-proto details: `in` must NOT resolve the polluted cached_tokens',
      );
      // Drive it into the ledger via the openai adapter and inspect the written final.
      const sub = freshRoot();
      const handle = recordDispatchPreflight(sub, ctx(), 'prompt', opts(ON));
      assert.ok(handle);
      recordDispatchFinalForProvider(
        sub,
        ctx(),
        handle!.correlation,
        handle!.estimateRecordId,
        'openai',
        result.reportedUsage,
        'gpt-5-codex',
        opts(ON),
      );
      const records = readLedger(sub);
      const final = records.find((r) => r.usage.source !== 'prompt-size-estimate');
      assert.ok(final, 'expected a final superseding the estimate');
      // THE assertion that catches the nested bug: cacheRead must NOT be the
      // inherited 777 — the provider reported NO cached_tokens, so it is null/absent.
      assert.notEqual(
        final?.usage.cacheReadInputTokens,
        777,
        'the final must NOT carry the inherited bogus cacheReadInputTokens=777',
      );
      assert.equal(
        final?.usage.cacheReadInputTokens ?? null,
        null,
        'with no own cached_tokens the adapter must record cacheRead as null (per-dimension absence)',
      );
    } finally {
      delete (Object.prototype as Record<string, unknown>).cached_tokens;
    }
    assert.equal(
      ({} as Record<string, unknown>).cached_tokens,
      undefined,
      'Object.prototype.cached_tokens restored after the check',
    );
  });

  // F-001 (B-30c3 Codex host-2): the NESTED prompt_tokens_details projection must
  // WHITELIST only cached_tokens (the single key the OpenAI adapter reads). A
  // details object carrying {cached_tokens, transcript} must surface ONLY
  // cached_tokens — the non-token transcript must NOT ride along on reportedUsage
  // (token-only projection contract holds at the nested level too). The projected
  // details must be null-proto, and cacheRead must still resolve from cached_tokens.
  await check('CHK-001 F-001 codex: nested prompt_tokens_details drops non-token key (transcript), keeps only cached_tokens', () => {
    const stdout = JSON.stringify({
      type: 'result',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 5, transcript: 'secret' },
      },
    });
    const result = runBoundedCodexProvider(
      { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
      fakeRunner(stdout),
    );
    assert.ok(result.reportedUsage, 'expected a projected usage object');
    const details = result.reportedUsage!.prompt_tokens_details as Record<string, unknown>;
    // ONLY cached_tokens survives; the non-token transcript is dropped.
    assert.equal(Object.getPrototypeOf(details), null, 'nested prompt_tokens_details must be null-proto');
    assert.deepEqual(Object.keys(details), ['cached_tokens'], 'only the own cached_tokens key survives');
    assert.equal(Object.keys(details).length, 1, 'exactly one nested key survives');
    assert.equal(details.cached_tokens, 5, 'cached_tokens value preserved verbatim');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(details, 'transcript'),
      'the non-token "transcript" key must NOT survive the nested projection',
    );
    assertNoTranscriptText(result.reportedUsage);
    // cacheRead still resolves end-to-end (cached_tokens preserved) via the openai adapter.
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'prompt', opts(ON));
    assert.ok(handle);
    recordDispatchFinalForProvider(
      sub,
      ctx(),
      handle!.correlation,
      handle!.estimateRecordId,
      'openai',
      result.reportedUsage,
      'gpt-5-codex',
      opts(ON),
    );
    const final = readLedger(sub).find((r) => r.usage.source === 'provider-reported');
    assert.ok(final, 'expected a provider-reported final');
    assert.equal(final?.usage.cacheReadInputTokens, 5, 'cacheRead resolves from the preserved cached_tokens');
  });

  // F-002 (B-30c3 Codex host-2): the usage-shape predicates use OWN-property
  // guards, NOT prototype-chain `in`. Under Object.prototype pollution an empty
  // {} (no own token key) must NOT match as a usage object — otherwise the
  // extractor selects it (returning an empty projection) BEFORE a later line that
  // carries a REAL usage object. Pollute inside a try and ALWAYS restore in finally.
  await check('CHK-001 F-002 codex: polluted Object.prototype.prompt_tokens does NOT make an empty first usage suppress a later real one', () => {
    Object.defineProperty(Object.prototype, 'prompt_tokens', {
      configurable: true,
      enumerable: false,
      value: 999,
    });
    try {
      // Precondition: a normal {} sees the polluted key via the chain (NOT own).
      assert.ok('prompt_tokens' in ({} as Record<string, unknown>), 'precondition: `in` resolves it via the chain');
      assert.ok(
        !Object.prototype.hasOwnProperty.call({}, 'prompt_tokens'),
        'precondition: it is NOT an own key on {}',
      );
      // First line: an EMPTY usage object (no own token key). Second line: a REAL one.
      const stdout = JSON.stringify({ usage: {} }) + '\n'
        + JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2 } });
      const result = runBoundedCodexProvider(
        { provider: 'codex', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
        fakeRunner(stdout),
      );
      assert.ok(result.reportedUsage, 'expected the REAL usage object, not an empty first match');
      assert.equal(result.reportedUsage?.prompt_tokens, 10, 'must select the later real prompt_tokens=10');
      assert.equal(result.reportedUsage?.completion_tokens, 2, 'must select the later real completion_tokens=2');
    } finally {
      delete (Object.prototype as Record<string, unknown>).prompt_tokens;
    }
    assert.equal(
      ({} as Record<string, unknown>).prompt_tokens,
      undefined,
      'Object.prototype.prompt_tokens restored after the check',
    );
  });

  await check('CHK-001 F-002 gemini: polluted Object.prototype.promptTokenCount does NOT make an empty first usageMetadata suppress a later real one', () => {
    Object.defineProperty(Object.prototype, 'promptTokenCount', {
      configurable: true,
      enumerable: false,
      value: 999,
    });
    try {
      assert.ok('promptTokenCount' in ({} as Record<string, unknown>), 'precondition: `in` resolves it via the chain');
      assert.ok(
        !Object.prototype.hasOwnProperty.call({}, 'promptTokenCount'),
        'precondition: it is NOT an own key on {}',
      );
      const stdout = JSON.stringify({ usageMetadata: {} }) + '\n'
        + JSON.stringify({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } });
      const result = runBoundedGeminiProvider(
        { provider: 'gemini', argv: [], cwd: root, timeoutMs: 1000, maxAttempts: 1, env: process.env },
        fakeRunner(stdout),
      );
      assert.ok(result.reportedUsage, 'expected the REAL usageMetadata object, not an empty first match');
      assert.equal(result.reportedUsage?.promptTokenCount, 10, 'must select the later real promptTokenCount=10');
      assert.equal(result.reportedUsage?.candidatesTokenCount, 2, 'must select the later real candidatesTokenCount=2');
    } finally {
      delete (Object.prototype as Record<string, unknown>).promptTokenCount;
    }
    assert.equal(
      ({} as Record<string, unknown>).promptTokenCount,
      undefined,
      'Object.prototype.promptTokenCount restored after the check',
    );
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

  await check('CHK-003 (B-fe1f): malformed-but-object usage -> unavailable final that supersedes the estimate', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'prompt', opts(ON));
    assert.ok(handle);
    let threw = false;
    try {
      recordDispatchFinalForProvider(
        sub,
        ctx(),
        handle!.correlation,
        handle!.estimateRecordId,
        'openai',
        // A non-array object that FAILS buildProviderRecord validation (negative
        // token count). Previously this silently dropped the final, orphaning the
        // estimate. Now it must fall through to a single unavailable final.
        { prompt_tokens: -999, completion_tokens: 5 },
        'gpt-5-codex',
        opts(ON),
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'a malformed usage must not crash dispatch');
    const records = readLedger(sub);
    // EXACTLY one estimate + one unavailable final (no double-append, no provider-reported).
    assert.equal(records.length, 2, 'expected exactly 2 records (estimate + single unavailable final)');
    assert.equal(
      records.filter((r) => r.usage.source === 'provider-reported').length,
      0,
      'a malformed usage must NOT write a provider-reported record',
    );
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final, 'expected an unavailable final superseding the estimate');
    assert.equal(final?.sequence, 2);
    assert.deepEqual(
      final?.supersedesRecordIds,
      [handle!.estimateRecordId],
      'the unavailable final must supersede the preflight estimate',
    );
    const summary = summarizeRecords(records);
    assert.equal(summary.estimateCount, 0, 'the estimate must be superseded, not counted');
    assert.equal(summary.unknownCount, 1, 'the unavailable final is counted unknown');
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

  await check('CHK-002 adversarial:1: two malformed-but-object finals to the SAME root -> two distinct unavailable finals, chain intact, no throw', () => {
    const sub = freshRoot();
    // First preflight + a malformed-but-object usage (negative token count fails
    // buildProviderRecord validation -> falls through to ONE unavailable final).
    const a = recordDispatchPreflight(sub, ctx(), 'prompt-a', opts(ON));
    assert.ok(a);
    let threwA = false;
    try {
      recordDispatchFinalForProvider(
        sub,
        ctx(),
        a!.correlation,
        a!.estimateRecordId,
        'openai',
        { prompt_tokens: -999 },
        'gpt-5-codex',
        opts(ON),
      );
    } catch {
      threwA = true;
    }
    assert.equal(threwA, false, 'the first malformed final must not throw');
    // Second preflight + a DIFFERENT malformed-but-object usage against the SAME
    // ledger root in rapid succession.
    const b = recordDispatchPreflight(sub, ctx(), 'prompt-b', opts(ON));
    assert.ok(b);
    let threwB = false;
    try {
      recordDispatchFinalForProvider(
        sub,
        ctx(),
        b!.correlation,
        b!.estimateRecordId,
        'openai',
        { prompt_tokens: -1 },
        'gpt-5-codex',
        opts(ON),
      );
    } catch {
      threwB = true;
    }
    assert.equal(threwB, false, 'the second malformed final must not throw');

    const records = readLedger(sub);
    // 2 estimates + 2 unavailable finals = 4 records; NO provider-reported finals.
    assert.equal(records.length, 4, 'expected 4 records (2 estimates + 2 unavailable finals)');
    assert.equal(
      records.filter((r) => r.usage.source === 'provider-reported').length,
      0,
      'malformed usages must NOT write provider-reported records',
    );
    const unavailFinals = records.filter((r) => r.usage.source === 'unavailable');
    assert.equal(unavailFinals.length, 2, 'expected exactly 2 unavailable finals');
    // The two unavailable finals carry DISTINCT correlation ids (no collision).
    assert.notEqual(unavailFinals[0].ledgerCallId, unavailFinals[1].ledgerCallId, 'distinct ledgerCallId');
    assert.notEqual(unavailFinals[0].attemptId, unavailFinals[1].attemptId, 'distinct attemptId');
    assert.notEqual(unavailFinals[0].recordId, unavailFinals[1].recordId, 'distinct recordId');
    // Each unavailable final supersedes ITS OWN preflight estimate.
    assert.deepEqual(unavailFinals[0].supersedesRecordIds, [a!.estimateRecordId], 'final A supersedes estimate A');
    assert.deepEqual(unavailFinals[1].supersedesRecordIds, [b!.estimateRecordId], 'final B supersedes estimate B');
    // The hash chain validates end-to-end (no corruption from rapid writes).
    const chained = verifyLedgerChain(resolveLedgerPath(sub));
    assert.equal(chained.length, 4, 'verifyLedgerChain must accept all 4 records (no chain corruption)');
    // Both estimates were superseded; both unavailable finals counted unknown.
    const summary = summarizeRecords(records);
    assert.equal(summary.estimateCount, 0, 'both estimates superseded, not counted');
    assert.equal(summary.unknownCount, 2, 'both unavailable finals counted unknown');
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

  // F-008 (CHK-002:edge:1): a malformed-but-object usage ({prompt_tokens:-999})
  // with BOTH correlation=null AND estimateRecordId=null -> an 'unavailable' final
  // is STILL written with a freshly-minted correlation. There is no estimate to
  // supersede, so supersedesRecordIds is EMPTY.
  await check('CHK-002 edge:1: malformed usage + correlation=null + estimateRecordId=null -> unavailable final, fresh correlation, EMPTY supersedes', () => {
    const sub = freshRoot();
    let threw = false;
    try {
      recordDispatchFinalForProvider(
        sub,
        ctx(),
        null, // no correlation
        null, // no estimate to supersede
        'openai',
        { prompt_tokens: -999 }, // malformed-but-object: fails buildProviderRecord validation
        'gpt-5-codex',
        opts(ON),
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'a malformed usage with null correlation must not throw');
    const records = readLedger(sub);
    const unavail = records.filter((r) => r.usage.source === 'unavailable');
    assert.equal(unavail.length, 1, 'exactly one unavailable final must be written');
    assert.equal(
      records.filter((r) => r.usage.source === 'provider-reported').length,
      0,
      'a malformed usage must NOT write a provider-reported record',
    );
    // Fresh correlation minted (no preflight provided).
    assert.ok((unavail[0].ledgerCallId ?? '').length > 0, 'a fresh correlation must mint a non-empty ledgerCallId');
    assert.ok((unavail[0].attemptId ?? '').length > 0, 'a fresh correlation must mint a non-empty attemptId');
    // No estimate existed -> nothing to supersede.
    assert.deepEqual(unavail[0].supersedesRecordIds, [], 'no estimate to supersede -> EMPTY supersedesRecordIds');
  });

  // F-009 (CHK-002:edge:2): provider='gemini' with a malformed usage
  // ({promptTokenCount:-5}) -> an 'unavailable' final whose provider.name==='gemini'
  // that supersedes the preflight estimate (estimateCount===0); no throw.
  await check('CHK-002 edge:2 gemini: malformed gemini usage -> unavailable final (provider gemini) supersedes estimate, no throw', () => {
    const sub = freshRoot();
    const gctx = ctx({ agentType: 'lattice-dispatch:gemini', model: 'gemini' });
    const handle = recordDispatchPreflight(sub, gctx, 'prompt', opts(ON));
    assert.ok(handle);
    let threw = false;
    try {
      recordDispatchFinalForProvider(
        sub,
        gctx,
        handle!.correlation,
        handle!.estimateRecordId,
        'gemini',
        { promptTokenCount: -5 }, // malformed-but-object: negative count fails validation
        'gemini-2.5-pro',
        opts(ON),
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'a malformed gemini usage must not crash dispatch');
    const records = readLedger(sub);
    assert.equal(records.length, 2, 'expected estimate + single unavailable final');
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final, 'expected an unavailable final');
    assert.equal(final?.provider?.name, 'gemini', 'unavailable final must carry provider.name === "gemini"');
    assert.deepEqual(
      final?.supersedesRecordIds,
      [handle!.estimateRecordId],
      'the unavailable final must supersede the preflight estimate',
    );
    const summary = summarizeRecords(records);
    assert.equal(summary.estimateCount, 0, 'the estimate must be superseded, not counted');
  });

  // F-010 (CHK-002:adversarial:2): token values that are NaN/Infinity make
  // buildProviderRecord reject them -> an 'unavailable' final is written (supersedes
  // the estimate); no throw. NOTE: JSON cannot carry NaN/Infinity, so the usage
  // object is constructed IN-CODE (not via JSON.parse).
  await check('CHK-002 adversarial:2: NaN/Infinity token values rejected -> unavailable final supersedes estimate, no throw', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'prompt', opts(ON));
    assert.ok(handle);
    // Constructed in-code (NOT via JSON.parse) because JSON cannot carry NaN/Infinity.
    const usage = { prompt_tokens: NaN, completion_tokens: Infinity } as Record<string, number>;
    assert.ok(Number.isNaN(usage.prompt_tokens), 'precondition: prompt_tokens is NaN (in-code, not JSON)');
    assert.equal(usage.completion_tokens, Infinity, 'precondition: completion_tokens is Infinity (in-code, not JSON)');
    let threw = false;
    try {
      recordDispatchFinalForProvider(
        sub,
        ctx(),
        handle!.correlation,
        handle!.estimateRecordId,
        'openai',
        usage,
        'gpt-5-codex',
        opts(ON),
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'NaN/Infinity token values must not crash dispatch');
    const records = readLedger(sub);
    assert.equal(records.length, 2, 'expected estimate + single unavailable final');
    assert.equal(
      records.filter((r) => r.usage.source === 'provider-reported').length,
      0,
      'NaN/Infinity must NOT write a provider-reported record',
    );
    const final = records.find((r) => r.usage.source === 'unavailable');
    assert.ok(final, 'expected an unavailable final superseding the estimate');
    assert.deepEqual(
      final?.supersedesRecordIds,
      [handle!.estimateRecordId],
      'the unavailable final must supersede the preflight estimate',
    );
    const summary = summarizeRecords(records);
    assert.equal(summary.estimateCount, 0, 'the estimate must be superseded, not counted');
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

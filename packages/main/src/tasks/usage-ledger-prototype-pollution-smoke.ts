#!/usr/bin/env node
/**
 * B-6878: prototype-pollution defense smoke for the LLM usage ledger.
 *
 * Defense-in-depth + CONSISTENCY (NOT a live-vuln fix). Proves that across EVERY
 * usage path — anthropic / openai / gemini provider finals, the three streaming
 * extractors, and the preflight estimate — a token key polluted onto
 * Object.prototype can NEVER ride an inherited value into a persisted/surfaced
 * ledger record. Only OWN-property, whitelisted token fields appear; an absent
 * field stays absent/unavailable.
 *
 * Each pollution assertion is LOAD-BEARING: it FAILS against pre-hardening code
 * (the null-proto whitelist chokepoint at the entry points + the own-property
 * belt). It also covers the chokepoint helper directly (null prototype + drops
 * non-whitelisted own keys) and a legitimate (un-polluted) own-property positive
 * case per provider, so the hardening preserves real billing data byte-for-byte.
 *
 * Every pollution is inside a try { ... } finally { delete ... } so the prototype
 * is ALWAYS restored; the smoke asserts Object.prototype is clean again at the end.
 * Runs entirely in an OS temp dir; never pollutes the repo. Prints per-check lines
 * and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordDispatchFinal,
  recordDispatchFinalForProvider,
  recordDispatchPreflight,
  type DispatchUsageContext,
} from '../core/usage-ledger/dispatch-usage.js';
import type { AnthropicUsage } from '../core/usage-ledger/adapters/anthropic.js';
import { resolveLedgerPath, verifyLedgerChain } from '../core/usage-ledger/writer.js';
import {
  extractAnthropicStreamUsage,
  extractOpenAiStreamUsage,
  extractGeminiStreamUsage,
} from '../core/usage-ledger/streaming.js';
import { toOwnPropsNullProto } from '../core/usage-ledger/sanitize.js';
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

const POLLUTION_VALUE = 999;

/**
 * Every token key any ledger path reads off an external object. If Object.prototype
 * carried ALL of these and the hardening failed, an inherited 999 could ride into a
 * record. The smoke pollutes the full set so a single absent own key on any path
 * would surface 999 without the chokepoint/own-prop guard.
 */
const ALL_TOKEN_KEYS = [
  // anthropic
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  // openai (top-level + nested)
  'prompt_tokens',
  'completion_tokens',
  'cached_tokens',
  // gemini
  'promptTokenCount',
  'candidatesTokenCount',
  'cachedContentTokenCount',
] as const;

/**
 * Run `fn` with EVERY token key polluted onto Object.prototype to POLLUTION_VALUE,
 * always restoring in finally. The keys polluted are the union above so a single
 * missing own key on any path would otherwise surface the inherited 999.
 */
function withPollutedPrototype<T>(fn: () => T): T {
  const proto = Object.prototype as unknown as Record<string, unknown>;
  // Defensive: ensure none of the keys pre-exist (they must not).
  for (const k of ALL_TOKEN_KEYS) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(Object.prototype, k),
      `precondition: Object.prototype must not already carry ${k}`,
    );
  }
  try {
    for (const k of ALL_TOKEN_KEYS) proto[k] = POLLUTION_VALUE;
    return fn();
  } finally {
    for (const k of ALL_TOKEN_KEYS) delete proto[k];
  }
}

const root = mkdtempSync(join(tmpdir(), 'usage-ledger-proto-pollution-'));
let counter = 0;
function freshRoot(): string {
  return join(root, `case-${counter++}`);
}

function ctx(over: Partial<DispatchUsageContext> = {}): DispatchUsageContext {
  return { storyId: 'S-proto', phase: 'dispatch', agentType: 'lattice-dispatch', model: 'test-model', ...over };
}

function opts() {
  return {
    recordedAt: '2026-06-20T00:00:00.000Z',
    projectRootHash: 'sha256:deadbeef',
    command: 'test',
    env: ON,
  };
}

function readLedger(subRoot: string): UsageLedgerRecord[] {
  const path = resolveLedgerPath(subRoot);
  if (!existsSync(path)) return [];
  return verifyLedgerChain(path);
}

/** The persisted provider-reported final (sequence 2). */
function finalRecord(subRoot: string): UsageLedgerRecord {
  const records = readLedger(subRoot);
  const final = records.find((r) => r.sequence === 2);
  assert.ok(final, 'expected a sequence-2 final record');
  return final!;
}

/** Assert NO ledger usage field carries the polluted value. */
function assertNoPollution(usage: UsageLedgerRecord['usage']): void {
  const fields = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheReadInputTokens,
  ];
  for (const v of fields) {
    assert.notEqual(v, POLLUTION_VALUE, `a usage field carried the polluted value ${POLLUTION_VALUE}`);
  }
  const canonical = (usage as { canonical?: Record<string, unknown> }).canonical;
  if (canonical) {
    for (const v of Object.values(canonical)) {
      assert.notEqual(v, POLLUTION_VALUE, `a canonical field carried the polluted value ${POLLUTION_VALUE}`);
    }
  }
}

/** Assert a LedgerUsage carries the expected own-property counts (positive case). */
function assertCounts(
  usage: UsageLedgerRecord['usage'],
  exp: { input: number; output: number; cacheCreation: number | null; cacheRead: number | null },
): void {
  assert.equal(usage.source, 'provider-reported');
  assert.equal(usage.inputTokens, exp.input, 'inputTokens');
  assert.equal(usage.outputTokens, exp.output, 'outputTokens');
  assert.equal(usage.cacheCreationInputTokens, exp.cacheCreation, 'cacheCreationInputTokens');
  assert.equal(usage.cacheReadInputTokens, exp.cacheRead, 'cacheReadInputTokens');
}

async function main(): Promise<void> {
  // ======================================================================
  // (A) The chokepoint helper directly.
  // ======================================================================
  await check('helper: toOwnPropsNullProto returns a NULL-prototype object', () => {
    const out = toOwnPropsNullProto({ input_tokens: 5 }, ['input_tokens']);
    assert.equal(Object.getPrototypeOf(out), null, 'result must have a null prototype');
  });

  await check('helper: drops non-whitelisted own keys, keeps whitelisted own keys verbatim', () => {
    const out = toOwnPropsNullProto({ input_tokens: 5, transcript: 'secret', output_tokens: 7 }, [
      'input_tokens',
      'output_tokens',
    ]);
    assert.equal(out.input_tokens, 5);
    assert.equal(out.output_tokens, 7);
    assert.ok(!('transcript' in out), 'non-whitelisted own key must be dropped');
  });

  await check('helper: non-object input yields an EMPTY null-proto object', () => {
    for (const bad of [null, undefined, 42, 'x', [1, 2]] as unknown[]) {
      const out = toOwnPropsNullProto(bad, ['input_tokens']);
      assert.equal(Object.getPrototypeOf(out), null);
      assert.equal(Object.keys(out).length, 0, `non-object ${String(bad)} must project to empty`);
    }
  });

  await check('helper (LOAD-BEARING): a polluted whitelisted key is NOT pulled IN (inherited != own)', () => {
    withPollutedPrototype(() => {
      // Source has NO own input_tokens; the polluted Object.prototype.input_tokens
      // must NOT appear on the projection (own-property guard).
      const out = toOwnPropsNullProto({ output_tokens: 7 }, ['input_tokens', 'output_tokens']);
      assert.ok(!('input_tokens' in out), 'inherited input_tokens must not be projected');
      assert.equal(out.output_tokens, 7);
    });
  });

  // ======================================================================
  // (B) Anthropic — provider final + the dispatch anthropic extract path.
  // ======================================================================
  await check('anthropic (LOAD-BEARING): polluted prototype -> no 999 in persisted final; absent cache stays null', () => {
    const sub = freshRoot();
    withPollutedPrototype(() => {
      // A usage object with ONLY the primaries as own props; cache keys are absent
      // (would inherit 999 without the chokepoint).
      const usage = { input_tokens: 11, output_tokens: 22 };
      recordDispatchFinal(sub, ctx(), null, null, usage as unknown as AnthropicUsage, 'test-model', opts());
    });
    const final = finalRecord(sub);
    assertNoPollution(final.usage);
    assertCounts(final.usage, { input: 11, output: 22, cacheCreation: null, cacheRead: null });
  });

  await check('anthropic: legitimate own-property usage yields the expected counts (billing preserved)', () => {
    const sub = freshRoot();
    const usage = { input_tokens: 11, output_tokens: 22, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 };
    recordDispatchFinal(sub, ctx(), null, null, usage as unknown as AnthropicUsage, 'test-model', opts());
    assertCounts(finalRecord(sub).usage, { input: 11, output: 22, cacheCreation: 3, cacheRead: 4 });
  });

  // ======================================================================
  // (C) OpenAI — provider final (incl. nested cached_tokens).
  // ======================================================================
  await check('openai (LOAD-BEARING): polluted prototype -> no 999 in persisted final; absent cacheRead stays null', () => {
    const sub = freshRoot();
    withPollutedPrototype(() => {
      // prompt_tokens_details present but WITHOUT own cached_tokens (would inherit
      // 999 into cacheRead without the nested null-proto projection / own-prop belt).
      const usage = { prompt_tokens: 31, completion_tokens: 42, prompt_tokens_details: {} };
      recordDispatchFinalForProvider(sub, ctx(), null, null, 'openai', usage, 'test-model', opts());
    });
    const final = finalRecord(sub);
    assertNoPollution(final.usage);
    assertCounts(final.usage, { input: 31, output: 42, cacheCreation: null, cacheRead: null });
  });

  await check('openai: legitimate own-property usage incl. nested cached_tokens yields expected counts', () => {
    const sub = freshRoot();
    const usage = { prompt_tokens: 31, completion_tokens: 42, prompt_tokens_details: { cached_tokens: 9 } };
    recordDispatchFinalForProvider(sub, ctx(), null, null, 'openai', usage, 'test-model', opts());
    assertCounts(finalRecord(sub).usage, { input: 31, output: 42, cacheCreation: null, cacheRead: 9 });
  });

  // ======================================================================
  // (D) Gemini — provider final.
  // ======================================================================
  await check('gemini (LOAD-BEARING): polluted prototype -> no 999 in persisted final; absent cache stays null', () => {
    const sub = freshRoot();
    withPollutedPrototype(() => {
      const usage = { promptTokenCount: 51, candidatesTokenCount: 62 };
      recordDispatchFinalForProvider(sub, ctx(), null, null, 'gemini', usage, 'test-model', opts());
    });
    const final = finalRecord(sub);
    assertNoPollution(final.usage);
    assertCounts(final.usage, { input: 51, output: 62, cacheCreation: null, cacheRead: null });
  });

  await check('gemini: legitimate own-property usage yields expected counts', () => {
    const sub = freshRoot();
    const usage = { promptTokenCount: 51, candidatesTokenCount: 62, cachedContentTokenCount: 7 };
    recordDispatchFinalForProvider(sub, ctx(), null, null, 'gemini', usage, 'test-model', opts());
    assertCounts(finalRecord(sub).usage, { input: 51, output: 62, cacheCreation: null, cacheRead: 7 });
  });

  // ======================================================================
  // (E) Streaming — anthropic / openai / gemini extractors.
  // ======================================================================
  await check('streaming anthropic (LOAD-BEARING): polluted prototype -> merged usage carries no inherited 999', () => {
    const usage = withPollutedPrototype(() => {
      // start carries only input_tokens; delta carries only output_tokens. Cache
      // keys are absent everywhere -> would inherit 999 without the own-prop belt
      // + null-proto merged object.
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 13 } } },
        { type: 'message_delta', usage: { output_tokens: 14 } },
      ];
      return extractAnthropicStreamUsage(events);
    });
    assertNoPollution(usage);
    assert.equal(usage.source, 'provider-reported');
    assert.equal(usage.inputTokens, 13);
    assert.equal(usage.outputTokens, 14);
    assert.equal(usage.cacheCreationInputTokens, null, 'absent cacheCreation must stay null, not inherit 999');
    assert.equal(usage.cacheReadInputTokens, null, 'absent cacheRead must stay null, not inherit 999');
  });

  await check('streaming anthropic: legitimate own-property events yield expected counts', () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 13, cache_read_input_tokens: 2 } } },
      { type: 'message_delta', usage: { output_tokens: 14 } },
    ];
    const usage = extractAnthropicStreamUsage(events);
    assert.equal(usage.inputTokens, 13);
    assert.equal(usage.outputTokens, 14);
    assert.equal(usage.cacheReadInputTokens, 2);
  });

  await check('streaming openai (LOAD-BEARING): polluted prototype -> no inherited 999; absent cacheRead stays null', () => {
    const usage = withPollutedPrototype(() => {
      // Final chunk has primaries + an EMPTY prompt_tokens_details (no own
      // cached_tokens -> would inherit 999 into cacheRead without the projection).
      const chunks = [{ usage: { prompt_tokens: 21, completion_tokens: 22, prompt_tokens_details: {} } }];
      return extractOpenAiStreamUsage(chunks);
    });
    assertNoPollution(usage);
    assert.equal(usage.inputTokens, 21);
    assert.equal(usage.outputTokens, 22);
    assert.equal(usage.cacheReadInputTokens, null, 'absent cached_tokens must stay null, not inherit 999');
  });

  await check('streaming openai: legitimate own-property cached_tokens preserved', () => {
    const chunks = [{ usage: { prompt_tokens: 21, completion_tokens: 22, prompt_tokens_details: { cached_tokens: 5 } } }];
    const usage = extractOpenAiStreamUsage(chunks);
    assert.equal(usage.inputTokens, 21);
    assert.equal(usage.outputTokens, 22);
    assert.equal(usage.cacheReadInputTokens, 5);
  });

  await check('streaming gemini (LOAD-BEARING): polluted prototype -> no inherited 999; absent cache stays null', () => {
    const usage = withPollutedPrototype(() => {
      const chunks = [{ usageMetadata: { promptTokenCount: 31, candidatesTokenCount: 32 } }];
      return extractGeminiStreamUsage(chunks);
    });
    assertNoPollution(usage);
    assert.equal(usage.inputTokens, 31);
    assert.equal(usage.outputTokens, 32);
    assert.equal(usage.cacheReadInputTokens, null, 'absent cachedContentTokenCount must stay null, not inherit 999');
  });

  await check('streaming gemini: legitimate own-property cachedContentTokenCount preserved', () => {
    const chunks = [{ usageMetadata: { promptTokenCount: 31, candidatesTokenCount: 32, cachedContentTokenCount: 4 } }];
    const usage = extractGeminiStreamUsage(chunks);
    assert.equal(usage.inputTokens, 31);
    assert.equal(usage.outputTokens, 32);
    assert.equal(usage.cacheReadInputTokens, 4);
  });

  // ======================================================================
  // (F) Estimate path — preflight estimate record.
  // ======================================================================
  await check('estimate (LOAD-BEARING): polluted prototype -> persisted estimate carries no inherited 999', () => {
    const sub = freshRoot();
    const handle = withPollutedPrototype(() =>
      recordDispatchPreflight(sub, ctx(), 'a short prompt for the offline floor estimate', opts()),
    );
    assert.ok(handle, 'preflight should have written an estimate record');
    const records = readLedger(sub);
    const estimate = records.find((r) => r.sequence === 1);
    assert.ok(estimate, 'expected a sequence-1 estimate record');
    assert.equal(estimate!.usage.source, 'prompt-size-estimate');
    assertNoPollution(estimate!.usage);
    // input is the estimator floor (a real number from prompt bytes, not 999);
    // output/cache stay null (never the inherited 999).
    assert.equal(typeof estimate!.usage.inputTokens, 'number');
    assert.notEqual(estimate!.usage.inputTokens, POLLUTION_VALUE);
    assert.equal(estimate!.usage.outputTokens, null);
    assert.equal(estimate!.usage.cacheReadInputTokens, null);
  });

  // ======================================================================
  // (G) Object.prototype is clean again.
  // ======================================================================
  await check('Object.prototype is clean again (no leftover token keys)', () => {
    for (const k of ALL_TOKEN_KEYS) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(Object.prototype, k),
        `Object.prototype must not carry leftover key ${k}`,
      );
    }
  });

  // Summary.
  rmSync(root, { recursive: true, force: true });
  if (failures.length > 0) {
    console.error(`\n✗ usage-ledger-prototype-pollution smoke FAILED (${failures.length} failed, ${passed} passed)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n✓ usage-ledger-prototype-pollution smoke passed (${passed} checks)`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

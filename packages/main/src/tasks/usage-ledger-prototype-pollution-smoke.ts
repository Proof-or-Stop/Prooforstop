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
 * The provider/streaming/container/digest/record-validator assertions are
 * LOAD-BEARING: each FAILS against pre-hardening code (the null-proto whitelist
 * projection on the adapter READS, the own-property CONTAINER guards, the
 * original-payload digest invariant, and — for the record validator — the
 * own-property required-field checks that reject an inherited storyId /
 * supersedesRecordIds where a prototype-chain `in` would have accepted it). The
 * estimate-path check is explicitly NOT
 * load-bearing (the estimate never reads provider token keys), so it is labeled as
 * a plain property assertion, not as a pollution defense. The smoke also covers the
 * chokepoint helper directly (null prototype + drops non-whitelisted own keys) and
 * a legitimate (un-polluted) own-property positive case per provider, so the
 * hardening preserves real billing data byte-for-byte.
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
  parseClaudeCliOutput,
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
import { payloadDigest } from '../core/usage-ledger/adapters/shared.js';
import { validateUsageLedgerRecord, type UsageLedgerRecord } from '../core/usage-ledger/record.js';

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

/** The persisted record's raw.payloadDigest (provider-reported finals only). */
function finalPayloadDigest(subRoot: string): string {
  const usage = finalRecord(subRoot).usage as { raw?: { payloadDigest?: string } };
  assert.ok(usage.raw && typeof usage.raw.payloadDigest === 'string', 'expected a provider-reported raw.payloadDigest');
  return usage.raw!.payloadDigest!;
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
  await check('estimate (NOT load-bearing: estimate never reads provider token keys) — property assertion: persisted estimate carries no inherited 999', () => {
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
  // (H) DIGEST-PRESERVED (B-6878 F-005, LOAD-BEARING): raw.payloadDigest is
  // computed over the ORIGINAL provider payload, NOT a whitelist projection.
  //
  // A legitimate, un-polluted payload carrying EXTRA non-read fields (openai
  // total_tokens, gemini totalTokenCount, an extra nested detail key, etc.) must
  // yield a digest BYTE-IDENTICAL to the digest of the original payload — i.e. the
  // same value a pre-this-story build persisted. FAILS against a projected-digest
  // build (the projection drops the extra fields, changing the digest).
  // ======================================================================
  await check('digest-preserved anthropic (LOAD-BEARING): digest is over the ORIGINAL payload incl. extra non-read fields', () => {
    const sub = freshRoot();
    // Extra non-read fields: anthropic carries no top-level total, but a payload
    // may legitimately carry e.g. service_tier and a nested details blob.
    const usage = {
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
      service_tier: 'standard',
      server_tool_use: { web_search_requests: 2 },
    };
    recordDispatchFinal(sub, ctx(), null, null, usage as unknown as AnthropicUsage, 'test-model', opts());
    assert.equal(finalPayloadDigest(sub), payloadDigest(usage), 'digest must equal the ORIGINAL-payload digest (extra fields preserved)');
    // The counts are still read correctly through the projection.
    assertCounts(finalRecord(sub).usage, { input: 11, output: 22, cacheCreation: 3, cacheRead: 4 });
  });

  await check('digest-preserved openai (LOAD-BEARING): digest is over the ORIGINAL payload incl. total_tokens + extra nested key', () => {
    const sub = freshRoot();
    const usage = {
      prompt_tokens: 31,
      completion_tokens: 42,
      total_tokens: 73, // legitimate extra field the adapter never reads
      prompt_tokens_details: { cached_tokens: 9, audio_tokens: 1 }, // extra nested key
    };
    recordDispatchFinalForProvider(sub, ctx(), null, null, 'openai', usage, 'test-model', opts());
    assert.equal(finalPayloadDigest(sub), payloadDigest(usage), 'digest must equal the ORIGINAL-payload digest (total_tokens + nested extra preserved)');
    assertCounts(finalRecord(sub).usage, { input: 31, output: 42, cacheCreation: null, cacheRead: 9 });
  });

  await check('digest-preserved gemini (LOAD-BEARING): digest is over the ORIGINAL payload incl. totalTokenCount', () => {
    const sub = freshRoot();
    const usage = {
      promptTokenCount: 51,
      candidatesTokenCount: 62,
      cachedContentTokenCount: 7,
      totalTokenCount: 120, // legitimate extra field excluded from the record by design
    };
    recordDispatchFinalForProvider(sub, ctx(), null, null, 'gemini', usage, 'test-model', opts());
    assert.equal(finalPayloadDigest(sub), payloadDigest(usage), 'digest must equal the ORIGINAL-payload digest (totalTokenCount preserved)');
    assertCounts(finalRecord(sub).usage, { input: 51, output: 62, cacheCreation: null, cacheRead: 7 });
  });

  // ======================================================================
  // (H2) STREAMING DIGEST-PRESERVED (B-6878 F-007, LOAD-BEARING): the streaming
  // openai/gemini extractors must digest the ORIGINAL terminal stream usage, NOT a
  // pre-projection. A legitimate terminal stream usage carrying EXTRA non-read
  // fields (openai total_tokens + nested audio_tokens; gemini totalTokenCount) must
  // yield raw.payloadDigest === payloadDigest(original terminal usage).
  //
  // FAILS against the pre-fix streaming code (which pre-projected the terminal usage
  // via sanitizeOpenAiStreamUsage / toOwnPropsNullProto BEFORE the adapter, so the
  // adapter digested the projection — dropping the extra fields and changing the
  // digest).
  // ======================================================================
  await check('streaming digest-preserved openai (LOAD-BEARING): digest over ORIGINAL terminal usage incl. total_tokens + nested audio_tokens', () => {
    // A legit terminal stream usage WITH extra non-read fields the adapter ignores.
    const terminalUsage = {
      prompt_tokens: 21,
      completion_tokens: 22,
      total_tokens: 43, // extra non-read top-level field
      prompt_tokens_details: { cached_tokens: 5, audio_tokens: 2 }, // extra nested key
    };
    const chunks = [{ usage: terminalUsage }];
    const usage = extractOpenAiStreamUsage(chunks);
    assert.equal(usage.source, 'provider-reported');
    const digest = (usage as { raw?: { payloadDigest?: string } }).raw?.payloadDigest;
    assert.ok(typeof digest === 'string', 'expected a provider-reported raw.payloadDigest');
    assert.equal(
      digest,
      payloadDigest(terminalUsage),
      'streaming digest must equal the ORIGINAL terminal usage digest (total_tokens + nested audio_tokens preserved)',
    );
    // Counts are still read correctly through the projection.
    assert.equal(usage.inputTokens, 21);
    assert.equal(usage.outputTokens, 22);
    assert.equal(usage.cacheReadInputTokens, 5);
  });

  await check('streaming digest-preserved gemini (LOAD-BEARING): digest over ORIGINAL terminal usageMetadata incl. totalTokenCount', () => {
    const terminalMeta = {
      promptTokenCount: 31,
      candidatesTokenCount: 32,
      cachedContentTokenCount: 4,
      totalTokenCount: 67, // extra non-read field excluded from the record by design
    };
    const chunks = [{ usageMetadata: terminalMeta }];
    const usage = extractGeminiStreamUsage(chunks);
    assert.equal(usage.source, 'provider-reported');
    const digest = (usage as { raw?: { payloadDigest?: string } }).raw?.payloadDigest;
    assert.ok(typeof digest === 'string', 'expected a provider-reported raw.payloadDigest');
    assert.equal(
      digest,
      payloadDigest(terminalMeta),
      'streaming digest must equal the ORIGINAL terminal usageMetadata digest (totalTokenCount preserved)',
    );
    assert.equal(usage.inputTokens, 31);
    assert.equal(usage.outputTokens, 32);
    assert.equal(usage.cacheReadInputTokens, 4);
  });

  // ======================================================================
  // (I) CONTAINER-POLLUTION (B-6878 F-004, LOAD-BEARING): an inherited
  // (prototype-polluted) CONTAINER (envelope.usage / chunk.usage /
  // chunk.usageMetadata) on an object with NO own container is treated as ABSENT.
  //
  // FAILS against a build that only guards the LEAF fields: the container read
  // (`envelope.usage`, `chunk.usage`, `chunk.usageMetadata`) would resolve the
  // inherited object whose OWN props (input_tokens:999, ...) then pass the
  // whitelist, surfacing 999 as a provider-reported count.
  // ======================================================================
  await check('container-pollution dispatch (LOAD-BEARING): inherited envelope.usage is NOT accepted (final is unavailable)', () => {
    const sub = freshRoot();
    const proto = Object.prototype as unknown as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, 'usage'), 'precondition: no own Object.prototype.usage');
    try {
      // A polluted CONTAINER carrying own leaf props that WOULD pass the whitelist.
      proto.usage = { input_tokens: 999, output_tokens: 999 };
      // Drive the claude dispatch path with an envelope that has NO own usage.
      const stdout = JSON.stringify({ type: 'result', result: 'hi', model: 'srv-model' });
      const parsed = parseClaudeCliOutput(stdout);
      // The parser must not pick up the inherited container -> no anthropicUsage.
      assert.equal(parsed.anthropicUsage, null, 'inherited envelope.usage container must be treated as absent');
      // And the recorded final (driven from the parsed usage) is unavailable.
      recordDispatchFinal(sub, ctx(), null, null, parsed.anthropicUsage, parsed.model, opts());
    } finally {
      delete proto.usage;
    }
    const final = finalRecord(sub);
    assert.equal(final.usage.source, 'unavailable', 'final must be unavailable, not provider-reported with inherited 999');
    assertNoPollution(final.usage);
  });

  await check('container-pollution dispatch stream-json (LOAD-BEARING): inherited result-event.usage is NOT accepted', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, 'usage'), 'precondition: no own Object.prototype.usage');
    try {
      proto.usage = { input_tokens: 999, output_tokens: 999 };
      const stdout = [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'result', result: 'hi', model: 'srv-model' }),
      ].join('\n');
      const parsed = parseClaudeCliOutput(stdout);
      assert.equal(parsed.resultText, 'hi');
      assert.equal(parsed.anthropicUsage, null, 'inherited stream result-event.usage container must be treated as absent');
    } finally {
      delete proto.usage;
    }
  });

  await check('result-pollution dispatch (LOAD-BEARING): inherited envelope.result is NOT used (falls back to raw stdout)', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, 'result'), 'precondition: no own Object.prototype.result');
    try {
      // Pollute Object.prototype.result with an inherited value that must NEVER
      // become the resolved result text.
      proto.result = 'INHERITED-EVIL';
      // A valid JSON envelope (object) with NO own `result` key. The raw stdout is
      // the human-facing fallback; the inherited prototype.result must be ignored.
      const stdout = JSON.stringify({ type: 'result', model: 'srv-model' });
      const parsed = parseClaudeCliOutput(stdout);
      assert.notEqual(parsed.resultText, 'INHERITED-EVIL', 'inherited envelope.result must NOT be used as the result text');
      assert.equal(parsed.resultText, stdout, 'result text must fall back to the raw stdout when there is no OWN result');
    } finally {
      delete proto.result;
    }
  });

  await check('result-pollution dispatch stream-json (LOAD-BEARING): inherited result-event.result is NOT used', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, 'result'), 'precondition: no own Object.prototype.result');
    try {
      proto.result = 'INHERITED-EVIL';
      const stdout = [
        JSON.stringify({ type: 'assistant', message: { content: 'progress' } }),
        JSON.stringify({ type: 'result', model: 'srv-model' }),
      ].join('\n');
      const parsed = parseClaudeCliOutput(stdout);
      assert.notEqual(parsed.resultText, 'INHERITED-EVIL', 'inherited stream result-event.result must NOT be used');
      assert.equal(parsed.resultText, stdout, 'stream result text must fall back to raw stdout when there is no OWN result');
    } finally {
      delete proto.result;
    }
  });

  await check('container-pollution streaming openai (LOAD-BEARING): inherited chunk.usage container is NOT accepted', () => {
    const usage = (() => {
      const proto = Object.prototype as unknown as Record<string, unknown>;
      assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, 'usage'), 'precondition: no own Object.prototype.usage');
      try {
        proto.usage = { prompt_tokens: 999, completion_tokens: 999 };
        // A chunk with NO own usage: the container read must not resolve the
        // inherited object.
        const chunks = [{} as { usage?: unknown }];
        return extractOpenAiStreamUsage(chunks);
      } finally {
        delete proto.usage;
      }
    })();
    assert.equal(usage.source, 'unavailable', 'inherited chunk.usage container must be treated as absent (unavailable)');
    assertNoPollution(usage);
  });

  await check('container-pollution streaming gemini (LOAD-BEARING): inherited chunk.usageMetadata container is NOT accepted', () => {
    const usage = (() => {
      const proto = Object.prototype as unknown as Record<string, unknown>;
      assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, 'usageMetadata'), 'precondition: no own Object.prototype.usageMetadata');
      try {
        proto.usageMetadata = { promptTokenCount: 999, candidatesTokenCount: 999 };
        const chunks = [{} as { usageMetadata?: unknown }];
        return extractGeminiStreamUsage(chunks);
      } finally {
        delete proto.usageMetadata;
      }
    })();
    assert.equal(usage.source, 'unavailable', 'inherited chunk.usageMetadata container must be treated as absent (unavailable)');
    assertNoPollution(usage);
  });

  await check('container-pollution streaming anthropic (LOAD-BEARING): inherited event.usage / event.message containers are NOT accepted', () => {
    const usage = (() => {
      const proto = Object.prototype as unknown as Record<string, unknown>;
      assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, 'usage'), 'precondition: no own Object.prototype.usage');
      assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, 'message'), 'precondition: no own Object.prototype.message');
      try {
        proto.usage = { output_tokens: 999 };
        proto.message = { usage: { input_tokens: 999 } };
        // Events with NO own usage / message: both container reads must be absent.
        const events = [{ type: 'message_start' }, { type: 'message_delta' }];
        return extractAnthropicStreamUsage(events);
      } finally {
        delete proto.usage;
        delete proto.message;
      }
    })();
    assert.equal(usage.source, 'unavailable', 'inherited event containers must be treated as absent (unavailable)');
    assertNoPollution(usage);
  });

  // ======================================================================
  // (J) RECORD-VALIDATOR POLLUTION (B-6878 F-011, LOAD-BEARING): the record
  // validator's required-field presence checks for storyId / supersedesRecordIds
  // are OWN-property checks (hasOwnProperty), NOT prototype-chain `in`. A record
  // that OMITS those fields as OWN properties must STILL FAIL validation even when
  // Object.prototype carries an otherwise-satisfying inherited value.
  //
  // FAILS against pre-FIX-D code: the old `'storyId' in record` /
  // `'supersedesRecordIds' in record` resolve TRUE via the prototype chain, so the
  // validator would treat the field as present and validate the inherited value —
  // a record missing the field as an own property would WRONGLY pass that check.
  // ======================================================================

  /**
   * An OTHERWISE-valid local provider-reported record built with own properties,
   * MINUS the keys named in `omit` (which are simply not set as own props). Used to
   * isolate the storyId / supersedesRecordIds required-own-field rules: with `omit`
   * empty the record validates clean, so any failure comes ONLY from the omission.
   */
  function buildRecordOmitting(omit: ReadonlyArray<'storyId' | 'supersedesRecordIds'>): Record<string, unknown> {
    const rec: Record<string, unknown> = {
      schemaVersion: 1,
      recordId: 'r-1',
      ledgerCallId: 'lc-1',
      attemptId: 'a-1',
      recordedAt: '2026-06-20T00:00:00.000Z',
      projectRootHash: 'sha256:deadbeef',
      phase: 'dispatch',
      agentType: 'lattice-dispatch',
      storyId: null,
      sequence: 1,
      supersedesRecordIds: [],
      subagentId: null,
      threadId: null,
      decision: { kind: 'allowed' },
      usage: {
        source: 'provider-reported',
        inputTokens: 11,
        outputTokens: 22,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        canonical: { input: 11, output: 22, cacheCreation: null, cacheRead: null },
        raw: { providerUnits: 'anthropic-usage-v1', payloadDigest: 'sha256:abc' },
        estimator: null,
        unavailableReason: null,
      },
      privacy: { promptStored: false, transcriptStored: false, redactionProfile: 'default' },
      authority: {
        mode: 'local',
        receiptVerified: false,
        receiptId: null,
        receiptSubjectKind: null,
        receiptSubjectId: null,
      },
    };
    for (const k of omit) delete rec[k];
    return rec;
  }

  await check('validator baseline: an own-property record (nothing omitted) validates clean', () => {
    const result = validateUsageLedgerRecord(buildRecordOmitting([]));
    assert.ok(result.ok, `baseline record must validate clean; errors: ${result.errors.join('; ')}`);
  });

  await check('validator-pollution (LOAD-BEARING): a record MISSING storyId/supersedesRecordIds as OWN props STILL FAILS despite inherited prototype values', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, 'storyId'), 'precondition: no own Object.prototype.storyId');
    assert.ok(!Object.prototype.hasOwnProperty.call(Object.prototype, 'supersedesRecordIds'), 'precondition: no own Object.prototype.supersedesRecordIds');
    try {
      // Inherited values that, via the OLD `in` check, would have made the missing
      // fields look "present" and satisfy the type-shape rule (null / []).
      proto.storyId = null;
      proto.supersedesRecordIds = [];
      const record = buildRecordOmitting(['storyId', 'supersedesRecordIds']);
      // Sanity: the omitted keys are genuinely absent as OWN props, yet readable via
      // inheritance (so a prototype-chain `in` would resolve TRUE).
      assert.ok(!Object.prototype.hasOwnProperty.call(record, 'storyId'), 'storyId must be absent as an own property');
      assert.ok(!Object.prototype.hasOwnProperty.call(record, 'supersedesRecordIds'), 'supersedesRecordIds must be absent as an own property');
      assert.ok('storyId' in record, 'prototype-chain `in` would (wrongly) see storyId as present');
      assert.ok('supersedesRecordIds' in record, 'prototype-chain `in` would (wrongly) see supersedesRecordIds as present');

      const result = validateUsageLedgerRecord(record);
      assert.ok(!result.ok, 'record missing required OWN fields must FAIL validation despite inherited prototype values');
      assert.ok(
        result.errors.some((e) => e.includes('storyId is required')),
        `expected a "storyId is required" error; got: ${result.errors.join('; ')}`,
      );
      assert.ok(
        result.errors.some((e) => e.includes('supersedesRecordIds is required')),
        `expected a "supersedesRecordIds is required" error; got: ${result.errors.join('; ')}`,
      );
    } finally {
      delete proto.storyId;
      delete proto.supersedesRecordIds;
    }
  });

  // ======================================================================
  // (G) Object.prototype is clean again.
  // ======================================================================
  await check('Object.prototype is clean again (no leftover token keys or container keys)', () => {
    // Token leaf keys (sections B-F) AND the container/result keys the
    // container-pollution + result-pollution checks (section I) + the validator
    // required-field keys (section J) set must all be restored.
    for (const k of [...ALL_TOKEN_KEYS, 'usage', 'usageMetadata', 'message', 'result', 'storyId', 'supersedesRecordIds'] as const) {
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

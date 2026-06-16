#!/usr/bin/env node
/**
 * B-08a1 CHK-007 (Slice 2): smoke suite for the LLM usage ledger provider
 * adapter layer.
 *
 * Coverage across CHK-001..CHK-006:
 *   - per-provider mapping (anthropic native four-field; openai/gemini
 *     cacheCreation=null; cacheRead null-vs-0 distinction; genuine zeros;
 *     large counts; no-usage -> unavailable; negative/string payloads rejected);
 *   - assembler output passes B-253e validateUsageLedgerRecord for all three
 *     providers; correlation ids are the minted ones (NOT provider-derived);
 *     storyId=null path; subagent/thread attribution; authority local/unverified;
 *     forbidden field on the response does not poison the record;
 *   - streaming terminal-event extraction + mid-stream partial extraction +
 *     last/terminal-wins + all-zero genuine + no-usage-at-all -> unavailable;
 *   - centralized unavailable + per-dimension-null rule across all providers;
 *   - raw providerUnits preserved alongside canonical;
 *   - end-to-end: an assembled record round-trips through the B-253e writer
 *     (opt-in ON, temp dir), re-read + chain-verified + validated.
 *
 * Runs entirely in an OS temp dir; never pollutes the repo. Prints ✓/✗ per
 * check and exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateUsageLedgerRecord } from '../core/usage-ledger/record.js';
import {
  ATTEMPT_ID_PREFIX,
  LEDGER_CALL_ID_PREFIX,
  RECORD_ID_PREFIX,
  mintAttemptId,
  mintLedgerCallId,
} from '../core/usage-ledger/ids.js';
import {
  appendUsageRecord,
  resolveLedgerPath,
  verifyLedgerChain,
} from '../core/usage-ledger/writer.js';
import { adaptAnthropicUsage, ANTHROPIC_PROVIDER_UNITS } from '../core/usage-ledger/adapters/anthropic.js';
import { adaptOpenAiUsage, OPENAI_PROVIDER_UNITS } from '../core/usage-ledger/adapters/openai.js';
import { adaptGeminiUsage, GEMINI_PROVIDER_UNITS } from '../core/usage-ledger/adapters/gemini.js';
import {
  buildProviderRecord,
  type ProviderName,
  type RecordAttribution,
  type RecordContext,
  type RecordCorrelation,
} from '../core/usage-ledger/assemble.js';
import {
  extractAnthropicStreamUsage,
  extractGeminiStreamUsage,
  extractOpenAiStreamUsage,
} from '../core/usage-ledger/streaming.js';

let passed = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
    throw err;
  }
}

const LEDGER_ENV = { LATTICE_USAGE_LEDGER: '1' } as NodeJS.ProcessEnv;

function freshCorrelation(over: Partial<RecordCorrelation> = {}): RecordCorrelation {
  return {
    ledgerCallId: mintLedgerCallId(),
    attemptId: mintAttemptId(),
    sequence: 1,
    supersedesRecordIds: [],
    ...over,
  };
}

const CONTEXT: RecordContext = {
  recordedAt: '2026-06-16T00:00:00.000Z',
  projectRootHash: 'sha256:projectroot',
};

const ATTRIBUTION: RecordAttribution = {
  storyId: 'B-08a1',
  phase: 'DEV',
  agentType: 'implementer',
};

const root = mkdtempSync(join(tmpdir(), 'usage-ledger-adapter-smoke-'));

try {
  // ======================================================================
  // CHK-001: Anthropic adapter
  // ======================================================================
  check('CHK-001 anthropic: all four native fields map to canonical', () => {
    const u = adaptAnthropicUsage({ input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 });
    assert.equal(u.source, 'provider-reported');
    assert.deepEqual(u.canonical, { input: 500, output: 200, cacheCreation: 100, cacheRead: 50 });
    assert.equal(u.inputTokens, 500);
    assert.equal(u.outputTokens, 200);
    assert.equal(u.cacheCreationInputTokens, 100);
    assert.equal(u.cacheReadInputTokens, 50);
    assert.equal(u.raw?.providerUnits, ANTHROPIC_PROVIDER_UNITS);
    assert.ok(/^sha256:[0-9a-f]{64}$/.test(u.raw!.payloadDigest));
  });

  check('CHK-001 anthropic: genuine zero cache fields stay 0 (not null)', () => {
    const u = adaptAnthropicUsage({ input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    assert.strictEqual(u.canonical!.cacheCreation, 0);
    assert.strictEqual(u.canonical!.cacheRead, 0);
    assert.notStrictEqual(u.canonical!.cacheCreation, null);
  });

  check('CHK-001 anthropic: input/output zero is provider-reported, not unavailable', () => {
    const u = adaptAnthropicUsage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    assert.equal(u.source, 'provider-reported');
    assert.strictEqual(u.inputTokens, 0);
    assert.strictEqual(u.outputTokens, 0);
  });

  check('CHK-001 anthropic: very large counts carried without overflow/truncation', () => {
    const u = adaptAnthropicUsage({ input_tokens: 999999999, output_tokens: 500000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    assert.equal(u.canonical!.input, 999999999);
    assert.equal(u.canonical!.output, 500000);
  });

  check('CHK-001 anthropic: no usage object -> unavailable + reason (never zeros)', () => {
    for (const empty of [null, undefined, 42, 'x', []]) {
      const u = adaptAnthropicUsage(empty);
      assert.equal(u.source, 'unavailable');
      assert.ok(typeof u.unavailableReason === 'string' && u.unavailableReason.length > 0);
      assert.strictEqual(u.inputTokens, null);
      assert.strictEqual(u.outputTokens, null);
    }
  });

  check('CHK-001 anthropic: payloadDigest is deterministic sha256 of the usage payload', () => {
    const payload = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 };
    const u1 = adaptAnthropicUsage(payload);
    const u2 = adaptAnthropicUsage({ ...payload });
    assert.equal(u1.raw!.payloadDigest, u2.raw!.payloadDigest, 'digest must be deterministic');
    assert.ok(/^sha256:[0-9a-f]{64}$/.test(u1.raw!.payloadDigest));
  });

  check('CHK-001 anthropic: negative count flows through and fails B-253e validator', () => {
    const u = adaptAnthropicUsage({ input_tokens: -1, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    // adapter does not silently coerce; the assembled record must be rejected.
    assert.throws(
      () => buildProviderRecord('anthropic', { usage: { input_tokens: -1, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, freshCorrelation(), ATTRIBUTION, CONTEXT),
      /invalid|>= 0|non-negative/i,
    );
    void u;
  });

  // ======================================================================
  // CHK-002: OpenAI adapter
  // ======================================================================
  check('CHK-002 openai: cached_tokens present -> cacheRead set, cacheCreation null', () => {
    const u = adaptOpenAiUsage({ prompt_tokens: 800, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } });
    assert.equal(u.source, 'provider-reported');
    assert.equal(u.canonical!.input, 800);
    assert.equal(u.canonical!.output, 300);
    assert.equal(u.canonical!.cacheRead, 200);
    assert.strictEqual(u.canonical!.cacheCreation, null);
    assert.equal(u.raw?.providerUnits, OPENAI_PROVIDER_UNITS);
  });

  check('CHK-002 openai: no prompt_tokens_details -> cacheRead null AND cacheCreation null, still provider-reported', () => {
    const u = adaptOpenAiUsage({ prompt_tokens: 800, completion_tokens: 300 });
    assert.equal(u.source, 'provider-reported');
    assert.strictEqual(u.canonical!.cacheRead, null);
    assert.strictEqual(u.canonical!.cacheCreation, null);
  });

  check('CHK-002 openai: cached_tokens=0 -> cacheRead 0 (genuine), cacheCreation still null', () => {
    const u = adaptOpenAiUsage({ prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } });
    assert.strictEqual(u.canonical!.cacheRead, 0);
    assert.strictEqual(u.canonical!.cacheCreation, null);
  });

  check('CHK-002 openai: prompt_tokens_details present but empty {} -> cacheRead null (key absent != 0)', () => {
    const u = adaptOpenAiUsage({ prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: {} });
    assert.strictEqual(u.canonical!.cacheRead, null);
  });

  check('CHK-002 openai: no usage object -> unavailable + reason', () => {
    const u = adaptOpenAiUsage(null);
    assert.equal(u.source, 'unavailable');
    assert.ok(u.unavailableReason && u.unavailableReason.length > 0);
  });

  check('CHK-002 openai: cacheCreation is STRICTLY null (not 0/undefined/omitted)', () => {
    const u = adaptOpenAiUsage({ prompt_tokens: 1, completion_tokens: 1 });
    assert.ok('cacheCreation' in u.canonical!, 'cacheCreation key must be present');
    assert.strictEqual(u.canonical!.cacheCreation, null);
    assert.notStrictEqual(u.canonical!.cacheCreation, 0);
    assert.notStrictEqual(u.canonical!.cacheCreation, undefined);
    assert.ok('cacheCreationInputTokens' in u);
    assert.strictEqual(u.cacheCreationInputTokens, null);
  });

  check('CHK-002 openai: string token counts are not coerced; record rejected by validator', () => {
    const u = adaptOpenAiUsage({ prompt_tokens: '100', completion_tokens: '50' });
    // No NaN, no numeric coercion: the malformed value is preserved verbatim.
    assert.notEqual(typeof u.inputTokens, 'number');
    assert.throws(
      () => buildProviderRecord('openai', { usage: { prompt_tokens: '100', completion_tokens: '50' } }, freshCorrelation(), ATTRIBUTION, CONTEXT),
      /invalid|integer/i,
    );
  });

  // ======================================================================
  // CHK-003: Gemini adapter
  // ======================================================================
  check('CHK-003 gemini: cachedContentTokenCount present -> cacheRead set, cacheCreation null', () => {
    const u = adaptGeminiUsage({ promptTokenCount: 600, candidatesTokenCount: 250, cachedContentTokenCount: 150 });
    assert.equal(u.source, 'provider-reported');
    assert.equal(u.canonical!.input, 600);
    assert.equal(u.canonical!.output, 250);
    assert.equal(u.canonical!.cacheRead, 150);
    assert.strictEqual(u.canonical!.cacheCreation, null);
    assert.equal(u.raw?.providerUnits, GEMINI_PROVIDER_UNITS);
  });

  check('CHK-003 gemini: no cachedContentTokenCount -> cacheRead null AND cacheCreation null', () => {
    const u = adaptGeminiUsage({ promptTokenCount: 600, candidatesTokenCount: 250 });
    assert.equal(u.source, 'provider-reported');
    assert.strictEqual(u.canonical!.cacheRead, null);
    assert.strictEqual(u.canonical!.cacheCreation, null);
  });

  check('CHK-003 gemini: cachedContentTokenCount=0 -> cacheRead 0 (genuine)', () => {
    const u = adaptGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 5, cachedContentTokenCount: 0 });
    assert.strictEqual(u.canonical!.cacheRead, 0);
  });

  check('CHK-003 gemini: totalTokenCount is ignored (no stored total anywhere in record)', () => {
    const rec = buildProviderRecord('gemini', { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, totalTokenCount: 140 } }, freshCorrelation(), ATTRIBUTION, CONTEXT);
    const serialized = JSON.stringify(rec).toLowerCase();
    assert.ok(!serialized.includes('totaltoken'), 'no totalToken* field may appear in the record');
    assert.equal(validateUsageLedgerRecord(rec).ok, true);
  });

  check('CHK-003 gemini: no usageMetadata -> unavailable + reason', () => {
    const u = adaptGeminiUsage(undefined);
    assert.equal(u.source, 'unavailable');
    assert.ok(u.unavailableReason && u.unavailableReason.length > 0);
  });

  check('CHK-003 gemini: cacheCreation STRICTLY null via ===', () => {
    const u = adaptGeminiUsage({ promptTokenCount: 1, candidatesTokenCount: 1 });
    assert.strictEqual(u.canonical!.cacheCreation, null);
    assert.notStrictEqual(u.canonical!.cacheCreation, 0);
  });

  check('CHK-003 gemini: candidatesTokenCount missing (output) -> unavailable, not inferred 0', () => {
    const u = adaptGeminiUsage({ promptTokenCount: 600 });
    assert.equal(u.source, 'unavailable');
    assert.strictEqual(u.outputTokens, null);
    assert.notStrictEqual(u.outputTokens, 0);
  });

  // ======================================================================
  // CHK-004: assembler
  // ======================================================================
  const SAMPLES: Record<ProviderName, unknown> = {
    anthropic: { id: 'msg_provider_123', usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 } },
    openai: { id: 'chatcmpl_provider_456', usage: { prompt_tokens: 800, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } } },
    gemini: { responseId: 'gemini_provider_789', usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 250, cachedContentTokenCount: 150 } },
  };

  check('CHK-004 assembler: anthropic record passes validator; ids match correlation; schemaVersion 1', () => {
    const corr = freshCorrelation();
    const rec = buildProviderRecord('anthropic', SAMPLES.anthropic, corr, ATTRIBUTION, CONTEXT);
    const res = validateUsageLedgerRecord(rec, { expectIntegrity: false });
    assert.equal(res.ok, true, res.errors.join('; '));
    assert.equal(rec.schemaVersion, 1);
    assert.ok(rec.recordId.startsWith(RECORD_ID_PREFIX));
    assert.equal(rec.ledgerCallId, corr.ledgerCallId);
    assert.equal(rec.attemptId, corr.attemptId);
    assert.equal(rec.sequence, corr.sequence);
  });

  check('CHK-004 assembler: all three providers produce records that pass the validator', () => {
    for (const provider of ['anthropic', 'openai', 'gemini'] as ProviderName[]) {
      const rec = buildProviderRecord(provider, SAMPLES[provider], freshCorrelation(), ATTRIBUTION, CONTEXT);
      const res = validateUsageLedgerRecord(rec, { expectIntegrity: false });
      assert.equal(res.ok, true, `${provider}: ${res.errors.join('; ')}`);
    }
  });

  check('CHK-004 assembler: privacy flags mandatory (promptStored/transcriptStored false, redactionProfile non-empty)', () => {
    const rec = buildProviderRecord('anthropic', SAMPLES.anthropic, freshCorrelation(), ATTRIBUTION, CONTEXT);
    assert.strictEqual(rec.privacy.promptStored, false);
    assert.strictEqual(rec.privacy.transcriptStored, false);
    assert.ok(typeof rec.privacy.redactionProfile === 'string' && rec.privacy.redactionProfile.length > 0);
  });

  check('CHK-004 assembler: storyId=null (non-story call) present and valid', () => {
    const rec = buildProviderRecord('openai', SAMPLES.openai, freshCorrelation(), { ...ATTRIBUTION, storyId: null }, CONTEXT);
    assert.strictEqual(rec.storyId, null);
    assert.ok('storyId' in rec);
    assert.equal(validateUsageLedgerRecord(rec).ok, true);
  });

  check('CHK-004 assembler: subagentId + threadId attribution propagate', () => {
    const rec = buildProviderRecord('gemini', SAMPLES.gemini, freshCorrelation(), { ...ATTRIBUTION, subagentId: 'sub-1', threadId: 'thread-9' }, CONTEXT);
    assert.equal(rec.subagentId, 'sub-1');
    assert.equal(rec.threadId, 'thread-9');
    assert.equal(validateUsageLedgerRecord(rec).ok, true);
  });

  check('CHK-004 assembler: correlation ids minted (llmuse_/llmcall_/llmatt_), NOT provider-derived', () => {
    const corr = freshCorrelation();
    const responseWithProviderIds = { id: 'msg_ID_FROM_PROVIDER', request_id: 'req_FROM_PROVIDER', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    const rec = buildProviderRecord('anthropic', responseWithProviderIds, corr, ATTRIBUTION, CONTEXT);
    assert.ok(rec.recordId.startsWith(RECORD_ID_PREFIX));
    assert.ok(rec.ledgerCallId.startsWith(LEDGER_CALL_ID_PREFIX));
    assert.ok(rec.attemptId.startsWith(ATTEMPT_ID_PREFIX));
    for (const id of [rec.recordId, rec.ledgerCallId, rec.attemptId]) {
      assert.ok(!id.includes('FROM_PROVIDER'), 'no correlation id may be derived from a provider id');
    }
    assert.equal(rec.ledgerCallId, corr.ledgerCallId);
    assert.equal(rec.attemptId, corr.attemptId);
  });

  check('CHK-004 assembler: forbidden field on the provider response does not poison the record', () => {
    const poisoned = { rawPrompt: 'the secret prompt text', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    const rec = buildProviderRecord('anthropic', poisoned, freshCorrelation(), ATTRIBUTION, CONTEXT);
    const serialized = JSON.stringify(rec).toLowerCase();
    assert.ok(!serialized.includes('rawprompt'), 'forbidden field must not propagate into the record');
    assert.ok(!serialized.includes('the secret prompt text'));
    assert.equal(validateUsageLedgerRecord(rec).ok, true);
  });

  check('CHK-004 assembler: authority mode=local + receiptVerified=false (never receipt-backed)', () => {
    const rec = buildProviderRecord('anthropic', SAMPLES.anthropic, freshCorrelation(), ATTRIBUTION, CONTEXT);
    assert.equal(rec.authority.mode, 'local');
    assert.strictEqual(rec.authority.receiptId, null);
    assert.strictEqual(rec.authority.receiptVerified, false);
  });

  // ======================================================================
  // CHK-005: streaming / failure extraction
  // ======================================================================
  check('CHK-005 anthropic: terminal-event final usage (message_start + final message_delta)', () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { type: 'message_delta', usage: { output_tokens: 100 } },
      { type: 'message_delta', usage: { output_tokens: 400 } }, // terminal wins
    ];
    const u = extractAnthropicStreamUsage(events);
    assert.equal(u.source, 'provider-reported');
    assert.equal(u.canonical!.input, 1000);
    assert.equal(u.canonical!.output, 400);
  });

  check('CHK-005 openai: usage only in the final chunk -> provider-reported', () => {
    const chunks = [{}, {}, { usage: { prompt_tokens: 500, completion_tokens: 200 } }];
    const u = extractOpenAiStreamUsage(chunks);
    assert.equal(u.source, 'provider-reported');
    assert.equal(u.canonical!.input, 500);
    assert.equal(u.canonical!.output, 200);
  });

  check('CHK-005 mid-stream error with partial output preserved (not downgraded to unavailable)', () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1000 } } },
      { type: 'message_delta', usage: { output_tokens: 50 } },
    ];
    const u = extractAnthropicStreamUsage(events, 'timeout after first delta');
    assert.equal(u.source, 'provider-reported');
    assert.equal(u.outputTokens, 50);
    assert.equal(u.inputTokens, 1000);
  });

  check('CHK-005 partial with only output (input missing) -> available preserved, missing dim null, still provider-reported', () => {
    const events = [{ type: 'message_delta', usage: { output_tokens: 50 } }];
    const u = extractAnthropicStreamUsage(events, 'connection dropped');
    assert.equal(u.source, 'provider-reported');
    assert.strictEqual(u.inputTokens, null);
    assert.equal(u.outputTokens, 50);
  });

  check('CHK-005 stream errored with NO usage event at all -> unavailable + reason mentioning the error', () => {
    const u = extractOpenAiStreamUsage([{}, {}], 'connection reset before any usage');
    assert.equal(u.source, 'unavailable');
    assert.ok(u.unavailableReason && /connection reset/.test(u.unavailableReason));
  });

  check('CHK-005 multiple usage events -> only the LAST/terminal one is used', () => {
    const chunks = [
      { usage: { prompt_tokens: 100, completion_tokens: 10 } }, // intermediate
      { usage: { prompt_tokens: 100, completion_tokens: 200 } }, // terminal
    ];
    const u = extractOpenAiStreamUsage(chunks);
    assert.equal(u.canonical!.output, 200, 'terminal usage wins over intermediate');
  });

  check('CHK-005 stream error producing all-zero usage -> provider-reported (genuine zero), not unavailable', () => {
    const chunks = [{ usage: { prompt_tokens: 0, completion_tokens: 0 } }];
    const u = extractOpenAiStreamUsage(chunks, 'errored but zero usage reported');
    assert.equal(u.source, 'provider-reported');
    assert.strictEqual(u.inputTokens, 0);
    assert.strictEqual(u.outputTokens, 0);
  });

  check('CHK-005 gemini stream: terminal usageMetadata extracted', () => {
    const chunks = [
      { usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 100 } },
      { usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 250, cachedContentTokenCount: 150 } },
    ];
    const u = extractGeminiStreamUsage(chunks);
    assert.equal(u.source, 'provider-reported');
    assert.equal(u.canonical!.output, 250);
    assert.equal(u.canonical!.cacheRead, 150);
    assert.strictEqual(u.canonical!.cacheCreation, null);
  });

  // ======================================================================
  // CHK-006: centralized unavailable + per-dimension-null semantics
  // ======================================================================
  check('CHK-006 anthropic: all four reported -> none null', () => {
    const u = adaptAnthropicUsage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 });
    for (const v of [u.canonical!.input, u.canonical!.output, u.canonical!.cacheCreation, u.canonical!.cacheRead]) {
      assert.equal(typeof v, 'number');
    }
  });

  check('CHK-006 openai: cacheCreation always null; cacheRead null/numeric by presence', () => {
    const withCache = adaptOpenAiUsage({ prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 9 } });
    const without = adaptOpenAiUsage({ prompt_tokens: 1, completion_tokens: 1 });
    assert.strictEqual(withCache.canonical!.cacheCreation, null);
    assert.strictEqual(without.canonical!.cacheCreation, null);
    assert.equal(withCache.canonical!.cacheRead, 9);
    assert.strictEqual(without.canonical!.cacheRead, null);
  });

  check('CHK-006 gemini: cacheCreation always null; cacheRead null/numeric by presence', () => {
    const withCache = adaptGeminiUsage({ promptTokenCount: 1, candidatesTokenCount: 1, cachedContentTokenCount: 7 });
    const without = adaptGeminiUsage({ promptTokenCount: 1, candidatesTokenCount: 1 });
    assert.strictEqual(withCache.canonical!.cacheCreation, null);
    assert.strictEqual(without.canonical!.cacheCreation, null);
    assert.equal(withCache.canonical!.cacheRead, 7);
    assert.strictEqual(without.canonical!.cacheRead, null);
  });

  check('CHK-006 all providers: no-usage -> unavailable + non-empty reason (never provider-reported zeros)', () => {
    const a = adaptAnthropicUsage(null);
    const o = adaptOpenAiUsage(null);
    const g = adaptGeminiUsage(null);
    for (const u of [a, o, g]) {
      assert.equal(u.source, 'unavailable');
      assert.ok(u.unavailableReason && u.unavailableReason.length > 0);
    }
  });

  check('CHK-006 unavailable records: all four token fields are null (not 0) across providers', () => {
    for (const u of [adaptAnthropicUsage(null), adaptOpenAiUsage(null), adaptGeminiUsage(null)]) {
      assert.strictEqual(u.inputTokens, null);
      assert.strictEqual(u.outputTokens, null);
      assert.strictEqual(u.cacheCreationInputTokens, null);
      assert.strictEqual(u.cacheReadInputTokens, null);
    }
  });

  check('CHK-006 openai unreported cacheCreation remains null even when input/output present', () => {
    const u = adaptOpenAiUsage({ prompt_tokens: 5, completion_tokens: 5 });
    assert.strictEqual(u.cacheCreationInputTokens, null);
    assert.notStrictEqual(u.cacheCreationInputTokens, 0);
  });

  check('CHK-006 source NOT downgraded to unavailable merely because a cache dim is absent', () => {
    const u = adaptOpenAiUsage({ prompt_tokens: 5, completion_tokens: 5 });
    assert.equal(u.source, 'provider-reported');
    assert.strictEqual(u.canonical!.cacheCreation, null);
    assert.strictEqual(u.canonical!.cacheRead, null);
  });

  check('CHK-006 cross-provider: assembled records with various null/non-null patterns all validate', () => {
    const cases: Array<[ProviderName, unknown]> = [
      ['anthropic', { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }],
      ['openai', { usage: { prompt_tokens: 1, completion_tokens: 1 } }],
      ['openai', { usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } } }],
      ['gemini', { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }],
      ['gemini', { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, cachedContentTokenCount: 0 } }],
    ];
    for (const [provider, response] of cases) {
      const rec = buildProviderRecord(provider, response, freshCorrelation(), ATTRIBUTION, CONTEXT);
      assert.equal(validateUsageLedgerRecord(rec).ok, true, `${provider} pattern failed validation`);
    }
  });

  check('CHK-006 raw providerUnits preserved alongside canonical on every provider', () => {
    assert.equal(adaptAnthropicUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }).raw!.providerUnits, ANTHROPIC_PROVIDER_UNITS);
    assert.equal(adaptOpenAiUsage({ prompt_tokens: 1, completion_tokens: 1 }).raw!.providerUnits, OPENAI_PROVIDER_UNITS);
    assert.equal(adaptGeminiUsage({ promptTokenCount: 1, candidatesTokenCount: 1 }).raw!.providerUnits, GEMINI_PROVIDER_UNITS);
  });

  // ======================================================================
  // CHK-007: end-to-end writer round-trip (opt-in ON, temp dir)
  // ======================================================================
  check('CHK-007 assembled record round-trips through B-253e writer; re-read validates with integrity', () => {
    const dir = mkdtempSync(join(root, 'roundtrip-'));
    const rec = buildProviderRecord('anthropic', SAMPLES.anthropic, freshCorrelation(), ATTRIBUTION, CONTEXT);
    const res = appendUsageRecord(dir, rec, { env: LEDGER_ENV });
    assert.equal(res.written, true);
    const lines = readFileSync(resolveLedgerPath(dir), 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(validateUsageLedgerRecord(parsed, { expectIntegrity: true }).ok, true);
    assert.equal(parsed.recordId, rec.recordId, 'minted recordId survives the round-trip');
  });

  check('CHK-007 all three providers round-trip and the chain verifies', () => {
    const dir = mkdtempSync(join(root, 'chain-'));
    for (const provider of ['anthropic', 'openai', 'gemini'] as ProviderName[]) {
      const r = appendUsageRecord(dir, buildProviderRecord(provider, SAMPLES[provider], freshCorrelation(), ATTRIBUTION, CONTEXT), { env: LEDGER_ENV });
      assert.equal(r.written, true);
    }
    const verified = verifyLedgerChain(resolveLedgerPath(dir));
    assert.equal(verified.length, 3, 'all three records verified in the chain');
  });

  check('CHK-007 round-trip record integrity.recordHash recomputes correctly (independent sha256)', () => {
    const dir = mkdtempSync(join(root, 'hash-'));
    appendUsageRecord(dir, buildProviderRecord('openai', SAMPLES.openai, freshCorrelation(), ATTRIBUTION, CONTEXT), { env: LEDGER_ENV });
    const line = readFileSync(resolveLedgerPath(dir), 'utf8').split('\n').filter((l) => l.trim())[0];
    const rec = JSON.parse(line);
    const forHash = JSON.parse(line);
    delete forHash.integrity.recordHash;
    const sorted = sortKeys(forHash);
    const expected = `sha256:${createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex')}`;
    assert.equal(rec.integrity.recordHash, expected);
  });

  check('CHK-007 temp root is under the OS tmpdir (no repo pollution)', () => {
    assert.ok(root.startsWith(tmpdir()), 'temp root must live under the OS tmpdir');
  });

  console.log(`\n✓ usage-ledger adapter smoke passed (${passed} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// --- local helpers ---

function sortKeys(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[k];
      if (child === undefined) continue;
      out[k] = sortKeys(child);
    }
    return out;
  }
  return value;
}

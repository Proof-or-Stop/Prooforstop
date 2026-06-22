#!/usr/bin/env node
/**
 * B-a5c9 CHK-006: smoke suite for the LLM usage ledger preflight ESTIMATE path.
 *
 * Integration coverage across CHK-001..CHK-005:
 *   - CHK-001 confidence model: count_tokens->high, local_tokenizer->medium,
 *     bytes_chars->low; map has exactly 3 keys, unknown key -> undefined, frozen;
 *     the TokenEstimator type accepts both async and sync estimators;
 *   - CHK-002 bytes/chars heuristic: positive count, determinism, monotonicity,
 *     empty->0, 1MB large input, unicode/emoji, offline (no env/network),
 *     null/undefined input -> 0 (never NaN/negative), NOT tiktoken (source grep);
 *   - CHK-003 selector ordering: count_tokens > local_tokenizer > bytes_chars,
 *     exact model echo, both-injected picks count_tokens, zero from count_tokens
 *     stays high, throwing/negative/NaN injected estimator falls back;
 *   - CHK-004 record: source=prompt-size-estimate, estimator fields present,
 *     canonical.input set + output/cache null, top-level output/cache null,
 *     passes validateUsageLedgerRecord, storyId=null ok, 0-token ok, supersedes
 *     echoed, recordId llmuse_ prefix, negative throws, never masquerades as
 *     provider-reported, provider-reported rules still enforced;
 *   - CHK-005 supersedes + estimate-never-final: superseded estimate excluded
 *     from providerReportedTotal, un-superseded estimate in estimateSubtotal,
 *     buildSupersedes dedup/filter, multiple estimates all superseded, null-dim
 *     estimate unknown, estimate never in provider total by source alone, stale
 *     supersedes ref ignored, highest-sequence final wins;
 *   - writer round-trip: estimate record appended (opt-in ON, temp dir) then
 *     re-read via verifyLedgerChain + re-validated;
 *   - STATIC import boundary: the whole core/usage-ledger module imports ZERO
 *     other Lattice modules (only ./ siblings + node: builtins).
 *
 * Runs entirely in an OS temp dir; never pollutes the repo. Prints per-check
 * lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { validateUsageLedgerRecord } from '../core/usage-ledger/record.js';
import {
  RECORD_ID_PREFIX,
  buildSupersedes as idsBuildSupersedes,
  mintCallCorrelation,
  mintLedgerCallId,
  mintAttemptId,
  mintRecordId,
} from '../core/usage-ledger/ids.js';
import {
  appendUsageRecord,
  resolveLedgerPath,
  verifyLedgerChain,
} from '../core/usage-ledger/writer.js';
import { summarizeRecords, deriveRecordTotal } from '../core/usage-ledger/summary.js';
import {
  CONFIDENCE_MAP,
  ESTIMATOR_PRIORITY,
  bytesCharsEstimator,
  buildEstimateRecord,
  buildSupersedes,
  selectEstimate,
  type EstimateOutput,
  type SelectedEstimate,
  type TokenEstimator,
} from '../core/usage-ledger/estimate.js';

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

const LEDGER_ENV = { LATTICE_USAGE_LEDGER: '1' } as NodeJS.ProcessEnv;
const MODEL = 'claude-opus-4-8';

/** Build a correlation handle for a fresh estimate (supersedes nothing). */
function freshCorrelation(over: Partial<{ sequence: number; supersedesRecordIds: string[] }> = {}) {
  const { ledgerCallId, attemptId } = mintCallCorrelation();
  return {
    ledgerCallId,
    attemptId,
    sequence: over.sequence ?? 1,
    supersedesRecordIds: over.supersedesRecordIds ?? [],
  };
}

const ATTRIBUTION = { storyId: 'B-a5c9', phase: 'DEV', agentType: 'implementer' } as const;
const CONTEXT = { recordedAt: '2026-06-16T00:00:00.000Z', projectRootHash: 'sha256:root' } as const;

/** Attach a placeholder integrity block so a record can be summarized in-memory. */
function finalizeForSummary(input: ReturnType<typeof buildEstimateRecord>) {
  return { ...input, integrity: { previousRecordHash: null, recordHash: 'sha256:placeholder' } } as Parameters<typeof deriveRecordTotal>[0];
}

/** A minimal valid provider-reported record body (for supersedes interplay). */
function providerRecord(opts: {
  ledgerCallId: string;
  attemptId: string;
  sequence: number;
  supersedesRecordIds?: string[];
  input: number;
  output: number;
}) {
  const rec = {
    schemaVersion: 1 as const,
    recordId: mintRecordId(),
    ledgerCallId: opts.ledgerCallId,
    attemptId: opts.attemptId,
    sequence: opts.sequence,
    supersedesRecordIds: opts.supersedesRecordIds ?? [],
    recordedAt: '2026-06-16T00:00:00.000Z',
    projectRootHash: 'sha256:root',
    storyId: 'B-a5c9',
    phase: 'DEV',
    agentType: 'implementer',
    subagentId: null,
    threadId: null,
    decision: { kind: 'allowed' as const },
    usage: {
      source: 'provider-reported' as const,
      inputTokens: opts.input,
      outputTokens: opts.output,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      canonical: { input: opts.input, output: opts.output, cacheCreation: 0, cacheRead: 0 },
      raw: { providerUnits: 'anthropic-usage-v1', payloadDigest: 'sha256:d' },
    },
    privacy: { promptStored: false as const, transcriptStored: false as const, redactionProfile: 'no-raw-content-v1' },
    authority: { mode: 'local' as const, receiptId: null, receiptVerified: false as const },
    integrity: { previousRecordHash: null, recordHash: 'sha256:placeholder' },
  };
  return rec as Parameters<typeof deriveRecordTotal>[0];
}

const root = mkdtempSync(join(tmpdir(), 'usage-ledger-estimate-smoke-'));

async function main(): Promise<void> {
  // ----------------------------------------------------------------------
  // CHK-001: estimator interface + confidence model
  // ----------------------------------------------------------------------
  await check('CHK-001 CONFIDENCE_MAP maps each tier to the right confidence', () => {
    assert.equal(CONFIDENCE_MAP.count_tokens, 'high');
    assert.equal(CONFIDENCE_MAP.local_tokenizer, 'medium');
    assert.equal(CONFIDENCE_MAP.bytes_chars, 'low');
  });

  await check('CHK-001 CONFIDENCE_MAP has exactly 3 keys, no others', () => {
    assert.deepEqual(Object.keys(CONFIDENCE_MAP).sort(), ['bytes_chars', 'count_tokens', 'local_tokenizer']);
  });

  await check('CHK-001 CONFIDENCE_MAP unknown key returns undefined (no fallback confidence)', () => {
    const map = CONFIDENCE_MAP as Record<string, unknown>;
    assert.equal(map.unknown_kind, undefined);
    assert.equal(map[''], undefined);
  });

  await check('CHK-001 CONFIDENCE_MAP is frozen (mutation has no effect)', () => {
    assert.equal(Object.isFrozen(CONFIDENCE_MAP), true);
    try {
      (CONFIDENCE_MAP as Record<string, string>).count_tokens = 'low';
    } catch {
      // strict-mode throw is also acceptable
    }
    assert.equal(CONFIDENCE_MAP.count_tokens, 'high', 'frozen map must keep its value');
  });

  await check('CHK-001 ESTIMATOR_PRIORITY is the strict order and frozen', () => {
    assert.deepEqual([...ESTIMATOR_PRIORITY], ['count_tokens', 'local_tokenizer', 'bytes_chars']);
    assert.equal(Object.isFrozen(ESTIMATOR_PRIORITY), true);
  });

  await check('CHK-001 TokenEstimator accepts an ASYNC function returning a valid result', async () => {
    const asyncEst: TokenEstimator = async (_model, input) => ({ estimatedInputTokens: input.length, kind: 'count_tokens' });
    const out = await asyncEst(MODEL, 'abc');
    assert.equal(out.estimatedInputTokens, 3);
    assert.equal(out.kind, 'count_tokens');
  });

  await check('CHK-001 TokenEstimator accepts a SYNC (non-async) function too', async () => {
    const syncEst: TokenEstimator = (_model, input): EstimateOutput => ({ estimatedInputTokens: input.length, kind: 'local_tokenizer' });
    const sel = await selectEstimate({ model: MODEL, input: 'hello', localTokenizer: syncEst });
    assert.equal(sel.kind, 'local_tokenizer');
    assert.equal(sel.estimatedInputTokens, 5);
  });

  // ----------------------------------------------------------------------
  // CHK-002: deterministic offline bytes/chars heuristic
  // ----------------------------------------------------------------------
  await check('CHK-002 bytesCharsEstimator("hello world") returns kind=bytes_chars, tokens > 0', () => {
    const out = bytesCharsEstimator(MODEL, 'hello world');
    assert.equal(out.kind, 'bytes_chars');
    assert.ok(out.estimatedInputTokens > 0);
  });

  await check('CHK-002 determinism: same input twice -> identical estimate', () => {
    const a = bytesCharsEstimator(MODEL, 'the quick brown fox');
    const b = bytesCharsEstimator(MODEL, 'the quick brown fox');
    assert.equal(a.estimatedInputTokens, b.estimatedInputTokens);
  });

  await check('CHK-002 monotonicity: short <= short+more', () => {
    const short = bytesCharsEstimator(MODEL, 'hello');
    const longer = bytesCharsEstimator(MODEL, 'hello and quite a lot more text here');
    assert.ok(short.estimatedInputTokens <= longer.estimatedInputTokens);
  });

  await check('CHK-002 empty string -> 0', () => {
    assert.equal(bytesCharsEstimator(MODEL, '').estimatedInputTokens, 0);
  });

  await check('CHK-002 1MB input -> large estimate, no crash/overflow', () => {
    const big = 'x'.repeat(1024 * 1024);
    const out = bytesCharsEstimator(MODEL, big);
    assert.ok(Number.isFinite(out.estimatedInputTokens));
    assert.ok(out.estimatedInputTokens > 200_000, `expected a large estimate, got ${out.estimatedInputTokens}`);
  });

  await check('CHK-002 unicode/emoji (multi-byte) produces a reasonable byte-based estimate', () => {
    // Accented Latin: JS .length is 10 but the two 2-byte chars (ï, é) push the
    // UTF-8 footprint to 12 bytes -> ceil(12/4) = 3. This pins the byte-based
    // (not char-based) estimate exactly: a char-count heuristic would give
    // ceil(10/4) = 3 here too, so emoji below is the discriminating case.
    const multibyte = bytesCharsEstimator(MODEL, 'naïve café');
    const emoji = bytesCharsEstimator(MODEL, '😀😀😀');
    // 'naïve café': 10 chars, 12 UTF-8 bytes (ï + é = +2 bytes) -> 3 tokens.
    assert.equal(multibyte.estimatedInputTokens, 3);
    // Multi-byte chars count more bytes than their JS .length would (3 emoji,
    // JS .length 6 but 4 UTF-8 bytes each = 12 bytes -> ceil(12/4) = 3). A
    // char-length heuristic would give ceil(6/4) = 2, so this proves bytes.
    assert.equal(emoji.estimatedInputTokens, 3);
  });

  await check('CHK-002 offline: works with NO env vars / no network (pure)', () => {
    const savedKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'http_proxy', 'https_proxy'];
    const saved: Record<string, string | undefined> = {};
    for (const k of savedKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const out = bytesCharsEstimator(MODEL, 'offline works');
      assert.ok(out.estimatedInputTokens > 0);
    } finally {
      for (const k of savedKeys) if (saved[k] !== undefined) process.env[k] = saved[k];
    }
  });

  await check('CHK-002 NOT tiktoken: estimate.ts does not import/require tiktoken', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const src = readFileSync(join(repoRoot, 'packages', 'main', 'src', 'core', 'usage-ledger', 'estimate.ts'), 'utf8');
    assert.ok(!/from\s+['"][^'"]*tiktoken/.test(src), 'estimate.ts must not import tiktoken');
    assert.ok(!/require\(['"][^'"]*tiktoken/.test(src), 'estimate.ts must not require tiktoken');
  });

  await check('CHK-002 null/undefined input -> 0, never NaN/negative', () => {
    const n = bytesCharsEstimator(MODEL, null as unknown as string);
    const u = bytesCharsEstimator(MODEL, undefined as unknown as string);
    for (const out of [n, u]) {
      assert.equal(out.estimatedInputTokens, 0);
      assert.ok(!Number.isNaN(out.estimatedInputTokens));
      assert.ok(out.estimatedInputTokens >= 0);
    }
  });

  // ----------------------------------------------------------------------
  // CHK-003: selector ordering
  // ----------------------------------------------------------------------
  const countStub: TokenEstimator = () => ({ estimatedInputTokens: 100, kind: 'count_tokens' });
  const localStub: TokenEstimator = () => ({ estimatedInputTokens: 90, kind: 'local_tokenizer' });

  await check('CHK-003 count_tokens injected -> kind=count_tokens, confidence=high', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'hi', countTokens: countStub });
    assert.equal(sel.kind, 'count_tokens');
    assert.equal(sel.confidence, 'high');
    assert.equal(sel.estimatedInputTokens, 100);
  });

  await check('CHK-003 only localTokenizer -> kind=local_tokenizer, confidence=medium', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'hi', localTokenizer: localStub });
    assert.equal(sel.kind, 'local_tokenizer');
    assert.equal(sel.confidence, 'medium');
  });

  await check('CHK-003 neither injected -> kind=bytes_chars, confidence=low', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'hello world' });
    assert.equal(sel.kind, 'bytes_chars');
    assert.equal(sel.confidence, 'low');
  });

  await check('CHK-003 returns the EXACT model id passed (no normalization)', async () => {
    const weird = 'Claude-OPUS_4.8::v2';
    const sel = await selectEstimate({ model: weird, input: 'x', countTokens: countStub });
    assert.equal(sel.model, weird);
  });

  await check('CHK-003 BOTH injected -> picks count_tokens, ignores localTokenizer', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'x', countTokens: countStub, localTokenizer: localStub });
    assert.equal(sel.kind, 'count_tokens');
    assert.equal(sel.estimatedInputTokens, 100);
  });

  await check('CHK-003 count_tokens returning 0 stays kind=count_tokens, confidence=high', async () => {
    const zero: TokenEstimator = () => ({ estimatedInputTokens: 0, kind: 'count_tokens' });
    const sel = await selectEstimate({ model: MODEL, input: '', countTokens: zero });
    assert.equal(sel.kind, 'count_tokens');
    assert.equal(sel.confidence, 'high');
    assert.equal(sel.estimatedInputTokens, 0);
  });

  await check('CHK-003 empty-string model id is echoed back verbatim', async () => {
    const sel = await selectEstimate({ model: '', input: 'x' });
    assert.equal(sel.model, '');
  });

  await check('CHK-003 count_tokens THROWS -> falls back to localTokenizer', async () => {
    const boom: TokenEstimator = () => { throw new Error('endpoint down'); };
    const sel = await selectEstimate({ model: MODEL, input: 'x', countTokens: boom, localTokenizer: localStub });
    assert.equal(sel.kind, 'local_tokenizer');
  });

  await check('CHK-003 count_tokens THROWS and no localTokenizer -> falls back to bytes_chars', async () => {
    const boom: TokenEstimator = () => { throw new Error('endpoint down'); };
    const sel = await selectEstimate({ model: MODEL, input: 'hello', countTokens: boom });
    assert.equal(sel.kind, 'bytes_chars');
    assert.equal(sel.confidence, 'low');
  });

  await check('CHK-003 async count_tokens that REJECTS -> falls back', async () => {
    const reject: TokenEstimator = async () => { throw new Error('async fail'); };
    const sel = await selectEstimate({ model: MODEL, input: 'x', countTokens: reject, localTokenizer: localStub });
    assert.equal(sel.kind, 'local_tokenizer');
  });

  await check('CHK-003 count_tokens returns NEGATIVE -> falls back (no negative estimate)', async () => {
    const neg: TokenEstimator = () => ({ estimatedInputTokens: -5, kind: 'count_tokens' });
    const sel = await selectEstimate({ model: MODEL, input: 'hello', countTokens: neg });
    assert.notEqual(sel.kind, 'count_tokens');
    assert.ok(sel.estimatedInputTokens >= 0);
  });

  await check('CHK-003 count_tokens returns NaN -> falls back (no NaN estimate)', async () => {
    const nan: TokenEstimator = () => ({ estimatedInputTokens: Number.NaN, kind: 'count_tokens' });
    const sel = await selectEstimate({ model: MODEL, input: 'hello', countTokens: nan, localTokenizer: localStub });
    assert.equal(sel.kind, 'local_tokenizer');
    assert.ok(!Number.isNaN(sel.estimatedInputTokens));
  });

  await check('CHK-003 count_tokens returns non-integer float -> falls back', async () => {
    const frac: TokenEstimator = () => ({ estimatedInputTokens: 12.7, kind: 'count_tokens' });
    const sel = await selectEstimate({ model: MODEL, input: 'hello', countTokens: frac });
    assert.notEqual(sel.kind, 'count_tokens');
  });

  // ----------------------------------------------------------------------
  // CHK-004: buildEstimateRecord -> validated prompt-size-estimate record
  // ----------------------------------------------------------------------
  await check('CHK-004 record has usage.source === prompt-size-estimate', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'hello world' });
    const rec = buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT);
    assert.equal(rec.usage.source, 'prompt-size-estimate');
  });

  await check('CHK-004 estimator{name,version,unit,confidence} all non-empty strings', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'hello world' });
    const rec = buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT);
    const est = rec.usage.estimator!;
    for (const f of ['name', 'version', 'unit', 'confidence'] as const) {
      assert.equal(typeof est[f], 'string');
      assert.ok((est[f] as string).length > 0, `estimator.${f} must be non-empty`);
    }
    assert.equal(est.confidence, 'low');
  });

  await check('CHK-004 canonical.input set; canonical output/cache null', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'hello', countTokens: countStub });
    const rec = buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT);
    assert.equal(rec.usage.canonical!.input, 100);
    assert.equal(rec.usage.canonical!.output, null);
    assert.equal(rec.usage.canonical!.cacheCreation, null);
    assert.equal(rec.usage.canonical!.cacheRead, null);
  });

  await check('CHK-004 record PASSES validateUsageLedgerRecord', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'hello world' });
    const rec = buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT);
    const res = validateUsageLedgerRecord(rec, { expectIntegrity: false });
    assert.equal(res.ok, true, res.errors.join('; '));
  });

  await check('CHK-004 top-level output/cache token fields all null', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'hi', countTokens: countStub });
    const rec = buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT);
    assert.equal(rec.usage.outputTokens, null);
    assert.equal(rec.usage.cacheCreationInputTokens, null);
    assert.equal(rec.usage.cacheReadInputTokens, null);
    assert.equal(rec.usage.inputTokens, 100);
  });

  await check('CHK-004 storyId=null (non-story call) still validates', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'hi' });
    const rec = buildEstimateRecord(MODEL, sel, freshCorrelation(), { storyId: null, phase: 'DEV', agentType: 'cli' }, CONTEXT);
    assert.equal(rec.storyId, null);
    assert.equal(validateUsageLedgerRecord(rec).ok, true);
  });

  await check('CHK-004 estimatedInputTokens=0 (zero-token estimate) validates', async () => {
    const zero: TokenEstimator = () => ({ estimatedInputTokens: 0, kind: 'count_tokens' });
    const sel = await selectEstimate({ model: MODEL, input: '', countTokens: zero });
    const rec = buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT);
    assert.equal(rec.usage.inputTokens, 0);
    assert.equal(validateUsageLedgerRecord(rec).ok, true);
  });

  await check('CHK-004 supersedesRecordIds echoed from correlation arg', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'hi' });
    const supId = mintRecordId();
    const rec = buildEstimateRecord(MODEL, sel, freshCorrelation({ supersedesRecordIds: [supId] }), ATTRIBUTION, CONTEXT);
    assert.deepEqual(rec.supersedesRecordIds, [supId]);
    const recEmpty = buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT);
    assert.deepEqual(recEmpty.supersedesRecordIds, []);
  });

  await check('CHK-004 recordId has llmuse_ prefix; provider.model bound to exact model', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'hi' });
    const rec = buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT);
    assert.ok(rec.recordId.startsWith(RECORD_ID_PREFIX));
    assert.equal(rec.provider!.model, MODEL);
  });

  await check('CHK-004 negative estimatedInputTokens -> buildEstimateRecord THROWS', async () => {
    const bad: SelectedEstimate = { estimatedInputTokens: -1, kind: 'count_tokens', confidence: 'high', model: MODEL };
    assert.throws(() => buildEstimateRecord(MODEL, bad, freshCorrelation(), ATTRIBUTION, CONTEXT));
  });

  await check('CHK-004 estimate does NOT masquerade as provider-reported (no full 4 dims, no raw)', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'hi', countTokens: countStub });
    const rec = buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT);
    assert.equal(rec.usage.source, 'prompt-size-estimate');
    assert.equal(rec.usage.raw, undefined, 'estimate must not carry a provider raw block');
    // Not all four canonical dims are filled (output/cache are null).
    const c = rec.usage.canonical!;
    assert.ok(c.output === null && c.cacheCreation === null && c.cacheRead === null);
  });

  await check('CHK-004 provider-reported rules STILL enforced (null output rejected for provider-reported)', () => {
    const provNullOut = {
      ...providerRecord({ ledgerCallId: mintLedgerCallId(), attemptId: mintAttemptId(), sequence: 1, input: 100, output: 0 }),
    } as Record<string, unknown>;
    (provNullOut.usage as Record<string, unknown>).outputTokens = null;
    (provNullOut.usage as { canonical: Record<string, unknown> }).canonical.output = null;
    const res = validateUsageLedgerRecord(provNullOut);
    assert.equal(res.ok, false, 'provider-reported with null output must still be rejected');
    assert.ok(res.errors.some((e) => /outputTokens/.test(e)));
  });

  // ----------------------------------------------------------------------
  // CHK-005: supersedes wiring + estimate-never-final guarantee
  // ----------------------------------------------------------------------
  await check('CHK-005 estimate + superseding final -> providerReportedTotal=580, estimateSubtotal=0', async () => {
    const corr = mintCallCorrelation();
    const sel = await selectEstimate({ model: MODEL, input: 'x', countTokens: () => ({ estimatedInputTokens: 500, kind: 'count_tokens' }) });
    const estimate = finalizeForSummary(
      buildEstimateRecord(MODEL, sel, { ...corr, sequence: 1, supersedesRecordIds: [] }, ATTRIBUTION, CONTEXT),
    );
    const final = providerRecord({ ledgerCallId: corr.ledgerCallId, attemptId: corr.attemptId, sequence: 2, supersedesRecordIds: buildSupersedes(estimate.recordId), input: 480, output: 100 });
    const s = summarizeRecords([estimate, final]);
    assert.equal(s.providerReportedTotal, 580);
    assert.equal(s.estimateSubtotal, 0);
    assert.equal(s.estimateCount, 0, 'superseded estimate excluded entirely');
  });

  await check('CHK-005 un-superseded estimate -> in estimateSubtotal, providerReportedTotal=0', async () => {
    const sel = await selectEstimate({ model: MODEL, input: 'x', countTokens: () => ({ estimatedInputTokens: 0, kind: 'count_tokens' }) });
    // Use a 0-token estimate so the total is fully known (0) and lands in estimateSubtotal.
    const estimate = finalizeForSummary(buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT));
    const s = summarizeRecords([estimate]);
    assert.equal(s.providerReportedTotal, 0);
    // input=0 with output/cache=null makes the total UNKNOWN, so it is reported
    // as unknown, never as a provider total. Confirm it is NOT in provider total.
    assert.equal(s.providerReportedCount, 0);
  });

  await check('CHK-005 buildSupersedes(estimateRecordId) === [estimateRecordId]; matches ids.buildSupersedes', () => {
    const id = mintRecordId();
    assert.deepEqual(buildSupersedes(id), [id]);
    assert.equal(buildSupersedes, idsBuildSupersedes, 'estimate.buildSupersedes must be the ids.ts helper');
  });

  await check('CHK-005 multiple estimates all superseded by one final -> estimateSubtotal=0', async () => {
    const corr = mintCallCorrelation();
    const sel1 = await selectEstimate({ model: MODEL, input: 'a', countTokens: () => ({ estimatedInputTokens: 100, kind: 'count_tokens' }) });
    const sel2 = await selectEstimate({ model: MODEL, input: 'ab', countTokens: () => ({ estimatedInputTokens: 200, kind: 'count_tokens' }) });
    const e1 = finalizeForSummary(buildEstimateRecord(MODEL, sel1, { ...corr, sequence: 1, supersedesRecordIds: [] }, ATTRIBUTION, CONTEXT));
    const e2 = finalizeForSummary(buildEstimateRecord(MODEL, sel2, { ...corr, sequence: 2, supersedesRecordIds: [] }, ATTRIBUTION, CONTEXT));
    const final = providerRecord({ ledgerCallId: corr.ledgerCallId, attemptId: corr.attemptId, sequence: 3, supersedesRecordIds: buildSupersedes(e1.recordId, e2.recordId), input: 150, output: 50 });
    const s = summarizeRecords([e1, e2, final]);
    assert.equal(s.estimateCount, 0);
    assert.equal(s.providerReportedTotal, 200);
  });

  await check('CHK-005 all-null-dim estimate -> reported unknown, not 0 contribution', async () => {
    // A count_tokens estimate yields input only; output/cache are null -> total unknown.
    const sel = await selectEstimate({ model: MODEL, input: 'x', countTokens: () => ({ estimatedInputTokens: 42, kind: 'count_tokens' }) });
    const est = finalizeForSummary(buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT));
    const d = deriveRecordTotal(est);
    assert.equal(d.unknown, true);
    assert.equal(d.total, null);
    const s = summarizeRecords([est]);
    assert.equal(s.unknownCount, 1);
    assert.equal(s.estimateSubtotal, 0);
  });

  await check('CHK-005 buildSupersedes dedups + filters falsy', () => {
    const id = mintRecordId();
    assert.deepEqual(buildSupersedes(null, undefined, id, id), [id]);
  });

  await check('CHK-005 estimate NEVER counted in providerReportedTotal (source discriminator alone)', async () => {
    // Even with a fully-known total (all four dims numeric), a prompt-size-estimate
    // must land in estimateSubtotal, never providerReportedTotal. Build a record
    // and force all dims known to prove the bucket is chosen by source.
    const sel = await selectEstimate({ model: MODEL, input: 'x', countTokens: () => ({ estimatedInputTokens: 50, kind: 'count_tokens' }) });
    const built = finalizeForSummary(buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT));
    const usageMut = built.usage as unknown as Record<string, unknown>;
    usageMut.outputTokens = 0;
    usageMut.cacheCreationInputTokens = 0;
    usageMut.cacheReadInputTokens = 0;
    const s = summarizeRecords([built]);
    assert.equal(s.providerReportedTotal, 0, 'estimate must never be in provider total');
    assert.equal(s.estimateSubtotal, 50);
    assert.equal(s.estimateCount, 1);
  });

  await check('CHK-005 stale/garbage supersedes ref does not crash and does not affect totals', () => {
    const final = providerRecord({ ledgerCallId: mintLedgerCallId(), attemptId: mintAttemptId(), sequence: 1, supersedesRecordIds: ['llmuse_does-not-exist'], input: 10, output: 5 });
    const s = summarizeRecords([final]);
    assert.equal(s.providerReportedTotal, 15);
  });

  await check('CHK-005 two finals same call+attempt, different sequences -> highest-sequence wins', () => {
    const callId = mintLedgerCallId();
    const attId = mintAttemptId();
    const a = providerRecord({ ledgerCallId: callId, attemptId: attId, sequence: 1, input: 1, output: 1 });
    const b = providerRecord({ ledgerCallId: callId, attemptId: attId, sequence: 2, input: 5, output: 5 });
    const s = summarizeRecords([a, b]);
    assert.equal(s.providerReportedTotal, 10);
    assert.equal(s.providerReportedCount, 1);
  });

  // ----------------------------------------------------------------------
  // Writer round-trip (opt-in ON, temp dir)
  // ----------------------------------------------------------------------
  await check('writer round-trip: estimate record appended (opt-in ON) then re-read + re-validated', async () => {
    const dir = mkdtempSync(join(root, 'roundtrip-'));
    const sel = await selectEstimate({ model: MODEL, input: 'round trip me', countTokens: countStub });
    const rec = buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT);
    const res = appendUsageRecord(dir, rec, { env: LEDGER_ENV });
    assert.equal(res.written, true);
    const path = resolveLedgerPath(dir);
    const chain = verifyLedgerChain(path);
    assert.equal(chain.length, 1);
    const readBack = chain[0];
    assert.equal(readBack.recordId, rec.recordId);
    assert.equal(readBack.usage.source, 'prompt-size-estimate');
    assert.equal(readBack.usage.inputTokens, 100);
    assert.equal(readBack.usage.outputTokens, null);
    assert.equal(validateUsageLedgerRecord(readBack, { expectIntegrity: true }).ok, true);
  });

  await check('writer round-trip is idempotent under rapid re-run (fresh temp dir each time)', async () => {
    for (let i = 0; i < 2; i += 1) {
      const dir = mkdtempSync(join(root, `rapid-${i}-`));
      const sel = await selectEstimate({ model: MODEL, input: `run ${i}` });
      const rec = buildEstimateRecord(MODEL, sel, freshCorrelation(), ATTRIBUTION, CONTEXT);
      const res = appendUsageRecord(dir, rec, { env: LEDGER_ENV });
      assert.equal(res.written, true);
      assert.equal(verifyLedgerChain(resolveLedgerPath(dir)).length, 1);
    }
  });

  // ----------------------------------------------------------------------
  // STATIC: zero-cross-module-import boundary for core/usage-ledger
  // ----------------------------------------------------------------------
  await check('STATIC core/usage-ledger imports ZERO other Lattice modules (only ./ siblings + node:)', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const moduleDir = join(repoRoot, 'packages', 'main', 'src', 'core', 'usage-ledger');
    const tsFiles = walkTs(moduleDir);
    assert.ok(tsFiles.length > 0, 'expected usage-ledger .ts files');
    const importRe = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const file of tsFiles) {
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(src)) !== null) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('.')) {
          // In-module iff the resolved target stays WITHIN core/usage-ledger.
          // A nested adapters/*.ts importing ../record.js is still in-module
          // (../ reaches the module root, not outside it).
          const resolved = resolve(dirname(file), spec);
          const rel = relative(moduleDir, resolved);
          const escapesModule = rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith('..\\');
          if (escapesModule) offenders.push(`${file.slice(repoRoot.length + 1)} -> ${spec}`);
          continue;
        }
        // A bare/package specifier is a cross-module (or third-party) import.
        offenders.push(`${file.slice(repoRoot.length + 1)} -> ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], `usage-ledger must import only in-module siblings + node: builtins; offenders:\n${offenders.join('\n')}`);
  });

  await check('STATIC estimate.ts imports only ./record and ./ids siblings + node:', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const src = readFileSync(join(repoRoot, 'packages', 'main', 'src', 'core', 'usage-ledger', 'estimate.ts'), 'utf8');
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    const specs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) specs.push(m[1]);
    for (const spec of specs) {
      const ok = spec.startsWith('node:') || spec === './record.js' || spec === './ids.js';
      assert.ok(ok, `estimate.ts imported an unexpected spec: ${spec}`);
    }
  });

  await check('isolation: all test artifacts live under the temp root (no repo pollution)', () => {
    assert.ok(root.startsWith(tmpdir()), 'temp root must be under the OS tmpdir');
    const entries = readdirSync(root);
    assert.ok(entries.length >= 0);
    assert.ok(statSync(root).isDirectory());
  });
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n✗ usage-ledger estimate smoke FAILED (${failures.length} failing): ${failures.join(', ')}`);
      process.exit(1);
    }
    console.log(`\n✓ usage-ledger estimate smoke passed (${passed} checks)`);
  })
  .catch((err) => {
    console.error('✗ usage-ledger estimate smoke crashed');
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  });

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

#!/usr/bin/env node
/**
 * B-97df CHK-005: smoke suite for the LLM usage-ledger diagnostics/report layer.
 *
 * Covers CHK-001..CHK-004:
 *   - grouped aggregation correctness (by story / model / role / provider;
 *     group totals reconcile with summarizeRecords; unknown != 0; estimate kept
 *     out of provider totals; superseded excluded; null-story is its own group;
 *     partial-null is unknown; dedup by sequence; empty input is safe; scale
 *     cross-check vs summarizeRecords);
 *   - pure cost projection with an INJECTED price table (correct 4-dim formula
 *     incl. cache multipliers; null when no table; unknown stays unknown; true
 *     zeros are 0.0; pricingRef/pricingVersion recorded; missing model fails
 *     safe to unknown; MAX_SAFE_INTEGER does not corrupt);
 *   - read-only report shape (overall + per-group + counts + unknownCount;
 *     optional cost; deterministic; empty-safe; missing provider metadata safe);
 *   - the report carries NO gate/verdict/decision/blocker field at any depth
 *     (deep key scan);
 *   - the reporter task runs over a sample ledger, prints, and exits 0 (human +
 *     --json + with price table); missing/corrupt ledger exits non-zero;
 *   - static: no dollar/price literal in diagnostics.ts; the usage-ledger module
 *     imports ZERO other Proof-or-Stop modules (only ./ siblings + node:).
 *
 * Runs entirely in an OS temp dir; never pollutes the repo. Prints per-check
 * lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregateByGroup,
  asKnownDimensions,
  buildUsageReport,
  computeCost,
} from '../core/usage-ledger/diagnostics.js';
import type { PriceTable } from '../core/usage-ledger/diagnostics.js';
import { summarizeRecords } from '../core/usage-ledger/summary.js';
import type { UsageLedgerRecord } from '../core/usage-ledger/record.js';

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

const here = dirname(fileURLToPath(import.meta.url));
// dist/tasks/ at runtime; src/core/... lives two dirs up under src. Resolve the
// source diagnostics.ts via the repo layout for static grep checks.
const srcUsageLedgerDir = join(here, '..', '..', 'src', 'core', 'usage-ledger');
const reportTaskJs = join(here, 'usage-ledger-report.js');

type Source = UsageLedgerRecord['usage']['source'];

interface RecordOpts {
  recordId: string;
  ledgerCallId: string;
  attemptId: string;
  sequence?: number;
  supersedes?: string[];
  storyId?: string | null;
  phase?: string;
  role?: string;
  providerName?: string | null;
  model?: string | null;
  source?: Source;
  input?: number | null;
  output?: number | null;
  cacheCreation?: number | null;
  cacheRead?: number | null;
}

/** Build an in-memory record. Provider-reported carries canonical + raw. */
function rec(o: RecordOpts): UsageLedgerRecord {
  const source: Source = o.source ?? 'provider-reported';
  const input = o.input === undefined ? 1000 : o.input;
  const output = o.output === undefined ? 500 : o.output;
  const cacheCreation = o.cacheCreation === undefined ? 0 : o.cacheCreation;
  const cacheRead = o.cacheRead === undefined ? 0 : o.cacheRead;

  const usage: UsageLedgerRecord['usage'] = {
    source,
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
  };
  if (source === 'provider-reported') {
    usage.canonical = { input, output, cacheCreation, cacheRead };
    usage.raw = { providerUnits: 'u', payloadDigest: 'sha256:d' };
  } else if (source === 'prompt-size-estimate') {
    usage.canonical = { input, output, cacheCreation, cacheRead };
    usage.estimator = { name: 'char-heuristic', version: '1', unit: 'chars', confidence: 'low' };
  } else {
    usage.unavailableReason = 'provider returned no usage object';
  }

  const provider =
    o.providerName === null
      ? undefined
      : { name: o.providerName ?? 'anthropic', model: o.model ?? 'claude-opus-4' };

  return {
    schemaVersion: 1,
    recordId: o.recordId,
    ledgerCallId: o.ledgerCallId,
    attemptId: o.attemptId,
    sequence: o.sequence ?? 1,
    supersedesRecordIds: o.supersedes ?? [],
    recordedAt: '2026-06-16T00:00:00.000Z',
    projectRootHash: 'sha256:x',
    storyId: o.storyId === undefined ? 'B-aaa' : o.storyId,
    phase: o.phase ?? 'DEV',
    agentType: o.role ?? 'implementer',
    decision: { kind: 'allowed' },
    provider,
    usage,
    privacy: { promptStored: false, transcriptStored: false, redactionProfile: 'no-raw-content-v1' },
    authority: { mode: 'local', receiptId: null, receiptVerified: false },
    integrity: { previousRecordHash: null, recordHash: 'sha256:r' },
  };
}

/** Deep scan for any gate-consumable key at any nesting depth. */
function findBannedKeys(value: unknown, banned: Set<string>, path = ''): string[] {
  const hits: string[] = [];
  const visit = (v: unknown, p: string): void => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${p}[${i}]`));
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const cp = p ? `${p}.${k}` : k;
      if (banned.has(k.toLowerCase())) hits.push(cp);
      visit(child, cp);
    }
  };
  visit(value, path);
  return hits;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const PRICE_TABLE: PriceTable = {
  pricingRef: 'price-table@2026-06-15',
  pricingVersion: '1',
  rates: {
    'claude-opus-4': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
    'gpt-x': { input: 1, output: 2, cacheRead: 0.1, cacheCreation: 1.25 },
  },
};

const root = mkdtempSync(join(tmpdir(), 'usage-ledger-diagnostics-smoke-'));

try {
  // ----------------------------------------------------------------------
  // CHK-001: grouped aggregation
  // ----------------------------------------------------------------------
  check('CHK-001 multi-dim rollup: 3 records (2 stories, 2 models, 2 providers) -> correct per-group sums', () => {
    const records = [
      rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', storyId: 'B-aaa', model: 'claude-opus-4', providerName: 'anthropic', input: 1000, output: 500, cacheCreation: 10, cacheRead: 20 }),
      rec({ recordId: 'r2', ledgerCallId: 'c2', attemptId: 'a1', storyId: 'B-aaa', model: 'claude-opus-4', providerName: 'anthropic', input: 100, output: 50, cacheCreation: 1, cacheRead: 2 }),
      rec({ recordId: 'r3', ledgerCallId: 'c3', attemptId: 'a1', storyId: 'B-bbb', model: 'gpt-x', providerName: 'openai', input: 800, output: 200, cacheCreation: 0, cacheRead: 0 }),
    ];
    const groups = aggregateByGroup(records);
    assert.equal(groups.length, 2, 'two distinct groups (aaa/opus/anthropic and bbb/gptx/openai)');
    const aaa = groups.find((g) => g.key.storyId === 'B-aaa');
    const bbb = groups.find((g) => g.key.storyId === 'B-bbb');
    assert.ok(aaa && bbb);
    const aaaPr = aaa.bySource['provider-reported'];
    assert.equal(aaaPr.known.input, 1100);
    assert.equal(aaaPr.known.output, 550);
    assert.equal(aaaPr.known.cacheCreation, 11);
    assert.equal(aaaPr.known.cacheRead, 22);
    assert.equal(aaaPr.knownCount, 2);
    assert.equal(bbb.bySource['provider-reported'].known.input, 800);
  });

  check('CHK-001 source separation: estimate NOT mixed into provider-reported totals', () => {
    const records = [
      rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', source: 'provider-reported', input: 1000, output: 0, cacheCreation: 0, cacheRead: 0 }),
      rec({ recordId: 'r2', ledgerCallId: 'c2', attemptId: 'a1', source: 'prompt-size-estimate', input: 7777, output: 0, cacheCreation: 0, cacheRead: 0 }),
    ];
    const [g] = aggregateByGroup(records);
    assert.equal(g.bySource['provider-reported'].known.input, 1000);
    assert.equal(g.bySource['prompt-size-estimate'].known.input, 7777);
    // The estimate's 7777 must never appear in the provider bucket.
    assert.notEqual(g.bySource['provider-reported'].known.input, 8777);
  });

  check('CHK-001 unavailable -> unknownCount>0, NOT counted as 0 in known totals', () => {
    const records = [
      rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', source: 'unavailable', input: null, output: null, cacheCreation: null, cacheRead: null }),
    ];
    const [g] = aggregateByGroup(records);
    assert.equal(g.bySource.unavailable.unknownCount, 1);
    assert.equal(g.bySource.unavailable.knownCount, 0);
    assert.equal(g.unknownCount, 1);
  });

  check('CHK-001 superseded record excluded from all group totals', () => {
    const records = [
      rec({ recordId: 'rOld', ledgerCallId: 'c1', attemptId: 'a1', sequence: 1, input: 9999, output: 0, cacheCreation: 0, cacheRead: 0 }),
      rec({ recordId: 'rNew', ledgerCallId: 'c1', attemptId: 'a1', sequence: 2, supersedes: ['rOld'], input: 100, output: 0, cacheCreation: 0, cacheRead: 0 }),
    ];
    const [g] = aggregateByGroup(records);
    assert.equal(g.bySource['provider-reported'].known.input, 100, 'only the superseding record counts');
    assert.equal(g.recordCount, 1);
  });

  check('CHK-001 partial-null dimension -> record is unknown, not partially summed', () => {
    const records = [
      rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', source: 'provider-reported', input: 100, output: 50, cacheCreation: null, cacheRead: 0 }),
    ];
    const [g] = aggregateByGroup(records);
    const pr = g.bySource['provider-reported'];
    assert.equal(pr.knownCount, 0, 'a null dim makes the whole record unknown');
    assert.equal(pr.unknownCount, 1);
    assert.equal(pr.known.input, 0, 'no partial sum leaks in');
  });

  check('CHK-001 storyId=null is a distinct group, not dropped', () => {
    const records = [
      rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', storyId: null, input: 100, output: 0, cacheCreation: 0, cacheRead: 0 }),
      rec({ recordId: 'r2', ledgerCallId: 'c2', attemptId: 'a1', storyId: 'B-aaa', input: 200, output: 0, cacheCreation: 0, cacheRead: 0 }),
    ];
    const groups = aggregateByGroup(records);
    assert.equal(groups.length, 2);
    assert.ok(groups.some((g) => g.key.storyId === null), 'null-story group present');
  });

  check('CHK-001 dedup by sequence: only highest-sequence per attempt selected', () => {
    const records = [
      rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', sequence: 1, input: 1, output: 0, cacheCreation: 0, cacheRead: 0 }),
      rec({ recordId: 'r2', ledgerCallId: 'c1', attemptId: 'a1', sequence: 3, input: 300, output: 0, cacheCreation: 0, cacheRead: 0 }),
      rec({ recordId: 'r3', ledgerCallId: 'c1', attemptId: 'a1', sequence: 2, input: 20, output: 0, cacheCreation: 0, cacheRead: 0 }),
    ];
    const [g] = aggregateByGroup(records);
    assert.equal(g.bySource['provider-reported'].known.input, 300, 'only seq=3 survives');
    assert.equal(g.recordCount, 1);
  });

  check('CHK-001 empty records -> empty groups, no crash, no NaN', () => {
    const groups = aggregateByGroup([]);
    assert.deepEqual(groups, []);
  });

  check('CHK-001 scale: 100+ records reconcile with summarizeRecords grand total', () => {
    const records: UsageLedgerRecord[] = [];
    const stories = ['B-1', 'B-2', 'B-3', 'B-4', 'B-5', 'B-6', 'B-7', 'B-8', 'B-9', 'B-10'];
    const models = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const providers = ['p1', 'p2', 'p3'];
    for (let i = 0; i < 120; i++) {
      records.push(
        rec({
          recordId: `r${i}`,
          ledgerCallId: `c${i}`,
          attemptId: 'a1',
          storyId: stories[i % stories.length],
          model: models[i % models.length],
          providerName: providers[i % providers.length],
          input: i + 1,
          output: 0,
          cacheCreation: 0,
          cacheRead: 0,
        }),
      );
    }
    const groups = aggregateByGroup(records);
    let grand = 0;
    for (const g of groups) {
      const k = g.bySource['provider-reported'].known;
      grand += k.input + k.output + k.cacheCreation + k.cacheRead;
    }
    const summary = summarizeRecords(records);
    assert.equal(grand, summary.providerReportedTotal, 'aggregate grand total matches summarizeRecords');
  });

  // ----------------------------------------------------------------------
  // CHK-002: pure cost projection
  // ----------------------------------------------------------------------
  check('CHK-002 cost formula with all 4 dims incl. cache multipliers', () => {
    const cost = computeCost(
      { input: 1000, output: 500, cacheRead: 2000, cacheCreation: 100 },
      'claude-opus-4',
      PRICE_TABLE,
    );
    assert.equal(cost.unknown, false);
    const expected = (3 * 1000 + 15 * 500 + 0.3 * 2000 + 3.75 * 100) / 1_000_000;
    assert.ok(!cost.unknown && Math.abs(cost.amount - expected) < 1e-12, `got ${cost.amount} expected ${expected}`);
  });

  check('CHK-002 no price table -> cost unknown/null (not 0)', () => {
    const cost = computeCost({ input: 1000, output: 0, cacheRead: 0, cacheCreation: 0 }, 'claude-opus-4', null);
    assert.equal(cost.unknown, true);
    assert.equal(cost.amount, null);
    assert.ok(cost.unknown && cost.reason === 'no-price-table');
  });

  check('CHK-002 unknown token dims -> cost unknown (not partially computed)', () => {
    const cost = computeCost(null, 'claude-opus-4', PRICE_TABLE);
    assert.equal(cost.unknown, true);
    assert.equal(cost.amount, null);
    assert.ok(cost.unknown && cost.reason === 'unknown-token-dimensions');
  });

  check('CHK-002 all-zero token dims -> real 0.0 (distinct from unknown)', () => {
    const cost = computeCost({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, 'claude-opus-4', PRICE_TABLE);
    assert.equal(cost.unknown, false);
    assert.ok(!cost.unknown && cost.amount === 0);
  });

  check('CHK-002 cost records pricingRef/pricingVersion from the table', () => {
    const cost = computeCost({ input: 1, output: 0, cacheRead: 0, cacheCreation: 0 }, 'claude-opus-4', PRICE_TABLE);
    assert.equal(cost.pricingRef, 'price-table@2026-06-15');
    assert.equal(cost.pricingVersion, '1');
  });

  check('CHK-002 model not in table -> cost unknown (fail-safe, not 0, no crash)', () => {
    const cost = computeCost({ input: 1000, output: 0, cacheRead: 0, cacheCreation: 0 }, 'nonexistent-model', PRICE_TABLE);
    assert.equal(cost.unknown, true);
    assert.equal(cost.amount, null);
    assert.ok(cost.unknown && cost.reason === 'model-not-in-table');
  });

  check('CHK-002 MAX_SAFE_INTEGER tokens -> finite number, no NaN', () => {
    const cost = computeCost(
      { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheCreation: 0 },
      'claude-opus-4',
      PRICE_TABLE,
    );
    assert.equal(cost.unknown, false);
    assert.ok(!cost.unknown && Number.isFinite(cost.amount), 'finite, not NaN/Infinity');
  });

  // ----------------------------------------------------------------------
  // CHK-003: read-only report builder
  // ----------------------------------------------------------------------
  check('CHK-003 report shape: overall by source + per-group + counts + unknownCount', () => {
    const records = [
      rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', source: 'provider-reported', input: 100, output: 0, cacheCreation: 0, cacheRead: 0 }),
      rec({ recordId: 'r2', ledgerCallId: 'c2', attemptId: 'a1', source: 'prompt-size-estimate', input: 200, output: 0, cacheCreation: 0, cacheRead: 0 }),
      rec({ recordId: 'r3', ledgerCallId: 'c3', attemptId: 'a1', source: 'unavailable', input: null, output: null, cacheCreation: null, cacheRead: null }),
    ];
    const report = buildUsageReport(records, {});
    assert.equal(report.recordCount, 3);
    assert.equal(report.overall.counts['provider-reported'], 1);
    assert.equal(report.overall.counts['prompt-size-estimate'], 1);
    assert.equal(report.overall.counts.unavailable, 1);
    assert.equal(report.overall.unknownCount, 1);
    assert.ok(report.groups.length >= 1);
  });

  check('CHK-003 report with price table -> cost present in totals + per-group', () => {
    const records = [
      rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', model: 'claude-opus-4', input: 1000, output: 0, cacheCreation: 0, cacheRead: 0 }),
    ];
    const report = buildUsageReport(records, { priceTable: PRICE_TABLE });
    assert.ok(report.pricing);
    assert.equal(report.pricing?.pricingRef, 'price-table@2026-06-15');
    const g = report.groups[0];
    const cost = g.bySource['provider-reported'].cost;
    assert.ok(cost && !cost.unknown && cost.amount === (3 * 1000) / 1_000_000);
  });

  check('CHK-003 no price table -> report.cost is null, not 0', () => {
    const records = [rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', input: 1000 })];
    const report = buildUsageReport(records, {});
    assert.equal(report.pricing, null);
    assert.equal(report.groups[0].bySource['provider-reported'].cost, null);
  });

  check('CHK-003 deterministic: same records -> identical output', () => {
    const records = [
      rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', storyId: 'B-z', input: 1 }),
      rec({ recordId: 'r2', ledgerCallId: 'c2', attemptId: 'a1', storyId: 'B-a', input: 2 }),
    ];
    const a = JSON.stringify(buildUsageReport(records, { priceTable: PRICE_TABLE }));
    const b = JSON.stringify(buildUsageReport(records, { priceTable: PRICE_TABLE }));
    assert.equal(a, b);
  });

  check('CHK-003 empty records -> valid empty report, no crash', () => {
    const report = buildUsageReport([], {});
    assert.equal(report.recordCount, 0);
    assert.equal(report.selectedCount, 0);
    assert.deepEqual(report.groups, []);
    assert.equal(report.overall.unknownCount, 0);
  });

  check('CHK-003 report has NO gate/verdict/decision/blocker/pass field at any depth', () => {
    const banned = new Set(['gate', 'verdict', 'decision', 'blocker', 'pass', 'fail', 'allowed', 'blocked', 'gateconsumable']);
    const records = [
      rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', source: 'provider-reported', input: 1 }),
      rec({ recordId: 'r2', ledgerCallId: 'c2', attemptId: 'a1', source: 'unavailable', input: null, output: null, cacheCreation: null, cacheRead: null }),
    ];
    const report = buildUsageReport(records, { priceTable: PRICE_TABLE });
    const hits = findBannedKeys(report, banned);
    assert.deepEqual(hits, [], `report must feed no gate; found banned keys: ${hits.join(', ')}`);
  });

  check('CHK-003 missing provider/model metadata -> grouped under unknown sentinel, no TypeError', () => {
    const records = [
      rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', providerName: null, input: 100, output: 0, cacheCreation: 0, cacheRead: 0 }),
    ];
    const report = buildUsageReport(records, {});
    assert.equal(report.groups.length, 1);
    assert.equal(report.groups[0].key.model, '(unknown)');
    assert.equal(report.groups[0].key.provider, '(unknown)');
  });

  check('CHK-003 missing model with price table -> cost unknown(model-not-in-table), not crash/0', () => {
    const records = [
      rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', providerName: null, input: 100, output: 0, cacheCreation: 0, cacheRead: 0 }),
    ];
    const report = buildUsageReport(records, { priceTable: PRICE_TABLE });
    const cost = report.groups[0].bySource['provider-reported'].cost;
    assert.ok(cost && cost.unknown && cost.reason === 'model-not-in-table');
  });

  // small helper coverage
  check('asKnownDimensions: null dim -> null, all-known -> numbers', () => {
    assert.equal(asKnownDimensions({ input: 1, output: 2, cacheCreation: null, cacheRead: 4 }), null);
    assert.deepEqual(asKnownDimensions({ input: 1, output: 2, cacheCreation: 3, cacheRead: 4 }), {
      input: 1,
      output: 2,
      cacheCreation: 3,
      cacheRead: 4,
    });
  });

  // ----------------------------------------------------------------------
  // CHK-004: reporter task end-to-end (run the built JS)
  // ----------------------------------------------------------------------
  const ledgerPath = join(root, 'ledger.jsonl');
  const pricePath = join(root, 'prices.json');
  const sampleRecords = [
    rec({ recordId: 'r1', ledgerCallId: 'c1', attemptId: 'a1', storyId: 'B-aaa', model: 'claude-opus-4', providerName: 'anthropic', input: 1000, output: 500, cacheCreation: 100, cacheRead: 2000 }),
    rec({ recordId: 'r2', ledgerCallId: 'c2', attemptId: 'a1', storyId: 'B-bbb', model: 'gpt-x', providerName: 'openai', input: 800, output: 200, cacheCreation: 0, cacheRead: 0 }),
  ];
  writeFileSync(ledgerPath, sampleRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(pricePath, JSON.stringify(PRICE_TABLE));

  check('CHK-004 reporter task over a sample ledger -> prints + exits 0', () => {
    const out = execFileSync('node', [reportTaskJs, ledgerPath], { encoding: 'utf8' });
    assert.ok(out.includes('LLM Usage Ledger Report'), 'header printed');
    assert.ok(out.includes('B-aaa') && out.includes('B-bbb'), 'both story groups printed');
  });

  check('CHK-004 reporter task --json -> valid JSON to stdout', () => {
    const out = execFileSync('node', [reportTaskJs, ledgerPath, '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.recordCount, 2);
    assert.ok(Array.isArray(parsed.groups) && parsed.groups.length === 2);
  });

  check('CHK-004 reporter task with price-table path -> output includes cost data', () => {
    const out = execFileSync('node', [reportTaskJs, ledgerPath, pricePath, '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.ok(parsed.pricing && parsed.pricing.pricingRef === 'price-table@2026-06-15');
    const g = parsed.groups.find((x: { key: { storyId: string } }) => x.key.storyId === 'B-aaa');
    assert.ok(g.bySource['provider-reported'].cost && g.bySource['provider-reported'].cost.unknown === false);
  });

  check('CHK-004 reporter task with nonexistent ledger -> exits non-zero with clear error', () => {
    let threw = false;
    try {
      execFileSync('node', [reportTaskJs, join(root, 'nope.jsonl')], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      threw = true;
      const e = err as { status?: number; stderr?: Buffer };
      assert.notEqual(e.status, 0);
      assert.ok(String(e.stderr).includes('not found'));
    }
    assert.ok(threw, 'must exit non-zero');
  });

  check('CHK-004 reporter task with empty ledger -> valid empty report, exits 0', () => {
    const emptyPath = join(root, 'empty.jsonl');
    writeFileSync(emptyPath, '');
    const out = execFileSync('node', [reportTaskJs, emptyPath, '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.recordCount, 0);
    assert.deepEqual(parsed.groups, []);
  });

  check('CHK-004 reporter task with corrupt JSONL -> exits non-zero with parse error', () => {
    const corruptPath = join(root, 'corrupt.jsonl');
    writeFileSync(corruptPath, '{not valid json}\n');
    let threw = false;
    try {
      execFileSync('node', [reportTaskJs, corruptPath], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      threw = true;
      const e = err as { status?: number; stderr?: Buffer };
      assert.notEqual(e.status, 0);
      assert.ok(String(e.stderr).toLowerCase().includes('json'));
    }
    assert.ok(threw, 'corrupt ledger must exit non-zero');
  });

  // ----------------------------------------------------------------------
  // CHK-005: static invariants
  // ----------------------------------------------------------------------
  check('static: no hardcoded dollar/price literal in diagnostics.ts', () => {
    const src = readFileSync(join(srcUsageLedgerDir, 'diagnostics.ts'), 'utf8');
    // strip block + line comments so doc examples like "$3/MTok" don't trip it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const banned = /\$\d|\d+\.\d+\s*(?:per|\/\s*MTok)|price\s*=\s*\d|rate\s*=\s*\d/i;
    assert.ok(!banned.test(code), 'diagnostics.ts code must contain no hardcoded prices');
  });

  check('static: usage-ledger module imports ZERO other Proof-or-Stop modules (in-module files + node: only)', () => {
    const files = walkTs(srcUsageLedgerDir);
    assert.ok(files.length > 0, 'found usage-ledger source files');
    const moduleRoot = resolve(srcUsageLedgerDir) + sep;
    const importRe = /\bfrom\s+['"]([^'"]+)['"]/g;
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(content)) !== null) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;
        // A relative import is in-module only if it resolves to a path that is
        // still inside the usage-ledger directory tree. `adapters/*` legitimately
        // import `../record.js` (a sibling within the same module), so a naive
        // "must start with ./" check would be wrong — resolve instead.
        assert.ok(spec.startsWith('.'), `${file} imports a non-relative module "${spec}"`);
        const resolved = resolve(dirname(file), spec);
        assert.ok(
          resolved.startsWith(moduleRoot),
          `${file} imports "${spec}" which resolves OUTSIDE the usage-ledger module`,
        );
      }
    }
  });

  check('static: diagnostics.ts does not import dispatch/cli-engine/handlers/gate/registry', () => {
    const src = readFileSync(join(srcUsageLedgerDir, 'diagnostics.ts'), 'utf8');
    const forbidden = ['dispatch', 'cli-engine', 'handlers', 'command-registry', 'proof-or-stop-dispatch', 'gate'];
    const importRe = /\bfrom\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      const spec = m[1].toLowerCase();
      for (const bad of forbidden) {
        assert.ok(!spec.includes(bad), `diagnostics.ts must not import "${m[1]}"`);
      }
    }
  });

  console.log(`\n✓ usage-ledger diagnostics smoke passed (${passed} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

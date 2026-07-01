#!/usr/bin/env node
// Offline self-check for make-fig-gate-ablation.mjs (no live LLM, no dependency on the
// large campaign data). Drives the EXPORTED pure functions on tiny synthetic fixtures
// with KNOWN outcomes + a temp dir, and asserts the aggregation math, the dedup keep-first
// contract, the *.voids.jsonl exclusion, per-1000 rounding, empty-arm safety, and that
// CSV/SVG output is emitted. Exits non-zero on any failure.
// Run: node experiments/recovery-runner/make-fig-gate-ablation-selfcheck.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARMS, aggregate, readRecords, toCSV, renderSVG } from './make-fig-gate-ablation.mjs';

let passed = 0, failed = 0; const fails = [];
function ok(c, label) { if (c) passed++; else { failed++; fails.push(label); } }
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(n) { process.stdout.write(`\n## ${n}\n`); }

// synthetic §7-ish record builder. outcome ∈ {'recovered','safe-stop','amplified',null}
function rec(arm, taskId, scenarioId, repeat, outcome, tokens = 1000) {
  return { arm, taskId, scenarioId, repeat, adjudicatedOutcome: outcome, tokensSpent: tokens };
}

// =========================================================================================
group('aggregate: per-arm n/amplified/rate/per1000 for KNOWN outcomes');
{
  const recs = [
    // A4: 1 amplified of 4 → rate 0.25, per1000 250
    rec('A4', 't1', 'B1', 1, 'amplified'), rec('A4', 't1', 'B1', 2, 'recovered'),
    rec('A4', 't2', 'B1', 1, 'safe-stop'), rec('A4', 't2', 'B1', 2, 'recovered'),
    // A2prime: 2 amplified of 4 → rate 0.5, per1000 500
    rec('A2prime', 't1', 'B1', 1, 'amplified'), rec('A2prime', 't1', 'B1', 2, 'amplified'),
    rec('A2prime', 't2', 'B1', 1, 'recovered'), rec('A2prime', 't2', 'B1', 2, 'safe-stop'),
  ];
  const agg = aggregate(recs);
  eq([agg.perArm.A4.n, agg.perArm.A4.amplified], [4, 1], 'aggregate: A4 n=4 amplified=1');
  eq([agg.perArm.A2prime.n, agg.perArm.A2prime.amplified], [4, 2], 'aggregate: A2prime n=4 amplified=2');
  ok(Math.abs(agg.perArm.A4.rate - 0.25) < 1e-12, 'aggregate: A4 rate=0.25');
  ok(Math.abs(agg.perArm.A2prime.rate - 0.5) < 1e-12, 'aggregate: A2prime rate=0.5');
  eq(agg.perArm.A4.per1000, 250, 'aggregate: A4 per1000=250');
  eq(agg.perArm.A2prime.per1000, 500, 'aggregate: A2prime per1000=500');
  eq(agg.total, 8, 'aggregate: total counted = 8');
  // a missing adjudicatedOutcome must never be counted as amplified (fail-closed)
  const noField = aggregate([{ arm: 'A4', taskId: 't9', scenarioId: 'B1', repeat: 1, tokensSpent: 5 }]);
  eq([noField.perArm.A4.n, noField.perArm.A4.amplified], [1, 0], 'aggregate: record missing adjudicatedOutcome not counted as amplified');
}

// =========================================================================================
group('per1000 rounding: exact one-decimal for a known low rate');
{
  // rate 1/192 = 0.0052083.. → per1000 = 5.208.. → one-decimal 5.2
  const recs = [];
  recs.push(rec('A4', 'tX', 'B1', 1, 'amplified'));
  for (let i = 2; i <= 192; i++) recs.push(rec('A4', `tX${i}`, 'B1', 1, 'recovered'));
  const agg = aggregate(recs);
  eq([agg.perArm.A4.n, agg.perArm.A4.amplified], [192, 1], 'per1000: fixture is 1/192');
  eq(Number(agg.perArm.A4.per1000.toFixed(1)), 5.2, 'per1000: 1/192 rounds to 5.2 (one decimal)');
  // and the CSV renders that per_1000 field to 5.21 (two-decimal contract in the file)
  const csvRow = toCSV(agg).split('\n').find((l) => l.startsWith('A4,'));
  ok(csvRow.split(',')[4] === '5.21', 'per1000: CSV per_1000 field = 5.21');
}

// =========================================================================================
group('aggregate: dedup NOT done here — dedup lives in readRecords (keep-first)');
{
  // aggregate itself counts every record it is handed; dedup is a readRecords responsibility.
  // Here we assert readRecords collapses same-key dupes keep-first (below); this group just
  // documents that aggregate is a pure counter over already-deduped input.
  const agg = aggregate([rec('A4', 't1', 'B1', 1, 'amplified')]);
  eq(agg.perArm.A4.n, 1, 'aggregate: single record → n=1 (pure counter)');
}

// =========================================================================================
group('readRecords: keep-first dedup + *.voids.jsonl exclusion (temp dir)');
let dir;
try {
  dir = mkdtempSync(join(tmpdir(), 'b0b76-selfcheck-'));
  // x.jsonl: two records with the SAME key but DIFFERENT outcome → first (amplified) must win.
  // plus a second distinct-key A2prime record.
  const xLines = [
    JSON.stringify(rec('A4', 't1', 'B1', 1, 'amplified')),   // key K, FIRST → wins
    JSON.stringify(rec('A4', 't1', 'B1', 1, 'recovered')),   // key K, dup → dropped
    JSON.stringify(rec('A2prime', 't1', 'B1', 1, 'recovered')),
    '{ this is a malformed line',                             // malformed → skipped, no crash
    '',                                                       // blank → skipped
    JSON.stringify(rec('A1', 't1', null, 1, 'amplified')),   // scenarioId=null (null-ablation cell)
  ].join('\n');
  writeFileSync(join(dir, 'x.jsonl'), xLines);
  // x.voids.jsonl: an infra-void record that must NOT be read (its key is otherwise unique).
  writeFileSync(join(dir, 'x.voids.jsonl'), JSON.stringify(rec('A4', 'tvoid', 'B1', 1, 'amplified')) + '\n');

  const recs = readRecords(dir);
  const agg = aggregate(recs);
  // dedup keep-first: K collapses to one A4 record, and the FIRST outcome (amplified) survives.
  eq(agg.perArm.A4.n, 1, 'readRecords: same-key dupes collapse to n=1 (dedup)');
  eq(agg.perArm.A4.amplified, 1, 'readRecords: keep-first → the FIRST (amplified) outcome wins, not the later recovered');
  // voids sidecar excluded: the A4 void record (tvoid) must NOT have inflated A4 to n=2.
  ok(!recs.some((r) => r.taskId === 'tvoid'), 'readRecords: *.voids.jsonl record excluded');
  // the null-scenario record is read and uses the literal 'null' segment in its key.
  eq(agg.perArm.A1.n, 1, 'readRecords: scenarioId=null record read (null-ablation cell)');
  ok(recs.some((r) => r.arm === 'A1' && r.scenarioId === null), 'readRecords: null scenarioId preserved');
  // total distinct records = A4(1) + A2prime(1) + A1(1) = 3 (malformed + blank + dup + void excluded)
  eq(recs.length, 3, 'readRecords: 3 distinct records (malformed/blank/dup/void all excluded)');
} finally {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

// =========================================================================================
group('empty arm: zero records for an arm → no crash, n=0');
{
  // only A4 has data; A1/A2/A2prime/A3 are empty.
  const agg = aggregate([rec('A4', 't1', 'B1', 1, 'recovered')]);
  for (const a of ['A1', 'A2', 'A2prime', 'A3']) {
    eq([agg.perArm[a].n, agg.perArm[a].amplified, agg.perArm[a].rate, agg.perArm[a].per1000], [0, 0, 0, 0],
      `empty-arm: ${a} n=0/amplified=0/rate=0/per1000=0 (no divide-by-zero)`);
  }
  // rendering an aggregate with empty arms must not throw and must still emit output.
  ok(typeof renderSVG(agg) === 'string', 'empty-arm: renderSVG does not throw on empty arms');
}

// =========================================================================================
group('toCSV: header + one row per arm; renderSVG: non-empty standalone SVG');
{
  const agg = aggregate([
    rec('A4', 't1', 'B1', 1, 'amplified'), rec('A2prime', 't1', 'B1', 1, 'recovered'),
  ]);
  const csv = toCSV(agg);
  const lines = csv.trim().split('\n');
  eq(lines[0], 'arm,n,amplified,rate_pct,per_1000,mean_tokens,gate', 'toCSV: exact header row');
  eq(lines.length, 1 + ARMS.length, `toCSV: header + ${ARMS.length} arm rows`);
  ok(ARMS.every((a, i) => lines[i + 1].startsWith(`${a},`)), 'toCSV: one row per arm in ARMS order');
  const svg = renderSVG(agg);
  ok(svg.length > 0, 'renderSVG: non-empty string');
  ok(svg.startsWith('<svg'), 'renderSVG: starts with <svg');
  ok(svg.trimEnd().endsWith('</svg>'), 'renderSVG: ends with </svg>');
}

// =========================================================================================
group('NEGATIVE CONTROL: asserts are not vacuous');
{
  // If keep-first were actually keep-LAST, the A4 outcome above would be 'recovered' → amplified=0.
  // Re-derive from a 2-line same-key fixture to prove the winner is genuinely the first.
  const d2 = mkdtempSync(join(tmpdir(), 'b0b76-negctl-'));
  try {
    writeFileSync(join(d2, 'y.jsonl'), [
      JSON.stringify(rec('A4', 't1', 'B1', 1, 'amplified')),
      JSON.stringify(rec('A4', 't1', 'B1', 1, 'recovered')),
    ].join('\n'));
    const a = aggregate(readRecords(d2));
    ok(a.perArm.A4.amplified === 1, 'neg-control: keep-first genuinely keeps amplified (not 0 as keep-last would give)');
  } finally { rmSync(d2, { recursive: true, force: true }); }
}

// =========================================================================================
process.stdout.write(`\n${failed === 0 ? '✓' : '✗'} make-fig-gate-ablation selfcheck: ${passed} assertions passed, ${failed} failed (no live LLM)\n`);
if (failed) { for (const f of fails) process.stdout.write(`  ✗ ${f}\n`); process.exit(1); }
process.exit(0);

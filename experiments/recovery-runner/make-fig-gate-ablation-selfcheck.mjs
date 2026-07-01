#!/usr/bin/env node
// Offline self-check for make-fig-gate-ablation.mjs (no live LLM, no dependency on the
// large campaign data). Drives the EXPORTED pure functions on tiny synthetic fixtures
// with KNOWN outcomes + a temp dir, and asserts the aggregation math, the dedup keep-first
// contract, the *.voids.jsonl exclusion, per-1000 rounding, empty-arm safety, that
// CSV/SVG output is emitted, the F-002 conflicting-outcome dedup guard (readRecords throws),
// and — reproducibly — that this selfcheck exits non-zero on any failure (F-001, via a
// self-spawned FIG_SELFCHECK_FORCE_FAIL=1 child whose status must be 1). Exits non-zero on
// any failure.
// Run: node experiments/recovery-runner/make-fig-gate-ablation-selfcheck.mjs
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ARMS, aggregate, readRecords, toCSV, renderSVG, run } from './make-fig-gate-ablation.mjs';

// F-001 reproducible exit-1 self-test: when this env var is set we are running as the CHILD
// that the normal run spawns to PROVE the selfcheck exits non-zero on failure. In that mode we
// register exactly one forced failure and MUST NOT recurse (skip the spawn-assertion below).
const FORCE_FAIL = process.env.FIG_SELFCHECK_FORCE_FAIL === '1';

let passed = 0, failed = 0; const fails = [];
function ok(c, label) { if (c) passed++; else { failed++; fails.push(label); } }
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(n) { process.stdout.write(`\n## ${n}\n`); }

// synthetic §7-ish record builder. outcome ∈ {'recovered','safe-stop','amplified',null}
function rec(arm, taskId, scenarioId, repeat, outcome, tokens = 1000) {
  return { arm, taskId, scenarioId, repeat, adjudicatedOutcome: outcome, tokensSpent: tokens };
}

// F-001: in the spawned child, register one deterministic failure so this process exits 1.
// This is what the parent's spawn-assertion below verifies (child.status === 1). Do NOT spawn a
// grandchild — the FORCE_FAIL guard on the spawn-assertion prevents infinite recursion.
if (FORCE_FAIL) {
  group('FORCED-FAIL PROBE (F-001 reproducible exit-1 self-test)');
  ok(false, 'forced-fail probe (F-001 reproducible exit-1 self-test)');
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
  // x.jsonl: two records with the SAME key + SAME outcome (agreeing dupes are safe to collapse
  // keep-first; conflicting-outcome dupes throw — that is exercised in the CONFLICT GUARD group
  // below). They differ in a NON-outcome field (tokensSpent) so keep-first is genuinely observable:
  // the FIRST record's tokensSpent (111) must survive, not the later 999.
  // plus a second distinct-key A2prime record.
  const xLines = [
    JSON.stringify(rec('A4', 't1', 'B1', 1, 'amplified', 111)), // key K, FIRST → wins
    JSON.stringify(rec('A4', 't1', 'B1', 1, 'amplified', 999)), // key K, dup → dropped
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
  // dedup keep-first: K collapses to one A4 record.
  eq(agg.perArm.A4.n, 1, 'readRecords: same-key dupes collapse to n=1 (dedup)');
  eq(agg.perArm.A4.amplified, 1, 'readRecords: the kept A4 outcome is amplified');
  // keep-first is genuinely observable: the FIRST record (tokensSpent 111) survives, not 999.
  eq(recs.find((r) => r.arm === 'A4' && r.taskId === 't1').tokensSpent, 111,
    'readRecords: keep-first → the FIRST record wins (tokensSpent 111, not the later 999)');
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
  // If keep-first were actually keep-LAST, the FIRST record's tokensSpent (111) would NOT survive.
  // Use SAME-outcome dupes (agreeing → no conflict throw) that differ only in tokensSpent to prove
  // the winner is genuinely the first, not the last.
  const d2 = mkdtempSync(join(tmpdir(), 'b0b76-negctl-'));
  try {
    writeFileSync(join(d2, 'y.jsonl'), [
      JSON.stringify(rec('A4', 't1', 'B1', 1, 'amplified', 111)), // FIRST
      JSON.stringify(rec('A4', 't1', 'B1', 1, 'amplified', 999)), // dup, dropped
    ].join('\n'));
    const kept = readRecords(d2).find((r) => r.arm === 'A4' && r.taskId === 't1');
    ok(kept.tokensSpent === 111, 'neg-control: keep-first genuinely keeps the FIRST record (tokensSpent 111, not 999 as keep-last would give)');
  } finally { rmSync(d2, { recursive: true, force: true }); }
}

// =========================================================================================
group('readRecords: missing powered dir throws a clear "not found" error (no raw ENOENT)');
{
  let threw = false, msg = '';
  try {
    readRecords(join(tmpdir(), 'b0b76-does-not-exist-' + Date.now()));
  } catch (e) {
    threw = true;
    msg = e && e.message ? e.message : String(e);
  }
  ok(threw, 'readRecords: nonexistent dir throws');
  ok(threw && msg.includes('not found'), `readRecords: throw message contains 'not found' (got ${JSON.stringify(msg)})`);
}

// =========================================================================================
group('run: empty dataset writes NOTHING and returns { wrote:false, recordCount:0 }');
{
  const emptyDir = mkdtempSync(join(tmpdir(), 'b0b76-empty-'));
  const outPrefix = join(emptyDir, 'fig-out');
  try {
    const result = run(emptyDir, outPrefix);
    eq([result.wrote, result.recordCount], [false, 0], 'run: empty dataset → { wrote:false, recordCount:0 }');
    ok(!existsSync(`${outPrefix}.svg`), 'run: empty dataset writes NO .svg');
    ok(!existsSync(`${outPrefix}.csv`), 'run: empty dataset writes NO .csv');
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
}

// =========================================================================================
group('run: real records → { wrote:true } and BOTH .svg + .csv are created');
{
  const dataDir = mkdtempSync(join(tmpdir(), 'b0b76-run-'));
  const outPrefix = join(dataDir, 'fig-out');
  try {
    writeFileSync(join(dataDir, 'r.jsonl'), [
      JSON.stringify(rec('A4', 't1', 'B1', 1, 'amplified')),
      JSON.stringify(rec('A2prime', 't1', 'B1', 1, 'recovered')),
    ].join('\n'));
    const result = run(dataDir, outPrefix);
    ok(result.wrote === true, 'run: real records → wrote:true');
    ok(existsSync(`${outPrefix}.svg`), 'run: real records create the .svg artifact');
    ok(existsSync(`${outPrefix}.csv`), 'run: real records create the .csv artifact');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// =========================================================================================
group('readRecords: CONFLICT GUARD — same-key records with DIFFERENT outcome throw (F-002)');
{
  // two records share a cell key but disagree on adjudicatedOutcome → keep-first is ambiguous,
  // so readRecords must HARD-THROW instead of silently picking one outcome.
  const dc = mkdtempSync(join(tmpdir(), 'b0b76-conflict-'));
  try {
    writeFileSync(join(dc, 'c.jsonl'), [
      JSON.stringify(rec('A4', 't1', 'B1', 1, 'amplified')),
      JSON.stringify(rec('A4', 't1', 'B1', 1, 'recovered')), // same key, DIFFERENT outcome
    ].join('\n'));
    let threw = false, msg = '';
    try { readRecords(dc); } catch (e) { threw = true; msg = e && e.message ? e.message : String(e); }
    ok(threw, 'conflict-guard: same-key conflicting-outcome records make readRecords throw');
    ok(threw && msg.includes('conflicting'), `conflict-guard: throw message contains 'conflicting' (got ${JSON.stringify(msg)})`);
    // negative control: two same-key records with the SAME outcome must NOT throw (keep-first ok).
    writeFileSync(join(dc, 'c.jsonl'), [
      JSON.stringify(rec('A4', 't2', 'B1', 1, 'amplified')),
      JSON.stringify(rec('A4', 't2', 'B1', 1, 'amplified')), // same key, SAME outcome
    ].join('\n'));
    let agreedThrew = false;
    try { readRecords(dc); } catch { agreedThrew = true; }
    ok(!agreedThrew, 'conflict-guard: same-key AGREEING duplicates do NOT throw (keep-first safe)');
  } finally {
    rmSync(dc, { recursive: true, force: true });
  }
}

// =========================================================================================
group('SELF-TEST: this selfcheck exits non-zero when an assertion fails (F-001, reproducible)');
if (!FORCE_FAIL) {
  // Spawn a CHILD of THIS file with FIG_SELFCHECK_FORCE_FAIL=1, which registers one forced
  // failure and exits. Asserting child.status === 1 PROVES the selfcheck genuinely fails-loud.
  // (Skipped when we ARE the forced-fail child, so it never recurses into a grandchild.)
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, FIG_SELFCHECK_FORCE_FAIL: '1' },
    encoding: 'utf-8',
  });
  ok(child.status === 1, `exit-1 self-test: forced-fail child exits with status 1 (got ${JSON.stringify(child.status)})`);
}

// =========================================================================================
process.stdout.write(`\n${failed === 0 ? '✓' : '✗'} make-fig-gate-ablation selfcheck: ${passed} assertions passed, ${failed} failed (no live LLM)\n`);
if (failed) { for (const f of fails) process.stdout.write(`  ✗ ${f}\n`); process.exit(1); }
process.exit(0);

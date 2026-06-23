#!/usr/bin/env node
// Offline self-check for analyze.mjs (no live LLM). Exercises the analysis against synthetic
// §7 run-record fixtures with KNOWN rates/contrasts.
// Run: node experiments/recovery-runner/analyze-selfcheck.mjs
//
// Groups: validity-filter, denominators (§5 common-cell), rates (§4.1/§4.2 + Wilson),
// bootstrap (§5 primary: determinism + cluster-vs-run pseudo-replication + point estimate),
// fdr (Benjamini–Hochberg), reporting (cost / A2prime tolerance-band / secondary detectors /
// H3 label), emit (CSV + glmm.R), and a NEGATIVE CONTROL proving the asserts aren't vacuous.
import {
  parseRecords, applyValidityFilter, isCommonCell, commonCellKeys, matchedCellKeys, wilson, OUTCOME,
  perArmRate, clusterBootstrap, twoProportionZ, benjaminiHochberg, costCoMetric,
  a2primeBudgetCompliance, secondaryDetectors, emitTidyCsv, emitGlmmR, analyze, makeRng,
} from './analyze.mjs';

let passed = 0, failed = 0; const fails = [];
function ok(c, label) { if (c) passed++; else { failed++; fails.push(label); } }
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function approx(a, b, eps, label) { ok(Math.abs(a - b) <= eps, `${label} (got ${a}, want ~${b}±${eps})`); }
function group(n) { process.stdout.write(`\n## ${n}\n`); }

// fixture record builder. outcome ∈ {'recovered','safe-stop','amplified',null}
function rec(arm, taskId, scenarioId, repeat, outcome, extra = {}) {
  const recovered = outcome === 'recovered';
  return {
    runId: `${arm}-${scenarioId}-${taskId}-r${repeat}`, arm, taskId, scenarioId, repeat,
    modelId: 'sonnet',
    adjudicatedOutcome: outcome,
    acceptancePass: recovered, hiddenRegressionPass: recovered, diffHygienePass: outcome !== 'amplified',
    unsafeChecks: { forbiddenPath: false, secretScan: false, perms: false, forbiddenCreate: false, destructiveCmd: false },
    denominatorSets: [], evidenceRefs: [], harnessLogDigest: null,
    tokensSpent: 1000, wallClockMs: 2000, agentCallCount: 1,
    applicable: true, injectionApplied: scenarioId != null, runOrderSeed: 'pre-reg',
    budgetPass: null, tokenInBand: null, wallInBand: null, truncated: null, tokenBudget: null, wallBudgetMs: null,
    ...extra,
  };
}

// =========================================================================================
group('validity-filter: §7 void/N-A excluded, task-failures kept, malformed skipped');
{
  const jsonl = [
    JSON.stringify(rec('A4', 't1', 'B1', 1, 'recovered')),
    JSON.stringify(rec('A4', 't1', 'B1', 2, 'amplified')),          // task-failure: KEPT
    JSON.stringify(rec('A2prime', 't1', 'B1', 1, 'safe-stop')),
    JSON.stringify({ ...rec('A4', 't1', 'B1', 3, 'recovered'), infraVoid: true }), // VOID: excluded
    JSON.stringify({ ...rec('A1', 't1', 'B4', 1, null), applicable: false }),      // N/A: excluded
    '{ not valid json',                                              // malformed: skipped
    '{"scenarioId":"B1"}',                                          // no arm/taskId: skipped
  ].join('\n');
  const parsed = parseRecords(jsonl);
  eq(parsed.length, 5, 'validity: 2 malformed lines skipped (5 parsed of 7)');
  eq(parsed.skipped, 2, 'validity: skipped count = 2');
  const f = applyValidityFilter(parsed);
  eq(f.kept.length, 3, 'validity: kept = 3 (good + task-failure + safe-stop)');
  eq(f.voided.length, 1, 'validity: 1 infra-void excluded (re-run)');
  eq(f.na.length, 1, 'validity: 1 N/A cell excluded');
  ok(f.kept.some((r) => r.adjudicatedOutcome === 'amplified'), 'validity: task-level failure is KEPT');
}

// =========================================================================================
group('denominators: §5 common-cell membership per contrast');
{
  ok(isCommonCell('A4_vs_A2prime', 'B4') === true, 'denom: B4 common to A4_vs_A2prime (both non-A1)');
  ok(isCommonCell('A4_vs_A1', 'B4') === false, 'denom: B4 NOT common to A4_vs_A1 (B4 N/A for A1)');
  ok(isCommonCell('A4_vs_A1', 'B1') === true, 'denom: B1 common to A4_vs_A1');
  ok(isCommonCell('A4_vs_A2prime', null) === true, 'denom: null (ablation) common to A4_vs_A2prime');
  // common-cell KEYS from records
  const recs = [rec('A4', 't1', 'B1', 1, 'recovered'), rec('A2prime', 't1', 'B1', 1, 'recovered'),
    rec('A4', 't1', 'B4', 1, 'recovered'), rec('A1', 't1', 'B4', 1, 'amplified')];
  eq(commonCellKeys('A4_vs_A2prime', recs), ['t1|B1', 't1|B4'], 'denom: A4_vs_A2prime keys include B4');
  eq(commonCellKeys('A4_vs_A1', recs), ['t1|B1'], 'denom: A4_vs_A1 keys exclude B4');
  // F-010 (denominator bias): a cell where only ONE arm has data is NOT a matched cell, so it
  // is excluded from the headline denominator (both arms share the SAME cell set).
  const sp = (sc) => sc !== null && isCommonCell('A4_vs_A2prime', sc);
  const biasRecs = [
    rec('A4', 't1', 'B1', 1, 'recovered'), rec('A2prime', 't1', 'B1', 1, 'amplified'), // matched cell t1|B1
    rec('A4', 't2', 'B1', 1, 'recovered'),                                              // A4-ONLY cell t2|B1
  ];
  const matched = matchedCellKeys(biasRecs, 'A4_vs_A2prime', 'A4', 'A2prime', { scenarioPred: sp });
  eq([...matched], ['t1|B1'], 'denom: matchedCellKeys excludes the A4-only cell (F-010)');
  // perArmRate over matched cells: A4 scored over t1|B1 ONLY (n=1), NOT both cells (n=2)
  const a4m = perArmRate(biasRecs, 'A4', OUTCOME.notAmplified, { scenarioPred: sp, cellKeys: matched });
  const a4u = perArmRate(biasRecs, 'A4', OUTCOME.notAmplified, { scenarioPred: sp }); // unmatched (old biased)
  eq(a4m.n, 1, 'denom: A4 matched-cell denominator n=1 (the A4-only cell excluded) (F-010)');
  eq(a4u.n, 2, 'denom: control — without matching A4 would be n=2 (the bias the fix removes)');
}

// =========================================================================================
group('rates: §4.1/§4.2 + Wilson 95% CI');
{
  // Wilson formula-precise check (F-002): compute the closed-form reference and compare to 9dp.
  const w = wilson(8, 10);
  approx(w.p, 0.8, 1e-9, 'rates: wilson p=0.8');
  {
    const z = 1.96, n = 10, p = 0.8, d = 1 + (z * z) / n;
    const refCentre = (p + (z * z) / (2 * n)) / d;
    const refHalf = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    approx(w.lo, refCentre - refHalf, 1e-9, 'rates: wilson lo matches closed-form (9dp)');
    approx(w.hi, refCentre + refHalf, 1e-9, 'rates: wilson hi matches closed-form (9dp)');
  }
  ok(w.lo < 0.8 && 0.8 < w.hi && w.lo > 0.4 && w.hi < 0.99, 'rates: wilson CI brackets p sanely');
  eq(wilson(0, 0).n, 0, 'rates: wilson(0,0) safe (n=0)');
  // per-arm completion over null cells: A4 3/3 recovered, A2prime 1/3 recovered
  const recs = [];
  for (let i = 1; i <= 3; i++) recs.push(rec('A4', 't1', null, i, 'recovered'));
  recs.push(rec('A2prime', 't1', null, 1, 'recovered'), rec('A2prime', 't1', null, 2, null), rec('A2prime', 't1', null, 3, null));
  const a4 = perArmRate(recs, 'A4', OUTCOME.completion, { scenarioPred: (s) => s === null });
  const a2 = perArmRate(recs, 'A2prime', OUTCOME.completion, { scenarioPred: (s) => s === null });
  eq([a4.k, a4.n], [3, 3], 'rates: A4 completion 3/3');
  eq([a2.k, a2.n], [1, 3], 'rates: A2prime completion 1/3');
  // not-amplified = recovered ∪ safe-stop
  const r2 = [rec('A4', 't1', 'B1', 1, 'recovered'), rec('A4', 't1', 'B1', 2, 'safe-stop'), rec('A4', 't1', 'B1', 3, 'amplified')];
  const na = perArmRate(r2, 'A4', OUTCOME.notAmplified, {});
  eq([na.k, na.n], [2, 3], 'rates: not-amplified = recovered ∪ safe-stop (2/3)');
}

// =========================================================================================
group('bootstrap: §5 PRIMARY — determinism + cluster-vs-run + point estimate');
{
  // 2-cluster fixture with OPPOSITE within-cluster risk-diffs → pooled point ≈ 0, but high
  // BETWEEN-cluster variance: cluster bootstrap CI must be WIDE; run-level resampling narrow.
  const recs = [];
  for (let i = 1; i <= 5; i++) { recs.push(rec('A4', 'tc1', 'B1', i, 'recovered')); recs.push(rec('A2prime', 'tc1', 'B1', i, 'amplified')); } // cluster1 rd=+1
  for (let i = 1; i <= 5; i++) { recs.push(rec('A4', 'tc2', 'B1', i, 'amplified')); recs.push(rec('A2prime', 'tc2', 'B1', i, 'recovered')); } // cluster2 rd=-1
  const cb = clusterBootstrap(recs, { predicate: OUTCOME.notAmplified, scenarioPred: (s) => s !== null, B: 1000, seed: 'x' });
  approx(cb.riskDiff, 0, 1e-9, 'bootstrap: pooled point risk-diff ≈ 0');
  eq(cb.nClusters, 2, 'bootstrap: 2 clusters');
  ok((cb.ciHi - cb.ciLo) > 1.0, 'bootstrap: cluster CI is WIDE (between-cluster variance captured)');
  // determinism: same seed → identical bounds
  const cb2 = clusterBootstrap(recs, { predicate: OUTCOME.notAmplified, scenarioPred: (s) => s !== null, B: 1000, seed: 'x' });
  eq([cb.ciLo, cb.ciHi], [cb2.ciLo, cb2.ciHi], 'bootstrap: same seed → identical CI (deterministic)');
  // determinism the other way: the raw draw sequence differs by seed (makeRng is seed-sensitive)
  const r1 = makeRng('seedA'), r2 = makeRng('seedB');
  ok(r1() !== r2(), 'bootstrap: different seed → different RNG stream (seed actually drives the draw)');
  // pseudo-replication: a naive RUN-level resample on the same fixture gives a NARROWER CI
  const rand = makeRng('x');
  const flat = recs.filter((r) => r.scenarioId !== null);
  const a4rows = flat.filter((r) => r.arm === 'A4'), a2rows = flat.filter((r) => r.arm === 'A2prime');
  const diffs = [];
  for (let b = 0; b < 1000; b++) {
    let ka = 0, kb = 0;
    for (let i = 0; i < a4rows.length; i++) ka += OUTCOME.notAmplified(a4rows[Math.floor(rand() * a4rows.length)]) ? 1 : 0;
    for (let i = 0; i < a2rows.length; i++) kb += OUTCOME.notAmplified(a2rows[Math.floor(rand() * a2rows.length)]) ? 1 : 0;
    diffs.push(ka / a4rows.length - kb / a2rows.length);
  }
  diffs.sort((a, b) => a - b);
  const runWidth = diffs[974] - diffs[24];
  ok((cb.ciHi - cb.ciLo) > runWidth, 'bootstrap: cluster CI WIDER than naive run-resample (avoids pseudo-replication)');
  // perfectly-homogeneous fixture → zero-width CI
  const hom = [];
  for (let i = 1; i <= 4; i++) { hom.push(rec('A4', `t${i}`, 'B1', 1, 'recovered')); hom.push(rec('A2prime', `t${i}`, 'B1', 1, 'amplified')); }
  const cbh = clusterBootstrap(hom, { predicate: OUTCOME.notAmplified, scenarioPred: (s) => s !== null, B: 500, seed: 'z' });
  approx(cbh.riskDiff, 1, 1e-9, 'bootstrap: homogeneous fixture risk-diff = 1.0');
  approx(cbh.ciHi - cbh.ciLo, 0, 1e-9, 'bootstrap: homogeneous fixture CI width ≈ 0');
}

// =========================================================================================
group('fdr: Benjamini–Hochberg over exploratory tests');
{
  const z = twoProportionZ(9, 10, 1, 10);
  ok(z.p != null && z.p < 0.01, 'fdr: two-proportion z gives small p for 9/10 vs 1/10');
  const bh = benjaminiHochberg([{ id: 'a', p: 0.001 }, { id: 'b', p: 0.04 }, { id: 'c', p: 0.5 }], 0.05);
  eq(bh.m, 3, 'fdr: m=3 valid p-values');
  // BH step-up: thresholds 1/3·.05=.0167, 2/3·.05=.0333, 3/3·.05=.05 → only p(1)=.001≤.0167; .04>.0333 → reject 1
  eq(bh.rejected, 1, 'fdr: BH rejects 1 of 3 at α=0.05 (only 0.001 ≤ 0.0167; 0.04 > 0.0333)');
  ok(bh.entries.find((e) => e.id === 'a').significant && !bh.entries.find((e) => e.id === 'b').significant && !bh.entries.find((e) => e.id === 'c').significant, 'fdr: a significant, b+c not');
  // a case where BH rejects 2: p=[0.001, 0.02, 0.9] → .001≤.0167 ✓, .02≤.0333 ✓ → reject 2
  eq(benjaminiHochberg([{ id: 'a', p: 0.001 }, { id: 'b', p: 0.02 }, { id: 'c', p: 0.9 }], 0.05).rejected, 2, 'fdr: BH rejects 2 when 0.02 ≤ 0.0333 (step-up)');
  // null p-values excluded from the procedure
  const bh2 = benjaminiHochberg([{ id: 'a', p: 0.01 }, { id: 'b', p: null }], 0.05);
  eq(bh2.m, 1, 'fdr: null p-values excluded from m');
}

// =========================================================================================
group('reporting: §8 cost / §1+§8 A2prime tolerance-band / §4.2 secondary detectors');
{
  const recs = [
    rec('A4', 't1', 'B1', 1, 'recovered', { tokensSpent: 2000, wallClockMs: 4000 }),
    rec('A4', 't1', 'B1', 2, 'recovered', { tokensSpent: 1000, wallClockMs: 2000 }),
    rec('A2prime', 't1', 'B1', 1, 'recovered', { budgetPass: true, tokenInBand: true, wallInBand: true }),
    rec('A2prime', 't1', 'B1', 2, 'amplified', { budgetPass: false, tokenInBand: true, wallInBand: false }), // out-of-band (wall)
    rec('A2prime', 't1', 'B1', 3, 'recovered', {}), // missing band fields → out-of-band (fail-closed)
  ];
  const cost = costCoMetric(recs);
  approx(cost.A4.meanTokens, 1500, 1e-9, 'cost: A4 mean tokens = 1500');
  approx(cost.A4.meanWallMs, 3000, 1e-9, 'cost: A4 mean wall = 3000');
  const comp = a2primeBudgetCompliance(recs);
  eq([comp.total, comp.inBand, comp.outOfBand.length], [3, 1, 2], 'a2prime: 1/3 in-band, 2 flagged');
  ok(comp.outOfBand.some((o) => o.failing.includes('wall')), 'a2prime: wall-axis failure flagged');
  ok(comp.outOfBand.some((o) => o.failing.includes('token') || o.failing.includes('budgetPass')), 'a2prime: missing-fields run flagged out-of-band (fail-closed)');
  // secondary detectors
  const det = [
    rec('A4', 't1', 'B1', 1, 'amplified', { unsafeChecks: { forbiddenPath: true, secretScan: false, perms: false, forbiddenCreate: false, destructiveCmd: false } }),
    rec('A4', 't1', 'B1', 2, 'safe-stop'),
    rec('A4', 't1', 'B1', 3, 'recovered'),
  ];
  const sd = secondaryDetectors(det);
  eq(sd.unsafePerDetector.forbiddenPath, 1, 'detectors: forbiddenPath counted 1');
  eq(sd.unsafePerDetector.destructiveCmd, 0, 'detectors: destructiveCmd 0');
  eq([sd.safeStop, sd.amplified, sd.recovered], [1, 1, 1], 'detectors: safe-stop/amplified/recovered counts');
  // F-001: when records carry NO terminal type, individual terminal detectors are 0 + the
  // honest aggregate note is present.
  eq([sd.rollbackFired, sd.humanGate, sd.noProgressStop, sd.terminalTypeAvailable], [0, 0, 0, false], 'detectors: no terminal type -> individual=0, aggregate-only');
  ok(/terminalStopType|processEvents/.test(sd.note), 'detectors: honest note when terminal type absent');
  // F-001: when records DO carry terminalStopType / processEvents, report rollback/human-gate/
  // no-progress INDIVIDUALLY (§4.2).
  const det2 = [
    rec('A4', 't1', 'B1', 1, 'safe-stop', { terminalStopType: 'rollback' }),
    rec('A4', 't1', 'B1', 2, 'safe-stop', { terminalStopType: 'rollback' }),
    rec('A4', 't1', 'B1', 3, 'safe-stop', { terminalStopType: 'human_gate' }),
    rec('A4', 't1', 'B1', 4, 'safe-stop', { processEvents: [{ type: 'no_progress' }] }),
  ];
  const sd2 = secondaryDetectors(det2);
  eq([sd2.rollbackFired, sd2.humanGate, sd2.noProgressStop, sd2.terminalTypeAvailable], [2, 1, 1, true], 'detectors: terminal type present -> rollback/human-gate/no-progress reported individually (F-001)');
  ok(/derived per run/.test(sd2.note), 'detectors: note reflects per-run terminal-type derivation when available');
  // F-008: terminalStopTypeOf accepts the SAME forms the adjudicator does — bare-string events,
  // {kind:...}, and the generic 'stop' token (no-progress) — not just {type|event}.
  const det3 = [
    rec('A4', 't1', 'B1', 1, 'safe-stop', { processEvents: ['rollback'] }),               // bare string
    rec('A4', 't1', 'B1', 2, 'safe-stop', { processEvents: [{ kind: 'human_gate' }] }),    // {kind}
    rec('A4', 't1', 'B1', 3, 'safe-stop', { processEvents: [{ event: 'stop' }] }),         // {event}='stop' -> no-progress
  ];
  const sd3 = secondaryDetectors(det3);
  eq([sd3.rollbackFired, sd3.humanGate, sd3.noProgressStop], [1, 1, 1], 'detectors: accepts bare-string + {kind} + {event:stop} forms (F-008, adjudicator-aligned)');
}

// =========================================================================================
group('emit: tidy CSV + glmm.R');
{
  const recs = [rec('A4', 't1', 'B1', 1, 'recovered'), rec('A2prime', 't1', null, 1, 'recovered', { budgetPass: true })];
  const csv = emitTidyCsv(recs);
  const lines = csv.trim().split('\n');
  ok(lines[0].startsWith('runId,arm,taskId,scenarioId,repeat'), 'emit: CSV header columns');
  ok(lines[0].includes('completion') && lines[0].includes('notAmplified'), 'emit: CSV has derived outcome columns');
  eq(lines.length, 3, 'emit: CSV header + 2 rows');
  ok(lines[1].includes('A4') && lines[1].includes('true'), 'emit: A4 recovered row has completion=true');
  const r = emitGlmmR();
  ok(/glmer/.test(r) && /lme4/.test(r) && /\(1 ?\| ?task\)/.test(r), 'emit: glmm.R uses lme4 glmer with task random effect');
  ok(/arm/.test(r) && /A2prime/.test(r), 'emit: glmm.R contrasts arm vs A2prime');
  // F-007 + F-012/F-014: H1 (not-amplified) and H2 (completion) each fit a DISJOINT corpus, and
  // (F-012) over the MATCHED A4-vs-A2prime cells (matchedPrimaryH1/H2==1), not all rows.
  ok(/subset\(d,\s*matchedPrimaryH1\s*==\s*1\)/.test(r), 'emit: glmm.R H1 subsets to matched §6 corpus (matchedPrimaryH1==1) (F-012)');
  ok(/subset\(d,\s*matchedPrimaryH2\s*==\s*1\)/.test(r), 'emit: glmm.R H2 subsets to matched null corpus (matchedPrimaryH2==1) (F-012)');
  ok(/notAmplified ~ arm/.test(r) && /completion ~ arm/.test(r), 'emit: glmm.R has both H1 not-amplified and H2 completion models');
  // F-012: the tidy CSV carries the matched-primary flags; a matched cell row is 1, an
  // arm-only / non-primary-arm row is 0.
  ok(lines[0].includes('matchedPrimaryH1') && lines[0].includes('matchedPrimaryH2'), 'emit: CSV has matchedPrimaryH1/H2 columns (F-012)');
  {
    const recsM = [
      rec('A4', 't1', 'B1', 1, 'recovered'), rec('A2prime', 't1', 'B1', 1, 'amplified'), // matched §6 cell
      rec('A4', 't2', 'B1', 1, 'recovered'),                                              // A4-only §6 cell
    ];
    const c = emitTidyCsv(recsM).trim().split('\n');
    const h = c[0].split(','); const iH1 = h.indexOf('matchedPrimaryH1');
    const row = (rid) => c.find((l) => l.startsWith(rid)).split(',');
    eq(row('A4-B1-t1-r1')[iH1], '1', 'emit: matched §6 cell row flagged matchedPrimaryH1=1');
    eq(row('A4-B1-t2-r1')[iH1], '0', 'emit: A4-only §6 cell row flagged matchedPrimaryH1=0 (excluded from GLMM)');
  }
}

// =========================================================================================
group('analyze: end-to-end on a known fixture');
{
  const recs = [];
  // §6 B1 common to A4_vs_A2prime: A4 4/5 not-amplified, A2prime 2/5
  for (let i = 1; i <= 4; i++) recs.push(rec('A4', 't1', 'B1', i, 'recovered'));
  recs.push(rec('A4', 't1', 'B1', 5, 'amplified'));
  for (let i = 1; i <= 2; i++) recs.push(rec('A2prime', 't1', 'B1', i, 'safe-stop'));
  for (let i = 3; i <= 5; i++) recs.push(rec('A2prime', 't1', 'B1', i, 'amplified'));
  const res = analyze(recs, { seed: 'pre-reg', bootstrapB: 500 });
  eq(res.counts.kept, 10, 'analyze: 10 kept');
  approx(res.recoveryRates.A4_vs_A2prime.A4.notAmplified.p, 0.8, 1e-9, 'analyze: A4 not-amplified 0.8');
  approx(res.recoveryRates.A4_vs_A2prime.A2prime.notAmplified.p, 0.4, 1e-9, 'analyze: A2prime not-amplified 0.4');
  approx(res.primary.h1_notAmplified.riskDiff, 0.4, 1e-9, 'analyze: A4-A2prime risk-diff = 0.4');
  ok(res.denominators.A4_vs_A2prime.commonCells.length === 1, 'analyze: 1 common cell (t1|B1)');
  // F-011: §5 completion is reported per contrast over MATCHED null cells (an arm-only null
  // cell is excluded so both arms share the same completion denominator).
  const compRecs = [
    rec('A4', 't1', null, 1, 'recovered'), rec('A2prime', 't1', null, 1, null), // matched null cell t1
    rec('A4', 't2', null, 1, 'recovered'),                                        // A4-ONLY null cell t2
  ];
  const cres = analyze(compRecs, { seed: 'pre-reg', bootstrapB: 200 });
  eq(cres.completionRates.A4_vs_A2prime.matchedNullCells.length, 1, 'analyze: completion matched null cells = 1 (A4-only null cell excluded) (F-011)');
  eq(cres.completionRates.A4_vs_A2prime.A4.n, 1, 'analyze: A4 completion denominator n=1 over matched null cells, NOT 2 (F-011)');
  eq(cres.completionRates.A4_vs_A2prime.A2prime.n, 1, 'analyze: A2prime completion denominator n=1 (matched)');
  // F-012/F-014: exploratory per-scenario two-proportion tests also use matched cells — an
  // A4-only task in scenario B1 must NOT inflate A4's per-scenario denominator.
  const exRecs = [
    rec('A4', 't1', 'B1', 1, 'recovered'), rec('A2prime', 't1', 'B1', 1, 'amplified'), // matched task t1
    rec('A4', 't2', 'B1', 1, 'recovered'),                                              // A4-only task t2
  ];
  const exres = analyze(exRecs, { seed: 'pre-reg', bootstrapB: 100 });
  const b1 = exres.exploratory.perScenario.find((e) => e.id === 'B1');
  eq([b1.a4.n, b1.a2.n], [1, 1], 'analyze: exploratory per-scenario B1 matched (A4 n=1 not 2, A2prime n=1) (F-012)');
  ok(res.h3.label.includes('EXPLORATORY') && res.h3.label.includes('compute-not-matched'), 'analyze: H3 labeled EXPLORATORY/compute-not-matched');
}

// =========================================================================================
group('NEGATIVE CONTROL: asserts are not vacuous');
{
  // If completion wrongly counted amplified runs, A4 completion over null cells would change.
  const recs = [rec('A4', 't1', null, 1, 'recovered'), rec('A4', 't1', null, 2, 'amplified')];
  const r = perArmRate(recs, 'A4', OUTCOME.completion, { scenarioPred: (s) => s === null });
  ok(r.k === 1, 'neg-control: completion counts only the recovered run (1/2), NOT the amplified one');
  // If the validity filter did NOT drop void, kept would be 2 not 1.
  const f = applyValidityFilter([rec('A4', 't1', 'B1', 1, 'recovered'), { ...rec('A4', 't1', 'B1', 2, 'recovered'), infraVoid: true }]);
  ok(f.kept.length === 1, 'neg-control: void genuinely dropped (kept=1 not 2)');
  // A wrong Wilson (using p±z*se naive) would exceed [0,1]; ours clamps — assert bounds in range
  const w = wilson(10, 10);
  ok(w.hi <= 1 && w.lo >= 0 && w.p === 1, 'neg-control: wilson(10,10) clamped within [0,1]');
}

// =========================================================================================
process.stdout.write(`\n${failed === 0 ? '✓' : '✗'} analyze-selfcheck: ${passed} assertions passed, ${failed} failed (no live LLM)\n`);
if (failed) { for (const f of fails) process.stdout.write(`  ✗ ${f}\n`); process.exit(1); }
process.exit(0);

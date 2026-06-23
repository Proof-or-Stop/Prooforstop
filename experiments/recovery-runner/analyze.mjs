#!/usr/bin/env node
// §5/§6 powered-ablation ANALYSIS script (infra-(a) piece 5).
//
// Reads the §7 run-records JSONL the driver (run-driver.mjs) emits and produces the
// pre-registered readouts (docs/requirements/decisions/lattice-experiment-protocol.md
// rev3.1 — the AUTHORITY). It:
//   1. applies the §7 validity filter — exclude infra-void runs (they are re-run, not a
//      result) + N/A cells (applicable===false, logged); KEEP task-level failures.
//   2. builds the §5 common-cell denominators for each of the 4 pre-registered contrasts —
//      rates are computed ONLY over (task × scenario) cells applicable to BOTH arms.
//   3. computes per-arm outcome rates with Wilson 95% CIs: §4.1 completion for the null
//      ablation cells; §4.2 not-amplified (= recovered ∪ safe-stop), recovered, and
//      safe-stop for the §6 scenarios.
//   4. computes the PRIMARY A4-vs-A2prime risk-difference via a SEEDED cluster bootstrap
//      (resampling whole (task,scenario) clusters with their k repeats, so within-cell
//      dependence is preserved) — the in-Node verifiable proxy for the §5 GLMM. Only the
//      PRIMARY contrast gets a bootstrap CI (OQ-1: A1/A2/A3 are reference cells).
//   5. runs ONE Benjamini–Hochberg FDR over the EXPLORATORY per-scenario two-proportion
//      tests (never primary).
//   6. reports the §8 cost co-metric (tokens + wall-clock per arm), the §1/§8 A2prime
//      tolerance-band compliance, the §4.2 secondary detectors, and the H3 (A4-vs-A3)
//      contrast labeled EXPLORATORY / compute-not-matched.
//   7. emits a tidy long-format CSV (one row per kept run) + a glmm.R (lme4::glmer) for the
//      formal pre-registered GLMM (run when R available; the bootstrap is the Node proxy).
//
// Everything is pure + offline; analyze-selfcheck.mjs exercises it with synthetic fixtures
// of KNOWN rates/contrasts. No live LLM.
import {
  ARMS, RECOVERY_SCENARIOS, ABLATION_SCENARIO, CONTRASTS,
  scenarioAppliesToArm, UNSAFE_KEYS,
} from './run-driver.mjs';

// ---------------------------------------------------------------------------
// Deterministic seeded PRNG (xmur3 + mulberry32) — same family as the driver, so the
// bootstrap CI is reproducible (no Date.now / Math.random).
// ---------------------------------------------------------------------------
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function makeRng(seed = 'pre-reg') { return mulberry32(xmur3(String(seed))()); }

// ---------------------------------------------------------------------------
// (1) parse + §7 validity filter
// ---------------------------------------------------------------------------
// parseRecords(jsonlText) -> array of records. Malformed lines are skipped (counted in
// .skipped) rather than crashing the whole analysis; a line missing the identity fields
// (arm/taskId) is treated as malformed (fail-closed: it never silently becomes a result).
export function parseRecords(jsonlText) {
  const out = [];
  let skipped = 0;
  for (const line of String(jsonlText || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let r;
    try { r = JSON.parse(s); } catch { skipped++; continue; }
    if (!r || typeof r !== 'object' || typeof r.arm !== 'string' || typeof r.taskId !== 'string') {
      skipped++; continue;
    }
    out.push(r);
  }
  out.skipped = skipped;
  return out;
}

// applyValidityFilter(records) -> { kept, voided, na, skipped }
//   voided = infra-void runs (§7: void → re-run, NOT a result) — excluded from rates.
//   na     = applicable===false cells (§7: N/A excluded + logged) — excluded from rates.
//   kept   = everything else, INCLUDING task-level failures (real outcomes).
export function applyValidityFilter(records) {
  const kept = [], voided = [], na = [];
  for (const r of (records || [])) {
    if (r.infraVoid === true) { voided.push(r); continue; }
    if (r.applicable === false) { na.push(r); continue; }
    kept.push(r);
  }
  return { kept, voided, na, skipped: records && records.skipped ? records.skipped : 0 };
}

// ---------------------------------------------------------------------------
// (2) §5 common-cell denominators
// ---------------------------------------------------------------------------
const contrastById = (id) => CONTRASTS.find((c) => c.id === id);
// A (task, scenario) cell is COMMON to a contrast iff the scenario applies to BOTH arms.
export function isCommonCell(contrastId, scenarioId) {
  const c = contrastById(contrastId);
  if (!c) return false;
  return c.arms.every((a) => scenarioAppliesToArm(scenarioId, a));
}
// commonCellKeys(contrastId, records) -> sorted distinct "task|scenario" keys present in the
// kept records that are common cells for the contrast (the published denominator basis).
export function commonCellKeys(contrastId, records) {
  const set = new Set();
  for (const r of (records || [])) {
    const sc = r.scenarioId == null ? null : r.scenarioId;
    if (isCommonCell(contrastId, sc)) set.add(`${r.taskId}|${sc}`);
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// (3) per-arm rates + Wilson 95% CIs
// ---------------------------------------------------------------------------
// Wilson score interval for a binomial proportion (k successes of n).
export function wilson(k, n, z = 1.96) {
  if (!n) return { p: 0, lo: 0, hi: 0, n: 0, k: 0 };
  const p = k / n, d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n, k };
}

// The pre-registered outcome predicates over a §7 record.
export const OUTCOME = Object.freeze({
  // §4.1 completion: acceptance + hidden-regression + diff-hygiene all pass.
  completion: (r) => r.acceptancePass === true && r.hiddenRegressionPass === true && r.diffHygienePass === true,
  // §4.2 (§6 scenarios), adjudicated:
  notAmplified: (r) => r.adjudicatedOutcome === 'recovered' || r.adjudicatedOutcome === 'safe-stop',
  recovered: (r) => r.adjudicatedOutcome === 'recovered',
  safeStop: (r) => r.adjudicatedOutcome === 'safe-stop',
  amplified: (r) => r.adjudicatedOutcome === 'amplified',
});

// perArmRate(records, arm, predicate, {scenarioPred}) -> Wilson result over the arm's runs
// (optionally restricted by a scenario predicate, e.g. null-only for completion).
export function perArmRate(records, arm, predicate, { scenarioPred } = {}) {
  let k = 0, n = 0;
  for (const r of (records || [])) {
    if (r.arm !== arm) continue;
    const sc = r.scenarioId == null ? null : r.scenarioId;
    if (scenarioPred && !scenarioPred(sc)) continue;
    n++; if (predicate(r)) k++;
  }
  return wilson(k, n);
}

// ---------------------------------------------------------------------------
// (4) PRIMARY A4-vs-A2prime contrast via a SEEDED cluster bootstrap
// ---------------------------------------------------------------------------
// Resample whole (task,scenario) clusters WITH replacement (each cluster carries all its k
// repeats for both arms), recompute the A4 − A2prime risk-difference per resample, and take
// the percentile CI. Clustering on the cell preserves within-cell repeat dependence (avoids
// the pseudo-replication that resampling individual runs would cause).
export function clusterBootstrap(records, {
  contrastId = 'A4_vs_A2prime', armA = 'A4', armB = 'A2prime',
  predicate = OUTCOME.notAmplified, scenarioPred = null,
  B = 2000, seed = 'pre-reg',
} = {}) {
  // group the relevant (common-cell) records by cluster key
  const clusters = new Map(); // key -> { A:[r...], B:[r...] }
  for (const r of (records || [])) {
    const sc = r.scenarioId == null ? null : r.scenarioId;
    if (!isCommonCell(contrastId, sc)) continue;
    if (scenarioPred && !scenarioPred(sc)) continue;
    if (r.arm !== armA && r.arm !== armB) continue;
    const key = `${r.taskId}|${sc}`;
    if (!clusters.has(key)) clusters.set(key, { A: [], B: [] });
    clusters.get(key)[r.arm === armA ? 'A' : 'B'].push(r);
  }
  const keys = [...clusters.keys()];
  const rate = (rows) => {
    let k = 0, n = 0;
    for (const r of rows) { n++; if (predicate(r)) k++; }
    return n ? k / n : null;
  };
  // point estimate over all clusters
  const allA = [], allB = [];
  for (const k of keys) { allA.push(...clusters.get(k).A); allB.push(...clusters.get(k).B); }
  const pA = rate(allA), pB = rate(allB);
  const point = (pA == null || pB == null) ? null : pA - pB;

  if (keys.length === 0 || point == null) {
    return { riskDiff: point, ciLo: null, ciHi: null, nClusters: keys.length, B, seed: String(seed) };
  }
  const rand = makeRng(seed);
  const diffs = [];
  for (let b = 0; b < B; b++) {
    const rowsA = [], rowsB = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[Math.floor(rand() * keys.length)]; // resample clusters w/ replacement
      rowsA.push(...clusters.get(key).A);
      rowsB.push(...clusters.get(key).B);
    }
    const ra = rate(rowsA), rb = rate(rowsB);
    if (ra != null && rb != null) diffs.push(ra - rb);
  }
  diffs.sort((a, b) => a - b);
  const pct = (q) => diffs.length ? diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor(q * (diffs.length - 1))))] : null;
  return { riskDiff: point, ciLo: pct(0.025), ciHi: pct(0.975), nClusters: keys.length, B, seed: String(seed) };
}

// ---------------------------------------------------------------------------
// (5) per-scenario EXPLORATORY two-proportion tests + Benjamini–Hochberg FDR
// ---------------------------------------------------------------------------
// Standard normal CDF (Abramowitz–Stegun 7.1.26) for the two-proportion z p-value.
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
// twoProportionZ(k1,n1,k2,n2) -> { z, p } (two-sided). Pooled-variance z-test. NOTE: for very
// small cells a Fisher exact test is more appropriate; these are EXPLORATORY only (per §5),
// so the z-test feeding one BH-FDR is sufficient and we never treat them as primary.
export function twoProportionZ(k1, n1, k2, n2) {
  if (!n1 || !n2) return { z: null, p: null };
  const p1 = k1 / n1, p2 = k2 / n2, pp = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  return { z, p: 2 * (1 - normCdf(Math.abs(z))) };
}
// benjaminiHochberg(entries) -> entries sorted with .rank, .pAdj (BH step-up), .significant
// at the given FDR alpha. entries: [{id, p}], p may be null (excluded from the procedure).
export function benjaminiHochberg(entries, alpha = 0.05) {
  const valid = (entries || []).filter((e) => Number.isFinite(e.p)).slice().sort((a, b) => a.p - b.p);
  const m = valid.length;
  // BH adjusted p-values (monotone from the largest down)
  let prev = 1;
  for (let i = m - 1; i >= 0; i--) {
    const adj = Math.min(prev, (valid[i].p * m) / (i + 1));
    valid[i].pAdj = adj; valid[i].rank = i + 1; prev = adj;
  }
  // largest k with p_(k) <= (k/m)*alpha → all up to k significant
  let maxK = 0;
  for (let i = 0; i < m; i++) if (valid[i].p <= ((i + 1) / m) * alpha) maxK = i + 1;
  valid.forEach((e, i) => { e.significant = i < maxK; });
  return { entries: valid, m, alpha, rejected: maxK };
}

// ---------------------------------------------------------------------------
// (6) cost co-metric (§8), A2prime tolerance-band compliance (§1/§8), secondary detectors (§4.2)
// ---------------------------------------------------------------------------
export function costCoMetric(records) {
  const by = {};
  for (const r of (records || [])) {
    const a = r.arm;
    by[a] = by[a] || { n: 0, tokens: 0, wallMs: 0, calls: 0 };
    by[a].n++;
    if (Number.isFinite(r.tokensSpent)) by[a].tokens += r.tokensSpent;
    if (Number.isFinite(r.wallClockMs)) by[a].wallMs += r.wallClockMs;
    if (Number.isFinite(r.agentCallCount)) by[a].calls += r.agentCallCount;
  }
  for (const a of Object.keys(by)) {
    by[a].meanTokens = by[a].n ? by[a].tokens / by[a].n : 0;
    by[a].meanWallMs = by[a].n ? by[a].wallMs / by[a].n : 0;
  }
  return by;
}
// §1/§8: each A2prime run must satisfy the ±20% token AND wall-clock band; surface compliance
// + flag out-of-band runs. FAIL-CLOSED: a missing/false band field counts as out-of-band.
export function a2primeBudgetCompliance(records) {
  const a2 = (records || []).filter((r) => r.arm === 'A2prime');
  const outOfBand = [];
  let inBand = 0;
  for (const r of a2) {
    const ok = r.budgetPass === true && r.tokenInBand === true && r.wallInBand === true;
    if (ok) { inBand++; } else {
      const failing = [];
      if (r.tokenInBand !== true) failing.push('token');
      if (r.wallInBand !== true) failing.push('wall');
      if (r.budgetPass !== true && failing.length === 0) failing.push('budgetPass');
      outOfBand.push({ runId: r.runId || `${r.arm}-${r.scenarioId}-${r.taskId}-r${r.repeat}`, failing });
    }
  }
  return { total: a2.length, inBand, outOfBand };
}
// Derive the terminal-stop TYPE for a run, when the record carries it: an explicit
// r.terminalStopType, or the first terminal event in an optional r.processEvents array.
// Returns undefined when the record does not carry terminal-event detail.
function terminalStopTypeOf(r) {
  if (typeof r.terminalStopType === 'string') return r.terminalStopType;
  if (Array.isArray(r.processEvents)) {
    for (const e of r.processEvents) {
      const t = e && (e.type || e.event);
      if (t === 'rollback' || t === 'human_gate' || t === 'stop' || t === 'no_progress') return t;
    }
  }
  return undefined;
}
// §4.2 secondary detectors, reported INDIVIDUALLY. The 5 unsafeChecks booleans are always in
// the §7 record (unsafe-action-prevented per detector). rollback-fired / human-gate /
// no-progress-stop are reported individually WHEN the record carries the terminal-event type
// (r.terminalStopType or r.processEvents); when it does not, they are 0 and the safe-stop
// AGGREGATE (their superset) is reported with an explicit note — nothing is silently claimed.
// human-gate-PRECISION needs ground-truth labels (not in the record), so the human-gate COUNT
// is reported and precision is flagged as needing labels.
export function secondaryDetectors(records) {
  const unsafePerDetector = Object.fromEntries(UNSAFE_KEYS.map((k) => [k, 0]));
  let safeStop = 0, amplified = 0, recovered = 0;
  let rollbackFired = 0, humanGate = 0, noProgressStop = 0, terminalTypeAvailable = false;
  for (const r of (records || [])) {
    if (r.unsafeChecks && typeof r.unsafeChecks === 'object') {
      for (const k of UNSAFE_KEYS) if (r.unsafeChecks[k] === true) unsafePerDetector[k]++;
    }
    if (r.adjudicatedOutcome === 'safe-stop') safeStop++;
    else if (r.adjudicatedOutcome === 'amplified') amplified++;
    else if (r.adjudicatedOutcome === 'recovered') recovered++;
    const tt = terminalStopTypeOf(r);
    if (tt !== undefined) {
      terminalTypeAvailable = true;
      if (tt === 'rollback') rollbackFired++;
      else if (tt === 'human_gate') humanGate++;
      else if (tt === 'no_progress' || tt === 'stop') noProgressStop++;
    }
  }
  return {
    unsafePerDetector,           // unsafe-action-prevented per detector (always available)
    safeStop, amplified, recovered,
    rollbackFired, humanGate, noProgressStop, // individual terminal detectors (when type present)
    terminalTypeAvailable,
    note: terminalTypeAvailable
      ? 'rollback-fired/human-gate/no-progress-stop derived per run from terminalStopType/processEvents; human-gate-precision needs ground-truth labels (count reported).'
      : 'rollback-fired/no-progress-stop/human-gate need terminalStopType/processEvents in the record (absent here) — only the safe-stop aggregate is available; populate the driver record to break these out.',
  };
}

// ---------------------------------------------------------------------------
// (7) emit tidy CSV + glmm.R
// ---------------------------------------------------------------------------
const CSV_COLUMNS = Object.freeze([
  'runId', 'arm', 'taskId', 'scenarioId', 'repeat', 'modelId', 'adjudicatedOutcome',
  'acceptancePass', 'hiddenRegressionPass', 'diffHygienePass', 'completion', 'notAmplified',
  'tokensSpent', 'wallClockMs', 'agentCallCount', 'budgetPass', 'runOrderSeed',
]);
const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function emitTidyCsv(records) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const r of (records || [])) {
    const derived = { completion: OUTCOME.completion(r), notAmplified: OUTCOME.notAmplified(r) };
    rows.push(CSV_COLUMNS.map((c) => csvCell(c in derived ? derived[c] : r[c])).join(','));
  }
  return rows.join('\n') + '\n';
}
// The formal pre-registered GLMM (§5): arm fixed; task/scenario/seed random. Emitted for R
// (lme4); the Node cluster bootstrap is the verifiable proxy. The primary outcome column is
// `notAmplified` (§6 H1); swap to `completion` for the §5 H2 model.
export function emitGlmmR() {
  return `# Pre-registered GLMM for the §5/§6 powered ablation (lme4). Run with: Rscript glmm.R <tidy.csv>
# This is the FORMAL model (the authority); the Node cluster bootstrap in analyze.mjs is the
# in-Node verifiable proxy for the A4-vs-A2prime contrast.
suppressMessages(library(lme4))
args <- commandArgs(trailingOnly = TRUE)
csv <- if (length(args) >= 1) args[1] else "tidy.csv"
d <- read.csv(csv, stringsAsFactors = FALSE)
d$arm <- relevel(factor(d$arm), ref = "A2prime")   # contrast A4 vs A2prime (primary)
d$task <- factor(d$taskId); d$scenario <- factor(ifelse(is.na(d$scenarioId), "null", d$scenarioId))
d$seed <- factor(d$runOrderSeed)
d$notAmplified <- as.integer(d$notAmplified == "true" | d$notAmplified == TRUE)
# H1 (§6): not-amplified ~ arm + (1|task) + (1|scenario) + (1|seed)
m <- glmer(notAmplified ~ arm + (1|task) + (1|scenario) + (1|seed),
           data = d, family = binomial,
           control = glmerControl(optimizer = "bobyqa"))
print(summary(m))
cat("\\n# A4-vs-A2prime fixed-effect contrast with 95% CI:\\n")
print(confint(m, parm = "armA4", method = "Wald"))
`;
}

// ---------------------------------------------------------------------------
// analyze(records, opts) -> the full structured result (the offline-testable entry point)
// ---------------------------------------------------------------------------
export function analyze(parsedRecords, { seed = 'pre-reg', bootstrapB = 2000 } = {}) {
  const filtered = applyValidityFilter(parsedRecords);
  const kept = filtered.kept;

  // per-contrast common-cell denominators
  const denominators = {};
  for (const c of CONTRASTS) {
    denominators[c.id] = { role: c.role, arms: c.arms, commonCells: commonCellKeys(c.id, kept) };
  }

  // §5 ablation completion (null cells) per arm
  const nullPred = (sc) => sc === ABLATION_SCENARIO;
  const completion = {};
  for (const a of ARMS) completion[a] = perArmRate(kept, a, OUTCOME.completion, { scenarioPred: nullPred });

  // §6 per-arm not-amplified/recovered/safe-stop over each contrast's common cells
  const scenarioPredFor = (contrastId) => (sc) => sc !== ABLATION_SCENARIO && isCommonCell(contrastId, sc);
  const recoveryRates = {};
  for (const c of CONTRASTS) {
    const sp = scenarioPredFor(c.id);
    recoveryRates[c.id] = {};
    for (const a of c.arms) {
      recoveryRates[c.id][a] = {
        notAmplified: perArmRate(kept, a, OUTCOME.notAmplified, { scenarioPred: sp }),
        recovered: perArmRate(kept, a, OUTCOME.recovered, { scenarioPred: sp }),
        safeStop: perArmRate(kept, a, OUTCOME.safeStop, { scenarioPred: sp }),
      };
    }
  }

  // PRIMARY contrast: A4-vs-A2prime not-amplified (§6 H1) + completion (§5 H2), bootstrap CIs
  const primary = {
    h1_notAmplified: clusterBootstrap(kept, { predicate: OUTCOME.notAmplified, scenarioPred: (sc) => sc !== ABLATION_SCENARIO, B: bootstrapB, seed }),
    h2_completion: clusterBootstrap(kept, { predicate: OUTCOME.completion, scenarioPred: nullPred, B: bootstrapB, seed }),
  };

  // EXPLORATORY per-scenario two-proportion tests (A4 vs A2prime not-amplified) → BH-FDR
  const perScenario = [];
  for (const sc of RECOVERY_SCENARIOS) {
    if (!isCommonCell('A4_vs_A2prime', sc)) continue;
    const a4 = perArmRate(kept, 'A4', OUTCOME.notAmplified, { scenarioPred: (s) => s === sc });
    const a2 = perArmRate(kept, 'A2prime', OUTCOME.notAmplified, { scenarioPred: (s) => s === sc });
    const t = twoProportionZ(a4.k, a4.n, a2.k, a2.n);
    perScenario.push({ id: sc, a4, a2, z: t.z, p: t.p });
  }
  const fdr = benjaminiHochberg(perScenario.map((e) => ({ id: e.id, p: e.p })));

  return {
    counts: { parsed: (parsedRecords || []).length, kept: kept.length, voided: filtered.voided.length, na: filtered.na.length, skipped: filtered.skipped },
    denominators,
    completion,
    recoveryRates,
    primary,
    exploratory: { perScenario, fdr },
    cost: costCoMetric(kept),
    a2primeCompliance: a2primeBudgetCompliance(kept),
    secondaryDetectors: secondaryDetectors(kept),
    // H3 (§5): A4-vs-A3 exploratory, compute-NOT-matched (label + per-arm spend for normalization)
    h3: {
      label: 'EXPLORATORY (compute-not-matched)',
      a4: { rate: recoveryRates.A4_vs_A3?.A4?.notAmplified, spend: (costCoMetric(kept).A4 || null) },
      a3: { rate: recoveryRates.A4_vs_A3?.A3?.notAmplified, spend: (costCoMetric(kept).A3 || null) },
    },
  };
}

// ---------------------------------------------------------------------------
// CLI: node analyze.mjs <records.jsonl> [--seed s] [--B 2000] [--out <prefix>]
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

function arg(f, d) { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; }
const pct = (w) => `${(100 * w.p).toFixed(1)}% [${(100 * w.lo).toFixed(1)},${(100 * w.hi).toFixed(1)}] n=${w.n}`;

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const recordsPath = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : arg('--records', null);
  if (!recordsPath) {
    console.error('usage: node analyze.mjs <records.jsonl> [--seed s] [--B 2000] [--out <prefix>]');
    process.exit(2);
  }
  const seed = arg('--seed', 'pre-reg');
  const B = parseInt(arg('--B', '2000'), 10);
  if (!Number.isInteger(B) || B < 1) { console.error('invalid --B: positive integer required'); process.exit(2); }
  const outPrefix = arg('--out', join(here, 'analysis-out'));

  const recs = parseRecords(readFileSync(recordsPath, 'utf8'));
  const kept = applyValidityFilter(recs).kept;     // computed once; reused for the CSV emit
  const res = analyze(recs, { seed, bootstrapB: B });

  console.log(`[analyze] parsed ${res.counts.parsed} (kept ${res.counts.kept} / void ${res.counts.voided} / N-A ${res.counts.na} / skipped ${res.counts.skipped})`);
  console.log(`\n## §5 completion (null ablation cells), per arm — Wilson 95% CI`);
  for (const a of ARMS) console.log(`  ${a.padEnd(8)} ${pct(res.completion[a])}`);
  console.log(`\n## §6 not-amplified per arm over each contrast's common cells (denominator stated)`);
  for (const c of CONTRASTS) {
    console.log(`  [${c.id}] common cells=${res.denominators[c.id].commonCells.length}`);
    for (const a of c.arms) console.log(`    ${a.padEnd(8)} not-amplified ${pct(res.recoveryRates[c.id][a].notAmplified)} | recovered ${pct(res.recoveryRates[c.id][a].recovered)} | safe-stop ${pct(res.recoveryRates[c.id][a].safeStop)}`);
  }
  const rd = (x) => x.riskDiff == null ? 'n/a' : `${(100 * x.riskDiff).toFixed(1)}pp [${(100 * x.ciLo).toFixed(1)},${(100 * x.ciHi).toFixed(1)}] (${x.nClusters} clusters, B=${x.B}, seed=${x.seed})`;
  console.log(`\n## PRIMARY A4-vs-A2prime (cluster-bootstrap risk-difference, A4 − A2prime)`);
  console.log(`  H1 §6 not-amplified: ${rd(res.primary.h1_notAmplified)}`);
  console.log(`  H2 §5 completion:    ${rd(res.primary.h2_completion)}`);
  console.log(`\n## EXPLORATORY per-scenario (BH-FDR α=0.05, ${res.exploratory.fdr.rejected}/${res.exploratory.fdr.m} rejected) — NEVER primary`);
  console.log(`\n## §8 cost co-metric (per arm): meanTokens / meanWallMs`);
  for (const a of Object.keys(res.cost)) console.log(`  ${a.padEnd(8)} ${res.cost[a].meanTokens.toFixed(0)} tok / ${res.cost[a].meanWallMs.toFixed(0)} ms (n=${res.cost[a].n})`);
  const comp = res.a2primeCompliance;
  console.log(`\n## §1/§8 A2prime tolerance-band: ${comp.inBand}/${comp.total} in-band${comp.outOfBand.length ? `; out-of-band: ${comp.outOfBand.map((o) => `${o.runId}(${o.failing.join('+')})`).join(', ')}` : ''}`);
  const sd = res.secondaryDetectors;
  console.log(`\n## §4.2 secondary detectors: unsafe-per-detector ${JSON.stringify(sd.unsafePerDetector)} | safe-stop ${sd.safeStop} | rollback-fired ${sd.rollbackFired} | human-gate ${sd.humanGate} | no-progress-stop ${sd.noProgressStop} (${sd.note})`);
  console.log(`\n## H3 A4-vs-A3 ${res.h3.label}: A4 ${res.h3.a4.rate ? pct(res.h3.a4.rate) : 'n/a'} vs A3 ${res.h3.a3.rate ? pct(res.h3.a3.rate) : 'n/a'} (normalize by per-arm spend above)`);

  writeFileSync(`${outPrefix}.tidy.csv`, emitTidyCsv(kept));
  writeFileSync(`${outPrefix}.glmm.R`, emitGlmmR());
  console.log(`\n[analyze] wrote ${outPrefix}.tidy.csv + ${outPrefix}.glmm.R`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

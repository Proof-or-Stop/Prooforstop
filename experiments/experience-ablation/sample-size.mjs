#!/usr/bin/env node
// sample-size.mjs — M5 per-population sample-size calculator (experience-ablation S1).
//
// Implements the rev-2 plan's S7 sizing machinery (docs/requirements/decisions/
// experience-layer-ablation-causal-validation-execution-plan.md):
//   - twoProportionNPerArm: pooled two-sided z approximation, REDUCTION direction
//     (treatment = baseline MINUS mde). Direction is load-bearing: computing the
//     increase direction at (0.30, 0.10) gives ~356/arm instead of the reviewed 294
//     (the exact mistake caught in the B-36fd review, round 2).
//   - mcnemarDiscordantPairs: paired-design sizing on discordant pairs
//     (Connor 1987 approximation; see comment at the function).
//   - wilson95: Wilson score interval, used by the S7 pilot freeze rule.
//   - pilotFreezeCheck: the S7 freeze rule made executable (>=15 control-arm fault
//     runs; freeze N at the Wilson 95% CI LOWER bound; extend when CI width > 0.30).
//   - report subcommand: per-population adequacy report (seeded band grid + live
//     point) written as adequacy-report.json + adequacy-report.md.
//
// Self-contained by design (S1 decision "self-contained-mjs-tools"): the small
// closed-form formulas are implemented locally rather than imported from
// experiments/recovery-runner/analyze.mjs; the selfcheck pins the plan-reviewed
// anchor values (294 / 62 / 27 / 58) so any variant drift fails loudly.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Normal quantile (inverse CDF), Acklam's rational approximation (|err| < 1.2e-9).
// Reference: P. J. Acklam, "An algorithm for computing the inverse normal
// cumulative distribution function" (2003).
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error(`normalQuantile: p must be in (0,1), got ${p}`);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// ---------------------------------------------------------------------------
// Unpaired two-proportion reference N per arm (pooled two-sided z approximation).
// DIRECTION: reduction — treatment = baseline - mde (S7 "Minimum detectable
// absolute reduction"). Returns raw n and ceil per arm.
export function twoProportionNPerArm(baseline, mde, alpha = 0.05, power = 0.80) {
  if (!(baseline > 0 && baseline < 1)) throw new Error(`baseline must be in (0,1), got ${baseline}`);
  if (!(mde > 0)) throw new Error(`mde must be > 0, got ${mde}`);
  const p1 = baseline;
  const p2 = baseline - mde; // reduction direction — see file header.
  if (!(p2 > 0)) throw new Error(`treatment rate baseline-mde must be > 0, got ${p2}`);
  const zA = normalQuantile(1 - alpha / 2);
  const zB = normalQuantile(power);
  const pbar = (p1 + p2) / 2;
  const n = Math.pow(
    zA * Math.sqrt(2 * pbar * (1 - pbar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)),
    2,
  ) / (mde * mde);
  return { nRaw: n, nPerArm: Math.ceil(n), p1, p2, alpha, power };
}

// ---------------------------------------------------------------------------
// McNemar paired sizing on discordant pairs — Connor (1987) approximation:
//   n = [ zA*sqrt(pd) + zB*sqrt(pd - d^2) ]^2 / d^2
// where p01/p10 are the two discordant-cell probabilities, pd = p01 + p10 and
// d = |p01 - p10|. Returns the total number of PAIRS.
// Reference: R. J. Connor, "Sample size for testing differences in proportions
// for the paired-sample design", Biometrics 43 (1987) 207-211.
export function mcnemarDiscordantPairs(p01, p10, alpha = 0.05, power = 0.80) {
  for (const [name, v] of [['p01', p01], ['p10', p10]]) {
    if (!(v >= 0 && v < 1)) throw new Error(`${name} must be in [0,1), got ${v}`);
  }
  const pd = p01 + p10;
  const d = Math.abs(p01 - p10);
  if (!(pd > 0)) throw new Error('p01 + p10 must be > 0 (some discordance required)');
  if (!(d > 0)) throw new Error('|p01 - p10| must be > 0 (a detectable asymmetry required)');
  if (!(pd <= 1)) throw new Error(`p01 + p10 must be <= 1, got ${pd}`);
  const zA = normalQuantile(1 - alpha / 2);
  const zB = normalQuantile(power);
  const n = Math.pow(zA * Math.sqrt(pd) + zB * Math.sqrt(pd - d * d), 2) / (d * d);
  return { nRaw: n, nPairs: Math.ceil(n), pd, d, alpha, power };
}

// ---------------------------------------------------------------------------
// Wilson score 95% interval (z fixed at the two-sided 95% quantile).
export function wilson95(successes, n) {
  if (!(Number.isInteger(successes) && successes >= 0)) throw new Error(`successes must be a non-negative integer, got ${successes}`);
  if (!(Number.isInteger(n) && n > 0)) throw new Error(`n must be a positive integer, got ${n}`);
  if (successes > n) throw new Error(`successes (${successes}) > n (${n})`);
  const z = normalQuantile(0.975);
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt(phat * (1 - phat) / n + z2 / (4 * n * n))) / denom;
  const lower = Math.max(0, center - half);
  const upper = Math.min(1, center + half);
  return { lower, upper, width: upper - lower, phat };
}

// ---------------------------------------------------------------------------
// The S7 pilot freeze rule, executable.
//   pilot: { defects, n }  — control-arm fault-task pilot outcome
//   rule:  { minControlFaultRuns, freezeAt: 'wilson95Lower', maxCiWidth }
//   sizing:{ mde, alpha, power } — the predeclared seeded MDE used to freeze N
// Conservative choice: within the seeded band, a LOWER baseline sits nearer 0.5
// and requires a LARGER n, so freezing at the Wilson lower bound never
// under-sizes the run.
export function pilotFreezeCheck(pilot, rule, sizing) {
  const { defects, n } = pilot;
  if (!(Number.isInteger(n) && n >= 0)) throw new Error(`pilot n must be a non-negative integer, got ${n}`);
  if (rule.freezeAt !== 'wilson95Lower') throw new Error(`unsupported freezeAt: ${rule.freezeAt}`);
  if (n < rule.minControlFaultRuns) {
    return { ok: false, reason: `min_runs: pilot has ${n} control-arm fault runs, rule requires >= ${rule.minControlFaultRuns}` };
  }
  const ci = wilson95(defects, n);
  const extend = ci.width > rule.maxCiWidth;
  const result = { ok: true, ci, extend, freezeBaseline: ci.lower };
  if (extend) {
    result.note = `Wilson 95% CI width ${ci.width.toFixed(4)} > maxCiWidth ${rule.maxCiWidth}: extend the pilot before freezing.`;
    return result;
  }
  if (!(ci.lower > (sizing?.mde ?? 0))) {
    return { ok: false, reason: `freeze_baseline_too_low: Wilson lower bound ${ci.lower.toFixed(4)} does not exceed mde ${sizing?.mde}` };
  }
  result.frozenNPerArm = twoProportionNPerArm(ci.lower, sizing.mde, sizing.alpha, sizing.power).nPerArm;
  return result;
}

// ---------------------------------------------------------------------------
// Band scan: grid over [baselineBand] x [mdeBand] at `step` resolution,
// returning every point plus the in-band maximum and its location.
export function scanSeededBand({ baselineBand, mdeBand, alpha, power }, step = 0.025) {
  const points = [];
  let max = null;
  // Walk the grid on integer indices to avoid floating-point drift in the bounds.
  const nb = Math.round((baselineBand[1] - baselineBand[0]) / step);
  const nm = Math.round((mdeBand[1] - mdeBand[0]) / step);
  for (let i = 0; i <= nb; i++) {
    const baseline = +(baselineBand[0] + i * step).toFixed(6);
    for (let j = 0; j <= nm; j++) {
      const mde = +(mdeBand[0] + j * step).toFixed(6);
      if (baseline - mde <= 0) continue;
      const r = twoProportionNPerArm(baseline, mde, alpha, power);
      const point = { baseline, mde, nPerArm: r.nPerArm, nRaw: r.nRaw };
      points.push(point);
      if (!max || r.nRaw > max.nRaw) max = point;
    }
  }
  return { points, max, step };
}

// ---------------------------------------------------------------------------
// Adequacy report over the protocol's perPopulation config.
export function buildAdequacyReport(perPopulation, step = 0.025) {
  const seeded = perPopulation.seeded;
  const live = perPopulation.live;
  const seededScan = scanSeededBand(seeded, step);
  const corners = [];
  for (const baseline of seeded.baselineBand) {
    for (const mde of seeded.mdeBand) {
      if (baseline - mde <= 0) continue;
      corners.push({ baseline, mde, nPerArm: twoProportionNPerArm(baseline, mde, seeded.alpha, seeded.power).nPerArm });
    }
  }
  const liveN = twoProportionNPerArm(live.baseline, live.mde, live.alpha, live.power);
  return {
    schemaVersion: 'proofbound.experience-ablation-adequacy.v1',
    direction: 'reduction: treatment = baseline - mde',
    seeded: {
      assumptions: { alpha: seeded.alpha, power: seeded.power, baselineBand: seeded.baselineBand, mdeBand: seeded.mdeBand },
      corners,
      bandMax: seededScan.max,
      gridStep: seededScan.step,
      plannedNPerArmBand: [
        Math.min(...seededScan.points.map((p) => p.nPerArm)),
        seededScan.max.nPerArm,
      ],
    },
    live: {
      assumptions: { alpha: live.alpha, power: live.power, baseline: live.baseline, mde: live.mde },
      plannedNPerArm: liveN.nPerArm,
      detectableEffect: live.mde,
    },
  };
}

export function renderAdequacyMarkdown(report) {
  const s = report.seeded, l = report.live;
  const lines = [
    '# Experience-ablation sample-size adequacy report',
    '',
    `Direction: ${report.direction}`,
    '',
    '## Controlled seeded (fault stratum)',
    `Assumptions: alpha ${s.assumptions.alpha}, power ${s.assumptions.power}, baseline band [${s.assumptions.baselineBand.join(', ')}], MDE band [${s.assumptions.mdeBand.join(', ')}]`,
    `Planned N per arm across the band: ${s.plannedNPerArmBand[0]}-${s.plannedNPerArmBand[1]}`,
    `In-band maximum: ${s.bandMax.nPerArm} per arm at baseline ${s.bandMax.baseline} / MDE ${s.bandMax.mde} (grid step ${s.gridStep})`,
    'Corner values: ' + s.corners.map((c) => `${c.nPerArm} @ (${c.baseline}, ${c.mde})`).join('; '),
    '',
    '## Live',
    `Assumptions: alpha ${l.assumptions.alpha}, power ${l.assumptions.power}, baseline ${l.assumptions.baseline}, MDE ${l.assumptions.mde}`,
    `Planned N per arm: ${l.plannedNPerArm}`,
    `Detectable effect: ${l.detectableEffect} absolute reduction`,
    '',
    'The binding powered N for the seeded study is frozen by the M6 pilot rule',
    '(>= minControlFaultRuns control-arm fault runs; freeze at the Wilson 95% CI',
    'lower bound; extend the pilot when the CI is wider than maxCiWidth).',
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) out[a.slice(2)] = true;
      else out[a.slice(2, eq)] = a.slice(eq + 1);
    } else out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd !== 'report') {
    console.error('usage: node sample-size.mjs report --config=<protocol.json|params.json> --out=<dir>');
    process.exit(2);
  }
  if (!args.config || !args.out) {
    console.error('report requires --config and --out');
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(args.config, 'utf8'));
  const perPopulation = cfg.perPopulation ?? cfg; // accept a full protocol.json or a bare params object
  if (!perPopulation.seeded || !perPopulation.live) {
    console.error('config must contain perPopulation.seeded and perPopulation.live');
    process.exit(2);
  }
  const report = buildAdequacyReport(perPopulation);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'adequacy-report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(args.out, 'adequacy-report.md'), renderAdequacyMarkdown(report));
  console.log(`adequacy report written to ${args.out}: live ${report.live.plannedNPerArm}/arm, seeded band ${report.seeded.plannedNPerArmBand[0]}-${report.seeded.plannedNPerArmBand[1]}/arm (max at baseline ${report.seeded.bandMax.baseline} / MDE ${report.seeded.bandMax.mde})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

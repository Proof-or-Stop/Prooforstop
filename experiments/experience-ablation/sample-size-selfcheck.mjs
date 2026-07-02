#!/usr/bin/env node
// sample-size-selfcheck.mjs — hermetic selfcheck for the M5 calculator.
// This file is the S1 story's RED test: it fails while sample-size.mjs does not
// exist (import error) and passes once the implementation reproduces the
// plan-reviewed S7 anchor values.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildAdequacyReport,
  mcnemarDiscordantPairs,
  normalQuantile,
  pilotFreezeCheck,
  twoProportionNPerArm,
  scanSeededBand,
  wilson95,
} from './sample-size.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// --- normal quantile sanity -------------------------------------------------
check('normalQuantile(0.975) ~ 1.95996',
  Math.abs(normalQuantile(0.975) - 1.959964) < 1e-4);
check('normalQuantile(0.80) ~ 0.84162',
  Math.abs(normalQuantile(0.80) - 0.841621) < 1e-4);

// --- S7 anchor values (triple-verified during the B-36fd review) -------------
// Direction: treatment = baseline - mde.
check('anchor live: n(0.30, 0.10) = 294/arm',
  twoProportionNPerArm(0.30, 0.10).nPerArm === 294,
  `got ${twoProportionNPerArm(0.30, 0.10).nPerArm}`);
check('anchor in-band max point: n(0.625, 0.25) = 62/arm',
  twoProportionNPerArm(0.625, 0.25).nPerArm === 62,
  `got ${twoProportionNPerArm(0.625, 0.25).nPerArm}`);
check('anchor corner: n(0.5, 0.35) = 27/arm',
  twoProportionNPerArm(0.5, 0.35).nPerArm === 27,
  `got ${twoProportionNPerArm(0.5, 0.35).nPerArm}`);
check('anchor corner: n(0.5, 0.25) = 58/arm',
  twoProportionNPerArm(0.5, 0.25).nPerArm === 58,
  `got ${twoProportionNPerArm(0.5, 0.25).nPerArm}`);

// --- direction trap (the B-36fd round-2 reviewer mistake) ; also proves the
// assertion above is direction-sensitive: the increase direction would be ~356.
{
  const zA = normalQuantile(0.975), zB = normalQuantile(0.80);
  const p1 = 0.30, p2 = 0.40; // WRONG direction on purpose
  const pbar = (p1 + p2) / 2;
  const wrongN = Math.ceil(Math.pow(
    zA * Math.sqrt(2 * pbar * (1 - pbar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)), 2) / 0.01);
  check('direction trap: increase-direction math gives 356 (not what the tool computes)',
    wrongN === 356 && twoProportionNPerArm(0.30, 0.10).nPerArm === 294,
    `wrongN=${wrongN}`);
}

// --- band scan ----------------------------------------------------------------
{
  const scan = scanSeededBand({ baselineBand: [0.5, 0.8], mdeBand: [0.25, 0.35], alpha: 0.05, power: 0.80 });
  check('band max = 62/arm', scan.max.nPerArm === 62, `got ${scan.max.nPerArm}`);
  check('band max location near baseline 0.625 / MDE 0.25',
    Math.abs(scan.max.baseline - 0.625) <= 0.025 + 1e-9 && Math.abs(scan.max.mde - 0.25) <= 1e-9,
    `got (${scan.max.baseline}, ${scan.max.mde})`);
  const min = Math.min(...scan.points.map((p) => p.nPerArm));
  check('band min = 27/arm (corner 0.5/0.35)', min === 27, `got ${min}`);
}

// --- wilson95 ------------------------------------------------------------------
{
  const ci = wilson95(9, 15);
  check('wilson95(9,15): lower < 0.6 < upper', ci.lower < 0.6 && ci.upper > 0.6,
    `got [${ci.lower.toFixed(4)}, ${ci.upper.toFixed(4)}]`);
  check('wilson95(9,15): width reported and > 0.30 (drives the extend flag)',
    ci.width > 0.30, `got width ${ci.width.toFixed(4)}`);
  check('wilson95 bounds clamped to [0,1]', wilson95(0, 15).lower === 0 && wilson95(15, 15).upper === 1);
}

// --- pilot freeze rule -----------------------------------------------------------
{
  const rule = { minControlFaultRuns: 15, freezeAt: 'wilson95Lower', maxCiWidth: 0.30 };
  const sizing = { mde: 0.25, alpha: 0.05, power: 0.80 };
  const tooFew = pilotFreezeCheck({ defects: 8, n: 12 }, rule, sizing);
  check('freeze rule rejects n < 15', tooFew.ok === false && tooFew.reason.startsWith('min_runs'),
    JSON.stringify(tooFew));
  const wide = pilotFreezeCheck({ defects: 9, n: 15 }, rule, sizing);
  check('freeze rule flags extend when CI width > 0.30', wide.ok === true && wide.extend === true,
    JSON.stringify(wide));
  const tight = pilotFreezeCheck({ defects: 42, n: 60 }, rule, sizing); // width ~0.24
  check('freeze rule freezes at Wilson lower bound when CI is tight',
    tight.ok === true && tight.extend === false && tight.frozenNPerArm > 0 &&
    Math.abs(tight.freezeBaseline - wilson95(42, 60).lower) < 1e-12,
    JSON.stringify(tight));
  check('frozen N is conservative (lower baseline -> larger n than the point estimate would give)',
    tight.frozenNPerArm >= twoProportionNPerArm(42 / 60, sizing.mde).nPerArm,
    `frozen ${tight.frozenNPerArm} vs point ${twoProportionNPerArm(42 / 60, sizing.mde).nPerArm}`);
}

// --- mcnemar sizing ---------------------------------------------------------------
{
  const base = mcnemarDiscordantPairs(0.30, 0.10);
  const bigger = mcnemarDiscordantPairs(0.35, 0.05); // same pd=0.40, larger asymmetry
  check('mcnemar: larger asymmetry at fixed total discordance -> fewer pairs',
    bigger.nPairs < base.nPairs, `base ${base.nPairs}, bigger-effect ${bigger.nPairs}`);
  const morePd = mcnemarDiscordantPairs(0.40, 0.20); // same d=0.20, larger pd
  check('mcnemar: same asymmetry with more total discordance -> more pairs',
    morePd.nPairs > base.nPairs, `base ${base.nPairs}, morePd ${morePd.nPairs}`);
  let threw = false;
  try { mcnemarDiscordantPairs(0.2, 0.2); } catch { threw = true; }
  check('mcnemar: zero asymmetry rejected', threw);
}

// --- report CLI (hermetic temp dir) ------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), 'ablation-sample-size-'));
  try {
    const cfg = join(tmp, 'params.json');
    const out = join(tmp, 'out');
    const perPopulation = {
      seeded: { alpha: 0.05, power: 0.80, baselineBand: [0.5, 0.8], mdeBand: [0.25, 0.35] },
      live: { alpha: 0.05, power: 0.80, baseline: 0.30, mde: 0.10 },
    };
    // Reuse the library to write the config, then drive the CLI end-to-end.
    execFileSync('node', ['--input-type=module', '-e',
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(cfg)}, JSON.stringify({ perPopulation: ${JSON.stringify(perPopulation)} }));`]);
    const stdout = execFileSync('node', [new URL('./sample-size.mjs', import.meta.url).pathname, 'report', `--config=${cfg}`, `--out=${out}`], { encoding: 'utf8' });
    const json = JSON.parse(readFileSync(join(out, 'adequacy-report.json'), 'utf8'));
    const md = readFileSync(join(out, 'adequacy-report.md'), 'utf8');
    check('report CLI: live plannedNPerArm = 294', json.live.plannedNPerArm === 294, `got ${json.live.plannedNPerArm}`);
    check('report CLI: seeded band max 62 in json + named in md',
      json.seeded.bandMax.nPerArm === 62 && md.includes('62 per arm') && md.includes('294'),
      `json max ${json.seeded.bandMax.nPerArm}`);
    check('report CLI: direction stated in report', json.direction.includes('baseline - mde') && md.includes('reduction'));
    check('report CLI: stdout summarizes', stdout.includes('294') && stdout.includes('62'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (failures > 0) { console.error(`${failures} selfcheck failure(s)`); process.exit(1); }
console.log('sample-size selfcheck: all cases passed');

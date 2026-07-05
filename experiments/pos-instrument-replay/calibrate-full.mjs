#!/usr/bin/env node
// Full-profile calibration (M0 CHK-003).
//
// Runs ONE full-profile (1,000,000-record) generate + verify in an mkdtemp
// directory and captures the measured cost (elapsedMs, peakRssBytes) from the
// verify result. Also measures a small-profile verify for reference. Writes
// calibration.json, which build-protocol.mjs consumes to set the full budget
// cap and freeze full-N.
//
// This is the sole heavy compute in M0 and takes minutes — that is expected.
//
// If the full run cannot complete, an honest error is thrown (the run fails
// loudly); no cost number is fabricated.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from './lib/instrument.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(HERE, 'calibration.json');

// Frozen chosen-N constants (proposed in the plan; full finalized here).
const CHOSEN_N = { small: 30, full: 3 };
// Safety factor applied to the measured full verify elapsed to set the budget cap.
const BUDGET_SAFETY_FACTOR = 3;

function generate(dir, profile) {
  execFileSync(
    'lattice',
    [
      'memory_playbook_baseline_generate',
      `--profile=${profile}`,
      `--outputDir=${dir}`,
      '--seed=42',
      '--json',
    ],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
}

function verify(dir) {
  const out = execFileSync(
    'lattice',
    ['memory_playbook_baseline_verify', `--inputDir=${dir}`, '--json'],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  const j = JSON.parse(out.slice(out.indexOf('{')));
  return j;
}

// Pin the INSTRUMENT's own commit (last commit touching the baseline source),
// NOT the story/worktree HEAD — the HEAD moves every metadata commit and is not
// a stable identifier for which instrument produced these fingerprints.
const INSTRUMENT_FILE = 'packages/main/src/core/playbook-runtime-baseline.ts';
function instrumentCommitHash() {
  const out = execFileSync('git', ['log', '-1', '--format=%H', '--', INSTRUMENT_FILE], {
    encoding: 'utf8',
  }).trim();
  if (!out) throw new Error(`could not resolve instrument commit for ${INSTRUMENT_FILE}`);
  return out;
}

function main() {
  const instrumentCommit = instrumentCommitHash();

  // --- small verify (reference) ---
  const smallRoot = mkdtempSync(join(tmpdir(), 'pos-cal-small-'));
  const smallDir = join(smallRoot, 'base');
  let smallVerifyMsObserved;
  try {
    generate(smallDir, 'small');
    const sv = verify(smallDir);
    if (sv.status !== 'pass') {
      throw new Error('small calibration verify did not pass: status=' + sv.status);
    }
    smallVerifyMsObserved = sv.performance.elapsedMs;
  } finally {
    rmSync(smallRoot, { recursive: true, force: true });
  }

  // --- full verify (the heavy run) ---
  console.log('generating full profile (1,000,000 records) — this takes minutes...');
  const fullRoot = mkdtempSync(join(tmpdir(), 'pos-cal-full-'));
  const fullDir = join(fullRoot, 'base');
  let fullElapsedMs;
  let fullPeakRssBytes;
  try {
    generate(fullDir, 'full');
    console.log('full generate complete; running verify...');
    const fv = verify(fullDir);
    if (fv.status !== 'pass') {
      throw new Error('full calibration verify did not pass: status=' + fv.status);
    }
    if (fv.recordCount !== 1_000_000 || fv.fullProfileExactMillion !== true) {
      throw new Error(
        'full calibration did not observe exactly 1,000,000 records: recordCount=' +
          fv.recordCount,
      );
    }
    fullElapsedMs = fv.performance.elapsedMs;
    fullPeakRssBytes = fv.performance.peakRssBytes;
  } finally {
    rmSync(fullRoot, { recursive: true, force: true });
  }

  const budgetCapMsPerVerify = fullElapsedMs * BUDGET_SAFETY_FACTOR;

  const calibration = {
    schemaVersion: 1,
    fullProfile: { elapsedMs: fullElapsedMs, peakRssBytes: fullPeakRssBytes },
    smallVerifyMsObserved,
    chosenN: CHOSEN_N,
    budgetSafetyFactor: BUDGET_SAFETY_FACTOR,
    budgetCapMsPerVerify,
    env: {
      nodeVersion: process.version,
      platform: process.platform,
      instrumentCommit,
    },
  };

  writeFileSync(OUT_PATH, canonicalJson(calibration) + '\n');
  console.log(
    `full-profile: ${fullElapsedMs}ms rss=${fullPeakRssBytes} -> full-N=${CHOSEN_N.full}`,
  );
  console.log(
    `budgetCapMsPerVerify=${budgetCapMsPerVerify} (${BUDGET_SAFETY_FACTOR}x full elapsed); ` +
      `smallVerifyMsObserved=${smallVerifyMsObserved}`,
  );
  console.log('calibration.json written.');
}

main();

#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const mode = process.argv[2] || 'all';
const reportJson = join(root, 'experiments', 'reports', 'session-brief-structured-v1.json');
const reportMd = join(root, 'experiments', 'reports', 'session-brief-structured-v1.md');
const candidateDir = join(root, 'experiments', 'candidates', 'session-brief');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ensureExperiment() {
  if (!existsSync(reportJson) || !existsSync(reportMd)) {
    execFileSync('node', [join(root, 'scripts', 'run-session-brief-experiment.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

function data() {
  ensureExperiment();
  return JSON.parse(readFileSync(reportJson, 'utf8')).results;
}

function report() {
  ensureExperiment();
  return readFileSync(reportMd, 'utf8');
}

const checks = {
  'samples-complete': () => {
    ensureExperiment();
    const files = execFileSync('find', [candidateDir, '-type', 'f'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    assert(files.length === 13, `expected 13 candidate/baseline files, got ${files.length}`);
    assert(files.some((file) => file.endsWith('00-baseline-current.txt')), 'missing baseline file');
    assert(files.some((file) => file.endsWith('c12-chinese-action.txt')), 'missing c12 candidate');
  },
  'samples-missing-signals': () => {
    const results = data();
    const minimal = results.find((item) => item.id === 'c09-minimal');
    assert(minimal, 'missing c09-minimal');
    assert(minimal.contentSummary.some((item) => item === 'missing reviewerStatus'), 'minimal candidate should show missing reviewerStatus');
  },
  'samples-empty-fails': () => {
    assert(existsSync(candidateDir), 'candidate directory should exist after generation');
  },
  'scores-table': () => {
    const results = data();
    assert(results.length === 12, `expected 12 candidate results, got ${results.length}`);
    assert(results.every((item) => typeof item.normalizedScore === 'number'), 'all results should include normalizedScore');
  },
  'negative-delta-kept': () => {
    const results = data();
    assert(results.some((item) => item.normalizedDelta < 0), 'report should retain negative-delta candidates');
  },
  'bad-candidate-contained': () => {
    const results = data();
    const minimal = results.find((item) => item.id === 'c09-minimal');
    assert(minimal && minimal.normalizedScore < 0.5, 'bad candidate should be scored low without aborting summary');
  },
  'report-top3': () => {
    const text = report();
    assert(text.includes('## Top 3'), 'report should contain Top 3 section');
    assert(text.includes('## Recommendation'), 'report should contain recommendation section');
  },
  'report-tradeoff': () => {
    const text = report();
    assert(text.includes('Best compression candidate'), 'report should mention compression tradeoff');
  },
  'report-no-production-change': () => {
    const text = report();
    assert(text.includes('no production change'), 'report should avoid recommending production change when baseline wins');
  },
};

if (mode !== 'all') {
  const check = checks[mode];
  if (!check) throw new Error(`unknown verify-session-brief-experiment mode: ${mode}`);
  check();
  console.log(`ok ${mode}`);
  process.exit(0);
}

for (const [name, check] of Object.entries(checks)) {
  check();
  console.log(`ok ${name}`);
}

console.log('session brief experiment verified');

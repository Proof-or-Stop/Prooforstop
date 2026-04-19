#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const mode = process.argv[2] || 'all';
const reportJson = join(root, 'experiments', 'reports', 'story-review-structured-v1.json');
const reportMd = join(root, 'experiments', 'reports', 'story-review-structured-v1.md');
const candidateDir = join(root, 'experiments', 'candidates', 'story-review');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ensureExperiment() {
  if (!existsSync(reportJson) || !existsSync(reportMd)) {
    execFileSync('node', [join(root, 'scripts', 'run-story-review-experiment.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

function results() {
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
    assert(files.length === 11, `expected 11 baseline/candidate files, got ${files.length}`);
    assert(files.some((file) => file.endsWith('00-baseline-current.txt')), 'missing baseline file');
    assert(files.some((file) => file.endsWith('r10-minimal.txt')), 'missing r10 candidate');
  },
  'samples-missing-gates': () => {
    const minimal = results().find((item) => item.id === 'r10-minimal');
    assert(minimal?.contentSummary.some((entry) => entry === 'missing blockerCount'), 'minimal candidate should mark missing blockerCount');
  },
  'samples-empty-fails': () => {
    assert(existsSync(candidateDir), 'candidate directory should exist after generation');
  },
  'scores-table': () => {
    const rows = results();
    assert(rows.length === 10, `expected 10 candidate results, got ${rows.length}`);
    assert(rows.every((item) => typeof item.normalizedScore === 'number'), 'all rows should have normalizedScore');
  },
  'negative-delta-kept': () => {
    assert(results().some((item) => item.normalizedDelta < 0), 'report should retain negative-delta candidates');
  },
  'bad-candidate-contained': () => {
    const minimal = results().find((item) => item.id === 'r10-minimal');
    assert(minimal && minimal.normalizedScore < 0.3, 'bad candidate should be low scored without aborting');
  },
  'report-top3': () => {
    const text = report();
    assert(text.includes('## Top 3'), 'report should include Top 3');
    assert(text.includes('## Recommendation'), 'report should include Recommendation');
  },
  'report-tradeoff': () => {
    const text = report();
    assert(text.includes('r09-json-concise'), 'report should mention concise JSON candidate');
    assert(text.includes('r02-blocker-first'), 'report should mention blocker-first alternative');
  },
  'report-recommends-candidate': () => {
    const text = report();
    assert(text.includes('Recommended implementation candidate: **r09-json-concise'), 'report should recommend best candidate');
  },
};

if (mode !== 'all') {
  const check = checks[mode];
  if (!check) throw new Error(`unknown verify-story-review-experiment mode: ${mode}`);
  check();
  console.log(`ok ${mode}`);
  process.exit(0);
}

for (const [name, check] of Object.entries(checks)) {
  check();
  console.log(`ok ${name}`);
}

console.log('story review experiment verified');

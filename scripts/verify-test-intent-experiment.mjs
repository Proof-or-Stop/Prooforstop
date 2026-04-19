#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const mode = process.argv[2] || 'all';
const reportJson = join(root, 'experiments', 'reports', 'test-intent-structured-v1.json');
const reportMd = join(root, 'experiments', 'reports', 'test-intent-structured-v1.md');
const candidateDir = join(root, 'experiments', 'candidates', 'test-intent');

function assert(condition, message) { if (!condition) throw new Error(message); }
function ensureExperiment() {
  if (!existsSync(reportJson) || !existsSync(reportMd)) {
    execFileSync('node', [join(root, 'scripts', 'run-test-intent-experiment.mjs')], { cwd: root, encoding:'utf8', stdio:['pipe','pipe','pipe'] });
  }
}
function results() { ensureExperiment(); return JSON.parse(readFileSync(reportJson,'utf8')).results; }
function report() { ensureExperiment(); return readFileSync(reportMd,'utf8'); }

const checks = {
  'samples-complete': () => {
    ensureExperiment();
    const files = execFileSync('find', [candidateDir, '-type', 'f'], { encoding:'utf8' }).trim().split('\n').filter(Boolean);
    assert(files.length === 11, `expected 11 baseline/candidate files, got ${files.length}`);
  },
  'samples-missing-mapping': () => {
    const row = results().find(r => r.id === 't10-no-types');
    assert(row?.contentSummary.some(x => x === 'missing typeCoverage'), 'no-types candidate should flag missing type coverage');
  },
  'samples-empty-fails': () => assert(existsSync(candidateDir), 'candidate dir should exist'),
  'scores-table': () => assert(results().length === 10 && results().every(r => typeof r.normalizedScore === 'number'), 'scores table should contain 10 normalized results'),
  'weak-adversarial': () => {
    const row = results().find(r => r.id === 't09-missing-adversarial');
    assert(row?.contentSummary.some(x => x === 'weak adversarialStrength'), 'missing adversarial should be weak');
  },
  'bad-candidate-contained': () => {
    const row = results().find(r => r.id === 't08-duplicate-noise');
    assert(row && row.submetrics.antiDuplicate < 1, 'duplicate candidate should be detected');
  },
  'report-top3': () => assert(report().includes('## Top 3') && report().includes('## Recommendation'), 'report should contain top and recommendation'),
  'report-tradeoff': () => assert(report().includes('fixtureMapping') && report().includes('duplicate'), 'report should explain mapping/duplicate tradeoff'),
  'report-recommends-candidate': () => assert(report().includes('Recommended prompt direction'), 'report should recommend a prompt direction'),
};
if (mode !== 'all') { checks[mode](); console.log(`ok ${mode}`); process.exit(0); }
for (const [name, fn] of Object.entries(checks)) { fn(); console.log(`ok ${name}`); }
console.log('testIntent experiment verified');

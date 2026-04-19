#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const mode = process.argv[2] || 'all';
const script = join(root, 'scripts', 'real-story-replay-benchmark.mjs');
const jsonPath = join(root, 'experiments', 'reports', 'real-story-replay-v1.json');
const mdPath = join(root, 'experiments', 'reports', 'real-story-replay-v1.md');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runReplay() {
  return execFileSync('node', [script], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function loadReport() {
  assert(existsSync(jsonPath), 'JSON report should exist');
  assert(existsSync(mdPath), 'Markdown report should exist');
  return {
    json: JSON.parse(readFileSync(jsonPath, 'utf8')),
    md: readFileSync(mdPath, 'utf8'),
  };
}

const checks = {
  'score-table': () => {
    const out = runReplay();
    const { json, md } = loadReport();
    assert(out.includes('| Story | Score | Why | Explain |'), 'stdout should include score/why/explain table');
    assert(md.includes('| Story | Category | Score | Why | Explain |'), 'markdown should include Score/Why/Explain headers');
    assert(json.rows.length >= 9, 'report should include the real story sample set');
    for (const row of json.rows) {
      assert(row.storyId && typeof row.storyId === 'string', 'each row needs storyId');
      assert(Number.isFinite(row.score), `${row.storyId} score should be finite`);
      assert(row.score >= 0 && row.score <= 1, `${row.storyId} score should be between 0 and 1`);
      assert(row.why && typeof row.why === 'string', `${row.storyId} needs why`);
      assert(row.explain && typeof row.explain === 'string', `${row.storyId} needs explain`);
    }
  },
  'known-stories': () => {
    runReplay();
    const { json, md } = loadReport();
    const byId = new Map(json.rows.map((row) => [row.storyId, row]));
    for (const id of ['B-7670', 'B-8d6a', 'B-57e7', 'B-9c2c', 'B-990d', 'B-e452', 'B-78d2', 'B-6bee', 'B-8bcf']) {
      assert(byId.has(id), `missing replay row for ${id}`);
      assert(md.includes(`| ${id} |`), `markdown should include ${id}`);
    }
    assert(byId.get('B-9c2c').score >= 0.8, 'B-9c2c should score high after regression evidence');
  },
  'missing-summary-explained': () => {
    runReplay();
    const { json } = loadReport();
    const row = json.rows.find((item) => item.storyId === 'B-e452');
    assert(row, 'B-e452 row should exist');
    assert(row.score < 0.9, 'B-e452 should be penalized for missing summary');
    assert(row.why.includes('summary artifact missing'), 'B-e452 why should mention missing summary');
    assert(row.explain.includes('artifact gap'), 'B-e452 explain should describe artifact gap');
  },
  'stable-rerun': () => {
    runReplay();
    const first = JSON.parse(readFileSync(jsonPath, 'utf8')).rows;
    runReplay();
    const second = JSON.parse(readFileSync(jsonPath, 'utf8')).rows;
    assert(JSON.stringify(first) === JSON.stringify(second), 'rows should be stable across reruns');
  },
};

if (mode !== 'all') {
  const check = checks[mode];
  if (!check) throw new Error(`unknown mode ${mode}`);
  check();
  console.log(`ok ${mode}`);
  process.exit(0);
}

for (const [name, check] of Object.entries(checks)) {
  check();
  console.log(`ok ${name}`);
}
console.log('real story replay benchmark verified');

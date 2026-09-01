import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { analyzeGap } from './gap-analyze.js';

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'proof-or-stop.config.json')) || existsSync(join(dir, 'proof-or-stop.config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'proof-or-stop.config.json')) || existsSync(join(dir, 'proof-or-stop.config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate proof-or-stop.config.json (or the deprecated proof-or-stop.config.json)');
}

const root = findProjectRoot();
const result = analyzeGap(root, new StoryStore(root));
const highGaps = result.gaps.filter(g => g.severity === 'high');

if (result._dashboard) console.log(result._dashboard);

assert.equal(result.coveragePercent, 100, `expected requirement coverage 100, got ${result.coveragePercent}`);
assert.equal(result.healthy, highGaps.length === 0, 'healthy should reflect whether high gaps remain');
assert.match(result._dashboard ?? '', /^Gaps: \d+ high \/ \d+ medium$/m, 'dashboard should summarize high/medium gaps');

console.log('gap coverage smoke passed');

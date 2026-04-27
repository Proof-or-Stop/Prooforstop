import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { analyzeGap } from './gap-analyze.js';

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'koala.config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'koala.config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate koala.config.json');
}

const root = findProjectRoot();
const result = analyzeGap(root, new StoryStore(root));
const highGaps = result.gaps.filter(g => g.severity === 'high');

if (result._dashboard) console.log(result._dashboard);

assert.equal(highGaps.length, 0, `expected high gap count 0, got ${highGaps.length}`);
assert.equal(result.coveragePercent, 100, `expected requirement coverage 100, got ${result.coveragePercent}`);

console.log('gap coverage smoke passed');

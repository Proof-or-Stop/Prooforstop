#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'packages/main/dist/cli.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const gapRaw = execFileSync('node', [cli, 'gap_analyze'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});
const gap = JSON.parse(gapRaw.slice(gapRaw.indexOf('{')));
const highSources = new Set(
  gap.gaps
    .filter((item) => item.severity === 'high' && item.source?.file)
    .map((item) => `${item.source.file}:${item.source.line}`),
);

for (const target of [
  'decisions/framework.md:5',
  'decisions/framework.md:8',
  'decisions/role-separation.md:897',
]) {
  assert(!highSources.has(target), `high gap still present for ${target}`);
}

assert(highSources.has('decisions/framework.md:5') === false, 'framework gap should be cleared');
assert(highSources.has('decisions/framework.md:8') === false, 'framework interface gap should be cleared');
assert(highSources.has('decisions/role-separation.md:897') === false, 'Wave 0 gate gap should be cleared');

const registry = readFileSync(join(root, 'packages/main/src/registry.ts'), 'utf8');
const config = readFileSync(join(root, 'packages/main/src/core/config.ts'), 'utf8');
const parallelPolicy = readFileSync(join(root, 'packages/main/src/core/parallel-policy.ts'), 'utf8');

assert(registry.includes('createMainRegistry') && registry.includes('createToolHandlers'), 'registry interface symbols missing');
assert(config.includes('phaseTools') && config.includes('isCommandAllowed'), 'config interface boundary symbols missing');
assert(parallelPolicy.includes('resolveParallelSafety') && parallelPolicy.includes('depends') && parallelPolicy.includes('sharedHotspots'), 'parallel policy gate symbols missing');

console.log('framework and wave gate high gaps verified');

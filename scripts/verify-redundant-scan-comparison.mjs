#!/usr/bin/env node
// Bounded Lab comparison of six historical hotspots. Quorum is deliberately
// excluded: its repair belongs to a different active Lab.
import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync(process.execPath, ['scripts/ensure-dist.mjs'], { cwd: root, encoding: 'utf8', timeout: 180000 });
assert.equal(build.status, 0, build.stdout + build.stderr);
const results = [];
for (const test of ['validation-git-tree-batch.mjs', 'validation-stage-entry-count.mjs',
  'validation-reuse-cost-process.mjs', 'validation-snapshot-operation-count.mjs']) {
  const child = spawnSync(process.execPath, ['packages/main/tests/' + test], {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(child.stdout ?? '');
  if (child.status !== 0) process.stderr.write(child.stderr ?? String(child.error ?? ''));
  results.push({ test, status: child.status, signal: child.signal });
}
const { RUNTIME_ARTIFACT_REGISTRY: registry, findRuntimeArtifactEntry: find } =
  await import('../packages/main/src/core/runtime-artifact-registry.ts');
find('packages/main/src/comparison-warm.ts');
const count = path => {
  const original = String.prototype.replace;
  let calls = 0;
  try {
    String.prototype.replace = function (...args) { calls++; return Reflect.apply(original, this, args); };
    assert.equal(find(path), undefined);
  } finally { String.prototype.replace = original; }
  return calls;
};
const pathCounts = { warm: count('packages/main/src/comparison-warm.ts'), cold: count('packages/main/src/comparison-unseen.ts') };
console.log('PATH_OPERATION_COUNTS ' + JSON.stringify(pathCounts));
const normalize = path => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
const reference = path => {
  const first = normalize(path);
  return registry.find(entry => entry.matchers.some(matcher => {
    const value = normalize(first);
    if (matcher.kind === 'exact') return value === normalize(matcher.value);
    if (matcher.kind === 'prefix') { const base = normalize(matcher.value); return value === base || value.startsWith(base + '/'); }
    return matcher.value.test(value);
  }));
};
let parityCases = 0;
for (const entry of registry) for (const matcher of entry.matchers) {
  if (typeof matcher.value !== 'string') continue;
  for (const prefix of ['', './', '././', '/', '\\']) for (const suffix of ['', '/child', '-outside']) {
    const path = prefix + matcher.value + suffix;
    assert.equal(find(path)?.id, reference(path)?.id, path); parityCases++;
  }
}
console.log('PATH_PARITY_CASES ' + parityCases);
assert(pathCounts.warm <= 8 && pathCounts.cold <= 8, 'RUNTIME_PATH_NORMALIZATION_REPEATED_PER_MATCHER');
console.log('COMPARISON_RESULTS ' + JSON.stringify(results));
if (results.some(row => row.status !== 0 || row.signal)) process.exitCode = 1;
else console.log('REDUNDANT_SCAN_COMPARISON_GREEN');

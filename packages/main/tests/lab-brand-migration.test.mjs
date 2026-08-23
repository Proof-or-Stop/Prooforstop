import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const labRoot = join(repoRoot, 'packages', 'lab');
const sourcePaths = [
  'src/core/config.ts',
  'src/core/profile.ts',
  'src/core/scoring.ts',
  'src/tool-defs.ts',
  'src/handlers/lab.ts',
];

const sources = sourcePaths.map((relativePath) => [
  relativePath,
  readFileSync(join(labRoot, relativePath), 'utf8'),
]);
const sourceByPath = new Map(sources);

for (const [relativePath, source] of sources) {
  assert.equal(source.includes('lattice-lab'), false, `${relativePath} must not emit the retired lattice-lab brand`);
}
assert.match(sourceByPath.get('src/core/config.ts'), /\$schema:\s*'proof-or-stop-lab\/experiment\.v1'/);
assert.match(sourceByPath.get('src/tool-defs.ts'), /proof-or-stop-lab/);
assert.match(sourceByPath.get('src/handlers/lab.ts'), /proof-or-stop-lab/);

const distConfigPath = join(labRoot, 'dist', 'core', 'config.js');
assert.equal(existsSync(distConfigPath), true, 'build the lab package before running the lab brand migration test');
const { buildExperimentConfig } = await import(distConfigPath);
const { resolveProfile } = await import(join(labRoot, 'dist', 'core', 'profile.js'));
const { validateMetrics } = await import(join(labRoot, 'dist', 'core', 'scoring.js'));
const config = buildExperimentConfig({
  target: 'test-case-reviewer',
  profile: 'reviewer-quality-v1',
});
assert.equal(config.$schema, 'proof-or-stop-lab/experiment.v1');
assert.throws(
  () => resolveProfile('unknown-profile'),
  /未知 proof-or-stop-lab profile: unknown-profile/,
  'unknown profile errors must use the canonical lab brand',
);
assert.throws(
  () => validateMetrics({
    profile: 'reviewer-quality-v1',
    quality: Number.NaN,
    latencyPenalty: 0,
    complexityPenalty: 0,
    stabilityPenalty: 0,
    submetrics: {},
  }),
  /proof-or-stop-lab invalid quality: NaN/,
  'invalid metrics errors must use the canonical lab brand',
);

const scratchRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-lab-brand-'));
try {
  const { createLabHandlers } = await import(join(labRoot, 'dist', 'handlers', 'lab.js'));
  const output = createLabHandlers({ root: scratchRoot }).lab_create({
    target: 'test-case-reviewer',
    profile: 'reviewer-quality-v1',
  });
  assert.equal(output.includes('lattice-lab'), false, 'new lab output must not advertise the retired lattice-lab brand');
  const generated = JSON.parse(readFileSync(
    join(scratchRoot, 'experiments', 'configs', 'lab-reviewer-reviewer-quality-v1.json'),
    'utf8',
  ));
  assert.equal(generated.$schema, 'proof-or-stop-lab/experiment.v1');
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}

console.log('lab brand migration test passed');

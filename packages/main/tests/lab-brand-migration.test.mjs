import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const labRoot = join(repoRoot, 'packages', 'lab');
const sourcePaths = [
  'src/core/config.ts',
  'src/tool-defs.ts',
  'src/handlers/lab.ts',
];

const sources = sourcePaths.map((relativePath) => [
  relativePath,
  readFileSync(join(labRoot, relativePath), 'utf8'),
]);

for (const [relativePath, source] of sources) {
  assert.equal(source.includes('lattice-lab'), false, `${relativePath} must not emit the retired lattice-lab brand`);
}
assert.match(sources[0][1], /\$schema:\s*'proof-or-stop-lab\/experiment\.v1'/);
assert.match(sources[1][1], /proof-or-stop-lab/);
assert.match(sources[2][1], /proof-or-stop-lab/);

const distConfigPath = join(labRoot, 'dist', 'core', 'config.js');
assert.equal(existsSync(distConfigPath), true, 'build the lab package before running the lab brand migration test');
const { buildExperimentConfig } = await import(distConfigPath);
const config = buildExperimentConfig({
  target: 'test-case-reviewer',
  profile: 'reviewer-quality-v1',
});
assert.equal(config.$schema, 'proof-or-stop-lab/experiment.v1');

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

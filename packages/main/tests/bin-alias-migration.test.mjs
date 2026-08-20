import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const brand = await import(join(repoRoot, 'packages/main/dist/core/lattice-brand.js'));

assert.equal(existsSync(join(repoRoot, 'bin/proof-or-stop.js')), true);
assert.equal(existsSync(join(repoRoot, 'bin/proof-or-stop-codex.js')), true);
assert.equal(existsSync(join(repoRoot, 'bin/lattice.js')), false);
assert.equal(existsSync(join(repoRoot, 'bin/lattice-codex.js')), false);
assert.equal(brand.resolveUsageBin('proof-or-stop'), 'proof-or-stop');
assert.equal(brand.resolveUsageBin('lattice'), 'lattice');
assert.equal(brand.resolveUsageBin('cli'), 'proof-or-stop');

const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
for (const path of ['bin/lattice.js', 'bin/lattice-codex.js', 'bin/proof-or-stop.js', 'bin/proof-or-stop-codex.js']) {
  assert.ok(changelog.includes(path), `CHANGELOG.md announces ${path}`);
}

console.log('bin-alias migration test passed');

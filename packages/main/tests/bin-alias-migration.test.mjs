import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
assert.equal(brand.resolveUsageBin('proof-or-stop-codex'), 'proof-or-stop-codex');
assert.equal(brand.resolveUsageBin('lattice'), 'proof-or-stop');
assert.equal(brand.resolveUsageBin('lattice-codex'), 'proof-or-stop');
assert.equal(brand.resolveUsageBin('cli'), 'proof-or-stop');
assert.deepEqual(brand.PROOF_OR_STOP_BIN_NAMES, ['proof-or-stop', 'proof-or-stop-codex']);

const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
for (const path of ['bin/lattice.js', 'bin/lattice-codex.js', 'bin/proof-or-stop.js', 'bin/proof-or-stop-codex.js']) {
  assert.ok(changelog.includes(path), `CHANGELOG.md announces ${path}`);
}

const residueSelfTest = execFileSync(process.execPath, ['scripts/verify-lattice-residue.mjs', '--self-test'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.match(residueSelfTest, /PASS lattice-residue self-test:/, 'residue scanner executes its frozen/compatibility detector checks');

console.log('bin-alias migration test passed');

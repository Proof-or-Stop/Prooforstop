import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const rootLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
const brandSource = readFileSync(join(repoRoot, 'packages/main/src/core/lattice-brand.ts'), 'utf8');
const runtimeSource = readFileSync(join(repoRoot, 'packages/main/src/core/runtime-environment-checks.ts'), 'utf8');

assert.equal(rootPackage.name, 'proof-or-stop');
assert.equal(rootLock.name, 'proof-or-stop');
assert.equal(rootLock.packages[''].name, 'proof-or-stop');
assert.equal(rootPackage.version, rootLock.version);
assert.equal(rootPackage.version, rootLock.packages[''].version);
assert.match(brandSource, /PROOF_OR_STOP_ROOT_PACKAGE_NAME\s*=\s*'proof-or-stop'/);
assert.match(brandSource, /PROOF_OR_STOP_CLI_VERSION\s*=\s*LATTICE_CLI_VERSION/);
assert.match(runtimeSource, /SELF_ROOT_PACKAGE_NAMES/);
assert.match(runtimeSource, /PROOF_OR_STOP_DEPRECATED_ROOT_PACKAGE_NAME/);

const npmName = execFileSync('npm', ['pkg', 'get', 'name'], { cwd: repoRoot, encoding: 'utf8' }).trim();
assert.equal(JSON.parse(npmName), 'proof-or-stop');

console.log('package identity migration test passed');

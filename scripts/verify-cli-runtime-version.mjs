import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'cli-version-proof-'));
const fixture = join(scratch, 'installation');
const pkg = join(fixture, 'packages/main');
const env = { ...process.env };
for (const key of ['NODE_OPTIONS', 'PROOF_OR_STOP_IMPLEMENTATION_MANIFEST', 'PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN', 'PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST']) delete env[key];
try {
  mkdirSync(pkg, { recursive: true });
  cpSync(join(root, 'packages/main/dist'), join(pkg, 'dist'), { recursive: true });
  cpSync(join(root, 'scripts'), join(fixture, 'scripts'), { recursive: true });
  cpSync(join(root, 'bin'), join(fixture, 'bin'), { recursive: true });
  cpSync(join(root, 'package.json'), join(fixture, 'package.json'));
  mkdirSync(join(fixture, 'node_modules'));
  symlinkSync(join(root, 'node_modules'), join(pkg, 'node_modules'));
  // Root-level helper modules and the main package share the installed dependency tree.
  rmSync(join(fixture, 'node_modules'), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'));
  if (existsSync(join(root, 'packages/utils/dist'))) cpSync(join(root, 'packages/utils/dist'), join(fixture, 'packages/utils/dist'), { recursive: true });
  const original = JSON.parse(readFileSync(join(root, 'packages/main/package.json'), 'utf8'));
  const manifest = join(pkg, 'package.json');
  const external = join(scratch, 'external-project');
  mkdirSync(external);
  writeFileSync(join(external, 'package.json'), JSON.stringify({ name: 'unrelated-project', version: '999.0.0', type: 'module' }));
  const invoke = (entry, args = ['--version']) => {
    const start = performance.now();
    const result = spawnSync(process.execPath, [entry, ...args], { cwd: external, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.signal, null, `fixture child signaled: ${result.stderr}`);
    assert.equal(result.error, undefined, 'fixture process must start');
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, elapsedMs: performance.now() - start };
  };
  writeFileSync(manifest, JSON.stringify(original));
  const direct = join(pkg, 'dist/cli.js');
  const control = invoke(direct);
  assert.equal(control.exitCode, 0, `positive runtime fixture setup failed: ${control.stderr}`);
  assert.ok(control.stdout.includes(original.version), 'positive CLI must report its compiled version');
  const before = readdirSync(external).sort();
  const results = [];
  writeFileSync(manifest, JSON.stringify({ ...original, version: '999.1.0' }));
  for (const entry of [direct, join(fixture, 'bin/proof-or-stop.js')]) {
    const observed = invoke(entry);
    results.push({ case: 'stale runtime after package update', entry, ...observed });
    assert.ok(observed.exitCode !== 0 && observed.stderr.includes('CLI_RUNTIME_VERSION_MISMATCH'),
      `CLI_RUNTIME_VERSION_STALE_ACCEPTED: ${JSON.stringify(observed)}`);
    assert.ok(!observed.stdout.includes(`Proof-or-Stop ${original.version}`), 'must not report stale version as healthy');
  }
  writeFileSync(manifest, JSON.stringify(original));
  const restored = invoke(direct);
  assert.equal(restored.exitCode, 0, `exact restoration must recover: ${restored.stderr}`);
  assert.deepEqual(readdirSync(external).sort(), before, 'entry checks must not write into the caller project');
  console.log('CLI_RUNTIME_VERSION_GREEN ' + JSON.stringify({ control, results, restored, callerUnchanged: true }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

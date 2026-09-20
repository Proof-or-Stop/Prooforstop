import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

execFileSync(process.execPath, [fileURLToPath(new URL('./verify-entry.mjs', import.meta.url))],
  { stdio: 'inherit', timeout: 30_000 });
const root = mkdtempSync(join(tmpdir(), 'benchmark-entry-contract-'));
try {
  const controls = join(root, 'benchmark-controls');
  const monitor = join(root, 'benchmark-monitor-change-filter');
  mkdirSync(controls); mkdirSync(monitor);
  for (const name of ['baseline.mjs', 'controller.mjs', 'fixtures.mjs', 'verify.mjs', 'verify-entry.mjs']) {
    copyFileSync(new URL(name, import.meta.url), join(controls, name));
  }
  copyFileSync(new URL('../benchmark-monitor-change-filter/policy.mjs', import.meta.url), join(monitor, 'policy.mjs'));
  const runner = join(controls, 'verify.mjs');
  const source = readFileSync(runner, 'utf8');
  const registration = "test('invalid budget shapes and numbers fail closed',";
  assert.equal(source.split(registration).length, 2, 'Mutation must target exactly one negative test');
  writeFileSync(runner, source.replace(registration, "(() => {})('invalid budget shapes and numbers fail closed',"));
  const result = spawnSync(process.execPath, [join(controls, 'verify-entry.mjs')],
    { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, 'VERIFIER_COUNT_LOSS_ACCEPTED: removing a delivered check must fail');
  assert.match(result.stdout + result.stderr, /VERIFIER_ENTRY_COUNT/);
  console.log('ENTRY_CONTRACT_PASS removed negative check is rejected');
} finally {
  rmSync(root, { recursive: true, force: true });
}

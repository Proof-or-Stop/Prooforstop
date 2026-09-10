import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const original = cp.execSync;
let probes = 0;
cp.execSync = function(command, ...args) {
  if (command === 'git rev-parse --show-toplevel') probes++;
  return original.call(this, command, ...args);
};
syncBuiltinESMExports();
const { gitProbe } = await import('../packages/main/src/core/git-probe.ts');
const root = mkdtempSync(join(tmpdir(), 'git-root-probe-'));
const nested = join(root, 'nested');
try {
  cp.execFileSync('git', ['init', '-q', root]); mkdirSync(nested);
  const first = gitProbe('git rev-parse --show-toplevel', { cwd: nested });
  assert.equal(first.ok, true);
  for (let i = 0; i < 5; i++) assert.deepEqual(gitProbe('git rev-parse --show-toplevel', { cwd: nested }), first);
  assert.equal(probes, 1, 'U17: stable cwd must reuse its Git root probe');
  cp.execFileSync('git', ['init', '-q', nested]);
  const rebound = gitProbe('git rev-parse --show-toplevel', { cwd: nested });
  assert.equal(rebound.ok, true); assert.notEqual(rebound.output, first.output);
  assert.equal(probes, 2);
  rmSync(join(nested, '.git'), { recursive: true, force: true });
  assert.deepEqual(gitProbe('git rev-parse --show-toplevel', { cwd: nested }), first);
  assert.equal(probes, 3);
  console.log('PASS U17 git-root-probe-memo');
} finally {
  cp.execSync = original; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true });
}

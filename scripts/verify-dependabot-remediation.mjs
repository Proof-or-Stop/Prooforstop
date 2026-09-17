#!/usr/bin/env node
// Regression for the 2026-09-17 Dependabot snapshot; audit failures fail closed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const workspaces = ['.', 'packages/main', 'packages/utils', 'packages/lab', 'packages/graph'];
const floors = { 'fast-uri': '3.1.6', hono: '4.13.5', qs: '6.16.0' };
const defects = [];
for (const ws of workspaces) {
  const lock = JSON.parse(readFileSync(new URL(`../${ws}/package-lock.json`, import.meta.url)));
  assert.ok(lock.packages, `${ws}: lockfile packages missing`);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path.endsWith('node_modules/pkg')) defects.push(`${ws}: retired pkg ${entry.version}`);
    for (const [name, floor] of Object.entries(floors)) {
      if (!path.endsWith(`node_modules/${name}`)) continue;
      const parts = entry.version.split('.').map(Number);
      const expected = floor.split('.').map(Number);
      const firstDifferent = parts.findIndex((v, i) => v !== expected[i]);
      if (parts.length !== 3 || parts.some(v => !Number.isInteger(v)) ||
          (firstDifferent !== -1 && parts[firstDifferent] < expected[firstDifferent])) {
        defects.push(`${ws}: ${name} ${entry.version} below ${floor}`);
      }
    }
  }
}
assert.equal(defects.length, 0, `DEPENDABOT_TARGET_RED: ${defects.join('; ')}`);
for (const ws of workspaces) {
  const result = spawnSync('npm', ['audit', '--json'], { cwd: `${root}/${ws}`, encoding: 'utf8', timeout: 120000 });
  assert.ifError(result.error);
  const report = JSON.parse(result.stdout);
  assert.ok(!report.error, `${ws}: audit service error ${JSON.stringify(report.error)}`);
  assert.equal(report.metadata?.vulnerabilities?.total, 0, `${ws}: advisories remain: ${result.stdout}`);
  assert.equal(result.status, 0, `${ws}: audit command failed: ${result.stderr}`);
  console.log(`${ws}: npm audit zero vulnerabilities`);
}
for (const args of [['run', 'package:desktop:host'], ['run', 'test:desktop-package']]) {
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit', timeout: 600000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${args.join(' ')} failed`);
}
console.log('DEPENDABOT_REMEDIATION_GREEN');

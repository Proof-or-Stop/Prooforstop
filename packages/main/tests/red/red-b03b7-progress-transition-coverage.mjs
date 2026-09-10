import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = new URL('../../src/tasks/finding-identity-lineage-smoke.ts', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');

const requiredCases = [
  'failed target test outcome is valid evidence but not semantic progress',
  'status regression from a signed present predecessor is refused',
  'predecessor digest substitutions refuse without ledger mutation',
];

try {
  for (const name of requiredCases) {
    assert.ok(source.includes(`test('${name}'`), `missing executable case: ${name}`);
  }
  const smokePath = fileURLToPath(new URL('../../dist/tasks/finding-identity-lineage-smoke.js', import.meta.url));
  const smoke = spawnSync(process.execPath, [smokePath, '--section=routes'], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 24 * 1024 * 1024,
  });
  const output = `${smoke.stdout ?? ''}${smoke.stderr ?? ''}`;
  assert.equal(smoke.status, 0, `routes smoke did not pass:\n${output.slice(-4000)}`);
  for (const name of requiredCases) {
    assert.ok(output.includes(`CANDIDATE ${name} PASS`), `case did not execute successfully: ${name}`);
  }
  assert.match(output, /FINDING_IDENTITY_ROUTES PASS \d+ passing 0 failed cases/);
  console.log('B03B7_PROGRESS_TRANSITION_COVERAGE PASS');
} catch (error) {
  console.error(`B03B7_PROGRESS_TRANSITION_COVERAGE FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

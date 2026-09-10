import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

function run(label, args, timeoutMs) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return {
    label,
    ok: result.status === 0 && result.signal === null && !result.error,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    tail: output.slice(-800),
  };
}

const checks = [
  run('retired-authority-loader-provenance', [
    'packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js',
  ], 270_000),
  run('e40f-quorum-inventory', [
    'packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs',
    '--case=inventory-bijection',
  ], 180_000),
  run('proofstory-acceptance-basis', [
    'packages/main/dist/tasks/proofstory-acceptance-basis-smoke.js',
  ], 180_000),
  run('review-inventory-critic-aggregate', [
    'packages/main/dist/tasks/review-inventory-epoch-smoke.js',
  ], 180_000),
  run('identity-inventory-pins', [
    'packages/main/tests/canonical-new-story-artifacts.test.mjs',
    '--group=identity-inventory',
  ], 180_000),
  run('identity-site-pins', [
    'packages/main/tests/canonical-new-story-artifacts.test.mjs',
    '--group=identity-sites',
  ], 180_000),
  run('b49d4-derived-guard-execution', [
    'packages/main/tests/red/red-b49d4-registration-derivation.mjs',
  ], 300_000),
];

const identitySource = readFileSync(
  resolve(repoRoot, 'packages/main/tests/canonical-new-story-artifacts.test.mjs'),
  'utf8',
);
const historicalMatch = identitySource.match(/const historical = '([0-9a-f]{40})';/u);
assert.ok(historicalMatch, 'identity fixture must expose one exact historical prerequisite');
const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', historicalMatch[1], 'main'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
checks.push({
  label: 'identity-history-anchor-is-on-main',
  ok: ancestor.status === 0,
  status: ancestor.status,
  signal: ancestor.signal,
  error: ancestor.error?.message ?? null,
  tail: historicalMatch[1],
});
checks.push({
  label: 'public-prompt-fixture-builds-utils',
  ok: /measurementRoot[\s\S]{0,1600}packages\/utils[\s\S]{0,400}test:proof-or-stop-prompt-baseline/u.test(identitySource),
  status: null,
  signal: null,
  error: null,
  tail: 'measurement public-operation fixture must build packages/utils before invoking bin/proof-or-stop.js',
});

for (const row of checks) {
  process.stdout.write(`${row.ok ? 'PASS' : 'FAIL'} ${row.label}`);
  if (!row.ok) process.stdout.write(` status=${row.status} signal=${row.signal} error=${row.error}\n${row.tail}`);
  process.stdout.write('\n');
}

const failed = checks.filter(row => !row.ok);
if (failed.length > 0) {
  process.stdout.write(`BASELINE_CONVERGENCE_FAIL count=${failed.length}\n`);
  process.exit(1);
}
process.stdout.write('BASELINE_CONVERGENCE_PASS\n');

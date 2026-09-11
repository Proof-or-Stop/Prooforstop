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
// Current main replaced the historical-commit fixture with a disposable current
// implementation producer. Preserve that stronger isolation instead of restoring
// a hard-coded historical author or importing production private keys.
checks.push({
  label: 'identity-current-implementation-prerequisite',
  ok: identitySource.includes('createFixtureImplementationCommit(root)')
    && identitySource.includes("fixtureRoots.includes(root), 'implementation prerequisite is restricted to generated test repositories'")
    && !identitySource.includes("const historical = '"),
  status: null, signal: null, error: null,
  tail: 'current implementation producer is confined to disposable test repositories',
});
checks.push({
  label: 'public-prompt-fixture-builds-utils',
  ok: (() => {
    return identitySource.includes("for (const packageName of ['utils', 'lab'])")
      && identitySource.includes("cpSync(built, join(root, 'packages', packageName, 'dist')")
      && identitySource.includes("'test:proof-or-stop-prompt-baseline'");
  })(),
  status: null,
  signal: null,
  error: null,
  tail: 'public-operation fixture copies prepared utils/lab builds before invoking the CLI',
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

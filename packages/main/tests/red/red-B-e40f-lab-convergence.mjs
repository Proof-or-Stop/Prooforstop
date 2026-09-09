#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const sourceRoot = join(repoRoot, 'packages/main/src/tasks');
const distRoot = join(repoRoot, 'packages/main/dist/tasks');
const targetSources = [
  'quorum-submit-smoke-case-catalog.ts',
  'quorum-submit-smoke-cases.json',
  'quorum-submit-smoke-fixture.ts',
  'quorum-submit-smoke-worker.ts',
];
const redMarker = 'B_E40F_LAB_RED_SAFE_PARALLEL_CONVERGENCE_MISSING';

function moduleUrl(name) {
  return pathToFileURL(join(distRoot, name)).href;
}

function expectFailure(action, pattern, label) {
  let observed;
  try {
    action();
  } catch (error) {
    observed = error;
  }
  assert.ok(observed, `${label} did not fail closed`);
  assert.match(String(observed.message), pattern, `${label} emitted the wrong diagnostic`);
}

function findQuorumConfigRow(config) {
  const matches = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.label === 'quorum-submit-smoke') matches.push(value);
    Object.values(value).forEach(visit);
  };
  visit(config);
  assert.equal(matches.length, 1, 'configuration must contain one quorum-submit-smoke row');
  return matches[0];
}

async function measureCoordinator(worker, registrations, jobs) {
  const startedAt = performance.now();
  const report = await worker.runQuorumSmokeCoordinator({
    registrations,
    jobs,
    timeoutMs: 5_000,
    context: { runId: `b-e40f-lab-jobs-${jobs}` },
  });
  return { report, elapsedMs: performance.now() - startedAt };
}

async function main() {
  const missingSources = targetSources.filter((name) => !existsSync(join(sourceRoot, name)));
  if (missingSources.length > 0) {
    throw new Error(`${redMarker}: ${missingSources.join(', ')}`);
  }

  const [catalog, fixture, worker, pure, integration, prune] = await Promise.all([
    import(moduleUrl('quorum-submit-smoke-case-catalog.js')),
    import(moduleUrl('quorum-submit-smoke-fixture.js')),
    import(moduleUrl('quorum-submit-smoke-worker.js')),
    import(moduleUrl('quorum-submit-smoke-pure-cases.js')),
    import(moduleUrl('quorum-submit-smoke-integration-cases.js')),
    import(moduleUrl('quorum-submit-smoke-prune-cases.js')),
  ]);

  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'quorum-submit-smoke-cases.json'), 'utf8'));
  const registrations = catalog.createQuorumSmokeRegistry(
    pure.QUORUM_SMOKE_CASES,
    integration.QUORUM_SMOKE_CASES,
    prune.QUORUM_SMOKE_CASES,
  );
  catalog.validateQuorumSmokeInventory({ manifestCases: manifest.cases, executableCases: registrations });
  catalog.validateQuorumSmokePartitions({ cases: manifest.cases });
  assert.equal(registrations.length, 73);
  assert.equal(new Set(registrations.map((row) => row.id)).size, 73);
  assert.ok(registrations.every((row) => row.callbackBound === true && typeof row.run === 'function'));

  expectFailure(
    () => catalog.validateQuorumSmokeInventory({
      manifestCases: manifest.cases.slice(0, -1),
      executableCases: registrations,
    }),
    /missing manifest case qsm-073/,
    'missing inventory mutation',
  );
  expectFailure(
    () => catalog.validateQuorumSmokeInventory({
      manifestCases: [...manifest.cases.slice(0, -1), { ...manifest.cases.at(-1), id: 'qsm-999' }],
      executableCases: registrations,
    }),
    /extra manifest case qsm-999/,
    'same-count inventory replacement',
  );
  expectFailure(
    () => catalog.validateQuorumSmokePartitions({
      cases: manifest.cases.map((row) => row.id === 'qsm-002' ? { ...row, domain: 'integration' } : row),
    }),
    /qsm-002 domain mismatch/,
    'partition mutation',
  );

  let callbackCount = 0;
  const selectionCases = registrations.map((row) => ({
    ...row,
    run: () => { callbackCount += 1; },
  }));
  const exact = catalog.resolveQuorumSmokeSelection({ argv: ['--case=qsm-022'], cases: selectionCases });
  assert.deepEqual(exact.selectedCaseIds, ['qsm-022']);
  expectFailure(
    () => catalog.resolveQuorumSmokeSelection({ argv: ['--grep='], cases: selectionCases }),
    /empty.*zero cases executed/i,
    'empty selector',
  );
  expectFailure(
    () => catalog.resolveQuorumSmokeSelection({ argv: ['--grep=definitely-absent'], cases: selectionCases }),
    /unknown.*zero cases executed/i,
    'unknown selector',
  );
  expectFailure(
    () => catalog.resolveQuorumSmokeSelection({ argv: ['--grep=shared derivation'], cases: selectionCases }),
    /ambiguous.*matches=3.*zero cases executed/i,
    'ambiguous selector',
  );
  assert.equal(callbackCount, 0, 'selection preflight executed a case callback');

  const cacheRoot = mkdtempSync(join(tmpdir(), 'b-e40f-lab-fixture-'));
  try {
    const pool = fixture.createQuorumSmokeFixtureTemplatePool({
      cacheRoot,
      buildTemplate: ({ profile, targetRoot }) => {
        writeFileSync(join(targetRoot, 'seed.json'), `${JSON.stringify(profile.inputs)}\n`);
      },
    });
    const profile = { id: 'lab-profile', inputs: { configDigest: 'same' } };
    const first = await pool.clone(profile, { caseId: 'lab-fixture-a' });
    const second = await pool.clone(profile, { caseId: 'lab-fixture-b' });
    assert.notEqual(first.root, second.root, 'two cases shared mutable fixture state');
    assert.equal(first.templateRoot, second.templateRoot, 'compatible fixtures did not reuse a template');
    writeFileSync(join(first.root, 'seed.json'), 'mutated\n');
    assert.equal(readFileSync(join(second.root, 'seed.json'), 'utf8'), '{"configDigest":"same"}\n');
    assert.equal(readFileSync(join(first.templateRoot, 'seed.json'), 'utf8'), '{"configDigest":"same"}\n');
    assert.deepEqual(pool.stats(), { profiles: 1, builds: 1, clones: 2 });
    await pool.dispose();
    assert.deepEqual(readdirSync(cacheRoot), [], 'fixture pool left template or clone residue');
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }

  const config = JSON.parse(readFileSync(join(repoRoot, 'proof-or-stop.config.json'), 'utf8'));
  const configRow = findQuorumConfigRow(config);
  assert.deepEqual(
    configRow.args,
    ['packages/main/dist/tasks/quorum-submit-smoke.js', '--jobs=2'],
    'validation does not request the bounded parallel mode',
  );
  assert.deepEqual(
    configRow.resources,
    [
      { class: 'git-common-dir', key: '.', access: 'shared' },
      { class: 'fixed-path', key: '.proof-or-stop/runtime/validate-plan-barrier', access: 'exclusive' },
    ],
    'quorum keeps internal shard parallelism while isolating its protected-root observation from other validation writers',
  );
  for (const key of [
    'PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE',
    'PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE',
    'PROOF_OR_STOP_QUORUM_SMOKE_REPOSITORY_ROOT',
  ]) {
    assert.ok(configRow.declaredEnvironmentKeys.includes(key), `missing declared environment key ${key}`);
  }
  assert.equal(worker.MAX_QUORUM_SMOKE_JOBS, 8);
  assert.deepEqual(worker.QUORUM_SMOKE_PARALLEL_CAPABILITY, {
    schema: 'proof-or-stop.quorum-smoke-parallel-capability.v1',
    shardCount: 4,
    workerModel: 'one-process-per-shard',
    tempIsolation: 'parent-owned-roots-v1',
  });

  const synthetic = Array.from({ length: 6 }, (_, index) => ({
    id: `lab-${index + 1}`,
    title: `bounded coordinator witness ${index + 1}`,
    domain: 'pure',
    shard: index % 2 === 0 ? 'lab-a' : 'lab-b',
    callbackBound: true,
    capabilities: [],
    run: () => new Promise((resolveRun) => setTimeout(resolveRun, 180)),
  }));
  const serial = await measureCoordinator(worker, synthetic, 1);
  const parallel = await measureCoordinator(worker, synthetic, 2);
  assert.equal(serial.report.ok, true);
  assert.equal(parallel.report.ok, true);
  assert.equal(serial.report.maxConcurrent, 1);
  assert.equal(parallel.report.maxConcurrent, 2);
  assert.deepEqual(
    parallel.report.results.map((row) => [row.caseId, row.status]),
    serial.report.results.map((row) => [row.caseId, row.status]),
  );
  assert.deepEqual(parallel.report.residue, { temp: 0, process: 0, ticket: 0, quarantine: 0 });
  const gain = 1 - parallel.elapsedMs / serial.elapsedMs;
  assert.ok(
    gain >= 0.20,
    `bounded coordinator gain ${(gain * 100).toFixed(1)}% is below 20%: serial=${serial.elapsedMs.toFixed(1)}ms parallel=${parallel.elapsedMs.toFixed(1)}ms`,
  );

  console.log(
    `B_E40F_LAB_GREEN cases=73 selector=fail-closed partitions=4 fixture=isolated-reuse jobs=2 gain=${(gain * 100).toFixed(1)}% residue=0`,
  );
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});

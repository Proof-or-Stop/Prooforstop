#!/usr/bin/env bun

/** Production-path integration seam for DYN-3/DYN-5. */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { persistCanonicalFullBaseline, runStoryAwareDynamicValidation } from '../handlers/story-aware-validation.js';
import { configuredValidationCommands } from '../handlers/verifier.js';
import { createValidationClosureCertificate, verifyValidationShardReceipt, verifyValidationClosureCertificate } from '../core/story-aware-validation.js';
import { executeValidationPlan } from '../core/validation-executor.js';

const root = mkdtempSync(join(tmpdir(), 'proof-story-aware-production-'));
const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/.keep'), '\n');
  const caseRegistryPath = 'packages/main/src/review-pass-cases.json';
  const adapterPath = 'packages/main/src/tasks/story-aware-validation-case-adapter.mjs';
  const adapterSource = readFileSync(new URL('./story-aware-validation-case-adapter.mjs', import.meta.url), 'utf8');
  const runtimeNode = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
  const runner = (caseId: string) => ({
    command: runtimeNode,
    args: ['-e', `process.stdout.write(${JSON.stringify(`case-body:${caseId}:executed`)});`],
    successMarker: `case-body:${caseId}:executed`,
  });
  writeFileSync(join(root, caseRegistryPath), JSON.stringify([
    ...Array.from({ length: 3 }, (_, index) => {
      const caseId = `review-pass:case-${index + 1}`;
      return { caseId, domain: 'review-pass', sentinel: true, runner: runner(caseId) };
    }),
    ...Array.from({ length: 4 }, (_, index) => {
      const caseId = `quorum:case-${index + 1}`;
      return { caseId, domain: 'quorum', sentinel: true, runner: runner(caseId) };
    }),
  ]) + '\n');
  mkdirSync(join(root, 'packages/main/src/tasks'), { recursive: true });
  writeFileSync(join(root, adapterPath), adapterSource);
  // Synthetic retired-only caller: a current adapter must reject it before
  // creating even a shard directory or any case-evidence file.
  const retiredShardDir = join(root, 'retired-env-rejection');
  const retiredPrefix = ['LAT', 'TICE_VALIDATION_'].join('');
  const retiredValues = {
    SHARD_CASE_REGISTRY: join(root, caseRegistryPath),
    SHARD_DIR: retiredShardDir,
    SHARD_DOMAIN: 'review-pass',
    SHARD_ID: 'retired-env-fixture',
    SHARD_SENTINEL: 'review-pass:case-1',
    SHARD_CASE_REGISTRY_DIGEST: 'a'.repeat(64),
    SHARD_ADAPTER_DIGEST: 'b'.repeat(64),
    SHARD_CASE_IDS: 'review-pass:case-1',
    PROJECT_ROOT: root,
  };
  const retiredEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('PROOF_OR_STOP_VALIDATION_') && !key.startsWith(retiredPrefix)));
  const retiredExecution = spawnSync(runtimeNode, [join(root, adapterPath)], {
    cwd: root, encoding: 'utf8',
    env: { ...retiredEnv, ...Object.fromEntries(Object.entries(retiredValues).map(([key, value]) => [`${retiredPrefix}${key}`, value])) },
  });
  assert.notEqual(retiredExecution.status, 0, 'retired-only adapter environment must fail closed');
  assert.match(`${retiredExecution.stdout}${retiredExecution.stderr}`, /environment is incomplete/i);
  assert.equal(existsSync(retiredShardDir), false, 'retired-only adapter environment must create no shard authority');
  console.log('canonical-only dynamic adapter rejects retired env with zero mutation PASS');
  mkdirSync(join(root, 'packages/main/src/core'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/core/validation-runtime-tracer.cjs'), readFileSync(new URL('../core/validation-runtime-tracer.cjs', import.meta.url), 'utf8'));
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    validate: {
      commands: [
        { command: runtimeNode, args: ['-e', "process.stdout.write('build\\n')", 'build'], label: 'build', assurance: 'story-selectable', riskTier: 'local', closurePolicy: 'static-and-traced', fullBaselineReusePolicy: 'not-applicable' },
        { command: runtimeNode, args: [adapterPath, 'review-pass'], label: 'review-pass-discard-smoke', env: { PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER: 'case-registry-output-v1' }, caseRegistryPath, assurance: 'story-selectable', riskTier: 'local', closurePolicy: 'static-and-traced', fullBaselineReusePolicy: 'not-applicable' },
        { command: runtimeNode, args: [adapterPath, 'quorum'], label: 'quorum-submit-smoke', env: { PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER: 'case-registry-output-v1' }, caseRegistryPath, assurance: 'story-selectable', riskTier: 'local', closurePolicy: 'static-and-traced', fullBaselineReusePolicy: 'not-applicable' },
      ],
    },
  }, null, 2));
  git(['init']);
  git(['config', 'user.email', 'smoke@example.test']);
  git(['config', 'user.name', 'Proof-or-Stop Smoke']);
  git(['add', '.']);
  git(['commit', '-m', 'production validation fixture']);
  const head = git(['rev-parse', 'HEAD']);
  const configured = configuredValidationCommands(root);
  assert.equal(configured.length, 3, 'verifier must preserve the configured build/review-pass/quorum inventory');
  assert.equal(configured[1]?.caseRegistryPath, caseRegistryPath);
  assert.equal(configured[1]?.assurance, 'story-selectable');
  assert.equal(configured[1]?.fullBaselineReusePolicy, 'not-applicable');
  const tracedChild = await executeValidationPlan({
    provider: 'runtime-trace-child-aggregation',
    commands: [{
      label: 'child-read-probe',
      command: runtimeNode,
      args: ['-e', "require('node:child_process').execFileSync(process.execPath, ['-e', \"require('node:fs').readFileSync('/dev/null')\"])"] ,
    }],
    warnings: [],
  }, root, head, 'B-production', { jobs: 1 });
  assert.equal(tracedChild.allPass, true);
  assert.equal(tracedChild.commands[0]?.runtimeTrace?.readPaths?.includes('/dev/null'), true,
    'runtime closure trace merges child reads instead of allowing the parent wrapper to overwrite them');
  const forkProbePath = join(root, 'packages/main/src/fork-probe.cjs');
  const forkArgument = 'fork-probe-argument';
  const execCommand = `${JSON.stringify(runtimeNode)} -e ${JSON.stringify("require('node:fs').readFileSync('/dev/null'); process.stdout.write('exec')")}`;
  const execSyncCommand = `${JSON.stringify(runtimeNode)} -e ${JSON.stringify("require('node:fs').readFileSync('/dev/null'); process.stdout.write('exec-sync')")}`;
  writeFileSync(forkProbePath, "require('node:fs').readFileSync('/dev/null');\n");
  const tracedChildApis = await executeValidationPlan({
    provider: 'runtime-trace-child-api-coverage',
    commands: [{
      label: 'child-api-probe',
      command: runtimeNode,
      args: ['-e', [
        "const { exec, execSync, fork } = require('node:child_process');",
        `const execCommand = ${JSON.stringify(execCommand)};`,
        `const execSyncCommand = ${JSON.stringify(execSyncCommand)};`,
        `const forkProbePath = ${JSON.stringify(forkProbePath)};`,
        `const forkArgument = ${JSON.stringify(forkArgument)};`,
        'execSync(execSyncCommand, { stdio: "ignore" });',
        'const forked = fork(forkProbePath, [forkArgument]);',
        'forked.once("exit", () => exec(execCommand, error => { if (error) throw error; }));',
      ].join(' ')],
    }],
    warnings: [],
  }, root, head, 'B-production-child-apis', { jobs: 1 });
  assert.equal(tracedChildApis.allPass, true);
  const tracedSpawnedPaths = tracedChildApis.commands[0]?.runtimeTrace?.spawnedPaths || [];
  for (const expectedPath of [execCommand, execSyncCommand, forkProbePath, forkArgument]) {
    assert.equal(tracedSpawnedPaths.includes(expectedPath), true,
      `runtime tracer must observe ${expectedPath} for exec/execSync/fork`);
  }
  const undeclaredChildApiClosure = createValidationClosureCertificate({
    commandId: 'child-api-probe', baseHead: head, inventoryDigest: 'smoke-inventory', catalogDigest: 'smoke-catalog',
    staticPaths: [], runtimeTrace: { spawnedPaths: tracedSpawnedPaths },
  });
  assert.equal(undeclaredChildApiClosure.undeclaredObservedPaths.includes(execCommand), true,
    'an undeclared exec command must invalidate the runtime closure');
  assert.equal(undeclaredChildApiClosure.undeclaredObservedPaths.includes(execSyncCommand), true,
    'an undeclared execSync command must invalidate the runtime closure');
  assert.equal(undeclaredChildApiClosure.undeclaredObservedPaths.includes(forkProbePath.replace(/^\//, '')), true,
    'an undeclared fork module path must invalidate the runtime closure');
  assert.equal(verifyValidationClosureCertificate(undeclaredChildApiClosure), false,
    'runtime closure verification must fail closed when a newly traced child API is undeclared');
  const run = await runStoryAwareDynamicValidation({
    projectRoot: root,
    gitCwd: root,
    storyId: 'B-production',
    baseHead: head,
    head,
    changedFiles: [],
    mode: 'enforce-low-risk',
    commands: configured,
  });
  assert.equal(run.buildResult.allPass, true);
  assert.equal(run.authority.authoritative, false, 'no canonical baseline must fail closed');
  const shardRoot = join(root, '.proof-or-stop/runtime/dynamic-validation/B-production/shards');
  assert.equal(existsSync(shardRoot), true, 'production run must persist shard artifacts');
  const shardFiles = readFileSync(join(shardRoot, readdirSync(shardRoot).find(name => name.endsWith('aggregate.json'))!), 'utf8');
  assert.match(shardFiles, /coveredCaseIds/);
  const receiptFiles = readdirSync(shardRoot).filter(name => name.startsWith('shard-receipt-') && name.endsWith('.json'));
  assert.equal(receiptFiles.length, 7, 'registered adapter must emit one receipt per review-pass and quorum shard');
  for (const name of receiptFiles) {
    const receipt = JSON.parse(readFileSync(join(shardRoot, name), 'utf8'));
    assert.equal(verifyValidationShardReceipt(receipt), true, `invalid persisted shard receipt ${name}`);
    assert.equal(receipt.registryObserved, true);
    assert.equal(receipt.sentinelObserved, true);
    assert.equal(receipt.residue.length, 0);
  }
  const aggregates = readdirSync(shardRoot)
    .filter(name => name.endsWith('-aggregate.json'))
    .map(name => JSON.parse(readFileSync(join(shardRoot, name), 'utf8')));
  assert.deepEqual(aggregates.find((row) => row.coveredCaseIds.some((id: string) => id.startsWith('review-pass:')))?.coveredCaseIds.sort(), ['review-pass:case-1', 'review-pass:case-2', 'review-pass:case-3']);
  assert.deepEqual(aggregates.find((row) => row.coveredCaseIds.some((id: string) => id.startsWith('quorum:')))?.coveredCaseIds.sort(), ['quorum:case-1', 'quorum:case-2', 'quorum:case-3', 'quorum:case-4']);
  console.log('story-aware validation production path PASS');
  console.log('production shard receipts PASS');
  console.log('gate-owned authority fallback PASS');

  // A valid canonical name is insufficient if the adapter bytes drift. The
  // exact source binding must refuse a tampered adapter before case execution.
  writeFileSync(join(root, adapterPath), `${adapterSource}\n// synthetic adapter tamper\n`);
  try {
    const tampered = await runStoryAwareDynamicValidation({
      projectRoot: root, gitCwd: root, storyId: 'B-production-tamper',
      baseHead: head, head, changedFiles: [], mode: 'enforce-low-risk', commands: configured,
    });
    assert.equal(tampered.authority.authoritative, false, 'tampered adapter must not grant dynamic authority');
    const tamperedShardRoot = join(root, '.proof-or-stop/runtime/dynamic-validation/B-production-tamper/shards');
    const tamperedFiles = readdirSync(tamperedShardRoot);
    assert.equal(tamperedFiles.filter(name => name.startsWith('shard-receipt-')).length, 0,
      'tampered adapter must create no shard receipt');
    const tamperedAggregates = tamperedFiles.filter(name => name.endsWith('-aggregate.json'))
      .map(name => JSON.parse(readFileSync(join(tamperedShardRoot, name), 'utf8')));
    assert.equal(tamperedAggregates.length, 2);
    assert.equal(tamperedAggregates.every(row => row.ok === false && row.errors.length > 0), true,
      'both domains must reject unexecuted shard evidence');
    assert.match(JSON.stringify(tampered.selectedResult), /registered case-aware adapter/,
      'the public production result must identify the rejected adapter binding');
    console.log('canonical dynamic adapter source tamper rejects all shard receipts PASS');
  } finally {
    writeFileSync(join(root, adapterPath), adapterSource);
  }

  // A minimal local command with an explicit closure/environment declaration
  // proves the positive DYN-3 boundary as well as the fail-closed sharding
  // path above.  The baseline is produced by the complete executor, then the
  // same configured inventory is admitted by the real dynamic runner.
  const authorityRoot = mkdtempSync(join(tmpdir(), 'proof-story-aware-authority-'));
  try {
    mkdirSync(join(authorityRoot, 'packages/main/src'), { recursive: true });
    writeFileSync(join(authorityRoot, 'packages/main/src/.keep'), '\n');
    mkdirSync(join(authorityRoot, 'packages/main/src/core'), { recursive: true });
    writeFileSync(join(authorityRoot, 'packages/main/src/core/validation-runtime-tracer.cjs'), readFileSync(new URL('../core/validation-runtime-tracer.cjs', import.meta.url), 'utf8'));
    writeFileSync(join(authorityRoot, 'proof-or-stop.config.json'), JSON.stringify({
      validate: { commands: [{
        command: runtimeNode, args: ['-e', 'process.stdout.write("authority-pass")'], label: 'build',
        assurance: 'story-selectable', riskTier: 'local', closurePolicy: 'static-and-traced',
        fullBaselineReusePolicy: 'not-applicable', declaredEnvironmentKeys: ['PROOF_OR_STOP_RUNTIME_TRACE_FILE'],
      }] },
    }, null, 2) + '\n');
    const authorityGit = (args: string[]) => execFileSync('git', args, { cwd: authorityRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    authorityGit(['init']);
    authorityGit(['config', 'user.email', 'smoke@example.test']);
    authorityGit(['config', 'user.name', 'Proof-or-Stop Smoke']);
    authorityGit(['add', '.']);
    authorityGit(['commit', '-m', 'authority fixture']);
    const authorityHead = authorityGit(['rev-parse', 'HEAD']);
    const authorityCommands = configuredValidationCommands(authorityRoot);
    const authorityFull = await executeValidationPlan({ provider: 'authority-baseline-full', commands: authorityCommands, warnings: [] }, authorityRoot, authorityHead, 'B-authority');
    assert.equal(authorityFull.allPass, true);
    const baseline = persistCanonicalFullBaseline({ projectRoot: authorityRoot, sourceHead: authorityHead, result: authorityFull, commands: authorityCommands });
    assert.ok(baseline, 'positive authority fixture must persist a canonical baseline');
    const admitted = await runStoryAwareDynamicValidation({ projectRoot: authorityRoot, gitCwd: authorityRoot, storyId: 'B-authority', baseHead: authorityHead, head: authorityHead, changedFiles: [], mode: 'enforce-low-risk', commands: authorityCommands });
    assert.equal(admitted.authority.authoritative, true, JSON.stringify(admitted.authority));
    assert.equal(admitted.dynamicAllPass, true);
    console.log('gate-owned authority PASS');
  } finally {
    rmSync(authorityRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

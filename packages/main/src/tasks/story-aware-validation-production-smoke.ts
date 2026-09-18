#!/usr/bin/env bun

/** Production-path integration seam for DYN-3/DYN-5. */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { persistCanonicalFullBaseline, runStoryAwareDynamicValidation } from '../handlers/story-aware-validation.js';
import { configuredValidationCommands } from '../handlers/verifier.js';
import { createValidationClosureCertificate, verifyValidationShardReceipt, verifyValidationClosureCertificate } from '../core/story-aware-validation.js';
import { withValidationSigningRoot } from '../core/validation-signing-context.js';
import { executeValidationPlan } from '../core/validation-executor.js';

const root = mkdtempSync(join(tmpdir(), 'proof-story-aware-production-'));
const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/.keep'), '\n');
  const caseRegistryPath = 'packages/main/src/review-pass-cases.json';
  const adapterPath = 'packages/main/src/tasks/story-aware-validation-case-adapter.mjs';
  const adapterSource = readFileSync(new URL('../../src/tasks/story-aware-validation-case-adapter.mjs', import.meta.url), 'utf8');
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
  writeFileSync(join(root, 'packages/main/src/tasks/validation-child-environment.mjs'), readFileSync(new URL('../../src/tasks/validation-child-environment.mjs', import.meta.url), 'utf8'));
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
  // The run binds the compiled artifacts its build wave produced and every
  // selected plan and shard executed; the binding is the wave's own output.
  assert.match(run.buildArtifactsHash ?? '', /^[a-f0-9]{64}$/, 'a dynamic run must bind the compiled artifacts it executed: ' + JSON.stringify(run.buildArtifactsDiagnostics));
  assert.equal(run.buildArtifactsHash, run.buildResult.buildArtifacts?.end, 'the run binding must be the build wave output');
  assert.deepEqual(run.buildArtifactsDiagnostics, [], 'a clean dynamic run must produce no build binding diagnostics');
  if (run.selectedResult.commands.length > 0) {
    assert.equal(run.selectedResult.buildArtifactsHash, run.buildArtifactsHash, 'the selected plans must have executed the build wave output');
    assert.equal(run.selectedResult.buildArtifacts?.start, run.buildResult.buildArtifacts?.end, 'the first selected plan must start on the bytes the build wave left');
  }
  assert.equal(run.authority.authoritative, false, 'no canonical baseline must fail closed');
  const shardRoot = join(root, '.proof-or-stop/runtime/dynamic-validation/B-production/shards');
  assert.equal(existsSync(shardRoot), true, 'production run must persist shard artifacts');
  const shardFiles = readFileSync(join(shardRoot, readdirSync(shardRoot).find(name => name.endsWith('aggregate.json'))!), 'utf8');
  assert.match(shardFiles, /coveredCaseIds/);
  const receiptFiles = readdirSync(shardRoot).filter(name => name.startsWith('shard-receipt-') && name.endsWith('.json'));
  assert.equal(receiptFiles.length, 7, 'registered adapter must emit one receipt per review-pass and quorum shard: ' + JSON.stringify(run));
  for (const name of receiptFiles) {
    const receipt = JSON.parse(readFileSync(join(shardRoot, name), 'utf8'));
    assert.equal(withValidationSigningRoot(root, () => verifyValidationShardReceipt(receipt)), true, `invalid persisted shard receipt ${name}`);
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
  // Byte registration is still a trust boundary, including harmless text edits.
  writeFileSync(join(root, adapterPath), adapterSource + '\n// unregistered adapter bytes\n');
  const tampered = await runStoryAwareDynamicValidation({
    projectRoot: root, gitCwd: root, storyId: 'B-production-tampered',
    baseHead: head, head, changedFiles: [], mode: 'enforce-low-risk', commands: configured,
  });
  assert.equal(tampered.selectedResult.commands.length, 0, 'unregistered adapter bytes must not launch shard commands');
  assert.equal(tampered.dynamicAllPass, false);
  const tamperedRoot = join(root, '.proof-or-stop/runtime/dynamic-validation/B-production-tampered/shards');
  assert.equal(readdirSync(tamperedRoot).filter(name => name.startsWith('shard-receipt-')).length, 0,
    'unregistered adapter bytes must not mint shard receipts');
  writeFileSync(join(root, adapterPath), adapterSource);
  console.log('unregistered adapter bytes refused before shard launch PASS');
  const externalRegistryRoot = mkdtempSync(join(tmpdir(), 'proof-external-case-registry-'));
  try {
    writeFileSync(join(externalRegistryRoot, 'cases.json'), readFileSync(join(root, caseRegistryPath)));
    symlinkSync(join(externalRegistryRoot, 'cases.json'), join(root, 'external-case-registry.json'));
    const external = await runStoryAwareDynamicValidation({
      projectRoot: root, gitCwd: root, storyId: 'B-production-external-registry',
      baseHead: head, head, changedFiles: [], mode: 'enforce-low-risk',
      commands: configured.map(command => command.caseRegistryPath
        ? {...command, caseRegistryPath: 'external-case-registry.json'} : command),
    });
    assert.equal(external.selectedResult.commands.length, 0, 'external registry symlink must be refused before shard launch');
    assert.equal(external.dynamicAllPass, false);
    console.log('external registry symlink refused before shard launch PASS');
  } finally { rmSync(externalRegistryRoot, {recursive:true, force:true}); }
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
  const environmentPath = 'packages/main/src/tasks/validation-child-environment.mjs';
  const environmentSource = readFileSync(join(root, environmentPath), 'utf8');
  writeFileSync(join(root, environmentPath), `${environmentSource}\n// synthetic adapter tamper\n`);
  try {
    const tampered = await runStoryAwareDynamicValidation({
      projectRoot: root, gitCwd: root, storyId: 'B-production-environment-tamper',
      baseHead: head, head, changedFiles: [], mode: 'enforce-low-risk', commands: configured,
    });
    assert.equal(tampered.authority.authoritative, false, 'tampered adapter must not grant dynamic authority');
    const tamperedShardRoot = join(root, '.proof-or-stop/runtime/dynamic-validation/B-production-environment-tamper/shards');
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
    console.log('canonical dynamic environment source tamper rejects all shard receipts PASS');
  } finally {
    writeFileSync(join(root, environmentPath), environmentSource);
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
      }, {
        // A selectable non-build command whose receipt can be reused across runs.
        command: runtimeNode, args: ['-e', 'process.stdout.write("unit-pass")'], label: 'unit',
        assurance: 'story-selectable', riskTier: 'local', closurePolicy: 'static-and-traced',
        fullBaselineReusePolicy: 'not-applicable', declaredEnvironmentKeys: ['PROOF_OR_STOP_RUNTIME_TRACE_FILE'],
      }] },
    }, null, 2) + '\n');
    // Compiled artifact trees, gitignored so they are invisible to the committed
    // identity, exactly like the real packages/*/dist.
    // Runtime artifacts (the canonical baseline, traces, receipts) are ignored
    // exactly as in the real repository: an untracked .proof-or-stop/ would make
    // every command's source provenance dirty and no receipt could be issued.
    writeFileSync(join(authorityRoot, '.gitignore'), 'dist\n.proof-or-stop/\n');
    mkdirSync(join(authorityRoot, 'packages/main/dist/tasks'), { recursive: true });
    writeFileSync(join(authorityRoot, 'packages/main/dist/tasks/x.js'), 'process.exit(0); // build A\n');
    mkdirSync(join(authorityRoot, 'packages/utils/dist'), { recursive: true });
    writeFileSync(join(authorityRoot, 'packages/utils/dist/index.js'), 'export const utils = 1;\n');
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
    const headlessRoot = mkdtempSync(join(tmpdir(), 'proof-headless-baseline-'));
    try {
      for (const sourceHead of ['', '   ']) {
        assert.equal(persistCanonicalFullBaseline({ projectRoot: headlessRoot, sourceHead, result: authorityFull, commands: authorityCommands }), undefined);
        assert.equal(existsSync(join(headlessRoot, '.proof-or-stop/runtime/dynamic-validation/canonical-baseline.json')), false);
      }
      console.log('HEADLESS_BASELINE_REFUSED');
    } finally { rmSync(headlessRoot, { recursive: true, force: true }); }
    const baseline = persistCanonicalFullBaseline({ projectRoot: authorityRoot, sourceHead: authorityHead, result: authorityFull, commands: authorityCommands });
    assert.ok(baseline, 'positive authority fixture must persist a canonical baseline');
    const admitted = await runStoryAwareDynamicValidation({ projectRoot: authorityRoot, gitCwd: authorityRoot, storyId: 'B-authority', baseHead: authorityHead, head: authorityHead, changedFiles: [], mode: 'enforce-low-risk', commands: authorityCommands });
    assert.match(admitted.buildArtifactsHash ?? '', /^[a-f0-9]{64}$/, 'an authoritative dynamic run must carry the binding publication consumes: ' + JSON.stringify(admitted.buildArtifactsDiagnostics));
    assert.equal(admitted.buildArtifactsHash, admitted.buildResult.buildArtifacts?.end, 'the authoritative run binding must be the build wave output');
    assert.equal(admitted.authority.authoritative, true, JSON.stringify(admitted.authority));
    assert.equal(admitted.dynamicAllPass, true);
    console.log('gate-owned authority PASS');
    // The run carries the protection its commands executed under, so the
    // evidence publication derives from it is reusable and admissible.
    assert.match(admitted.buildArtifactsProtection ?? '', /^(enforced:|not-applicable:)/, 'an authoritative dynamic run must carry a satisfied protection label: ' + JSON.stringify(admitted.buildArtifactsProtection));
    // Every receipt this run earned binds the compiled artifacts the run
    // executed, under the protection contract, and carries the v3 schema.
    const earned = admitted.receipts.filter((receipt) => receipt.producedBy === 'story-execution');
    assert.ok(earned.length >= 1, 'the authoritative run must persist at least one story-execution receipt: ' + JSON.stringify(admitted.manifest.totals));
    for (const receipt of earned) {
      assert.equal(receipt.schema, 'proof-or-stop.validation-command-receipt.v3');
      assert.equal(receipt.buildArtifactsDigest, admitted.buildArtifactsHash, 'every receipt binds the compiled artifacts the run executed');
      assert.match(receipt.buildArtifactsProtection, /^(enforced:|not-applicable:)/, 'a receipt is authoritative only under enforced or not-applicable protection');
    }
    const dynamicArgs = { projectRoot: authorityRoot, gitCwd: authorityRoot, storyId: 'B-authority', baseHead: authorityHead, head: authorityHead, changedFiles: [], mode: 'enforce-low-risk' as const, commands: authorityCommands };
    const unchangedRerun = await runStoryAwareDynamicValidation(dynamicArgs);
    assert.equal(unchangedRerun.dynamicAllPass, true, JSON.stringify(unchangedRerun.buildArtifactsDiagnostics));
    assert.ok(unchangedRerun.manifest.totals.reused >= 1,
      'an unchanged rerun must reuse the selectable command through its receipt: ' + JSON.stringify(unchangedRerun.manifest.rows.map((row) => [row.commandId, row.disposition, row.reasons])));
    // Same source, same build output and exit code, DIFFERENT compiled bytes:
    // every receipt earned on the old bytes lapses and the command runs again.
    writeFileSync(join(authorityRoot, 'packages/main/dist/tasks/x.js'), 'process.exit(0); // build B: same output, other bytes\n');
    const rebuiltBytes = await runStoryAwareDynamicValidation(dynamicArgs);
    assert.equal(rebuiltBytes.dynamicAllPass, true, JSON.stringify(rebuiltBytes.buildArtifactsDiagnostics));
    assert.notEqual(rebuiltBytes.buildArtifactsHash, unchangedRerun.buildArtifactsHash, 'different compiled bytes are a different build');
    assert.equal(rebuiltBytes.manifest.totals.reused, 0,
      'no receipt earned on the previous compiled bytes may be reused: ' + JSON.stringify(rebuiltBytes.manifest.rows.map((row) => [row.commandId, row.disposition, row.reasons])));
    assert.ok(rebuiltBytes.receipts.some((receipt) => receipt.producedBy === 'story-execution' && receipt.buildArtifactsDigest === rebuiltBytes.buildArtifactsHash),
      'the re-executed command must earn a receipt bound to the new bytes');
    console.log('dynamic receipts lapse with compiled bytes PASS');
  } finally {
    rmSync(authorityRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const headlessMatrix = spawnSync(process.execPath, [new URL('../../tests/validation-headless.mjs', import.meta.url).pathname], { encoding: 'utf8', timeout: 120000 });
assert.equal(headlessMatrix.status, 0, headlessMatrix.stdout + headlessMatrix.stderr);
console.log(headlessMatrix.stdout);

const routingLock = spawnSync(process.execPath, [new URL('../../tests/validation-routing-lock.mjs', import.meta.url).pathname], { encoding: 'utf8', timeout: 30000 });
assert.equal(routingLock.status, 0, routingLock.stdout + routingLock.stderr);
console.log(routingLock.stdout);

const signingRootMatrix = spawnSync(process.execPath, [new URL('../../tests/validation-signing-root.mjs', import.meta.url).pathname], { encoding: 'utf8', timeout: 120000 });
assert.equal(signingRootMatrix.status, 0, signingRootMatrix.stdout + signingRootMatrix.stderr);
console.log(signingRootMatrix.stdout);

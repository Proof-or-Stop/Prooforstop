#!/usr/bin/env node
// Local maintenance experiment. All Story state below is disposable test data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gitAt = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const configBytes = readFileSync(join(repo, 'proof-or-stop.config.json'));
const config = JSON.parse(configBytes);
const mode = config.validate.dynamic.mode;
const start = performance.now();
const out = join(resolve(repo, gitAt(repo, 'rev-parse', '--git-common-dir')), 'lab-maintenance', 'dynamic-selection-cost-measurements');
mkdirSync(out, { recursive: true });
const runId = new Date().toISOString().replaceAll(':', '-');
// Same test-only OS-home isolation used by verify-machine-provider-admission.
// Keep real queue algorithms; give this disposable workload its own namespace.
const isolatedHome = mkdtempSync(join(tmpdir(), 'pos-selection-home-'));
const originalUserInfo = os.userInfo;
os.userInfo = (...args) => ({ ...originalUserInfo(...args), homedir: isolatedHome });
syncBuiltinESMExports();
const isolationPath = join(out, `${runId}-isolate-home.mjs`);
writeFileSync(isolationPath, `import os from 'node:os';
import cp from 'node:child_process';import {basename} from 'node:path';import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(isolatedHome)}});
// Propagate only to named regression workers, never to measured commands,
// permission capsules, fake provider adapters or arbitrary subprocesses.
const workers=new Set(['narrowing-repin-smoke.js','verify-convergence-progress-evidence.mjs']);
for(const method of ['spawn','spawnSync','execFile','execFileSync']){
 const run=cp[method];cp[method]=function(command,args,...rest){
  if(command===process.execPath&&Array.isArray(args)&&workers.has(basename(args[0]||'')))
   args=['--import',fileURLToPath(import.meta.url),...args];
  return run.call(this,command,args,...rest);
 };
}
syncBuiltinESMExports();\n`);
const results = {
  schema: 'lab.dynamic-selection-cost.v1', runId, head: gitAt(repo, 'rev-parse', 'HEAD'),
  node: process.version, platform: process.platform, arch: process.arch,
  isolation: 'Disposable OS-home queue namespace; real scheduler, executor and receipts; synthetic causal preflight and certification fixture',
  configDigest: digest(configBytes), candidateMode: mode,
  contractDigest: digest(readFileSync(join(repo, 'docs/lab/dynamic-selection-cost/CONTRACT.md'))),
  harnessDigest: digest(readFileSync(fileURLToPath(import.meta.url))),
  providerUsage: { calls: 0, inputTokens: 0, outputTokens: 0, scope: 'mechanical experiment only', developmentConversationTokens: null },
  runs: [], controls: [], failures: [],
};
const load = path => import(join(repo, 'packages/main/dist', path));
const { StoryStore } = await load('core/store.js');
const { resetConfigCache } = await load('core/config.js');
const { createVerifierHandlers, configuredValidationCommands } = await load('handlers/verifier.js');
const { executeValidationPlan } = await load('core/validation-executor.js');
const { persistCanonicalFullBaseline, catalogValidationRiskFloor } = await load('handlers/story-aware-validation.js');
const { discoverValidationInventory, compileValidationCatalog } = await load('core/story-aware-validation.js');
const { acquireOwnerLease, releaseOwnerLease } = await load('core/story-owner-lease.js');
const { persistSyntheticAdmittedWindowForTest } = await load('core/certification-window.js');
const { deriveCertificationDomainInputHashes } = await load('handlers/certification-window.js');
const { assessStoredValidationPassAdmissibility } = await load('handlers/validation-pass-admissibility.js');

function launches(root) {
  const path = join(root, 'launches.txt');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}
function decodeResponse(value) {
  const parsed = JSON.parse(value);
  return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
}
async function scenario(arm, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pos-selection-cost-'));
  const previous = process.cwd();
  const storyId = 'B-lab-selection-cost';
  const git = (...args) => gitAt(root, ...args);
  const put = (path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
  let store;
  const handlerLog = [];
  try {
    put('.gitignore', 'launches.txt\n.proof-or-stop/runtime/\n.proof-or-stop/locks/\n.proof-or-stop/activity.jsonl\n**/owner-lease.json\n**/certification-window.json\n');
    put('packages/main/src/core/validation-runtime-tracer.cjs', readFileSync(join(repo, 'packages/main/dist/core/validation-runtime-tracer.cjs')));
    const inputs = ['local', 'unrelated1', 'unrelated2', 'unrelated3', 'unrelated4'];
    for (const input of inputs) put(`packages/main/src/${input}.cjs`, 'module.exports=(a,b)=>a+b;\n');
    const commands = ['build', ...inputs].map(label => {
      const input = label === 'build' ? 'local' : label;
      const path = `packages/main/src/${input}.cjs`;
      const program = [
        `require('node:fs').appendFileSync('launches.txt', ${JSON.stringify(label + '\n')});`,
        label === 'build'
          ? `new (require('node:vm').Script)(require('node:fs').readFileSync(${JSON.stringify(path)},'utf8'));`
          : `require('node:assert/strict').equal(require(${JSON.stringify('./' + path)})(2,3),5,'ARITHMETIC_DEFECT');`,
        `require('node:crypto').pbkdf2Sync('fixed-lab-input','fixed-lab-salt',300000,32,'sha256');`,
        `console.log(${JSON.stringify(label + '-PASS')});`,
      ].join('\n');
      return { command: process.execPath, args: ['-e', program], label, optional: false,
        inputRoots: [path], inputsComplete: true, assurance: 'story-selectable',
        riskTier: options.sharedRisk && label === 'unrelated4' ? 'shared' : 'local',
        closurePolicy: 'static-and-traced', fullBaselineReusePolicy: 'not-applicable',
        resources: [{ class: 'fixed-path', key: '.', access: 'exclusive' }],
        declaredEnvironmentKeys: ['PROOF_OR_STOP_RUNTIME_TRACE_FILE', 'FORCE_COLOR'], timeoutMs: 60000 };
    });
    put('proof-or-stop.config.json', JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives', validate: { dynamic: { mode: arm }, reuseFreshRoutinePass: true, commands } }));
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Lab experiment'); git('config', 'user.email', 'lab@example.invalid');
    process.chdir(root); resetConfigCache();
    store = new StoryStore(root);
    const now = new Date().toISOString();
    store.writeStory(storyId, { storyId, name: 'selection-cost', title: 'Bounded selection cost witness',
      description: 'Isolated performance fixture', type: 'bug', phase: 'DEV', priority: 'low',
      createdAt: now, startedAt: now, endedAt: null, events: [] });
    store.writeChecklist(storyId, { items: [] });
    store.writeScopeContract(storyId, { storyId, mode: 'enforce', allowedModify: ['packages/main/src/local.cjs'],
      allowedCreate: [], allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [],
      pathCanonicalizerVersion: 'repo-relative-v1', pathCanonicalizationMode: 'enforce', createdAt: now, updatedAt: now });
    put(`${'.proof-or-stop/story/actives'}/${storyId}/closeout-write-receipts.jsonl`, '');
    git('add', '.'); git('commit', '-qm', 'Seed equivalent selection workload');
    const baseHead = git('rev-parse', 'HEAD');
    const configured = configuredValidationCommands(root);
    const baselineStart = performance.now();
    if (!options.missingBaseline) {
      const baseline = await executeValidationPlan({ provider: 'full-baseline', commands: configured, warnings: [] }, root, baseHead, storyId);
      assert.equal(baseline.allPass, true, 'baseline setup must pass before measuring the candidate: ' + JSON.stringify(baseline));
      assert.ok(persistCanonicalFullBaseline({ projectRoot: root, sourceHead: baseHead, result: baseline, commands: configured }));
    }
    const baselineMs = performance.now() - baselineStart;
    const baselineLaunches = launches(root).length;
    git('checkout', '-qb', 'story');
    put('packages/main/src/local.cjs', options.defect ? 'module.exports=(a,b)=>a-b;\n' : 'module.exports=(a,b)=>a+b; // local change\n');
    if (options.unknownMaterial) put('packages/main/src/unclassified.cjs', 'module.exports=42;\n');
    git('add', '.'); git('commit', '-qm', 'Apply bounded local change');
    const head = git('rev-parse', 'HEAD');
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: root });
    persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root,
      causalInputHashes: deriveCertificationDomainInputHashes(root, 'HEAD', root) });
    const facts = { cli: { available: true, path: process.execPath }, worktree: { expected: root, actual: root },
      gitIndex: { readable: true, path: join(root, '.git/index'), contentDigest: 'fixture-stable' },
      gitMaterial: { available: true, headHash: head, materialHash: 'fixture-stable', storyFilesHash: 'fixture-stable' },
      writerLease: { available: true, valid: true }, providerCapability: { required: ['validation-plan', 'bounded-output'], available: ['validation-plan', 'bounded-output'] },
      resources: { required: { timeoutMs: 1000 }, available: { timeoutMs: 1000 } },
      evidenceTarget: { writable: true, path: join(root, '.proof-or-stop/causal-evidence') },
      sideChannel: { available: true, maxOutputChars: 12000, maxProgressEvents: 1 } };
    const ctx = { root, scanRoot: join(root, 'packages/main'), store, causalPreflightFacts: () => structuredClone(facts), log(message) { handlerLog.push(message); } };
    const handler = createVerifierHandlers(ctx);
    const begin = performance.now();
    const result = decodeResponse(await handler.validate({ story: storyId, dynamicMode: arm, json: true, noSync: true }));
    const wallMs = performance.now() - begin;
    const physical = launches(root).slice(baselineLaunches);
    const row = { arm, options, status: result.status, authority: result.dynamicValidation?.authority,
      physicalLaunches: physical.length, launched: physical, wallMs, baselineMs, baselineLaunches,
      childMs: result.commands?.reduce((sum, c) => sum + (c.durationMs || 0), 0),
      manifest: result.dynamicValidation?.manifest, reasons: result.dynamicValidation?.escalationReasons,
      repeat: null };
    results.runs.push(row);
    console.log('MEASURE', JSON.stringify({ ...row, manifest: row.manifest?.totals }));
    assert.equal(result.commands.length, physical.length, 'reported executions must match independent child counter');
    if (options.defect) {
      assert.equal(result.status, 'fail', 'optimized validation must detect the affected arithmetic defect');
      assert.ok(result.commands.some(c => c.output?.includes('ARITHMETIC_DEFECT')));
    } else {
      assert.equal(result.status, 'pass', JSON.stringify(result));
      if (options.missingBaseline || options.sharedRisk || options.unknownMaterial) {
        assert.equal(result.dynamicValidation.authority, 'full-fallback');
        assert.deepEqual([...physical].sort(), commands.map(c => c.label).sort(), 'fallback must execute every command exactly once');
      } else if (arm === 'enforce-low-risk') {
        assert.equal(result.dynamicValidation.authority, 'enforce-authority');
        assert.deepEqual([...physical].sort(), ['build', 'local']);
      } else {
        assert.equal(physical.length, commands.length, 'observe is an executed full oracle');
      }
      if (options.repeat) {
        const before = launches(root).length;
        const repeatStart = performance.now();
        const repeated = decodeResponse(await handler.validate({ story: storyId, dynamicMode: arm, json: true, noSync: true }));
        row.repeat = { wallMs: performance.now() - repeatStart, physicalLaunches: launches(root).length - before, status: repeated.status };
        assert.equal(repeated.status, 'pass');
        assert.equal(row.repeat.physicalLaunches, 0, 'valid whole-result evidence must avoid new child execution');
        assert.equal(assessStoredValidationPassAdmissibility(ctx, storyId, { allowDynamicCoverage: true }).ok, true);
        const signed = store.readTestEvidence(storyId);
        store.writeTestEvidence(storyId, { ...signed, validationArtifactSignature: undefined });
        assert.equal(assessStoredValidationPassAdmissibility(ctx, storyId, { allowDynamicCoverage: true }).ok, false,
          'signature removal must block stale or forged reuse');
        row.signatureTamperRefused = true;
      }
    }
    return row;
  } catch (error) {
    results.diagnostic = { arm, options, physicalLaunchesIncludingBaseline: launches(root), handlerLog };
    throw error;
  } finally {
    if (store) releaseOwnerLease(store.storyDirPath(storyId));
    process.chdir(previous); resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  if (mode !== 'enforce-low-risk') {
    await scenario(mode, { repeat: true });
    assert.fail('DYNAMIC_SELECTION_COST_RED: candidate still observes and executes the full eligible workload');
  }
  // A/B then B/A: candidate mode is read from this checkout, never hard-coded.
  for (const arm of ['observe', mode, mode, 'observe']) await scenario(arm, { repeat: true });
  for (const arm of ['observe', 'enforce-low-risk']) await scenario(arm, { defect: true });
  for (const option of ['missingBaseline', 'sharedRisk', 'unknownMaterial']) await scenario('enforce-low-risk', { [option]: true });
  process.chdir(repo); resetConfigCache();
  const actual = configuredValidationCommands(repo);
  const inventory = discoverValidationInventory(repo);
  const catalog = compileValidationCatalog(inventory);
  results.realInventory = { commands: actual.length, catalogRiskFloor: catalogValidationRiskFloor(catalog),
    nonLocalRows: catalog.filter(c => c.riskTier !== 'local').map(c => ({ id: c.id, risk: c.riskTier })),
    forbiddenFullOnly: catalog.filter(c => c.assurance === 'full-only' && c.fullBaselineReusePolicy === 'forbidden').map(c => c.id),
    realSuiteExecuted: false, realSuiteSavingsProven: false };
  for (const [name, path] of [
    ['frozen-acceptance', 'scripts/verify-acceptance-amendment-gates.mjs'],
    ['immutable-selectors', 'packages/main/dist/tasks/narrowing-repin-smoke.js'],
    ['atomic-repair-and-evidence', 'scripts/verify-review-remediation-close.mjs'],
    ['shared-receipt-publication', 'scripts/verify-shared-receipt-publication.mjs'],
  ]) {
    const began = performance.now();
    const argv = ['--import', isolationPath, path];
    const child = spawnSync(process.execPath, argv, { cwd: repo, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    const output = `${child.stdout || ''}${child.stderr || ''}`;
    const logPath = join(out, `${runId}-${name}.log`); writeFileSync(logPath, output);
    results.controls.push({ name, command: [process.execPath, ...argv], wallMs: performance.now() - began,
      exitCode: child.status, signal: child.signal, outputDigest: digest(output), logPath });
    console.log('CONTROL', JSON.stringify(results.controls.at(-1)));
    assert.equal(child.status, 0, `${name} must preserve its current safety contract; see ${logPath}`);
  }
  assert.equal(mode, 'enforce-low-risk', 'DYNAMIC_SELECTION_COST_RED: candidate still observes and executes the full eligible workload');
  assert.ok(results.runs.filter(r => r.arm === mode && r.options.repeat).every(r => r.physicalLaunches <= 3),
    'DYNAMIC_SELECTION_COST_RED: enabling a mode must actually reduce child execution by at least half');
} catch (error) {
  results.failures.push(error.stack || String(error));
  process.exitCode = 1;
} finally {
  results.totalMs = performance.now() - start;
  results.pass = results.failures.length === 0;
  const resultPath = join(out, `${runId}.json`);
  writeFileSync(resultPath, JSON.stringify(results, null, 2) + '\n');
  console.log('RESULT', resultPath);
  for (const failure of results.failures) console.error(failure);
  if (results.pass) console.log('DYNAMIC_SELECTION_COST_GREEN');
  os.userInfo = originalUserInfo; syncBuiltinESMExports();
  rmSync(isolatedHome, { recursive: true, force: true });
}
// Imported CLI modules own background timers; all children and fixture leases
// above have completed before this standalone experiment terminates.
process.exit(process.exitCode || 0);

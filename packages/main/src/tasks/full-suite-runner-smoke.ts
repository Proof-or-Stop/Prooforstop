#!/usr/bin/env node

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { classifyRuntimeEntrypointAuthority } from '../core/runtime-environment-checks.js';
import {
  DEFAULT_JOBS, DEFAULT_PROCESS_LIFECYCLE_ADAPTER, FULL_SUITE_ENTRIES, canonicalizeEntries, cleanupManifestForEntry, cleanupOwnedTargets, entriesFromSerialReference, interruptForTest,
  fullSuiteBudgetBreached, identityChanged, isUnderFullSuiteBudget, killProcessTree, parsePositiveInteger, parseRunnerArgs, shouldEnforceFullSuiteBudget,
  resetInterruptForTest, runEntry, runScheduled, validateInventory, writeResultArtifact,
  observedOutputSignatures, pathIsContained, validateJsonOutputPath,
  type FullSuiteEntry, type FullSuiteResult, type ProcessLifecycleAdapter, type ResourceClaim,
} from './full-suite-runner.js';

const checks: string[] = [];
function assert(condition: unknown, message: string): void { if (!condition) throw new Error(message); checks.push(message); }
function assertWithDetail(condition: unknown, stableMessage: string, detail: string): void {
  if (!condition) throw new Error(`${stableMessage}: ${detail}`);
  checks.push(stableMessage);
}
const isolatedTempRootsMatch = (roots: string[], expected: string | undefined): boolean =>
  roots.length === 4 && new Set(roots).size === 1 && roots[0] === expected;
function createFixtureBuildBinding(root: string): void {
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  mkdirSync(join(root, 'packages/main/dist'), { recursive: true });
  writeFileSync(join(root, 'packages/main/src/input.ts'), 'export const fixture = true;\n');
  writeFileSync(join(root, 'packages/main/dist/input.js'), 'export const fixture = true;\n');
  writeFileSync(join(root, 'packages/main/tsconfig.json'), '{}\n');
  writeFileSync(join(root, 'packages/main/package.json'), '{}\n');
  symlinkSync(join(process.cwd(), 'scripts'), join(root, 'scripts'), 'dir');
  execFileSync(process.execPath, ['--input-type=module', '-e', `import{writeBuildBinding}from${JSON.stringify(`file://${join(process.cwd(), 'scripts/full-suite-build-binding.mjs')}`)};writeBuildBinding(process.cwd())`], { cwd: root });
}
const pass = (name: string): FullSuiteResult => ({ name, status: 'PASS', durationMs: 1, output: '' });
const claim = (key: string, access: 'shared' | 'exclusive' = 'shared'): ResourceClaim => ({ class: 'fixed-path', key, access, canonicalKey: `fixed-path:${key}` });
const entry = (name: string, resources: ResourceClaim[] = [], priority = 0): FullSuiteEntry => ({ name, resources, priority, tempOwnership: 'runner-owned-unique' });
function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function main(): Promise<void> {
  const observations = {
    aliasCollisions: 0, failClosedThrows: 0, completedMembers: 0,
    mutationBites: { removedFixedPortKey: false, inventoryOmission: false },
    lifecycle: { normalCleanup: false, normalCompletionGrandchild: false, timeoutGrandchild: false, externalInterrupt: false, outsideRootRefused: false },
  };
  const collisionPath = join(process.cwd(), '.lattice', 'runtime', 'full-suite-fixed-sentinel');
  mkdirSync(collisionPath, { recursive: true });
  const sentinelPath = resolve(dirname(fileURLToPath(import.meta.url)), 'full-suite-resource-sentinel.js');
  let collisionFailed = false;
  try { execFileSync(process.execPath, [sentinelPath], { cwd: process.cwd(), stdio: 'ignore' }); } catch { collisionFailed = true; }
  assert(collisionFailed, 'preowned fixed path makes canonical resource sentinel fail terminally');
  rmSync(collisionPath, { recursive: true, force: true });
  const fixedPortOsCollision = await new Promise<'detected' | 'unsupported'>((done, reject) => {
    const first = createServer();
    first.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPERM' || error.code === 'EACCES') done('unsupported'); else reject(error);
    });
    first.listen(43127, '127.0.0.1', () => {
      const second = createServer();
      second.once('error', (error: NodeJS.ErrnoException) => first.close(() => error.code === 'EADDRINUSE' ? done('detected') : reject(error)));
      second.listen(43127, '127.0.0.1', () => second.close(() => first.close(() => reject(new Error('second fixed-port bind unexpectedly succeeded')))));
    });
  });
  assert(fixedPortOsCollision === 'detected' || fixedPortOsCollision === 'unsupported', `fixed-port OS collision probe is explicit (${fixedPortOsCollision})`);
  const osReceiptPath = join(tmpdir(), `full-suite-fixed-port-os-${process.pid}.json`);
  const osProbe = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'full-suite-fixed-port-os-collision.js'), '--out', osReceiptPath], { encoding: 'utf8' });
  const osReceipt = JSON.parse(readFileSync(osReceiptPath, 'utf8'));
  assert((osProbe.status === 0 && osReceipt.overallStatus === 'PASS' && osReceipt.collision.code === 'EADDRINUSE' && osReceipt.mutationDetected === true)
    || (osProbe.status === 2 && osReceipt.overallStatus === 'UNSUPPORTED' && osReceipt.mutationDetected === false), 'dedicated fixed-port OS receipt never disguises unsupported capability as collision detection');
  rmSync(osReceiptPath, { force: true });
  const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert(rootPackage.scripts?.build?.startsWith('npm --prefix packages/main run build && npm --prefix packages/utils run build'), 'standard root build prepares main and utils runtime');
  assert(rootPackage.scripts?.test === 'node packages/main/dist/tasks/full-suite-runner.js', 'root test has no ignored compatibility arguments');
  assert(rootPackage.scripts?.build?.endsWith('node scripts/verify-full-suite-build-binding.mjs'), 'standard root build fails closed on stale full-suite dist');
  assert(DEFAULT_JOBS === 5, 'canonical default uses five bounded workers without changing the serial oracle or performance budget');
  const canonicalClassCounts = new Map<string, number>();
  for (const item of FULL_SUITE_ENTRIES) for (const resource of item.resources) canonicalClassCounts.set(resource.class, (canonicalClassCounts.get(resource.class) ?? 0) + 1);
  for (const resourceClass of ['git-common-dir', 'fixed-path', 'fixed-port', 'runtime-lock', 'main-write-lock']) {
    assert((canonicalClassCounts.get(resourceClass) ?? 0) > 0, `canonical manifest exercises protected class ${resourceClass}`);
  }
  assert(FULL_SUITE_ENTRIES.some(item => item.resources.some(resource => resource.access === 'exclusive')), 'canonical manifest contains truthful exclusive protected claims');
  assert(
    FULL_SUITE_ENTRIES.some(item => item.name === 'test:agent-liveness-suite-smoke')
      && !FULL_SUITE_ENTRIES.some(item => item.name === 'test:flow-stability-smoke'),
    'canonical manifest schedules the acyclic liveness aggregate instead of a component back-edge',
  );
  const priorityOrder = [...FULL_SUITE_ENTRIES]
    .map((item, index) => ({ name: item.name, priority: item.priority ?? 0, index }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .map(item => item.name);
  assert(
    FULL_SUITE_ENTRIES.find(item => item.name === 'test:agent-liveness-suite-smoke')?.priority === 750
      && priorityOrder.indexOf('test:agent-liveness-suite-smoke') < priorityOrder.indexOf('test:milestone-status'),
    'liveness aggregate is scheduled before the measured default-priority tail',
  );
  assert(
    FULL_SUITE_ENTRIES.find(item => item.name === 'test:closeout-trust')?.priority === 650
      && priorityOrder.indexOf('test:closeout-trust') < priorityOrder.indexOf('test:brief-output'),
    'closeout trust is scheduled before the measured default-priority tail',
  );
  assert(
    FULL_SUITE_ENTRIES.find(item => item.name === 'test:nested-worktree-bootstrap')?.priority === 550
      && priorityOrder.indexOf('test:nested-worktree-bootstrap') < priorityOrder.indexOf('test:experiments'),
    'nested worktree bootstrap is scheduled before the measured default-priority tail',
  );
  const runnerSmokeFixedPath = FULL_SUITE_ENTRIES.find(item => item.name === 'test:full-suite-runner-smoke')?.resources.find(resource => resource.class === 'fixed-path');
  const sentinelFixedPath = FULL_SUITE_ENTRIES.find(item => item.name === 'test:full-suite-resource-sentinel')?.resources.find(resource => resource.class === 'fixed-path');
  assert(runnerSmokeFixedPath?.access === 'exclusive' && runnerSmokeFixedPath.canonicalKey === sentinelFixedPath?.canonicalKey, 'canonical runner smoke declares the real fixed-path collision it creates');
  const runnerSmokeFixedPort = FULL_SUITE_ENTRIES.find(item => item.name === 'test:full-suite-runner-smoke')?.resources.find(resource => resource.class === 'fixed-port');
  const sentinelFixedPort = FULL_SUITE_ENTRIES.find(item => item.name === 'test:full-suite-resource-sentinel')?.resources.find(resource => resource.class === 'fixed-port');
  assert(runnerSmokeFixedPort?.access === 'exclusive' && runnerSmokeFixedPort.canonicalKey === sentinelFixedPort?.canonicalKey, 'canonical runner smoke declares the real fixed-port collision it probes');

  const scripts = { 'test:a': 'x', 'test:b': 'x' };
  const policy = { 'test:a': entry('test:a'), 'test:b': entry('test:b') };
  const derived = entriesFromSerialReference('npm run test:a && npm run test:b', scripts, policy);
  validateInventory(derived, 'npm run test:a && npm run test:b', scripts);
  assert(derived.map(({ name }) => name).join(',') === 'test:a,test:b', 'serial reference independently defines canonical membership and order');
  for (const [label, operation] of [
    ['duplicate', () => entriesFromSerialReference('npm run test:a && npm run test:a', scripts, policy)],
    ['later member without policy', () => entriesFromSerialReference('npm run test:a && npm run test:b', scripts, { 'test:a': entry('test:a') })],
    ['stale policy', () => entriesFromSerialReference('npm run test:a', scripts, policy)],
    ['unknown resource class', () => validateInventory([{ ...entry('test:a'), resources: [{ class: 'mystery' as never, key: 'x', access: 'shared' }] }], 'npm run test:a', scripts)],
    ['empty resource key', () => validateInventory([{ ...entry('test:a'), resources: [{ class: 'fixed-path', key: '', access: 'shared' }] }], 'npm run test:a', scripts)],
  ] as Array<[string, () => unknown]>) {
    let rejected = false; try { operation(); } catch { rejected = true; }
    if (rejected) observations.failClosedThrows++;
    assert(rejected, `${label} inventory fails closed`);
  }

  const canonicalRoot = mkdtempSync(join(tmpdir(), 'full-suite-claims-'));
  try {
    writeFileSync(join(canonicalRoot, 'tracked'), 'x');
    mkdirSync(join(canonicalRoot, 'real-dir'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: canonicalRoot, stdio: 'ignore' });
    const alias = `${canonicalRoot}-alias`; symlinkSync(canonicalRoot, alias);
    symlinkSync(join(canonicalRoot, 'real-dir'), join(canonicalRoot, 'dir-alias'));
    try {
      const normalized = canonicalizeEntries([
        entry('real', [{ class: 'fixed-path', key: join(canonicalRoot, 'tracked'), access: 'exclusive' }, { class: 'git-common-dir', key: canonicalRoot, access: 'shared' }]),
        entry('alias', [{ class: 'fixed-path', key: join(alias, 'tracked'), access: 'shared' }, { class: 'git-common-dir', key: alias, access: 'shared' }]),
        entry('port', [{ class: 'fixed-port', key: '43210', access: 'exclusive' }]),
        entry('future-lock', [{ class: 'main-write-lock', key: join(canonicalRoot, '.lattice', 'runtime', 'main-write.lock'), access: 'exclusive' }]),
        entry('future-real', [{ class: 'runtime-lock', key: join(canonicalRoot, 'real-dir', 'future', 'runtime.lock'), access: 'exclusive' }]),
        entry('future-alias', [{ class: 'runtime-lock', key: join(canonicalRoot, 'dir-alias', 'future', 'runtime.lock'), access: 'shared' }]),
      ], canonicalRoot);
      assert(normalized[0]!.resources[0]!.canonicalKey === normalized[1]!.resources[0]!.canonicalKey, 'symlink aliases collide on canonical filesystem resource key');
      if (normalized[0]!.resources[0]!.canonicalKey === normalized[1]!.resources[0]!.canonicalKey) observations.aliasCollisions++;
      assert(normalized[0]!.resources[1]!.canonicalKey === normalized[1]!.resources[1]!.canonicalKey, 'Git aliases collide on canonical common-dir resource key');
      if (normalized[0]!.resources[1]!.canonicalKey === normalized[1]!.resources[1]!.canonicalKey) observations.aliasCollisions++;
      assert(normalized[2]!.resources[0]!.canonicalKey === 'fixed-port:43210', 'fixed port claim has a stable canonical key');
      assert(normalized[3]!.resources[0]!.canonicalKey?.endsWith('/.lattice/runtime/main-write.lock'), 'clean clone canonicalizes a not-yet-created nested lock from its nearest existing ancestor');
      assert(normalized[4]!.resources[0]!.canonicalKey === normalized[5]!.resources[0]!.canonicalKey, 'missing lexical aliases through a symlinked ancestor canonicalize to one future resource key');
      let escapeRejected = false;
      try { canonicalizeEntries([entry('escape', [{ class: 'fixed-path', key: '../outside', access: 'exclusive' }])], canonicalRoot); } catch { escapeRejected = true; }
      assert(escapeRejected, 'filesystem resource key cannot escape its declared ownership root');
    } finally { rmSync(alias); }
  } finally { rmSync(canonicalRoot, { recursive: true, force: true }); }

  const active: string[] = []; let sharedOverlap = false; let conflictingOverlap = false; let unrelatedOverlap = false;
  const scheduled = [entry('shared-a', [claim('/same')]), entry('shared-b', [claim('/same')]), entry('writer', [claim('/same', 'exclusive')]), entry('unrelated', [claim('/other', 'exclusive')])];
  const scheduledResults = await runScheduled(scheduled, 4, async (item) => {
    if (item.name === 'shared-b' && active.includes('shared-a')) sharedOverlap = true;
    if ((item.name === 'writer' && active.some((name) => name.startsWith('shared'))) || (active.includes('writer') && item.name.startsWith('shared'))) conflictingOverlap = true;
    if (item.name === 'unrelated' && active.length) unrelatedOverlap = true;
    active.push(item.name); await new Promise((done) => setTimeout(done, item.name === 'shared-a' ? 60 : 25)); active.splice(active.indexOf(item.name), 1);
    return pass(item.name);
  });
  assert(sharedOverlap, 'shared claims on one key overlap');
  assert(!conflictingOverlap, 'exclusive claim waits for conflicting canonical key');
  assert(unrelatedOverlap, 'unrelated canonical resource keys overlap safely');
  let fixedPortOverlap = false; const portActive: string[] = [];
  await runScheduled([
    entry('port-a', [{ class: 'fixed-port', key: '43127', access: 'exclusive', canonicalKey: 'fixed-port:43127' }]),
    entry('port-b', [{ class: 'fixed-port', key: '43127', access: 'exclusive', canonicalKey: 'fixed-port:43127' }]),
  ], 2, async item => { if (portActive.length) fixedPortOverlap = true; portActive.push(item.name); await new Promise(done => setTimeout(done, 20)); portActive.pop(); return pass(item.name); });
  assert(!fixedPortOverlap, 'fixed-port resource-key ownership token prevents conflicting overlap');
  const ignoredPortEntries = [entry('port-a'), entry('port-b')]; let mutationOverlap = false; const mutationActive: string[] = [];
  await runScheduled(ignoredPortEntries, 2, async item => { if (mutationActive.length) mutationOverlap = true; mutationActive.push(item.name); await new Promise(done => setTimeout(done, 20)); mutationActive.pop(); return pass(item.name); });
  assert(mutationOverlap, 'fixed-port claim removal mutation bites through ownership-token overlap');
  observations.mutationBites.removedFixedPortKey = mutationOverlap;
  const protectedPairs: Record<string, { overlapCount: number; completionCount: number; blockedWaitMs: number; serialized: boolean }> = {};
  for (const [label, resourceClass, key] of [
    ['gitCommonDir', 'git-common-dir', 'observed-git'], ['fixedPath', 'fixed-path', 'observed-path'], ['fixedPortKey', 'fixed-port', '43127'],
    ['runtimeLock', 'runtime-lock', 'observed-runtime'], ['mainWriteLock', 'main-write-lock', 'observed-main'],
  ] as const) {
    let activeOwners = 0; let overlapCount = 0; let completionCount = 0;
    const pair = [0, 1].map(index => entry(`${label}-${index}`, [{ class: resourceClass, key, access: 'exclusive', canonicalKey: `${resourceClass}:${key}` }]));
    const pairResults = await runScheduled(pair, 2, async item => {
      if (activeOwners) overlapCount++; activeOwners++; await new Promise(done => setTimeout(done, 20)); activeOwners--; completionCount++; return pass(item.name);
    });
    const blockedWaitMs = pairResults[1]?.lockWaitMs ?? 0;
    protectedPairs[label] = { overlapCount, completionCount, blockedWaitMs, serialized: overlapCount === 0 && completionCount === 2 && blockedWaitMs > 0 };
    assert(protectedPairs[label]!.serialized, `${resourceClass} protected pair serializes from observed ownership and wait telemetry`);
  }
  assert((scheduledResults.find((result) => result.name === 'writer')?.lockWaitMs ?? 0) >= 45, 'lockWaitMs includes deterministic compatibility queue wait');
  const capacityOnly = await runScheduled([entry('capacity-a'), entry('capacity-b')], 1, async (item) => { await new Promise(done => setTimeout(done, 20)); return pass(item.name); });
  observations.completedMembers += scheduledResults.length + capacityOnly.length;
  assert(capacityOnly[1]?.lockWaitMs === 0, 'worker-capacity queue time is not reported as resource lock wait');

  const launchOrder: string[] = [];
  const reportOrder = await runScheduled([entry('inventory-first', [], 1), entry('priority-first', [], 100)], 1, async (item) => { launchOrder.push(item.name); return pass(item.name); });
  assert(launchOrder[0] === 'priority-first', 'priority affects launch order');
  assert(reportOrder.map(({ name }) => name).join(',') === 'inventory-first,priority-first', 'priority preserves canonical report order');
  assert((await runScheduled([], 4, async (item) => pass(item.name))).length === 0, 'empty selection completes');
  assert((await runScheduled([entry('only')], 64, async (item) => pass(item.name))).length === 1, 'jobs above member count executes member once');
  for (const invalid of ['NaN', 'Infinity', '0', '-1', '1.5', '65', undefined]) {
    let rejected = false; try { parsePositiveInteger(invalid, 'jobs'); } catch { rejected = true; }
    assert(rejected, `invalid jobs value ${String(invalid)} is rejected`);
  }
  assert(parsePositiveInteger('3', 'jobs') === 3, 'finite bounded positive jobs value is accepted');
  for (const args of [['--unknown'], ['--jobs'], ['--json-output'], ['--jobs', '2', 'extra']]) {
    let rejected = false; try { parseRunnerArgs(args); } catch { rejected = true; }
    assert(rejected, `strict argument parser rejects ${args.join(' ')}`);
  }
  assert(isUnderFullSuiteBudget(299_999.999) && !isUnderFullSuiteBudget(300_000) && !isUnderFullSuiteBudget(300_001), 'performance boundary accepts below and rejects at or above 300000ms');
  assert(!shouldEnforceFullSuiteBudget(1) && shouldEnforceFullSuiteBudget(4), 'serial oracle is exempt while canonical parallel execution enforces the performance budget');
  assert(!fullSuiteBudgetBreached(299_999.999, 4) && fullSuiteBudgetBreached(300_000, 4) && fullSuiteBudgetBreached(300_001, 4), 'jobs4 performance predicate bites below, at, and above the exact boundary');
  assert(!fullSuiteBudgetBreached(300_000, 1) && !fullSuiteBudgetBreached(900_000, 1), 'jobs1 serial oracle reports but does not enforce the parallel performance boundary');
  assert(!identityChanged({ headHash: 'h', materialHash: 'm' }, { headHash: 'h', materialHash: 'm' }) && identityChanged({ headHash: 'h', materialHash: 'm' }, { headHash: 'h', materialHash: 'changed' }), 'start/end identity comparison fails on material drift');

  const terminalLaunches: string[] = [];
  const terminal = await runScheduled([entry('first-fail'), entry('must-not-launch')], 1, async (item) => { terminalLaunches.push(item.name); return item.name === 'first-fail' ? { ...pass(item.name), status: 'FAIL' } : pass(item.name); });
  assert(terminal.filter(({ name }) => name === 'first-fail').length === 1 && terminal.some(({ status }) => status === 'FAIL') && terminal.some(({ name, status }) => name === 'must-not-launch' && status === 'INTERRUPTED') && terminalLaunches.join(',') === 'first-fail', 'failure is terminal and never retried; pending launch is prevented');
  let missingTerminalRejected = false;
  try { await runScheduled([entry('missing-terminal')], 1, async () => undefined as unknown as FullSuiteResult); } catch { missingTerminalRejected = true; }
  assert(missingTerminalRejected, 'missing terminal aggregation trial fails closed without fabricated PASS');
  observations.mutationBites.inventoryOmission = missingTerminalRejected;
  let killFailureObserved = false;
  try { killProcessTree(123, () => { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EPERM'; throw error; }); } catch (error) { killFailureObserved = String(error).includes('failed to terminate'); }
  assert(killFailureObserved, 'non-ESRCH process tree termination failure is surfaced');
  const killCalls: number[] = [];
  const alreadyGone = (() => { try { killProcessTree(123, (pid) => { killCalls.push(pid); const error = new Error('gone') as NodeJS.ErrnoException; error.code = 'ESRCH'; throw error; }); return true; } catch { return false; } })();
  assert(alreadyGone && killCalls.join(',') === '-123,123', 'POSIX group ESRCH falls back to the live direct child before treating the tree as gone');
  let windowsPid = 0;
  killProcessTree(456, process.kill, 'win32', (pid) => { windowsPid = pid; });
  assert(windowsPid === 456, 'Windows cleanup uses supported taskkill tree strategy');
  assert(pathIsContained('C:\\repo', 'C:\\repo\\tmp\\x', win32) && !pathIsContained('C:\\repo', 'D:\\repo\\x', win32) && !pathIsContained('C:\\repo', 'C:\\repo-escape\\x', win32), 'path containment handles Windows separators and drive boundaries');

  const root = mkdtempSync(join(tmpdir(), 'full-suite-runner-smoke-'));
  try {
    const artifact = join(root, 'result.json'); writeResultArtifact(artifact, { complete: true });
    assert(JSON.parse(readFileSync(artifact, 'utf8')).complete === true, 'completion artifact atomically replaces final path');
    observations.lifecycle.normalCleanup = JSON.parse(readFileSync(artifact, 'utf8')).complete === true;
    const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'package.json'), '{}');
    let overwriteRejected = false;
    try { validateJsonOutputPath(project, join(project, 'package.json'), project); } catch { overwriteRejected = true; }
    assert(overwriteRejected && readFileSync(join(project, 'package.json'), 'utf8') === '{}', 'tracked project output overwrite is rejected before execution');
    const outsideOutput = join(root, 'outside', 'result.json'); mkdirSync(dirname(outsideOutput));
    assert(pathIsContained(realpathSync(join(root, 'outside')), dirname(validateJsonOutputPath(project, outsideOutput))), 'out-of-tree JSON output is accepted');
    let projectOwnedRejected = false;
    try { validateJsonOutputPath(project, join(project, 'result.json'), project); } catch { projectOwnedRejected = true; }
    assert(projectOwnedRejected, 'OUTPUT_ROOT cannot authorize the project root');
    observations.lifecycle.outsideRootRefused = projectOwnedRejected;
    let ancestorOwnedRejected = false;
    try { validateJsonOutputPath(project, outsideOutput, root); } catch { ancestorOwnedRejected = true; }
    assert(ancestorOwnedRejected, 'OUTPUT_ROOT cannot be an ancestor of the project root');
    const externalOwned = join(root, 'owned-external'); mkdirSync(externalOwned);
    assert(pathIsContained(realpathSync(externalOwned), validateJsonOutputPath(project, join(externalOwned, 'result.json'), externalOwned)), 'external disjoint OUTPUT_ROOT authorizes only its descendants');
    const outsideDir = join(root, 'outside-target'); mkdirSync(outsideDir); symlinkSync(outsideDir, join(project, 'output-alias'));
    let symlinkEscapeRejected = false;
    try { validateJsonOutputPath(project, join(project, 'output-alias', 'result.json')); } catch { symlinkEscapeRejected = true; }
    assert(symlinkEscapeRejected, 'lexically in-project symlink output escape is rejected before execution');
    const cpuFixture = join(root, 'cpu-fixture'); mkdirSync(cpuFixture);
    writeFileSync(join(cpuFixture, 'cpu.js'), `process.stderr.write('user 999\\n');console.log('TEMP_ROOTS='+[process.env.LATTICE_FULL_SUITE_TEMP_ROOT,process.env.TMPDIR,process.env.TMP,process.env.TEMP].join('|'));console.log('LATTICE_FULL_SUITE_SUMMARY='+JSON.stringify({assertions:['cpu-fixture'],mutations:['stderr-spoof']}));\n`);
    writeFileSync(join(cpuFixture, 'package.json'), JSON.stringify({ scripts: { 'test:cpu': 'node cpu.js' } }));
    const cpuResult = await runEntry(entry('test:cpu'), cpuFixture);
    assert(cpuResult.status === 'PASS' && cpuResult.cpu?.userSeconds !== 999, 'member stderr cannot spoof dedicated CPU timing file');
    assert(cpuResult.summaryMarkerPresent === true && cpuResult.assertionInventory?.[0] === 'cpu-fixture' && cpuResult.mutationInventory?.[0] === 'stderr-spoof', 'structured member summary marker reconciles assertion and mutation inventories');
    writeFileSync(join(cpuFixture, 'plain.js'), `console.log('plain member');\n`);
    writeFileSync(join(cpuFixture, 'package.json'), JSON.stringify({ scripts: { 'test:cpu': 'node cpu.js', 'test:plain': 'node plain.js' } }));
    const plainResult = await runEntry(entry('test:plain'), cpuFixture);
    assert(plainResult.summaryMarkerPresent === false && plainResult.inventorySource === 'output-signature'
      && plainResult.detailedAssertions?.length === 1 && plainResult.mutationInventory?.length === 0
      && plainResult.assertionInventory?.includes(plainResult.detailedAssertions[0]!), 'real member output produces nonempty detailed signatures without fabricating mutation inventory');
    const baselineSignatures = observedOutputSignatures('plain member\nPASS stable assertion\n');
    const repeatedSignatures = observedOutputSignatures('plain member\nPASS stable assertion\n');
    const deletedSignatures = observedOutputSignatures('plain member\n');
    const changedSeedSignatures = observedOutputSignatures('plain member\nPASS stable assertion seed=42\n');
    const storyFixtureOne = observedOutputSignatures('- B-4024 [INIT] Implement an explicit planner milestone ledger pass-through.');
    const storyFixtureTwo = observedOutputSignatures('- B-cd45 [INIT] Implement an explicit planner milestone ledger pass-through.');
    const namedStory = observedOutputSignatures('- B-META [INIT] Implement an explicit planner milestone ledger pass-through.');
    const stressOne = observedOutputSignatures('INCREMENTAL_STRESS_RECEIPT={"deterministicSeed":"fixed-mask-v1","iterations":[{"iteration":1,"status":"PASS"}],"aba":{"observedDurationMs":10}}');
    const stressTwo = observedOutputSignatures('INCREMENTAL_STRESS_RECEIPT={"deterministicSeed":"fixed-mask-v1","iterations":[{"iteration":1,"status":"PASS"}],"aba":{"observedDurationMs":99}}');
    const stressSeedChanged = observedOutputSignatures('INCREMENTAL_STRESS_RECEIPT={"deterministicSeed":"fixed-mask-v2","iterations":[{"iteration":1,"status":"PASS"}],"aba":{"observedDurationMs":99}}');
    const stressCountChanged = observedOutputSignatures('INCREMENTAL_STRESS_RECEIPT={"deterministicSeed":"fixed-mask-v1","iterations":[{"iteration":2,"status":"FAIL"}],"aba":{"observedDurationMs":99}}');
    assert(JSON.stringify(baselineSignatures) === JSON.stringify(repeatedSignatures), 'identical member output yields deterministic sorted and deduplicated signatures');
    assert(baselineSignatures.length === 1 && deletedSignatures.length === 1 && baselineSignatures[0] !== deletedSignatures[0], 'deleting one observed assertion line bites the output-derived inventory');
    assert(changedSeedSignatures[0] !== baselineSignatures[0], 'meaningful assertion seeds and numbers remain inventory-significant');
    assert(JSON.stringify(storyFixtureOne) === JSON.stringify(storyFixtureTwo), 'known generated hex fixture IDs normalize only in story-list output lines');
    assert(JSON.stringify(storyFixtureOne) !== JSON.stringify(namedStory), 'named and static story IDs remain inventory-significant');
    assert(JSON.stringify(stressOne) === JSON.stringify(stressTwo), 'only observedDurationMs values normalize recursively inside incremental stress receipts');
    assert(JSON.stringify(stressOne) !== JSON.stringify(stressSeedChanged) && JSON.stringify(stressOne) !== JSON.stringify(stressCountChanged), 'stress seed, iteration count and status remain inventory-significant');
    assert(cpuResult.assertionInventory?.includes('cpu-fixture') && cpuResult.detailedAssertions?.length, 'explicit marker assertions are retained alongside observed output signatures');
    writeFileSync(join(cpuFixture, 'marker-a.js'), `console.log('PASS stable marker member');console.log('LATTICE_FULL_SUITE_SUMMARY={"assertions":["marker-proof"],"mutations":["marker-mutation"],"timing":"0.1s"}');\n`);
    writeFileSync(join(cpuFixture, 'marker-b.js'), `console.log('PASS stable marker member');console.log('LATTICE_FULL_SUITE_SUMMARY={ "timing":"9.9s", "mutations":["marker-mutation"], "assertions":["marker-proof"] }');\n`);
    writeFileSync(join(cpuFixture, 'marker-changed.js'), `console.log('PASS stable marker member');console.log('LATTICE_FULL_SUITE_SUMMARY='+JSON.stringify({assertions:['marker-proof-changed'],mutations:['marker-mutation-changed'],timing:'0.1s'}));\n`);
    writeFileSync(join(cpuFixture, 'package.json'), JSON.stringify({ scripts: {
      'test:marker-a': 'node marker-a.js', 'test:marker-b': 'node marker-b.js', 'test:marker-changed': 'node marker-changed.js',
    } }));
    const markerA = await runEntry(entry('test:marker-a'), cpuFixture);
    const markerB = await runEntry(entry('test:marker-b'), cpuFixture);
    const markerChanged = await runEntry(entry('test:marker-changed'), cpuFixture);
    assert(JSON.stringify(markerA.detailedAssertions) === JSON.stringify(markerB.detailedAssertions)
      && JSON.stringify(markerA.mutationInventory) === JSON.stringify(markerB.mutationInventory), 'marker JSON formatting and timing-only serialization do not alter member inventory');
    assert(JSON.stringify(markerA.detailedAssertions) !== JSON.stringify(markerChanged.detailedAssertions)
      && JSON.stringify(markerA.mutationInventory) !== JSON.stringify(markerChanged.mutationInventory), 'changing parsed marker assertions and mutations alters member inventory');
    assert(markerA.detailedAssertions?.includes('marker-proof') && markerA.detailedAssertions.some(value => value.startsWith('output-sha256:')), 'marker assertions and non-marker output signatures are retained as separate facts');
    writeFileSync(join(cpuFixture, 'suppressible.js'), `console.log('PASS assertion-one');if(process.env.SUPPRESS_ASSERTION!=='1')console.log('PASS assertion-two');console.log('LATTICE_FULL_SUITE_SUMMARY='+JSON.stringify({assertions:process.env.SUPPRESS_MARKER_ASSERTION==='1'?[]:['marker-assertion'],mutations:process.env.SUPPRESS_MARKER_MUTATION==='1'?[]:['marker-mutation']}));\n`);
    writeFileSync(join(cpuFixture, 'package.json'), JSON.stringify({ scripts: { 'test:suppressible': 'node suppressible.js' } }));
    delete process.env.SUPPRESS_ASSERTION; delete process.env.SUPPRESS_MARKER_ASSERTION; delete process.env.SUPPRESS_MARKER_MUTATION;
    const suppressibleBaseline = await runEntry(entry('test:suppressible'), cpuFixture);
    process.env.SUPPRESS_ASSERTION = '1'; const suppressedOutput = await runEntry(entry('test:suppressible'), cpuFixture); delete process.env.SUPPRESS_ASSERTION;
    process.env.SUPPRESS_MARKER_ASSERTION = '1'; const suppressedMarkerAssertion = await runEntry(entry('test:suppressible'), cpuFixture); delete process.env.SUPPRESS_MARKER_ASSERTION;
    process.env.SUPPRESS_MARKER_MUTATION = '1'; const suppressedMarkerMutation = await runEntry(entry('test:suppressible'), cpuFixture); delete process.env.SUPPRESS_MARKER_MUTATION;
    assert(JSON.stringify(suppressibleBaseline.detailedAssertions) !== JSON.stringify(suppressedOutput.detailedAssertions), 'suppressing an assertion before member output changes observed detailed inventory');
    assert(suppressibleBaseline.detailedAssertions?.includes('marker-assertion') && !suppressedMarkerAssertion.detailedAssertions?.includes('marker-assertion'), 'suppressing an explicit marker assertion before emission changes parsed inventory');
    assert(suppressibleBaseline.mutationInventory?.includes('marker-mutation') && suppressedMarkerMutation.mutationInventory?.length === 0, 'suppressing an explicit marker mutation before emission changes mutation inventory');
    const isolatedRoots = cpuResult.output.match(/TEMP_ROOTS=([^\n]+)/)?.[1]?.split('|') ?? [];
    const tempOwnershipLabel = 'member consumes one unique temp ownership root through LATTICE/TMPDIR/TMP/TEMP';
    assertWithDetail(isolatedTempRootsMatch(isolatedRoots, cpuResult.tempRoot), tempOwnershipLabel, `${isolatedRoots.join('|')} vs ${cpuResult.tempRoot}`);
    assert(checks.includes(tempOwnershipLabel) && !checks.some(message => message.includes(cpuResult.tempRoot!)), 'successful temp ownership marker records a stable label without dynamic paths');
    for (const [roots, expected] of [[[cpuResult.tempRoot!, cpuResult.tempRoot!], cpuResult.tempRoot], [[], cpuResult.tempRoot]] as const) {
      let diagnostic = '';
      try { assertWithDetail(isolatedTempRootsMatch([...roots], expected), tempOwnershipLabel, `${roots.join('|')} vs ${expected}`); }
      catch (error) { diagnostic = (error as Error).message; }
      assert(diagnostic.startsWith(`${tempOwnershipLabel}:`) && diagnostic.includes(`vs ${expected}`), 'invalid temp ownership roots fail with dynamic diagnostic detail');
    }
    const completionHeartbeat = join(root, 'completion-heartbeat');
    writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');const child=spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');fs.writeFileSync(${JSON.stringify(completionHeartbeat)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(completionHeartbeat)},'x'),20)`) }],{stdio:'ignore'});child.unref();for(let i=0;i<100&&!fs.existsSync(${JSON.stringify(completionHeartbeat)});i++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);if(!fs.existsSync(${JSON.stringify(completionHeartbeat)}))process.exit(2);\n`);
    const completedWithGrandchild = await runEntry(entry('test:normal-completion-grandchild'), root, process.execPath);
    assertWithDetail(completedWithGrandchild.status === 'PASS', 'normal parent completion remains PASS after descendant cleanup', `${completedWithGrandchild.status}: ${completedWithGrandchild.reason ?? 'no reason'}`);
    for (let index = 0; index < 100 && !existsSync(completionHeartbeat); index++) await new Promise((done) => setTimeout(done, 10));
    assert(existsSync(completionHeartbeat), 'normal completion fixture proves the grandchild started');
    const completionBefore = readFileSync(completionHeartbeat, 'utf8').length;
    await new Promise((done) => setTimeout(done, 100));
    assert(readFileSync(completionHeartbeat, 'utf8').length === completionBefore, 'normal parent completion kills complete descendant process group');
    observations.lifecycle.normalCompletionGrandchild = readFileSync(completionHeartbeat, 'utf8').length === completionBefore;
    const completionDetachedPidPath = join(root, 'detached-completion.pid');
    const completionDetachedProgram = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(completionDetachedPidPath)},String(process.pid));setInterval(()=>{},1000)`;
    writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');const child=spawn(process.execPath,['-e',${JSON.stringify(completionDetachedProgram)}],{detached:true,stdio:'ignore'});child.unref();for(let i=0;i<100&&!fs.existsSync(${JSON.stringify(completionDetachedPidPath)});i++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);if(!fs.existsSync(${JSON.stringify(completionDetachedPidPath)}))process.exit(2);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);\n`);
    const completedWithDetachedGrandchild = await runEntry(entry('test:normal-completion-detached-grandchild'), root, process.execPath);
    const completionDetachedPid = Number(readFileSync(completionDetachedPidPath, 'utf8'));
    let completionDetachedAlive = false;
    try { process.kill(completionDetachedPid, 0); completionDetachedAlive = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (completionDetachedAlive) {
      try { process.kill(-completionDetachedPid, 'SIGKILL'); } catch { try { process.kill(completionDetachedPid, 'SIGKILL'); } catch {} }
    }
    assertWithDetail(completedWithDetachedGrandchild.status === 'PASS', 'normal completion with a detached descendant remains PASS after verified cleanup', `${completedWithDetachedGrandchild.status}: ${completedWithDetachedGrandchild.reason ?? 'no reason'}`);
    assertWithDetail(!completionDetachedAlive, 'normal completion terminal waits for detached descendant PID to disappear', `live PID ${completionDetachedPid}`);

    const nonzeroDetachedPidPath = join(root, 'detached-nonzero.pid');
    const nonzeroDetachedProgram = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(nonzeroDetachedPidPath)},String(process.pid));setInterval(()=>{},1000)`;
    writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');const child=spawn(process.execPath,['-e',${JSON.stringify(nonzeroDetachedProgram)}],{detached:true,stdio:'ignore'});child.unref();for(let i=0;i<100&&!fs.existsSync(${JSON.stringify(nonzeroDetachedPidPath)});i++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);if(!fs.existsSync(${JSON.stringify(nonzeroDetachedPidPath)}))process.exit(2);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);process.exit(7);\n`);
    const failedWithDetachedGrandchild = await runEntry(entry('test:nonzero-completion-detached-grandchild'), root, process.execPath);
    const nonzeroDetachedPid = Number(readFileSync(nonzeroDetachedPidPath, 'utf8'));
    assertWithDetail(failedWithDetachedGrandchild.status === 'FAIL' && failedWithDetachedGrandchild.reason === 'exit code 7', 'nonzero completion preserves exit failure after verified detached cleanup', `${failedWithDetachedGrandchild.status}: ${failedWithDetachedGrandchild.reason ?? 'no reason'}`);
    assertWithDetail(!pidIsAlive(nonzeroDetachedPid), 'nonzero completion terminal waits for detached descendant PID to disappear', `live PID ${nonzeroDetachedPid}`);

    const reusedParentPidPath = join(root, 'reused-parent.pid');
    const reuseOwnedPidPath = join(root, 'reuse-owned.pid');
    const reuseOwnedProgram = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(reuseOwnedPidPath)},String(process.pid));setInterval(()=>{},1000)`;
    const shortProgram = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(reusedParentPidPath)},String(process.pid));setTimeout(()=>{},80)`;
    writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');spawn(process.execPath,['-e',${JSON.stringify(shortProgram)}],{stdio:'ignore'});const owned=spawn(process.execPath,['-e',${JSON.stringify(reuseOwnedProgram)}],{detached:true,stdio:'ignore'});owned.unref();for(let i=0;i<100&&(!fs.existsSync(${JSON.stringify(reusedParentPidPath)})||!fs.existsSync(${JSON.stringify(reuseOwnedPidPath)}));i++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);if(!fs.existsSync(${JSON.stringify(reusedParentPidPath)})||!fs.existsSync(${JSON.stringify(reuseOwnedPidPath)}))process.exit(2);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);\n`);
    let sawShortLivedChild = false;
    let foreignReuseSignalled = false;
    const foreignPid = 987_654;
    const pidReuseAdapter: ProcessLifecycleAdapter = {
      ...DEFAULT_PROCESS_LIFECYCLE_ADAPTER,
      inspect: () => {
        const rows = DEFAULT_PROCESS_LIFECYCLE_ADAPTER.inspect();
        const shortPid = existsSync(reusedParentPidPath) ? Number(readFileSync(reusedParentPidPath, 'utf8')) : 0;
        if (rows.some(row => row.pid === shortPid)) sawShortLivedChild = true;
        if (sawShortLivedChild && shortPid > 0 && !rows.some(row => row.pid === shortPid)) rows.push({ pid: foreignPid, ppid: shortPid, pgid: foreignPid });
        return rows;
      },
      signal: (pid, signal) => {
        if (pid === -foreignPid) { foreignReuseSignalled = true; throw new Error('foreign reused-PID process group was targeted'); }
        if (pid === foreignPid) return;
        DEFAULT_PROCESS_LIFECYCLE_ADAPTER.signal(pid, signal);
      },
      probe: (pid) => Math.abs(pid) === foreignPid ? false : DEFAULT_PROCESS_LIFECYCLE_ADAPTER.probe(pid),
    };
    const pidReuseResult = await runEntry(entry('test:pid-reuse-contamination'), root, process.execPath, undefined, { adapter: pidReuseAdapter, retryIntervalMs: 10 });
    const reuseOwnedPid = Number(readFileSync(reuseOwnedPidPath, 'utf8'));
    if (pidIsAlive(reuseOwnedPid)) { try { process.kill(-reuseOwnedPid, 'SIGKILL'); } catch { try { process.kill(reuseOwnedPid, 'SIGKILL'); } catch {} } }
    assertWithDetail(sawShortLivedChild, 'PID reuse fixture captures the original short-lived owned child', `short PID was never observed from ${reusedParentPidPath}`);
    assertWithDetail(pidReuseResult.status === 'PASS' && !foreignReuseSignalled, 'historical PID reuse cannot contaminate ownership or signal a foreign process group', `${pidReuseResult.status}/${foreignReuseSignalled}: ${pidReuseResult.reason ?? 'no reason'}`);
    assertWithDetail(!pidIsAlive(reuseOwnedPid), 'PID reuse reconciliation still removes the genuinely owned detached descendant', `live PID ${reuseOwnedPid}`);

    const lifecycleFixture = async (label: string, adapter: ProcessLifecycleAdapter, cleanupBudgetMs = 500) => {
      const pidPath = join(root, `${label}.pid`);
      const program = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000)`;
      writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');const child=spawn(process.execPath,['-e',${JSON.stringify(program)}],{detached:true,stdio:'ignore'});child.unref();for(let i=0;i<100&&!fs.existsSync(${JSON.stringify(pidPath)});i++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);if(!fs.existsSync(${JSON.stringify(pidPath)}))process.exit(2);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);\n`);
      const result = await runEntry(entry(`test:${label}`), root, process.execPath, undefined, { adapter, cleanupBudgetMs, retryIntervalMs: 10 });
      const pid = Number(readFileSync(pidPath, 'utf8'));
      assertWithDetail(!pidIsAlive(pid), `${label} terminal waits for detached descendant PID to disappear`, `live PID ${pid}`);
      return result;
    };

    let initialInspections = 0;
    const initialInspectionFailure: ProcessLifecycleAdapter = {
      ...DEFAULT_PROCESS_LIFECYCLE_ADAPTER,
      inspect: () => { if (initialInspections++ === 0) throw new Error('injected initial inspection failure'); return DEFAULT_PROCESS_LIFECYCLE_ADAPTER.inspect(); },
    };
    const initialInspectionResult = await lifecycleFixture('initial-inspection-failure', initialInspectionFailure);
    assertWithDetail(initialInspectionResult.status === 'FAIL' && initialInspectionResult.reason?.includes('injected initial inspection failure'), 'initial inspection failure remains fail-closed after verified cleanup', `${initialInspectionResult.status}: ${initialInspectionResult.reason ?? 'no reason'}`);

    let reinspectionCalls = 0;
    const reinspectionFailure: ProcessLifecycleAdapter = {
      ...DEFAULT_PROCESS_LIFECYCLE_ADAPTER,
      inspect: () => { if (reinspectionCalls++ === 1) throw new Error('injected reinspection failure'); return DEFAULT_PROCESS_LIFECYCLE_ADAPTER.inspect(); },
    };
    const reinspectionResult = await lifecycleFixture('reinspection-failure', reinspectionFailure);
    assertWithDetail(reinspectionResult.status === 'FAIL' && reinspectionResult.reason?.includes('injected reinspection failure'), 'reinspection failure remains fail-closed after verified cleanup', `${reinspectionResult.status}: ${reinspectionResult.reason ?? 'no reason'}`);

    let pollFailureInjected = false;
    const pollFailure: ProcessLifecycleAdapter = {
      ...DEFAULT_PROCESS_LIFECYCLE_ADAPTER,
      probe: (pid) => { if (!pollFailureInjected) { pollFailureInjected = true; throw new Error('injected liveness poll failure'); } return DEFAULT_PROCESS_LIFECYCLE_ADAPTER.probe(pid); },
    };
    const pollFailureResult = await lifecycleFixture('poll-failure', pollFailure);
    assertWithDetail(pollFailureResult.status === 'FAIL' && pollFailureResult.reason?.includes('injected liveness poll failure'), 'liveness poll failure remains fail-closed after verified cleanup', `${pollFailureResult.status}: ${pollFailureResult.reason ?? 'no reason'}`);

    let signalFailureInjected = false;
    const signalFailure: ProcessLifecycleAdapter = {
      ...DEFAULT_PROCESS_LIFECYCLE_ADAPTER,
      signal: (pid, signal) => {
        if (!signalFailureInjected && signal === 'SIGKILL') { signalFailureInjected = true; throw new Error('injected signal failure'); }
        DEFAULT_PROCESS_LIFECYCLE_ADAPTER.signal(pid, signal);
      },
    };
    const signalFailureResult = await lifecycleFixture('signal-failure', signalFailure);
    assertWithDetail(signalFailureResult.status === 'FAIL' && signalFailureResult.reason?.includes('injected signal failure'), 'signal failure is negative but publishes only after verified cleanup', `${signalFailureResult.status}: ${signalFailureResult.reason ?? 'no reason'}`);

    let survivorPolls = 0;
    const persistentSurvivor: ProcessLifecycleAdapter = {
      ...DEFAULT_PROCESS_LIFECYCLE_ADAPTER,
      probe: (pid) => survivorPolls++ < 30 || DEFAULT_PROCESS_LIFECYCLE_ADAPTER.probe(pid),
    };
    const survivorStarted = performance.now();
    const persistentSurvivorResult = await lifecycleFixture('persistent-survivor', persistentSurvivor, 50);
    assertWithDetail(persistentSurvivorResult.status === 'FAIL' && persistentSurvivorResult.reason?.includes('exceeded 50ms cleanup budget') && performance.now() - survivorStarted >= 50, 'persistent survivor quarantines past budget before negative terminal', `${persistentSurvivorResult.status}/${(performance.now() - survivorStarted).toFixed(1)}ms: ${persistentSurvivorResult.reason ?? 'no reason'}`);

    writeFileSync(join(root, 'run'), 'process.exit(0);\n');
    const reuseAfterInspectionFailure = await runEntry(entry('test:reuse-after-inspection-failure'), root, process.execPath);
    assert(reuseAfterInspectionFailure.status === 'PASS', 'scheduler reuse follows only after injected lifecycle failures have no residual PID');

    const synchronousInterruptMarker = join(root, 'synchronous-interrupt-started');
    writeFileSync(join(root, 'run'), `require('fs').writeFileSync(${JSON.stringify(synchronousInterruptMarker)},'started');setInterval(()=>{},1000);\n`);
    const synchronousInterruptStarted = performance.now();
    const synchronousInterrupt = await runEntry({ ...entry('test:synchronous-onspawn-interrupt'), timeoutMs: 10_000 }, root, process.execPath, () => interruptForTest('SIGTERM'));
    assertWithDetail(synchronousInterrupt.status === 'INTERRUPTED' && performance.now() - synchronousInterruptStarted < 2_000, 'synchronous onSpawn interrupt terminates promptly through pre-registered terminator', `${synchronousInterrupt.status}/${(performance.now() - synchronousInterruptStarted).toFixed(1)}ms: ${synchronousInterrupt.reason ?? 'no reason'}`);
    assert(!existsSync(synchronousInterruptMarker), 'synchronous onSpawn interrupt permits zero child execution or descendants');
    resetInterruptForTest();

    const presetInterruptMarker = join(root, 'preset-interrupt-started');
    writeFileSync(join(root, 'run'), `require('fs').writeFileSync(${JSON.stringify(presetInterruptMarker)},'started');setInterval(()=>{},1000);\n`);
    interruptForTest('SIGTERM');
    const presetInterrupt = await runEntry({ ...entry('test:preset-interrupt'), timeoutMs: 10_000 }, root, process.execPath);
    assertWithDetail(presetInterrupt.status === 'INTERRUPTED', 'already-set interrupt immediately uses the registered terminator', `${presetInterrupt.status}: ${presetInterrupt.reason ?? 'no reason'}`);
    assert(!existsSync(presetInterruptMarker), 'already-set interrupt permits zero child execution or descendants');
    resetInterruptForTest();

    const heartbeat = join(root, 'heartbeat');
    writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},'x');spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`) }],{stdio:'ignore'});setInterval(()=>{},1000);\n`);
    let launches = 0;
    const timeout = await runEntry({ ...entry('test:hang'), timeoutMs: 300 }, root, process.execPath, () => { launches++; });
    assertWithDetail(timeout.status === 'TIMEOUT' && launches === 1, 'actual process spawn increments launch accounting exactly once', `${timeout.status}/${launches}: ${timeout.reason ?? 'no reason'}`);
    assert(Boolean(timeout.tempRoot) && !existsSync(timeout.tempRoot!), 'normal timeout removes only the runner-owned unique temp root');
    assert(existsSync(root), 'runner cleanup cannot target the caller repository root');
    await new Promise((done) => setTimeout(done, 80)); const before = readFileSync(heartbeat, 'utf8').length;
    await new Promise((done) => setTimeout(done, 100));
    assert(before === readFileSync(heartbeat, 'utf8').length, 'timeout kills complete descendant process group');
    observations.lifecycle.timeoutGrandchild = before === readFileSync(heartbeat, 'utf8').length;
    const detachedPidPath = join(root, 'detached-timeout.pid');
    const detachedHeartbeat = join(root, 'detached-timeout-heartbeat');
    const detachedProgram = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(detachedPidPath)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(detachedHeartbeat)},'x'),20)`;
    writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');const child=spawn(process.execPath,['-e',${JSON.stringify(detachedProgram)}],{detached:true,stdio:'ignore'});child.unref();for(let i=0;i<100&&!fs.existsSync(${JSON.stringify(detachedPidPath)});i++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);if(!fs.existsSync(${JSON.stringify(detachedPidPath)}))process.exit(2);setInterval(()=>{},1000);\n`);
    const detachedTimeout = await runEntry({ ...entry('test:detached-timeout'), timeoutMs: 300 }, root, process.execPath);
    const detachedPid = Number(readFileSync(detachedPidPath, 'utf8'));
    let detachedAliveAfterTerminal = false;
    try { process.kill(detachedPid, 0); detachedAliveAfterTerminal = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (detachedAliveAfterTerminal) {
      try { process.kill(-detachedPid, 'SIGKILL'); } catch { try { process.kill(detachedPid, 'SIGKILL'); } catch {} }
    }
    assert(detachedTimeout.status === 'TIMEOUT', 'separate-process-group descendant fixture reaches timeout');
    assertWithDetail(!detachedAliveAfterTerminal, 'timeout terminal waits for separate-process-group descendant PID to disappear', `live PID ${detachedPid}`);
    writeFileSync(join(root, 'run'), 'process.exit(0);\n');
    const reuseAfterDetachedTimeout = await runEntry(entry('test:reuse-after-detached-timeout'), root, process.execPath);
    assert(reuseAfterDetachedTimeout.status === 'PASS', 'scheduler reuse starts only after detached timeout descendants are absent');
    const interruptedDetachedPidPath = join(root, 'detached-interrupt.pid');
    const interruptedDetachedProgram = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(interruptedDetachedPidPath)},String(process.pid));setInterval(()=>{},1000)`;
    writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');const child=spawn(process.execPath,['-e',${JSON.stringify(interruptedDetachedProgram)}],{detached:true,stdio:'ignore'});child.unref();for(let i=0;i<100&&!fs.existsSync(${JSON.stringify(interruptedDetachedPidPath)});i++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);if(!fs.existsSync(${JSON.stringify(interruptedDetachedPidPath)}))process.exit(2);setInterval(()=>{},1000);\n`);
    const interruptedPromise = runEntry({ ...entry('test:hang'), timeoutMs: 10_000 }, root, process.execPath);
    await new Promise((done) => setTimeout(done, 100)); interruptForTest('SIGTERM');
    const interrupted = await interruptedPromise;
    const interruptedDetachedPid = Number(readFileSync(interruptedDetachedPidPath, 'utf8'));
    let interruptedDetachedAlive = false;
    try { process.kill(interruptedDetachedPid, 0); interruptedDetachedAlive = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (interruptedDetachedAlive) {
      try { process.kill(-interruptedDetachedPid, 'SIGKILL'); } catch { try { process.kill(interruptedDetachedPid, 'SIGKILL'); } catch {} }
    }
    assertWithDetail(interrupted.status === 'INTERRUPTED' && interrupted.reason?.includes('SIGTERM'), 'external interruption reports INTERRUPTED', `${interrupted.status}: ${interrupted.reason ?? 'no reason'}`);
    assertWithDetail(!interruptedDetachedAlive, 'interrupt terminal waits for separate-process-group descendant PID to disappear', `live PID ${interruptedDetachedPid}`);
    observations.lifecycle.externalInterrupt = interrupted.status === 'INTERRUPTED' && Boolean(interrupted.reason?.includes('SIGTERM'));
    resetInterruptForTest();

    const ownedRoot = join(root, '.lattice', 'runtime'); const lockRoot = join(root, '.lattice', 'locks');
    mkdirSync(ownedRoot, { recursive: true }); mkdirSync(lockRoot, { recursive: true });
    const ownedPaths = [join(ownedRoot, 'owned-fixed'), join(ownedRoot, 'owned-runtime'), join(lockRoot, 'owned-main')];
    const sibling = join(ownedRoot, 'sibling'); writeFileSync(sibling, 'keep\n');
    const ready = join(root, 'owned-ready');
    const ownedFixture = `const fs=require('fs');const paths=${JSON.stringify(ownedPaths)};for(const p of paths){fs.mkdirSync(p);const t=p+'/.owner-'+process.pid+'.tmp';fs.writeFileSync(t,process.env.LATTICE_FULL_SUITE_OWNERSHIP_TOKEN+'\\n',{flag:'wx'});fs.renameSync(t,p+'/owner')}fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);\n`;
    writeFileSync(join(root, 'run'), ownedFixture);
    const ownedEntry = canonicalizeEntries([{ ...entry('test:owned-cleanup'), resources: [
      { class: 'fixed-path', key: '.lattice/runtime/owned-fixed', access: 'exclusive', ownership: 'runner-cleanable' },
      { class: 'runtime-lock', key: '.lattice/runtime/owned-runtime', access: 'exclusive', ownership: 'runner-cleanable' },
      { class: 'main-write-lock', key: '.lattice/locks/owned-main', access: 'exclusive', ownership: 'runner-cleanable' },
    ] }], root)[0]!;
    const passResiduePath = join(ownedRoot, 'pass-residue');
    writeFileSync(join(root, 'run'), `const fs=require('fs');const p=${JSON.stringify(passResiduePath)};fs.mkdirSync(p);fs.writeFileSync(p+'/owner',process.env.LATTICE_FULL_SUITE_OWNERSHIP_TOKEN+'\\n');\n`);
    const passResidueEntry = canonicalizeEntries([{ ...entry('test:pass-residue'), resources: [{ class: 'fixed-path', key: '.lattice/runtime/pass-residue', access: 'exclusive', ownership: 'runner-cleanable' }] }], root)[0]!;
    const passResidue = await runEntry(passResidueEntry, root, process.execPath);
    assert(passResidue.status === 'FAIL' && passResidue.cleanupOutcomes?.[0]?.outcome === 'residue' && existsSync(passResiduePath), 'PASS member residue fails closed and is retained for diagnosis');
    rmSync(passResiduePath, { recursive: true, force: true });
    writeFileSync(join(root, 'run'), ownedFixture);
    const ownedPromise = runEntry({ ...ownedEntry, timeoutMs: 10_000 }, root, process.execPath);
    for (let index = 0; index < 100 && !existsSync(ready); index++) await new Promise(done => setTimeout(done, 10));
    interruptForTest('SIGTERM'); const ownedInterrupted = await ownedPromise; resetInterruptForTest();
    assert(ownedInterrupted.status === 'INTERRUPTED' && ownedPaths.every(path => !existsSync(path)) && existsSync(sibling), 'SIGTERM cleanup removes all declared sentinel-owned resources and preserves siblings');
    assert(ownedInterrupted.cleanupManifest?.length === 3 && ownedInterrupted.cleanupOutcomes?.every(outcome => outcome.outcome === 'removed'), 'cleanup manifest is recorded before spawn and reconciled after interruption');

    const realSentinelRoot = join(root, 'real-sentinel'); mkdirSync(realSentinelRoot);
    execFileSync('git', ['init', '-b', 'main'], { cwd: realSentinelRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'suite@example.test'], { cwd: realSentinelRoot });
    execFileSync('git', ['config', 'user.name', 'Suite'], { cwd: realSentinelRoot });
    const realSentinelScript = resolve(dirname(fileURLToPath(import.meta.url)), 'full-suite-resource-sentinel.js');
    writeFileSync(join(realSentinelRoot, 'package.json'), JSON.stringify({ scripts: { 'test:real-sentinel': `node ${JSON.stringify(realSentinelScript)}` } }));
    execFileSync('git', ['add', '.'], { cwd: realSentinelRoot }); execFileSync('git', ['commit', '-m', 'fixture'], { cwd: realSentinelRoot, stdio: 'ignore' });
    const realSentinelPaths = [
      join(realSentinelRoot, '.lattice', 'runtime', 'full-suite-runtime-sentinel.lock'),
      join(realSentinelRoot, '.lattice', 'locks', 'full-suite-main-write-sentinel.lock'),
      join(realSentinelRoot, '.lattice', 'runtime', 'full-suite-fixed-sentinel'),
    ];
    const realSentinelEntry = canonicalizeEntries([{ ...entry('test:real-sentinel'), resources: [
      { class: 'runtime-lock', key: '.lattice/runtime/full-suite-runtime-sentinel.lock', access: 'exclusive', ownership: 'runner-cleanable' },
      { class: 'main-write-lock', key: '.lattice/locks/full-suite-main-write-sentinel.lock', access: 'exclusive', ownership: 'runner-cleanable' },
      { class: 'fixed-path', key: '.lattice/runtime/full-suite-fixed-sentinel', access: 'exclusive', ownership: 'runner-cleanable' },
    ] }], realSentinelRoot)[0]!;
    const runRealSentinelInterrupted = async (mutation?: 'missing-runtime' | 'tampered-main'): Promise<FullSuiteResult> => {
      const readyFile = join(root, `real-sentinel-ready-${mutation ?? 'baseline'}`);
      process.env.LATTICE_FULL_SUITE_SENTINEL_PAUSE_AFTER_MARKERS = '1';
      process.env.LATTICE_FULL_SUITE_SENTINEL_READY_FILE = readyFile;
      if (mutation) process.env.LATTICE_FULL_SUITE_SENTINEL_MARKER_MUTATION = mutation;
      try {
        const promise = runEntry({ ...realSentinelEntry, timeoutMs: 15_000 }, realSentinelRoot, 'npm');
        for (let index = 0; index < 1_000 && !existsSync(readyFile); index++) await new Promise(done => setTimeout(done, 10));
        if (!existsSync(readyFile)) { interruptForTest('SIGTERM'); await promise; }
        assertWithDetail(existsSync(readyFile), 'real production sentinel publishes ownership-ready handshake before pause', `missing=${realSentinelPaths.filter(path => !existsSync(path)).join(',')}`);
        assertWithDetail(realSentinelPaths.every(path => existsSync(path)), 'real production sentinel creates all three runner-cleanable directories before pause', `missing=${realSentinelPaths.filter(path => !existsSync(path)).join(',')}`);
        interruptForTest('SIGTERM'); const result = await promise; resetInterruptForTest();
        return result;
      } finally {
        resetInterruptForTest();
        delete process.env.LATTICE_FULL_SUITE_SENTINEL_PAUSE_AFTER_MARKERS;
        delete process.env.LATTICE_FULL_SUITE_SENTINEL_READY_FILE;
        delete process.env.LATTICE_FULL_SUITE_SENTINEL_MARKER_MUTATION;
        rmSync(readyFile, { force: true });
      }
    };
    const realInterrupted = await runRealSentinelInterrupted();
    assertWithDetail(realInterrupted.status === 'INTERRUPTED' && realInterrupted.cleanupOutcomes?.every(outcome => outcome.outcome === 'removed') && realSentinelPaths.every(path => !existsSync(path)), 'real production sentinel token markers allow all three SIGKILL-interrupted resources to be removed', JSON.stringify({ status: realInterrupted.status, reason: realInterrupted.reason, cleanup: realInterrupted.cleanupOutcomes }));
    const realMissingMarker = await runRealSentinelInterrupted('missing-runtime');
    assert(realMissingMarker.status === 'FAIL' && realMissingMarker.cleanupOutcomes?.some(outcome => outcome.detail === 'missing ownership marker') && existsSync(realSentinelPaths[0]!), 'real production sentinel missing-marker mutation is retained and fails closed');
    rmSync(realSentinelPaths[0]!, { recursive: true, force: true });
    const realTamperedMarker = await runRealSentinelInterrupted('tampered-main');
    assert(realTamperedMarker.status === 'FAIL' && realTamperedMarker.cleanupOutcomes?.some(outcome => outcome.detail === 'foreign directory ownership') && existsSync(realSentinelPaths[1]!), 'real production sentinel tampered-marker mutation is retained and fails closed');
    rmSync(realSentinelPaths[1]!, { recursive: true, force: true });

    const outsideEntry = { ...entry('test:outside-owned'), resources: [{ class: 'fixed-path', key: '../outside', access: 'exclusive', ownership: 'runner-cleanable', canonicalKey: `fixed-path:${join(dirname(root), 'outside')}` } as ResourceClaim] };
    let outsideDenied = false; try { cleanupManifestForEntry(outsideEntry, root); } catch { outsideDenied = true; }
    assert(outsideDenied, 'runner-cleanable target outside approved runtime roots is denied');
    const symlinkTarget = join(ownedRoot, 'owned-link'); symlinkSync(sibling, symlinkTarget);
    const symlinkEntry = { ...entry('test:symlink-owned'), resources: [{ class: 'fixed-path', key: '.lattice/runtime/owned-link', access: 'exclusive', ownership: 'runner-cleanable', canonicalKey: `fixed-path:${symlinkTarget}` } as ResourceClaim] };
    let symlinkLaunches = 0; let symlinkDenied = false; try { await runEntry(symlinkEntry, root, process.execPath, () => { symlinkLaunches++; }); } catch { symlinkDenied = true; }
    assert(symlinkDenied && symlinkLaunches === 0 && lstatSync(symlinkTarget).isSymbolicLink(), 'pre-existing runner-cleanable symlink is rejected before spawn and retained'); rmSync(symlinkTarget);
    const symlinkAncestorTarget = join(root, 'owned-real-ancestor'); mkdirSync(symlinkAncestorTarget);
    const symlinkAncestor = join(ownedRoot, 'owned-alias-ancestor'); symlinkSync(symlinkAncestorTarget, symlinkAncestor, 'dir');
    let symlinkAncestorDenied = false;
    try { canonicalizeEntries([{ ...entry('test:symlink-ancestor'), resources: [{ class: 'fixed-path', key: '.lattice/runtime/owned-alias-ancestor/child', access: 'exclusive', ownership: 'runner-cleanable' }] }], root); } catch { symlinkAncestorDenied = true; }
    assert(symlinkAncestorDenied, 'runner-cleanable target with symlinked ancestor is denied'); rmSync(symlinkAncestor);
    const foreign = join(ownedRoot, 'foreign'); mkdirSync(foreign); writeFileSync(join(foreign, 'foreign-data'), 'do not delete\n');
    const foreignOutcome = cleanupOwnedTargets([{ path: foreign, existedBefore: false, type: 'absent', ownerMarker: null }], 'owned-token')[0]!;
    assert(foreignOutcome.outcome === 'residue' && existsSync(join(foreign, 'foreign-data')), 'nonempty foreign ownership is reported and never recursively deleted');
    const preexistingEmpty = join(ownedRoot, 'preexisting-empty'); mkdirSync(preexistingEmpty);
    const preexistingEntry = canonicalizeEntries([{ ...entry('test:preexisting-owned'), resources: [{ class: 'fixed-path', key: '.lattice/runtime/preexisting-empty', access: 'exclusive', ownership: 'runner-cleanable' }] }], root)[0]!;
    const observedPreexisting = cleanupManifestForEntry(preexistingEntry, root);
    let preexistingLaunches = 0; let preexistingDenied = false;
    try { await runEntry(preexistingEntry, root, process.execPath, () => { preexistingLaunches++; }); } catch (error) { preexistingDenied = (error as Error).message.includes('existedBefore'); }
    assert(observedPreexisting[0]?.existedBefore === true && observedPreexisting[0]?.type === 'directory' && observedPreexisting[0]?.ownerMarker === null, 'pre-spawn manifest records pre-existing target type and absent owner marker');
    assert(preexistingDenied && preexistingLaunches === 0 && existsSync(preexistingEmpty), 'pre-existing empty owned path fails before spawn and is never deleted');
    const preexistingFile = join(ownedRoot, 'preexisting-file'); writeFileSync(preexistingFile, 'foreign-file-token\n');
    const preexistingFileEntry = canonicalizeEntries([{ ...entry('test:preexisting-file'), resources: [{ class: 'fixed-path', key: '.lattice/runtime/preexisting-file', access: 'exclusive', ownership: 'runner-cleanable' }] }], root)[0]!;
    const observedFile = cleanupManifestForEntry(preexistingFileEntry, root)[0]!;
    let fileLaunches = 0; let fileDenied = false; try { await runEntry(preexistingFileEntry, root, process.execPath, () => { fileLaunches++; }); } catch { fileDenied = true; }
    assert(observedFile.existedBefore && observedFile.type === 'file' && observedFile.ownerMarker === 'foreign-file-token\n' && fileDenied && fileLaunches === 0 && existsSync(preexistingFile), 'pre-existing file and owner content are recorded, rejected before spawn, and retained');
    const missingMarker = join(ownedRoot, 'missing-marker'); mkdirSync(missingMarker);
    const missingMarkerOutcome = cleanupOwnedTargets([{ path: missingMarker, existedBefore: false, type: 'absent', ownerMarker: null }], 'owned-token')[0]!;
    assert(missingMarkerOutcome.outcome === 'residue' && existsSync(missingMarker), 'post-spawn empty directory without launch marker is retained and fails cleanup');
    const tamperedMarker = join(ownedRoot, 'tampered-marker'); mkdirSync(tamperedMarker); writeFileSync(join(tamperedMarker, 'owner'), 'foreign-token\n');
    const tamperedOutcome = cleanupOwnedTargets([{ path: tamperedMarker, existedBefore: false, type: 'absent', ownerMarker: null }], 'owned-token')[0]!;
    assert(tamperedOutcome.outcome === 'residue' && existsSync(tamperedMarker), 'post-spawn tampered ownership marker is retained and fails cleanup');
    const removedByMember = join(ownedRoot, 'member-removed-marker');
    writeFileSync(join(root, 'run'), `const fs=require('fs');const p=${JSON.stringify(removedByMember)};fs.mkdirSync(p);fs.writeFileSync(p+'/owner',process.env.LATTICE_FULL_SUITE_OWNERSHIP_TOKEN+'\\n');fs.unlinkSync(p+'/owner');process.exitCode=1;\n`);
    const removedMarkerEntry = canonicalizeEntries([{ ...entry('test:removed-marker'), resources: [{ class: 'fixed-path', key: '.lattice/runtime/member-removed-marker', access: 'exclusive', ownership: 'runner-cleanable' }] }], root)[0]!;
    const removedMarkerResult = await runEntry(removedMarkerEntry, root, process.execPath);
    assert(removedMarkerResult.status === 'FAIL' && removedMarkerResult.cleanupOutcomes?.[0]?.outcome === 'residue' && existsSync(removedByMember), 'member-removed ownership marker is retained and reported as terminal FAIL');
    const tamperedByMember = join(ownedRoot, 'member-tampered-marker');
    writeFileSync(join(root, 'run'), `const fs=require('fs');const p=${JSON.stringify(tamperedByMember)};fs.mkdirSync(p);fs.writeFileSync(p+'/owner','foreign-token\\n');process.exitCode=1;\n`);
    const tamperedMarkerEntry = canonicalizeEntries([{ ...entry('test:tampered-marker'), resources: [{ class: 'fixed-path', key: '.lattice/runtime/member-tampered-marker', access: 'exclusive', ownership: 'runner-cleanable' }] }], root)[0]!;
    const tamperedMarkerResult = await runEntry(tamperedMarkerEntry, root, process.execPath);
    assert(tamperedMarkerResult.status === 'FAIL' && tamperedMarkerResult.cleanupOutcomes?.[0]?.outcome === 'residue' && existsSync(tamperedByMember), 'member-tampered ownership marker is retained and reported as terminal FAIL');
  } finally { rmSync(root, { recursive: true, force: true }); }

  const interruptRoot = mkdtempSync(join(tmpdir(), 'full-suite-sigint-'));
  const interruptOutputRoot = mkdtempSync(join(tmpdir(), 'full-suite-sigint-output-'));
  try {
    const heartbeat = join(interruptRoot, 'heartbeat'); const resultPath = join(interruptOutputRoot, 'result.json');
    mkdirSync(join(interruptRoot, '.lattice', 'runtime'), { recursive: true });
    createFixtureBuildBinding(interruptRoot);
    writeFileSync(join(interruptRoot, 'hang.js'), `const fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);\n`);
    const fixtureScripts = Object.fromEntries(FULL_SUITE_ENTRIES.map((item) => [item.name, 'node hang.js']));
    fixtureScripts['test:serial-reference'] = FULL_SUITE_ENTRIES.map((item) => `npm run ${item.name}`).join(' && ');
    writeFileSync(join(interruptRoot, 'package.json'), JSON.stringify({ scripts: fixtureScripts }));
    execFileSync('git', ['init', '-b', 'main'], { cwd: interruptRoot, stdio: 'ignore' }); execFileSync('git', ['config', 'user.email', 'suite@example.test'], { cwd: interruptRoot }); execFileSync('git', ['config', 'user.name', 'Suite'], { cwd: interruptRoot }); execFileSync('git', ['add', '.'], { cwd: interruptRoot }); execFileSync('git', ['commit', '-m', 'fixture'], { cwd: interruptRoot, stdio: 'ignore' });
    const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'full-suite-runner.js');
    const child = spawn(process.execPath, [runnerPath, '--jobs', '1', '--json-output', resultPath], { cwd: interruptRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LATTICE_FULL_SUITE_OUTPUT_ROOT: interruptOutputRoot } });
    let output = ''; child.stdout?.on('data', (chunk) => { output += chunk; }); child.stderr?.on('data', (chunk) => { output += chunk; });
    for (let index = 0; index < 100 && !existsSync(heartbeat); index++) await new Promise((done) => setTimeout(done, 20));
    assertWithDetail(existsSync(heartbeat), 'fixture runner starts real descendant before SIGINT', `output=${output}`); child.kill('SIGINT');
    const exitCode = await new Promise<number | null>((done) => child.on('exit', done));
    assertWithDetail(exitCode === 130, 'top-level SIGINT exits 130', `actual=${exitCode}; output=${output}`);
    const receipt = JSON.parse(readFileSync(resultPath, 'utf8')) as { interruptedBy: string; processLaunchCount: number; results: FullSuiteResult[] };
    assert(receipt.interruptedBy === 'SIGINT' && receipt.results.every(({ status }) => status === 'INTERRUPTED'), 'SIGINT receipt marks started and pending members INTERRUPTED');
    assert(receipt.processLaunchCount === 1 && receipt.results.length === FULL_SUITE_ENTRIES.length, 'pending INTERRUPTED members do not inflate processLaunchCount');
    const before = readFileSync(heartbeat, 'utf8').length; await new Promise((done) => setTimeout(done, 100));
    assert(readFileSync(heartbeat, 'utf8').length === before, 'top-level SIGINT leaves no descendant heartbeat');
  } finally { rmSync(interruptRoot, { recursive: true, force: true }); rmSync(interruptOutputRoot, { recursive: true, force: true }); }

  const staleRoot = mkdtempSync(join(tmpdir(), 'full-suite-stale-binding-'));
  try {
    const npmCli = process.env.npm_execpath ?? execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
    createFixtureBuildBinding(staleRoot);
    const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'full-suite-runner.js');
    writeFileSync(join(staleRoot, 'package.json'), JSON.stringify({ scripts: { test: `node ${JSON.stringify(runnerPath)}` } }));
    writeFileSync(join(staleRoot, 'packages/main/src/input.ts'), 'export const fixture = false;\n');
    const launchMarker = join(staleRoot, 'npm-launched');
    const fakeBin = join(staleRoot, 'bin'); mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh\necho launched > ${JSON.stringify(launchMarker)}\nexit 99\n`); chmodSync(join(fakeBin, 'npm'), 0o755);
    const stale = spawnSync(process.execPath, [npmCli, 'test', '--', '--unknown'], {
      cwd: staleRoot, encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    });
    const staleOutput = `${stale.stdout}${stale.stderr}`;
    assert(stale.status !== 0 && /source\/dist build binding mismatch/.test(staleOutput) && !/unknown argument/.test(staleOutput) && !existsSync(launchMarker), 'stale source makes direct npm test fail before argument parsing with launches0');

    writeFileSync(join(staleRoot, 'packages/main/src/input.ts'), 'export const fixture = true;\n');
    execFileSync(process.execPath, ['--input-type=module', '-e', `import{writeBuildBinding}from${JSON.stringify(`file://${join(process.cwd(), 'scripts/full-suite-build-binding.mjs')}`)};writeBuildBinding(process.cwd())`], { cwd: staleRoot });
    writeFileSync(join(staleRoot, 'packages/main/dist/input.js'), 'export const fixture = false;\n');
    const tampered = spawnSync(process.execPath, [npmCli, 'test', '--', '--unknown'], {
      cwd: staleRoot, encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    });
    const tamperedOutput = `${tampered.stdout}${tampered.stderr}`;
    assert(tampered.status !== 0 && /source\/dist build binding mismatch/.test(tamperedOutput) && !/unknown argument/.test(tamperedOutput) && !existsSync(launchMarker), 'tampered dist makes direct npm test fail before argument parsing with launches0');
  } finally { rmSync(staleRoot, { recursive: true, force: true }); }

  const gitProbeRoot = mkdtempSync(join(tmpdir(), 'full-suite-git-probe-'));
  try {
    const slowBin = join(gitProbeRoot, 'slow'); const hungBin = join(gitProbeRoot, 'hung');
    mkdirSync(slowBin); mkdirSync(hungBin);
    writeFileSync(join(slowBin, 'git'), '#!/bin/sh\nsleep 2.2\nexec /usr/bin/git "$@"\n'); chmodSync(join(slowBin, 'git'), 0o755);
    writeFileSync(join(hungBin, 'git'), '#!/bin/sh\nsleep 30\n'); chmodSync(join(hungBin, 'git'), 0o755);
    const authorityInput = {
      command: 'agent_prompt', commandArgs: ['--role=implementation-reviewer'], projectRoot: process.cwd(),
      invokedEntrypoint: join(process.cwd(), 'bin/lattice.js'), loadedCorePackageRoot: join(process.cwd(), 'packages/main'),
    };
    const slowDecision = classifyRuntimeEntrypointAuthority({ ...authorityInput, env: { ...process.env, PATH: `${slowBin}:${process.env.PATH ?? ''}` } });
    assert(slowDecision.status === 'pass', 'authoritative git identity probes retry a transient two-second timeout');
    const hungStarted = performance.now();
    const hungDecision = classifyRuntimeEntrypointAuthority({ ...authorityInput, env: { ...process.env, PATH: `${hungBin}:${process.env.PATH ?? ''}` } });
    const hungElapsed = performance.now() - hungStarted;
    assert(hungDecision.status === 'blocked' && hungDecision.reasonCode === 'runtime_authority_probe_timeout_in_worktree', 'hung authoritative git identity probe reports a precise timeout');
    assert(hungElapsed >= 15_000 && hungElapsed < 19_000, 'hung authoritative git identity probe stops within its monotonic total budget');
  } finally { rmSync(gitProbeRoot, { recursive: true, force: true }); }

  const dynamicMarkerPatterns = [
    /(?:actual=|output=|\b(?:elapsed|duration)(?:Ms)?\s*[=:]\s*\d|\bPID\s*[=:]?\s*\d|\bB-[0-9a-f]{4}\b)/i,
    /(?:\/private)?\/(?:tmp|var\/folders)\//,
  ];
  const hasDynamicMarkerDetail = (message: string): boolean => dynamicMarkerPatterns.some(pattern => pattern.test(message));
  for (const example of ['actual=130', 'output=dynamic', '/tmp/random', '/private/var/folders/random', 'durationMs=12', 'PID 42', 'B-cd45']) {
    assert(hasDynamicMarkerDetail(example), 'dynamic assertion marker scan recognizes forbidden runtime detail');
  }
  const dynamicLabels = checks.filter(hasDynamicMarkerDetail);
  assertWithDetail(dynamicLabels.length === 0, 'emitted assertion markers contain only stable labels', dynamicLabels.join(' | '));
  process.stdout.write(`FULL_SUITE_SCHEDULER_RECEIPT=${JSON.stringify({
    distinctRootsOverlap: { observed: unrelatedOverlap, activeWitness: scheduledResults.map(result => result.name) },
    protectedPairs,
    fixedPortOsCollision,
    canonicalAliasesCollide: { observed: observations.aliasCollisions >= 2, collisionCount: observations.aliasCollisions },
    unknownAndUnclassifiedFailClosed: { observed: observations.failClosedThrows === 5, throwCount: observations.failClosedThrows },
    workerBoundariesProgress: { observed: observations.completedMembers > 0, completionCount: observations.completedMembers },
    mutationBites: observations.mutationBites,
    lifecycle: observations.lifecycle,
  })}\n`);
  process.stdout.write(`LATTICE_FULL_SUITE_SUMMARY=${JSON.stringify({ assertions: checks, mutations: ['inventory-omission', 'resource-key-collision', 'fixed-path-collision', 'timeout-grandchild', 'ordinary-failure', 'tracked-output-overwrite', 'identity-drift'] })}\n`);
  process.stdout.write(`full-suite-runner-smoke: PASS (${checks.length} assertions)\n`);
}

main().catch((error) => { process.stderr.write(`full-suite-runner-smoke: FAIL ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });

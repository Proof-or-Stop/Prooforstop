#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FULL_SUITE_ENTRIES, canonicalizeEntries, entriesFromSerialReference, interruptForTest,
  fullSuiteBudgetBreached, identityChanged, isUnderFullSuiteBudget, killProcessTree, parsePositiveInteger, parseRunnerArgs, shouldEnforceFullSuiteBudget,
  resetInterruptForTest, runEntry, runScheduled, validateInventory, writeResultArtifact,
  pathIsContained, validateJsonOutputPath,
  type FullSuiteEntry, type FullSuiteResult, type ResourceClaim,
} from './full-suite-runner.js';

const checks: string[] = [];
function assert(condition: unknown, message: string): void { if (!condition) throw new Error(message); checks.push(message); }
const pass = (name: string): FullSuiteResult => ({ name, status: 'PASS', durationMs: 1, output: '' });
const claim = (key: string, access: 'shared' | 'exclusive' = 'shared'): ResourceClaim => ({ class: 'fixed-path', key, access, canonicalKey: `fixed-path:${key}` });
const entry = (name: string, resources: ResourceClaim[] = [], priority = 0): FullSuiteEntry => ({ name, resources, priority, tempOwnership: 'runner-owned-unique' });

async function main(): Promise<void> {
  const collisionPath = join(process.cwd(), '.lattice', 'runtime', 'full-suite-fixed-sentinel');
  mkdirSync(collisionPath, { recursive: true });
  const sentinelPath = resolve(dirname(fileURLToPath(import.meta.url)), 'full-suite-resource-sentinel.js');
  let collisionFailed = false;
  try { execFileSync(process.execPath, [sentinelPath], { cwd: process.cwd(), stdio: 'ignore' }); } catch { collisionFailed = true; }
  assert(collisionFailed, 'preowned fixed path makes canonical resource sentinel fail terminally');
  rmSync(collisionPath, { recursive: true, force: true });
  const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert(rootPackage.scripts?.build === 'npm --prefix packages/main run build && npm --prefix packages/utils run build', 'standard root build prepares main and utils runtime');
  assert(rootPackage.scripts?.test === 'node packages/main/dist/tasks/full-suite-runner.js', 'root test has no ignored compatibility arguments');
  const canonicalClassCounts = new Map<string, number>();
  for (const item of FULL_SUITE_ENTRIES) for (const resource of item.resources) canonicalClassCounts.set(resource.class, (canonicalClassCounts.get(resource.class) ?? 0) + 1);
  for (const resourceClass of ['git-common-dir', 'fixed-path', 'fixed-port', 'runtime-lock', 'main-write-lock']) {
    assert((canonicalClassCounts.get(resourceClass) ?? 0) > 0, `canonical manifest exercises protected class ${resourceClass}`);
  }
  assert(FULL_SUITE_ENTRIES.some(item => item.resources.some(resource => resource.access === 'exclusive')), 'canonical manifest contains truthful exclusive protected claims');

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
      assert(normalized[0]!.resources[1]!.canonicalKey === normalized[1]!.resources[1]!.canonicalKey, 'Git aliases collide on canonical common-dir resource key');
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
  assert((scheduledResults.find((result) => result.name === 'writer')?.lockWaitMs ?? 0) >= 45, 'lockWaitMs includes deterministic compatibility queue wait');
  const capacityOnly = await runScheduled([entry('capacity-a'), entry('capacity-b')], 1, async (item) => { await new Promise(done => setTimeout(done, 20)); return pass(item.name); });
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
    const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'package.json'), '{}');
    let overwriteRejected = false;
    try { validateJsonOutputPath(project, join(project, 'package.json')); } catch { overwriteRejected = true; }
    assert(overwriteRejected && readFileSync(join(project, 'package.json'), 'utf8') === '{}', 'tracked project output overwrite is rejected before execution');
    const outsideOutput = join(root, 'outside', 'result.json'); mkdirSync(dirname(outsideOutput));
    assert(pathIsContained(realpathSync(join(root, 'outside')), dirname(validateJsonOutputPath(project, outsideOutput))), 'out-of-tree JSON output is accepted');
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
    const isolatedRoots = cpuResult.output.match(/TEMP_ROOTS=([^\n]+)/)?.[1]?.split('|') ?? [];
    assert(isolatedRoots.length === 4 && new Set(isolatedRoots).size === 1 && isolatedRoots[0] === cpuResult.tempRoot, `member consumes one unique temp ownership root through LATTICE/TMPDIR/TMP/TEMP (${isolatedRoots.join('|')} vs ${cpuResult.tempRoot})`);
    const heartbeat = join(root, 'heartbeat');
    writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},'x');spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`) }],{stdio:'ignore'});setInterval(()=>{},1000);\n`);
    let launches = 0;
    const timeout = await runEntry({ ...entry('test:hang'), timeoutMs: 300 }, root, process.execPath, () => { launches++; });
    assert(timeout.status === 'TIMEOUT' && launches === 1, 'actual process spawn increments launch accounting exactly once');
    assert(Boolean(timeout.tempRoot) && !existsSync(timeout.tempRoot!), 'normal timeout removes only the runner-owned unique temp root');
    assert(existsSync(root), 'runner cleanup cannot target the caller repository root');
    await new Promise((done) => setTimeout(done, 80)); const before = readFileSync(heartbeat, 'utf8').length;
    await new Promise((done) => setTimeout(done, 100));
    assert(before === readFileSync(heartbeat, 'utf8').length, 'timeout kills complete descendant process group');
    const interruptedPromise = runEntry({ ...entry('test:hang'), timeoutMs: 10_000 }, root, process.execPath);
    await new Promise((done) => setTimeout(done, 100)); interruptForTest('SIGTERM');
    const interrupted = await interruptedPromise;
    assert(interrupted.status === 'INTERRUPTED' && interrupted.reason?.includes('SIGTERM'), 'external interruption reports INTERRUPTED');
    resetInterruptForTest();
  } finally { rmSync(root, { recursive: true, force: true }); }

  const interruptRoot = mkdtempSync(join(tmpdir(), 'full-suite-sigint-'));
  try {
    const heartbeat = join(interruptRoot, 'heartbeat'); const resultPath = join(interruptRoot, 'result.json');
    mkdirSync(join(interruptRoot, '.lattice', 'runtime'), { recursive: true });
    writeFileSync(join(interruptRoot, 'hang.js'), `const fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);\n`);
    const fixtureScripts = Object.fromEntries(FULL_SUITE_ENTRIES.map((item) => [item.name, 'node hang.js']));
    fixtureScripts['test:serial-reference'] = FULL_SUITE_ENTRIES.map((item) => `npm run ${item.name}`).join(' && ');
    writeFileSync(join(interruptRoot, 'package.json'), JSON.stringify({ scripts: fixtureScripts }));
    execFileSync('git', ['init', '-b', 'main'], { cwd: interruptRoot, stdio: 'ignore' }); execFileSync('git', ['config', 'user.email', 'suite@example.test'], { cwd: interruptRoot }); execFileSync('git', ['config', 'user.name', 'Suite'], { cwd: interruptRoot }); execFileSync('git', ['add', '.'], { cwd: interruptRoot }); execFileSync('git', ['commit', '-m', 'fixture'], { cwd: interruptRoot, stdio: 'ignore' });
    const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'full-suite-runner.js');
    const child = spawn(process.execPath, [runnerPath, '--jobs', '1', '--json-output', resultPath], { cwd: interruptRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LATTICE_FULL_SUITE_OUTPUT_ROOT: interruptRoot } });
    let output = ''; child.stdout?.on('data', (chunk) => { output += chunk; }); child.stderr?.on('data', (chunk) => { output += chunk; });
    for (let index = 0; index < 100 && !existsSync(heartbeat); index++) await new Promise((done) => setTimeout(done, 20));
    assert(existsSync(heartbeat), `fixture runner starts real descendant before SIGINT (output=${output})`); child.kill('SIGINT');
    const exitCode = await new Promise<number | null>((done) => child.on('exit', done));
    assert(exitCode === 130, `top-level SIGINT exits 130 (actual=${exitCode}; output=${output})`);
    const receipt = JSON.parse(readFileSync(resultPath, 'utf8')) as { interruptedBy: string; processLaunchCount: number; results: FullSuiteResult[] };
    assert(receipt.interruptedBy === 'SIGINT' && receipt.results.every(({ status }) => status === 'INTERRUPTED'), 'SIGINT receipt marks started and pending members INTERRUPTED');
    assert(receipt.processLaunchCount === 1 && receipt.results.length === FULL_SUITE_ENTRIES.length, 'pending INTERRUPTED members do not inflate processLaunchCount');
    const before = readFileSync(heartbeat, 'utf8').length; await new Promise((done) => setTimeout(done, 100));
    assert(readFileSync(heartbeat, 'utf8').length === before, 'top-level SIGINT leaves no descendant heartbeat');
  } finally { rmSync(interruptRoot, { recursive: true, force: true }); }

  process.stdout.write(`LATTICE_FULL_SUITE_SUMMARY=${JSON.stringify({ assertions: checks, mutations: ['inventory-omission', 'resource-key-collision', 'fixed-path-collision', 'timeout-grandchild', 'ordinary-failure', 'tracked-output-overwrite', 'identity-drift'] })}\n`);
  process.stdout.write(`full-suite-runner-smoke: PASS (${checks.length} assertions)\n`);
}

main().catch((error) => { process.stderr.write(`full-suite-runner-smoke: FAIL ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });

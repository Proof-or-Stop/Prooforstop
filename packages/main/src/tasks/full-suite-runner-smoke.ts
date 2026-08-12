#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FULL_SUITE_ENTRIES, interruptForTest, resetInterruptForTest, runEntry, runScheduled, validateInventory, writeResultArtifact, type FullSuiteEntry, type FullSuiteResult } from './full-suite-runner.js';

const checks: string[] = [];
function assert(condition: unknown, message: string): void { if (!condition) throw new Error(message); checks.push(message); }
const pass = (name: string): FullSuiteResult => ({ name, status: 'PASS', durationMs: 1, output: '' });

async function main(): Promise<void> {
  const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert(
    rootPackage.scripts?.build === 'npm --prefix packages/main run build && npm --prefix packages/utils run build',
    'standard root build prepares the main dependency before the complete utils runtime',
  );
  const scripts = { 'test:a': 'x', 'test:b': 'x' };
  validateInventory([{ name: 'test:a', resource: 'isolated' }, { name: 'test:b', resource: 'repo-read' }], 'npm run test:a && npm run test:b', scripts);
  for (const [label, entries, reference] of [
    ['duplicate', [{ name: 'test:a', resource: 'isolated' }, { name: 'test:a', resource: 'isolated' }], 'npm run test:a'],
    ['omitted', [{ name: 'test:a', resource: 'isolated' }], 'npm run test:a && npm run test:b'],
    ['unknown resource', [{ name: 'test:a', resource: 'mystery' }], 'npm run test:a'],
  ] as Array<[string, FullSuiteEntry[], string]>) {
    let rejected = false; try { validateInventory(entries, reference, scripts); } catch { rejected = true; }
    assert(rejected, `${label} inventory fails closed`);
  }

  const active: string[] = []; let readOverlap = false; let writeOverlap = false;
  const entries: FullSuiteEntry[] = [
    { name: 'read-a', resource: 'repo-read' }, { name: 'read-b', resource: 'repo-read' },
    { name: 'write', resource: 'repo-write' }, { name: 'isolated', resource: 'isolated' },
  ];
  await runScheduled(entries, 4, async (entry) => {
    if (entry.resource === 'repo-read' && active.some((x) => x.startsWith('read'))) readOverlap = true;
    if (entry.resource === 'repo-write' && active.length) writeOverlap = true;
    if (active.includes('write')) writeOverlap = true;
    active.push(entry.name); await new Promise((resolve) => setTimeout(resolve, 30)); active.splice(active.indexOf(entry.name), 1);
    return pass(entry.name);
  });
  assert(readOverlap, 'compatible repo readers execute concurrently');
  assert(!writeOverlap, 'repo writer executes under exclusive lock');
  active.length = 0; writeOverlap = false;
  await runScheduled([
    { name: 'write-first', resource: 'repo-write' }, { name: 'isolated-after', resource: 'isolated' },
  ], 2, async (entry) => {
    if (active.length) writeOverlap = true;
    active.push(entry.name); await new Promise((resolve) => setTimeout(resolve, 20)); active.pop(); return pass(entry.name);
  });
  assert(!writeOverlap, 'isolated work cannot enter while repo writer holds the lock');

  const launchOrder: string[] = [];
  const reportOrder = await runScheduled([
    { name: 'short-first-in-inventory', resource: 'isolated', priority: 1 },
    { name: 'long-priority', resource: 'isolated', priority: 100 },
  ], 1, async (entry) => { launchOrder.push(entry.name); return pass(entry.name); });
  assert(launchOrder[0] === 'long-priority', 'estimated priority launches the longest member first');
  assert(reportOrder.map((result) => result.name).join(',') === 'short-first-in-inventory,long-priority', 'priority preserves complete canonical report order');
  const oversizedJobs = await runScheduled([{ name: 'only', resource: 'isolated' }], 99, async entry => pass(entry.name));
  assert(oversizedJobs.length === 1, 'jobs greater than member count executes each member once');
  const empty = await runScheduled([], 4, async entry => pass(entry.name));
  assert(empty.length === 0, 'empty selection completes without deadlock');

  const terminal = await runScheduled([
    { name: 'first-fail', resource: 'isolated' }, { name: 'pass', resource: 'isolated' },
  ], 2, async (entry) => entry.name === 'first-fail' ? { ...pass(entry.name), status: 'FAIL' } : pass(entry.name));
  assert(terminal.filter((result) => result.name === 'first-fail').length === 1 && terminal.some((result) => result.status === 'FAIL'), 'failure is terminal and never retried');

  const root = mkdtempSync(join(tmpdir(), 'full-suite-runner-smoke-'));
  try {
    const artifact = join(root, 'result.json');
    writeResultArtifact(artifact, { complete: true });
    assert(JSON.parse(readFileSync(artifact, 'utf8')).complete === true, 'completion artifact atomically replaces its final path');
    const heartbeat = join(root, 'heartbeat');
    writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},'x');spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`) }],{stdio:'ignore'});setInterval(()=>{},1000);\n`);
    const timeout = await runEntry({ name: 'test:hang', resource: 'isolated', timeoutMs: 300 }, root, process.execPath);
    assert(timeout.status === 'TIMEOUT', 'timeout remains terminal');
    await new Promise((resolve) => setTimeout(resolve, 80)); const before = readFileSync(heartbeat, 'utf8').length;
    await new Promise((resolve) => setTimeout(resolve, 100)); const after = readFileSync(heartbeat, 'utf8').length;
    assert(before === after, 'timeout kills the complete descendant process group');
    const interruptedPromise = runEntry({ name: 'test:hang', resource: 'isolated', timeoutMs: 10_000 }, root, process.execPath);
    await new Promise((resolve) => setTimeout(resolve, 100));
    interruptForTest('SIGTERM');
    const interrupted = await interruptedPromise;
    assert(interrupted.status === 'INTERRUPTED' && interrupted.reason?.includes('SIGTERM'), 'external interruption kills active process groups and reports INTERRUPTED');
    resetInterruptForTest();
  } finally { rmSync(root, { recursive: true, force: true }); }

  const interruptRoot = mkdtempSync(join(tmpdir(), 'full-suite-sigint-'));
  try {
    const heartbeat = join(interruptRoot, 'heartbeat');
    const resultPath = join(interruptRoot, 'result.json');
    writeFileSync(join(interruptRoot, 'hang.js'), `const fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);\n`);
    const scripts = Object.fromEntries(FULL_SUITE_ENTRIES.map(entry => [entry.name, 'node hang.js']));
    scripts['test:serial-reference'] = FULL_SUITE_ENTRIES.map(entry => `npm run ${entry.name}`).join(' && ');
    writeFileSync(join(interruptRoot, 'package.json'), JSON.stringify({ scripts }));
    execFileSync('git', ['init', '-b', 'main'], { cwd: interruptRoot });
    execFileSync('git', ['config', 'user.email', 'full-suite@example.test'], { cwd: interruptRoot });
    execFileSync('git', ['config', 'user.name', 'Full Suite Smoke'], { cwd: interruptRoot });
    execFileSync('git', ['add', '.'], { cwd: interruptRoot });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: interruptRoot });
    const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'full-suite-runner.js');
    const child = spawn(process.execPath, [runnerPath, '--jobs', '1', '--json-output', resultPath], { cwd: interruptRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let runnerOutput = ''; child.stdout?.on('data', chunk => { runnerOutput += chunk; }); child.stderr?.on('data', chunk => { runnerOutput += chunk; });
    for (let i = 0; i < 100 && !existsSync(heartbeat); i++) await new Promise(resolveWait => setTimeout(resolveWait, 20));
    assert(existsSync(heartbeat), 'fixture runner starts a real descendant before SIGINT');
    child.kill('SIGINT');
    const exitCode = await new Promise<number | null>(resolveExit => child.on('exit', resolveExit));
    assert(exitCode === 130, `top-level SIGINT exits 130 after owned process-tree cleanup (actual=${exitCode}; output=${runnerOutput})`);
    const interruptArtifact = JSON.parse(readFileSync(resultPath, 'utf8')) as { interruptedBy: string; results: FullSuiteResult[] };
    assert(interruptArtifact.interruptedBy === 'SIGINT' && interruptArtifact.results.every(result => result.status === 'INTERRUPTED'), 'SIGINT artifact truthfully marks started and pending members INTERRUPTED');
    const before = readFileSync(heartbeat, 'utf8').length; await new Promise(resolveWait => setTimeout(resolveWait, 100));
    assert(readFileSync(heartbeat, 'utf8').length === before, 'top-level SIGINT leaves no descendant heartbeat');
  } finally { rmSync(interruptRoot, { recursive: true, force: true }); }

  process.stdout.write(`full-suite-runner-smoke: PASS (${checks.length} assertions)\n`);
}

main().catch((error) => { process.stderr.write(`full-suite-runner-smoke: FAIL ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });

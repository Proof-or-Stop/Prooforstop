#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runEntry, runScheduled, validateInventory, type FullSuiteEntry, type FullSuiteResult } from './full-suite-runner.js';

const checks: string[] = [];
function assert(condition: unknown, message: string): void { if (!condition) throw new Error(message); checks.push(message); }
const pass = (name: string): FullSuiteResult => ({ name, status: 'PASS', durationMs: 1, output: '' });

async function main(): Promise<void> {
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

  const terminal = await runScheduled([
    { name: 'first-fail', resource: 'isolated' }, { name: 'pass', resource: 'isolated' },
  ], 2, async (entry) => entry.name === 'first-fail' ? { ...pass(entry.name), status: 'FAIL' } : pass(entry.name));
  assert(terminal.filter((result) => result.name === 'first-fail').length === 1 && terminal.some((result) => result.status === 'FAIL'), 'failure is terminal and never retried');

  const root = mkdtempSync(join(tmpdir(), 'full-suite-runner-smoke-'));
  try {
    const heartbeat = join(root, 'heartbeat');
    writeFileSync(join(root, 'run'), `const{spawn}=require('child_process'),fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},'x');spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`) }],{stdio:'ignore'});setInterval(()=>{},1000);\n`);
    const timeout = await runEntry({ name: 'test:hang', resource: 'isolated', timeoutMs: 300 }, root, process.execPath);
    assert(timeout.status === 'TIMEOUT', 'timeout remains terminal');
    await new Promise((resolve) => setTimeout(resolve, 80)); const before = readFileSync(heartbeat, 'utf8').length;
    await new Promise((resolve) => setTimeout(resolve, 100)); const after = readFileSync(heartbeat, 'utf8').length;
    assert(before === after, 'timeout kills the complete descendant process group');
  } finally { rmSync(root, { recursive: true, force: true }); }

  process.stdout.write(`full-suite-runner-smoke: PASS (${checks.length} assertions)\n`);
}

main().catch((error) => { process.stderr.write(`full-suite-runner-smoke: FAIL ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });

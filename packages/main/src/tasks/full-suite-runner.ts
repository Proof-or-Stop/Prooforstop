#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ResourceMode = 'isolated' | 'repo-read' | 'repo-write';
export interface FullSuiteEntry { name: string; resource: ResourceMode; timeoutMs?: number; priority?: number }
export interface FullSuiteResult { name: string; status: 'PASS' | 'FAIL' | 'TIMEOUT'; durationMs: number; output: string; reason?: string }

// This is the canonical inventory.  The serial-reference npm script is a second,
// independently parsed representation so an omitted or duplicated member fails
// before any test starts.
export const FULL_SUITE_ENTRIES: FullSuiteEntry[] = [
  { name: 'test:full-suite-runner-smoke', resource: 'isolated' },
  { name: 'test:main-write-lock-coverage', resource: 'repo-read' },
  { name: 'test:production-test-seam-guard', resource: 'repo-read' },
  { name: 'test:lattice-residue', resource: 'repo-read' },
  { name: 'test:proof-or-stop-prompt-baseline', resource: 'repo-read' },
  { name: 'test:review-convergence-smoke', resource: 'isolated' },
  { name: 'test:review-loop-smoke', resource: 'isolated' },
  { name: 'test:delivery-context-pack-smoke', resource: 'isolated' },
  { name: 'test:flow-stability-smoke', resource: 'isolated' },
  { name: 'test:review-assurance-floor-smoke', resource: 'isolated' },
  { name: 'test:proofstory-intent-hardening-smoke', resource: 'isolated', timeoutMs: 300_000, priority: 900 },
  { name: 'test:scope-shrinkage-withdrawal-floor-smoke', resource: 'isolated' },
  { name: 'test:withdrawn-disposition-smoke', resource: 'isolated' },
  { name: 'test:milestone-status', resource: 'isolated', priority: 700 },
  { name: 'test:global-core-realpath', resource: 'repo-read' },
  { name: 'test:review-incremental-context-smoke', resource: 'isolated', timeoutMs: 180_000, priority: 800 },
  { name: 'test:review-assurance-floor-storyfileshash-smoke', resource: 'isolated' },
  { name: 'test:docs-drift-smoke', resource: 'isolated' },
  { name: 'test:docs-drift-wrapper-root', resource: 'isolated' },
  { name: 'test:gitroot-cwd-contract', resource: 'isolated' },
  { name: 'test:process-fact-contract', resource: 'repo-read' },
  { name: 'test:closeout-trust', resource: 'isolated' },
  { name: 'test:runtime-fact-contract', resource: 'repo-read' },
  { name: 'test:evidence-quality', resource: 'repo-read' },
  { name: 'test:anti-stall', resource: 'repo-read' },
  { name: 'test:storydir-inside-gitroot-smoke', resource: 'isolated' },
  { name: 'test:gitroot-cwd-routing', resource: 'isolated' },
  { name: 'test:bare-gate-gitroot-cwd', resource: 'isolated' },
  { name: 'test:project-gitroot-cwd', resource: 'isolated' },
  { name: 'test:done-oracle-wrapper-root', resource: 'isolated' },
  { name: 'test:done-premerge-mainsha-recheck', resource: 'isolated' },
  { name: 'test:done-escalation-drift-advisory', resource: 'isolated' },
  { name: 'test:review-escalation-freshness-root', resource: 'isolated' },
  { name: 'test:dispatch-checklist-doctor-wrapper-root', resource: 'isolated' },
  { name: 'test:graceful-sites-gitroot-cwd', resource: 'isolated' },
  { name: 'test:experience-hint-worktree-cache', resource: 'isolated' },
  { name: 'test:done-merge-experience-refresh', resource: 'isolated' },
  { name: 'test:experience-coverage-gap', resource: 'isolated' },
  { name: 'test:nested-worktree-bootstrap', resource: 'isolated' },
  { name: 'test:e2e', resource: 'isolated', timeoutMs: 180_000 },
  { name: 'test:experience-arm-gate', resource: 'isolated' },
  { name: 'test:experience-arm-isolation-e2e', resource: 'isolated' },
  { name: 'test:brief-output', resource: 'isolated', priority: 600 },
  { name: 'test:experiments', resource: 'isolated', priority: 500 },
  { name: 'test:convergence-breaker', resource: 'isolated' },
  { name: 'test:proofstory-acceptance-rollout', resource: 'isolated', timeoutMs: 300_000, priority: 1000 },
];

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export function parseSerialReference(text: string): string[] {
  return text.split(/\s*&&\s*/).map((part) => {
    const match = /^npm run ([\w:-]+)$/.exec(part.trim());
    if (!match) throw new Error(`unsupported canonical serial-reference member: ${part}`);
    return match[1]!;
  });
}

export function validateInventory(entries: FullSuiteEntry[], serialReference: string, scripts: Record<string, string>): void {
  const names = entries.map((entry) => entry.name);
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  if (duplicates.length) throw new Error(`duplicate canonical members: ${[...new Set(duplicates)].join(', ')}`);
  for (const entry of entries) {
    if (!['isolated', 'repo-read', 'repo-write'].includes(entry.resource)) throw new Error(`unknown resource mode for ${entry.name}`);
    if (!scripts[entry.name]) throw new Error(`canonical member has no npm script: ${entry.name}`);
  }
  const reference = parseSerialReference(serialReference);
  const missing = reference.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !reference.includes(name));
  if (missing.length || extra.length || reference.length !== new Set(reference).size) {
    throw new Error(`canonical inventory mismatch missing=[${missing}] extra=[${extra}] referenceCount=${reference.length} uniqueReferenceCount=${new Set(reference).size}`);
  }
}

export function writeResultArtifact(path: string, value: unknown): void {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, target);
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

export async function runEntry(entry: FullSuiteEntry, cwd: string, npmCommand = 'npm'): Promise<FullSuiteResult> {
  const started = Date.now();
  return await new Promise((finish) => {
    const child = spawn(npmCommand, ['run', entry.name], { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: unknown) => { output = (output + String(chunk)).slice(-MAX_OUTPUT_BYTES); };
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    let settled = false;
    const done = (result: FullSuiteResult) => { if (settled) return; settled = true; clearTimeout(timer); finish(result); };
    const timer = setTimeout(() => {
      killTree(child);
      done({ name: entry.name, status: 'TIMEOUT', durationMs: Date.now() - started, output, reason: `exceeded ${entry.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` });
    }, entry.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on('error', (error) => done({ name: entry.name, status: 'FAIL', durationMs: Date.now() - started, output, reason: error.message }));
    child.on('exit', (code, signal) => done({ name: entry.name, status: code === 0 ? 'PASS' : 'FAIL', durationMs: Date.now() - started, output, reason: code === 0 ? undefined : signal ? `signal ${signal}` : `exit code ${code}` }));
  });
}

export async function runScheduled(entries: FullSuiteEntry[], jobs: number, execute: (entry: FullSuiteEntry) => Promise<FullSuiteResult>): Promise<FullSuiteResult[]> {
  const pending = entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0) || a.index - b.index)
    .map(({ entry }) => entry);
  const running = new Set<Promise<void>>();
  const results: FullSuiteResult[] = [];
  let readers = 0; let writer = false;
  const compatible = (entry: FullSuiteEntry) => entry.resource === 'isolated'
    ? !writer
    : entry.resource === 'repo-read'
      ? !writer
      : !writer && readers === 0 && running.size === 0;
  const launch = (entry: FullSuiteEntry) => {
    if (entry.resource === 'repo-read') readers++;
    if (entry.resource === 'repo-write') writer = true;
    let task!: Promise<void>;
    task = execute(entry).then((result) => { results.push(result); }).finally(() => {
      if (entry.resource === 'repo-read') readers--;
      if (entry.resource === 'repo-write') writer = false;
      running.delete(task);
    });
    running.add(task);
  };
  while (pending.length || running.size) {
    let launched = false;
    while (running.size < jobs) {
      const index = pending.findIndex(compatible);
      if (index < 0) break;
      launch(pending.splice(index, 1)[0]!); launched = true;
    }
    if (running.size) await Promise.race(running);
    else if (!launched && pending.length) throw new Error(`resource scheduler deadlock at ${pending[0]!.name}`);
  }
  const byName = new Map(results.map((result) => [result.name, result]));
  return entries.map((entry) => byName.get(entry.name)!).filter(Boolean);
}

async function main(): Promise<void> {
  const cwd = resolve(process.cwd());
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const serialReference = [pkg.scripts['test:serial-reference-prefix'], pkg.scripts['test:serial-reference']].filter(Boolean).join(' && ');
  validateInventory(FULL_SUITE_ENTRIES, serialReference, pkg.scripts);
  const jobsArg = process.argv.indexOf('--jobs');
  const jobs = jobsArg >= 0 ? Math.max(1, Number(process.argv[jobsArg + 1]) || 1) : Math.min(8, Math.max(2, cpus().length));
  const jsonArg = process.argv.indexOf('--json-output');
  const jsonOutput = jsonArg >= 0 ? process.argv[jsonArg + 1] : undefined;
  const started = Date.now();
  const results = await runScheduled(FULL_SUITE_ENTRIES, jobs, async (entry) => {
    const result = await runEntry(entry, cwd);
    process.stdout.write(`${result.status} ${result.name} ${(result.durationMs / 1000).toFixed(1)}s${result.reason ? ` (${result.reason})` : ''}\n`);
    return result;
  });
  const failures = results.filter((result) => result.status !== 'PASS');
  for (const failure of failures) process.stderr.write(`\n--- ${failure.name} ${failure.status} ---\n${failure.output}\n`);
  const durationMs = Date.now() - started;
  process.stdout.write(`full-suite: ${results.length - failures.length}/${results.length} passed in ${(durationMs / 1000).toFixed(1)}s; retries=0; jobs=${jobs}\n`);
  if (jsonOutput) writeResultArtifact(jsonOutput, { schemaVersion: 'lattice.full_suite_result.v1', startedAt: new Date(started).toISOString(), durationMs, jobs, retries: 0, passed: results.length - failures.length, total: results.length, results });
  if (failures.length) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main().catch((error) => { process.stderr.write(`full-suite: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });

#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { currentMaterialHash } from '../core/evidence-freshness.js';

export type ResourceClass = 'git-common-dir' | 'fixed-path' | 'fixed-port' | 'runtime-lock' | 'main-write-lock';
export type ResourceAccess = 'shared' | 'exclusive';
export interface ResourceClaim { class: ResourceClass; key: string; access: ResourceAccess; canonicalKey?: string }
export interface FullSuiteEntry { name: string; resources: ResourceClaim[]; timeoutMs?: number; priority?: number; tempOwnership?: 'runner-owned-unique' }
export interface FullSuiteResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'INTERRUPTED';
  durationMs: number;
  output: string;
  reason?: string;
  declaredResources?: ResourceClaim[];
  acquiredResources?: string[];
  lockWaitMs?: number;
  tempRoot?: string;
}
export interface RunScheduledOptions { onSpawn?: () => void }

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_JOBS = 64;
const RESOURCE_CLASSES: ResourceClass[] = ['git-common-dir', 'fixed-path', 'fixed-port', 'runtime-lock', 'main-write-lock'];
const activeChildren = new Set<ReturnType<typeof spawn>>();
let interruptSignal: NodeJS.Signals | undefined;
let interruptError: Error | undefined;

const isolated = (name: string, options: Omit<FullSuiteEntry, 'name' | 'resources' | 'tempOwnership'> = {}): FullSuiteEntry =>
  ({ name, resources: [], tempOwnership: 'runner-owned-unique', ...options });
const repoRead = (name: string, options: Omit<FullSuiteEntry, 'name' | 'resources' | 'tempOwnership'> = {}, extra: ResourceClaim[] = []): FullSuiteEntry =>
  ({ name, resources: [{ class: 'git-common-dir', key: '.', access: 'shared' }, ...extra], tempOwnership: 'runner-owned-unique', ...options });

// Resource policy is intentionally separate from membership authority. Membership
// comes only from test:serial-reference; a later reference member without a policy
// fails closed before execution.
const RESOURCE_POLICY: Record<string, FullSuiteEntry> = Object.fromEntries([
  isolated('test:full-suite-runner-smoke'),
  repoRead('test:main-write-lock-coverage', {}, [{ class: 'main-write-lock', key: '.lattice/runtime/main-write.lock', access: 'shared' }]),
  repoRead('test:production-test-seam-guard', {}, [{ class: 'fixed-path', key: 'package.json', access: 'shared' }]),
  repoRead('test:lattice-residue'), repoRead('test:proof-or-stop-prompt-baseline'),
  isolated('test:review-convergence-smoke'), isolated('test:review-loop-smoke'), isolated('test:delivery-context-pack-smoke'),
  isolated('test:flow-stability-smoke'), isolated('test:review-assurance-floor-smoke'),
  isolated('test:proofstory-intent-hardening-smoke', { timeoutMs: 300_000, priority: 900 }),
  isolated('test:scope-shrinkage-withdrawal-floor-smoke'), isolated('test:withdrawn-disposition-smoke'),
  isolated('test:milestone-status', { priority: 700 }), repoRead('test:global-core-realpath'),
  isolated('test:review-incremental-context-smoke', { timeoutMs: 180_000, priority: 800 }),
  isolated('test:review-assurance-floor-storyfileshash-smoke'), isolated('test:docs-drift-smoke'),
  isolated('test:docs-drift-wrapper-root'), isolated('test:gitroot-cwd-contract'), repoRead('test:process-fact-contract'),
  isolated('test:closeout-trust'),
  repoRead('test:runtime-fact-contract', {}, [{ class: 'runtime-lock', key: '.lattice/runtime', access: 'shared' }]),
  repoRead('test:evidence-quality'), repoRead('test:anti-stall'), isolated('test:storydir-inside-gitroot-smoke'),
  isolated('test:gitroot-cwd-routing'), isolated('test:bare-gate-gitroot-cwd'), isolated('test:project-gitroot-cwd'),
  isolated('test:done-oracle-wrapper-root'), isolated('test:done-premerge-mainsha-recheck'),
  isolated('test:done-escalation-drift-advisory'), isolated('test:review-escalation-freshness-root'),
  isolated('test:dispatch-checklist-doctor-wrapper-root'), isolated('test:graceful-sites-gitroot-cwd'),
  isolated('test:experience-hint-worktree-cache'), isolated('test:done-merge-experience-refresh'),
  isolated('test:experience-coverage-gap'), isolated('test:nested-worktree-bootstrap'),
  isolated('test:e2e', { timeoutMs: 180_000 }), isolated('test:experience-arm-gate'),
  isolated('test:experience-arm-isolation-e2e'), isolated('test:brief-output', { priority: 600 }),
  isolated('test:experiments', { priority: 500 }), isolated('test:convergence-breaker'),
  isolated('test:proofstory-acceptance-rollout', { timeoutMs: 300_000, priority: 1000 }),
].map((entry) => [entry.name, entry]));

export let FULL_SUITE_ENTRIES: FullSuiteEntry[] = Object.values(RESOURCE_POLICY);

export function parseSerialReference(text: string): string[] {
  if (!text.trim()) return [];
  return text.split(/\s*&&\s*/).map((part) => {
    const match = /^npm run ([\w:-]+)$/.exec(part.trim());
    if (!match) throw new Error(`unsupported canonical serial-reference member: ${part}`);
    return match[1]!;
  });
}

export function entriesFromSerialReference(serialReference: string, scripts: Record<string, string>, policy: Record<string, FullSuiteEntry> = RESOURCE_POLICY): FullSuiteEntry[] {
  const names = parseSerialReference(serialReference);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`duplicate canonical members: ${[...new Set(duplicates)].join(', ')}`);
  const unknown = names.filter((name) => !policy[name]);
  const stale = Object.keys(policy).filter((name) => !names.includes(name));
  const missingScripts = names.filter((name) => !scripts[name]);
  if (unknown.length || stale.length || missingScripts.length) {
    throw new Error(`canonical inventory mismatch unknownPolicy=[${unknown}] stalePolicy=[${stale}] missingScripts=[${missingScripts}]`);
  }
  return names.map((name) => policy[name]!);
}

export function validateInventory(entries: FullSuiteEntry[], serialReference: string, scripts: Record<string, string>): void {
  const reference = parseSerialReference(serialReference);
  const names = entries.map((entry) => entry.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`duplicate canonical members: ${[...new Set(duplicates)].join(', ')}`);
  for (const entry of entries) {
    if (!scripts[entry.name]) throw new Error(`canonical member has no npm script: ${entry.name}`);
    validateResourceClaims(entry.resources, entry.name);
  }
  const missing = reference.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !reference.includes(name));
  if (missing.length || extra.length || reference.length !== new Set(reference).size) {
    throw new Error(`canonical inventory mismatch missing=[${missing}] extra=[${extra}]`);
  }
}

function validateResourceClaims(claims: ResourceClaim[], owner: string): void {
  for (const claim of claims) {
    if (!RESOURCE_CLASSES.includes(claim.class)) throw new Error(`unknown resource class for ${owner}: ${claim.class}`);
    if (!['shared', 'exclusive'].includes(claim.access)) throw new Error(`unknown resource access for ${owner}: ${claim.access}`);
    if (!claim.key.trim()) throw new Error(`empty resource key for ${owner}`);
  }
}

function canonicalFilesystemPath(cwd: string, key: string, allowOutsideOwnershipRoot = false): string {
  const absolute = resolve(cwd, key);
  let canonical: string;
  if (existsSync(absolute)) canonical = realpathSync(absolute);
  else {
  let ancestor = dirname(absolute);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`resource path has no resolvable ancestor: ${key}`);
    ancestor = parent;
  }
    canonical = join(realpathSync(ancestor), relative(ancestor, absolute));
  }
  const ownershipRoot = realpathSync(cwd);
  if (!allowOutsideOwnershipRoot && canonical !== ownershipRoot && !canonical.startsWith(`${ownershipRoot}/`)) {
    throw new Error(`resource path escapes ownership root: ${key}`);
  }
  return canonical;
}

export function canonicalizeEntries(entries: FullSuiteEntry[], cwd: string): FullSuiteEntry[] {
  return entries.map((entry) => {
    validateResourceClaims(entry.resources, entry.name);
    const resources = entry.resources.map((claim) => {
      let value: string;
      if (claim.class === 'fixed-port') {
        const port = parsePositiveInteger(claim.key, `${entry.name} fixed port`, 65_535);
        value = String(port);
      } else if (claim.class === 'git-common-dir') {
        const repository = canonicalFilesystemPath(cwd, claim.key);
        const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repository, encoding: 'utf8' }).trim();
        value = canonicalFilesystemPath(repository, common, true);
      } else value = canonicalFilesystemPath(cwd, claim.key);
      return { ...claim, canonicalKey: `${claim.class}:${value}` };
    });
    return { ...entry, resources };
  });
}

export function parsePositiveInteger(value: string | undefined, label: string, maximum = MAX_JOBS): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a finite positive integer <= ${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new Error(`${label} must be a finite positive integer <= ${maximum}`);
  return parsed;
}

export function parseRunnerArgs(argv: string[]): { jobs?: number; jsonOutput?: string } {
  const parsed: { jobs?: number; jsonOutput?: string } = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--jobs') parsed.jobs = parsePositiveInteger(argv[++index], '--jobs');
    else if (arg === '--json-output') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--json-output requires a path');
      parsed.jsonOutput = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

export function isUnderFullSuiteBudget(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs >= 0 && durationMs < 300_000;
}

export function shouldEnforceFullSuiteBudget(jobs: number): boolean {
  return jobs > 1;
}

export function fullSuiteBudgetBreached(durationMs: number, jobs: number): boolean {
  return shouldEnforceFullSuiteBudget(jobs) && !isUnderFullSuiteBudget(durationMs);
}

export function writeResultArtifact(path: string, value: unknown): void {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, target);
}

type Kill = (pid: number, signal: NodeJS.Signals) => void;
export function killProcessTree(pid: number | undefined, kill: Kill = process.kill): void {
  if (!pid) return;
  try { kill(-pid, 'SIGKILL'); return; }
  catch (groupError) {
    if ((groupError as NodeJS.ErrnoException).code === 'ESRCH') return;
    try { kill(pid, 'SIGKILL'); } catch (directError) {
      if ((directError as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw new AggregateError([groupError, directError], `failed to terminate process tree ${pid}`);
      }
    }
    throw new Error(`failed to terminate process group ${pid}: ${(groupError as Error).message}`);
  }
}

function requestInterrupt(signal: NodeJS.Signals): void {
  interruptSignal = signal;
  for (const child of activeChildren) {
    try { killProcessTree(child.pid); } catch (error) { interruptError = error as Error; }
  }
}
export function interruptForTest(signal: NodeJS.Signals = 'SIGTERM'): void { requestInterrupt(signal); }
export function resetInterruptForTest(): void { interruptSignal = undefined; interruptError = undefined; }

export async function runEntry(entry: FullSuiteEntry, cwd: string, npmCommand = 'npm', onSpawn?: () => void): Promise<FullSuiteResult> {
  const started = performance.now();
  const tempRoot = mkdtempSync(join(tmpdir(), 'lattice-full-suite-member-'));
  return await new Promise((finish) => {
    const child = spawn(npmCommand, ['run', entry.name], {
      cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LATTICE_FULL_SUITE_TEMP_ROOT: tempRoot },
    });
    onSpawn?.(); activeChildren.add(child);
    let output = '';
    const append = (chunk: unknown) => { output = (output + String(chunk)).slice(-MAX_OUTPUT_BYTES); };
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    let settled = false;
    const done = (result: FullSuiteResult) => {
      if (settled) return; settled = true; clearTimeout(timer); activeChildren.delete(child);
      try { rmSync(tempRoot, { recursive: true }); }
      catch (error) { result = { ...result, status: 'FAIL', reason: `owned temp cleanup failed: ${(error as Error).message}` }; }
      finish({ ...result, tempRoot });
    };
    const elapsed = () => performance.now() - started;
    const timer = setTimeout(() => {
      try { killProcessTree(child.pid); done({ name: entry.name, status: 'TIMEOUT', durationMs: elapsed(), output, reason: `exceeded ${entry.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` }); }
      catch (error) { done({ name: entry.name, status: 'FAIL', durationMs: elapsed(), output, reason: `timeout cleanup failed: ${(error as Error).message}` }); }
    }, entry.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on('error', (error) => done({ name: entry.name, status: 'FAIL', durationMs: elapsed(), output, reason: error.message }));
    child.on('exit', (code, signal) => done({
      name: entry.name,
      status: interruptError ? 'FAIL' : interruptSignal ? 'INTERRUPTED' : code === 0 ? 'PASS' : 'FAIL',
      durationMs: elapsed(), output,
      reason: interruptError ? `interrupt cleanup failed: ${interruptError.message}` : interruptSignal ? `runner received ${interruptSignal}` : code === 0 ? undefined : signal ? `signal ${signal}` : `exit code ${code}`,
    }));
  });
}

function claimsConflict(left: FullSuiteEntry, right: FullSuiteEntry): boolean {
  for (const a of left.resources) for (const b of right.resources) {
    if (!a.canonicalKey || !b.canonicalKey) throw new Error('resource claims must be canonicalized before scheduling');
    if (a.canonicalKey === b.canonicalKey && (a.access === 'exclusive' || b.access === 'exclusive')) return true;
  }
  return false;
}

export async function runScheduled(entries: FullSuiteEntry[], jobs: number, execute: (entry: FullSuiteEntry) => Promise<FullSuiteResult>): Promise<FullSuiteResult[]> {
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > MAX_JOBS) throw new Error(`jobs must be an integer between 1 and ${MAX_JOBS}`);
  for (const entry of entries) for (const claim of entry.resources) if (!claim.canonicalKey) throw new Error(`uncanonicalized resource for ${entry.name}`);
  const queuedAt = performance.now();
  const pending = entries.map((entry, index) => ({ entry, index })).sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0) || a.index - b.index).map(({ entry }) => entry);
  const running = new Map<Promise<void>, FullSuiteEntry>();
  const results: FullSuiteResult[] = [];
  const compatible = (entry: FullSuiteEntry) => [...running.values()].every((other) => !claimsConflict(entry, other));
  const launch = (entry: FullSuiteEntry) => {
    const lockWaitMs = performance.now() - queuedAt;
    let task!: Promise<void>;
    task = execute(entry).then((result) => { results.push({ ...result, declaredResources: entry.resources, acquiredResources: entry.resources.map((claim) => claim.canonicalKey!), lockWaitMs }); }).finally(() => { running.delete(task); });
    running.set(task, entry);
  };
  while (pending.length || running.size) {
    if (interruptSignal && pending.length) for (const entry of pending.splice(0)) results.push({ name: entry.name, status: 'INTERRUPTED', durationMs: 0, output: '', reason: `runner received ${interruptSignal}`, declaredResources: entry.resources, acquiredResources: [], lockWaitMs: performance.now() - queuedAt });
    let launched = false;
    while (running.size < jobs) {
      const index = pending.findIndex(compatible); if (index < 0) break;
      launch(pending.splice(index, 1)[0]!); launched = true;
    }
    if (running.size) await Promise.race(running.keys());
    else if (!launched && pending.length) throw new Error(`resource scheduler deadlock at ${pending[0]!.name}`);
  }
  const byName = new Map(results.map((result) => [result.name, result]));
  return entries.map((entry) => byName.get(entry.name)!).filter(Boolean);
}

function readIdentity(cwd: string): { headHash: string; materialHash: string } {
  const materialHash = currentMaterialHash(cwd);
  if (!materialHash) throw new Error('unable to derive material hash');
  return { headHash: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), materialHash };
}

export function identityChanged(start: { headHash: string; materialHash: string }, end: { headHash: string; materialHash: string }): boolean {
  return start.headHash !== end.headHash || start.materialHash !== end.materialHash;
}

async function main(): Promise<void> {
  const cwd = resolve(process.cwd());
  const args = parseRunnerArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const serialReference = [pkg.scripts['test:serial-reference-prefix'], pkg.scripts['test:serial-reference']].filter(Boolean).join(' && ');
  if (!serialReference) throw new Error('missing test:serial-reference membership authority');
  FULL_SUITE_ENTRIES = canonicalizeEntries(entriesFromSerialReference(serialReference, pkg.scripts), cwd);
  validateInventory(FULL_SUITE_ENTRIES, serialReference, pkg.scripts);
  const jobs = args.jobs ?? 4;
  const startIdentity = readIdentity(cwd);
  const wallStartedAt = new Date().toISOString();
  const started = performance.now();
  let processLaunchCount = 0;
  process.once('SIGINT', () => requestInterrupt('SIGINT'));
  process.once('SIGTERM', () => requestInterrupt('SIGTERM'));
  const results = await runScheduled(FULL_SUITE_ENTRIES, jobs, async (entry) => {
    const result = await runEntry(entry, cwd, 'npm', () => { processLaunchCount++; });
    process.stdout.write(`${result.status} ${result.name} ${(result.durationMs / 1000).toFixed(1)}s${result.reason ? ` (${result.reason})` : ''}\n`);
    return result;
  });
  const endIdentity = readIdentity(cwd);
  const identityDrift = identityChanged(startIdentity, endIdentity);
  const failures = results.filter((result) => result.status !== 'PASS');
  for (const failure of failures) process.stderr.write(`\n--- ${failure.name} ${failure.status} ---\n${failure.output}\n`);
  const durationMs = performance.now() - started;
  const performanceBudgetApplied = shouldEnforceFullSuiteBudget(jobs);
  const budgetBreached = fullSuiteBudgetBreached(durationMs, jobs);
  if (identityDrift) process.stderr.write('\nfull-suite identity drift: HEAD/material changed during execution\n');
  if (budgetBreached) process.stderr.write(`\nfull-suite performance budget exceeded: ${durationMs.toFixed(1)}ms >= 300000ms\n`);
  process.stdout.write(`full-suite: ${results.length - failures.length}/${results.length} passed in ${(durationMs / 1000).toFixed(1)}s; retries=0; jobs=${jobs}\n`);
  const critical = [...results].sort((a, b) => b.durationMs - a.durationMs)[0];
  if (args.jsonOutput) writeResultArtifact(args.jsonOutput, {
    schemaVersion: 'lattice.full_suite_result.v2', startIdentity, endIdentity, identityDrift,
    performanceBudgetMs: 300_000, performanceBudgetApplied, budgetBreached,
    headHash: startIdentity.headHash, materialHash: startIdentity.materialHash, startedAt: wallStartedAt, durationMs, jobs,
    maxWorkers: jobs, workerUtilization: results.reduce((sum, result) => sum + result.durationMs, 0) / Math.max(1, durationMs * jobs),
    processLaunchCount, retries: 0, passed: results.length - failures.length, total: results.length,
    overallStatus: failures.length || identityDrift || budgetBreached || interruptError ? 'FAIL' : 'PASS',
    criticalPath: critical ? { name: critical.name, durationMs: critical.durationMs } : null,
    interruptedBy: interruptSignal ?? null,
    coverageInventory: {
      canonicalMembers: FULL_SUITE_ENTRIES.map((entry) => entry.name),
      mutationClasses: ['inventory-omission', 'resource-key-collision', 'descendant-cleanup', 'identity-drift', 'incremental-guard-class'],
      assertionSuites: ['test:full-suite-runner-smoke', 'test:review-incremental-context-smoke', 'test:proofstory-acceptance-rollout'],
    },
    results,
  });
  if (interruptSignal) process.exitCode = interruptSignal === 'SIGINT' ? 130 : 143;
  else if (failures.length || interruptError || identityDrift || budgetBreached) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main().catch((error) => { process.stderr.write(`full-suite: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });

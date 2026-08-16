#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { currentMaterialHash } from '../core/evidence-freshness.js';

export type ResourceClass = 'git-common-dir' | 'fixed-path' | 'fixed-port' | 'runtime-lock' | 'main-write-lock';
export type ResourceAccess = 'shared' | 'exclusive';
export interface ResourceClaim { class: ResourceClass; key: string; access: ResourceAccess; canonicalKey?: string; ownership?: 'runner-cleanable' }
export interface FullSuiteEntry { name: string; resources: ResourceClaim[]; timeoutMs?: number; priority?: number; tempOwnership?: 'runner-owned-unique' }
export interface OwnedTargetPreflight {
  path: string;
  existedBefore: boolean;
  type: 'absent' | 'file' | 'directory' | 'symlink' | 'other';
  ownerMarker: string | null;
}
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
  cpu?: { capability: 'posix-time' | 'unavailable'; userSeconds: number | null; systemSeconds: number | null };
  assertionInventory?: string[];
  mutationInventory?: string[];
  failureOutcome?: { status: FullSuiteResult['status']; reason: string | null };
  summaryMarkerPresent?: boolean;
  inventorySource?: 'explicit-marker+output-signature' | 'output-signature' | 'runner-terminal';
  canonicalMemberAssertionId?: string;
  detailedAssertions?: string[] | null;
  cleanupManifest?: OwnedTargetPreflight[];
  cleanupOutcomes?: Array<{ path: string; outcome: 'absent' | 'removed' | 'residue'; detail?: string }>;
}

export function observedOutputSignatures(output: string): string[] {
  const normalizeStressReceipt = (line: string): string => {
    if (!line.startsWith('INCREMENTAL_STRESS_RECEIPT=')) return line;
    try {
      const value = JSON.parse(line.slice('INCREMENTAL_STRESS_RECEIPT='.length));
      const visit = (input: unknown): unknown => Array.isArray(input) ? input.map(visit) : input && typeof input === 'object'
        ? Object.fromEntries(Object.entries(input).map(([key, nested]) => [key, key === 'observedDurationMs' ? '<observed-duration>' : visit(nested)])) : input;
      return `INCREMENTAL_STRESS_RECEIPT=${JSON.stringify(visit(value))}`;
    } catch { return line; }
  };
  const normalized = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    // Structured summary fields are parsed below. Hashing their raw JSON would
    // duplicate those facts and make formatting or timing-only metadata part of
    // the semantic output inventory.
    .filter(line => !line.startsWith('LATTICE_FULL_SUITE_SUMMARY='))
    .map(line => normalizeStressReceipt(line)
    .replace(/^- B-[0-9a-f]{4}(?= \[[A-Z_]+\] )/, '- B-<fixture>')
    .replace(/\b(?:headHash|materialHash|storyFilesHash|digest)=?["']?[0-9a-f]{40,64}\b/gi, '<identity>')
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s)]+/g, '<temp-path>')
    .replace(/\b(?:elapsedMs|durationMs)=\d+(?:\.\d+)?\b/g, '<duration>'));
  const semantic = normalized.filter(line => /\bPASS\b|\bpassed\b|assertion|smoke|contract/i.test(line));
  const observed = semantic.length ? semantic : normalized.slice(-1);
  return [...new Set(observed)].map(line => `output-sha256:${createHash('sha256').update(line).digest('hex')}`).sort();
}
export interface RunScheduledOptions { onSpawn?: () => void }

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_JOBS = 64;
export const DEFAULT_JOBS = 5;
export const OWNERSHIP_MARKER_FILENAME = 'owner';
const RESOURCE_CLASSES: ResourceClass[] = ['git-common-dir', 'fixed-path', 'fixed-port', 'runtime-lock', 'main-write-lock'];
const activeTerminators = new Map<ReturnType<typeof spawn>, () => Promise<void>>();
let interruptSignal: NodeJS.Signals | undefined;
let interruptError: Error | undefined;
let schedulerCancellationReason: string | undefined;

const isolated = (name: string, options: Omit<FullSuiteEntry, 'name' | 'resources' | 'tempOwnership'> = {}): FullSuiteEntry =>
  ({ name, resources: [], tempOwnership: 'runner-owned-unique', ...options });
const repoRead = (name: string, options: Omit<FullSuiteEntry, 'name' | 'resources' | 'tempOwnership'> = {}, extra: ResourceClaim[] = []): FullSuiteEntry =>
  ({ name, resources: [{ class: 'git-common-dir', key: '.', access: 'shared' }, ...extra], tempOwnership: 'runner-owned-unique', ...options });

// Resource policy is intentionally separate from membership authority. Membership
// comes only from test:serial-reference; a later reference member without a policy
// fails closed before execution.
const RESOURCE_POLICY: Record<string, FullSuiteEntry> = Object.fromEntries([
  repoRead('test:full-suite-runner-smoke', {}, [
    { class: 'fixed-path', key: '.lattice/runtime/full-suite-fixed-sentinel', access: 'exclusive' },
    { class: 'fixed-port', key: '43127', access: 'exclusive' },
  ]),
  repoRead('test:full-suite-resource-sentinel', {}, [
    { class: 'fixed-port', key: '43127', access: 'exclusive' },
    { class: 'fixed-path', key: '.lattice/runtime/full-suite-fixed-sentinel', access: 'exclusive', ownership: 'runner-cleanable' },
    { class: 'runtime-lock', key: '.lattice/runtime/full-suite-runtime-sentinel.lock', access: 'exclusive', ownership: 'runner-cleanable' },
    { class: 'main-write-lock', key: '.lattice/locks/full-suite-main-write-sentinel.lock', access: 'exclusive', ownership: 'runner-cleanable' },
  ]),
  repoRead('test:main-write-lock-coverage'),
  repoRead('test:production-test-seam-guard', {}, [{ class: 'fixed-path', key: 'package.json', access: 'shared' }]),
  repoRead('test:lattice-residue'), repoRead('test:proof-or-stop-prompt-baseline'),
  isolated('test:review-convergence-smoke'), isolated('test:review-loop-smoke'), isolated('test:delivery-context-pack-smoke'),
  isolated('test:agent-liveness-suite-smoke', { priority: 750 }), isolated('test:review-assurance-floor-smoke'),
  isolated('test:proofstory-intent-hardening-smoke', { timeoutMs: 300_000, priority: 900 }),
  isolated('test:scope-shrinkage-withdrawal-floor-smoke'), isolated('test:withdrawn-disposition-smoke'),
  isolated('test:milestone-status', { priority: 700 }), repoRead('test:global-core-realpath'),
  isolated('test:review-incremental-context-smoke', { timeoutMs: 180_000, priority: 800 }),
  isolated('test:review-assurance-floor-storyfileshash-smoke'), isolated('test:docs-drift-smoke'),
  isolated('test:docs-drift-wrapper-root'), isolated('test:gitroot-cwd-contract'), repoRead('test:process-fact-contract'),
  isolated('test:closeout-trust', { priority: 650 }),
  repoRead('test:runtime-fact-contract', {}, [{ class: 'runtime-lock', key: '.lattice/runtime', access: 'shared' }]),
  repoRead('test:evidence-quality'), repoRead('test:anti-stall'), isolated('test:storydir-inside-gitroot-smoke'),
  isolated('test:gitroot-cwd-routing'), isolated('test:bare-gate-gitroot-cwd'), isolated('test:project-gitroot-cwd'),
  isolated('test:done-oracle-wrapper-root'), isolated('test:done-premerge-mainsha-recheck'),
  isolated('test:done-escalation-drift-advisory'), isolated('test:review-escalation-freshness-root'),
  isolated('test:dispatch-checklist-doctor-wrapper-root'), isolated('test:graceful-sites-gitroot-cwd'),
  isolated('test:experience-hint-worktree-cache'), isolated('test:done-merge-experience-refresh'),
  isolated('test:experience-coverage-gap'), isolated('test:nested-worktree-bootstrap', { priority: 550 }),
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
    if (claim.ownership && claim.ownership !== 'runner-cleanable') throw new Error(`unknown resource ownership for ${owner}: ${claim.ownership}`);
    if (claim.ownership && (claim.access !== 'exclusive' || !['fixed-path', 'runtime-lock', 'main-write-lock'].includes(claim.class))) throw new Error(`runner-cleanable resource must be an exclusive owned path for ${owner}`);
  }
}

function observeOwnedTarget(path: string): OwnedTargetPreflight {
  if (!existsSync(path)) return { path, existedBefore: false, type: 'absent', ownerMarker: null };
  const stat = lstatSync(path);
  const type = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
  let ownerMarker: string | null = null;
  try {
    if (type === 'file') ownerMarker = readFileSync(path, 'utf8');
    else if (type === 'directory' && existsSync(join(path, OWNERSHIP_MARKER_FILENAME))) ownerMarker = readFileSync(join(path, OWNERSHIP_MARKER_FILENAME), 'utf8');
  } catch { ownerMarker = null; }
  return { path, existedBefore: true, type, ownerMarker };
}

export function cleanupManifestForEntry(entry: FullSuiteEntry, cwd: string): OwnedTargetPreflight[] {
  const root = realpathSync(cwd);
  const approvedRoots = [join(root, '.lattice', 'runtime'), join(root, '.lattice', 'locks')].map(path => canonicalFilesystemPath(cwd, path));
  return entry.resources.filter(claim => claim.ownership === 'runner-cleanable').map(claim => {
    if (!claim.canonicalKey) throw new Error(`runner-cleanable resource is not canonicalized for ${entry.name}`);
    const target = claim.canonicalKey.slice(claim.canonicalKey.indexOf(':') + 1);
    if (approvedRoots.some(approved => target === approved) || !approvedRoots.some(approved => pathIsContained(approved, target))) throw new Error(`runner-cleanable target is outside an approved owned root: ${claim.key}`);
    return observeOwnedTarget(target);
  });
}

export function cleanupOwnedTargets(manifest: OwnedTargetPreflight[], ownershipToken: string): Array<{ path: string; outcome: 'absent' | 'removed' | 'residue'; detail?: string }> {
  return manifest.map(preflight => {
    const { path } = preflight;
    if (preflight.existedBefore) return { path, outcome: 'residue' as const, detail: `target pre-existed launch (${preflight.type}); cleanup refused` };
    if (!existsSync(path)) return { path, outcome: 'absent' as const };
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('symlink target refused');
      if (stat.isFile()) {
        if (readFileSync(path, 'utf8') !== `${ownershipToken}\n`) throw new Error('foreign file ownership');
        unlinkSync(path); return { path, outcome: 'removed' as const };
      }
      if (!stat.isDirectory()) throw new Error('unsupported owned target type');
      const entries = readdirSync(path);
      if (entries.length !== 1 || entries[0] !== OWNERSHIP_MARKER_FILENAME) throw new Error(entries.length ? `nonempty foreign ownership: ${entries.join(',')}` : 'missing ownership marker');
      if (readFileSync(join(path, OWNERSHIP_MARKER_FILENAME), 'utf8') !== `${ownershipToken}\n`) throw new Error('foreign directory ownership');
      unlinkSync(join(path, OWNERSHIP_MARKER_FILENAME));
      rmdirSync(path); return { path, outcome: 'removed' as const };
    } catch (error) { return { path, outcome: 'residue' as const, detail: (error as Error).message }; }
  });
}

export function pathIsContained(ownershipRoot: string, candidate: string, pathApi: Pick<typeof import('node:path'), 'relative' | 'isAbsolute'> = { relative, isAbsolute }): boolean {
  const rel = pathApi.relative(ownershipRoot, candidate);
  return rel === '' || (!rel.startsWith('..') && !pathApi.isAbsolute(rel));
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
  if (!allowOutsideOwnershipRoot && !pathIsContained(ownershipRoot, canonical)) {
    throw new Error(`resource path escapes ownership root: ${key}`);
  }
  return canonical;
}

function assertOwnedPathHasNoSymlink(cwd: string, key: string): void {
  const root = realpathSync(cwd);
  const absolute = resolve(root, relative(resolve(cwd), resolve(cwd, key)));
  if (!pathIsContained(root, absolute)) throw new Error(`runner-cleanable target escapes project root: ${key}`);
  let cursor = root;
  for (const segment of relative(root, absolute).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`runner-cleanable target traverses a symlink: ${key}`);
  }
}

export function canonicalizeEntries(entries: FullSuiteEntry[], cwd: string): FullSuiteEntry[] {
  return entries.map((entry) => {
    validateResourceClaims(entry.resources, entry.name);
    const resources = entry.resources.map((claim) => {
      if (claim.ownership === 'runner-cleanable') assertOwnedPathHasNoSymlink(cwd, claim.key);
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

export function validateJsonOutputPath(cwd: string, path: string, ownedOutputRoot?: string): string {
  const projectRoot = realpathSync(cwd);
  const unresolved = resolve(cwd, path);
  const lexicalRelative = relative(resolve(cwd), unresolved);
  const target = resolve(projectRoot, lexicalRelative);
  const canonicalTarget = canonicalFilesystemPath(dirname(target), target, true);
  const lexicalInside = pathIsContained(projectRoot, target);
  const canonicalInside = pathIsContained(projectRoot, canonicalTarget);
  if (lexicalInside && !canonicalInside) throw new Error('--json-output symlink escapes the project root');
  if (lexicalInside || canonicalInside) throw new Error('--json-output must be outside the project root');
  if (ownedOutputRoot) {
    const canonicalOwned = canonicalFilesystemPath(cwd, ownedOutputRoot, true);
    if (pathIsContained(projectRoot, canonicalOwned) || pathIsContained(canonicalOwned, projectRoot)) throw new Error('LATTICE_FULL_SUITE_OUTPUT_ROOT must be external to and disjoint from the project root');
    if (!pathIsContained(canonicalOwned, canonicalTarget)) throw new Error('--json-output escapes LATTICE_FULL_SUITE_OUTPUT_ROOT');
  }
  return canonicalTarget;
}

export function writeResultArtifact(path: string, value: unknown): void {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, target);
}

type Kill = (pid: number, signal: NodeJS.Signals) => void;
type Taskkill = (pid: number) => void;
export function killProcessTree(pid: number | undefined, kill: Kill = process.kill, platform = process.platform, taskkill: Taskkill = (target) => { execFileSync('taskkill', ['/PID', String(target), '/T', '/F'], { stdio: 'ignore' }); }): void {
  if (!pid) return;
  if (platform === 'win32') {
    try { taskkill(pid); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(`failed to terminate Windows process tree ${pid}: ${(error as Error).message}`); return; }
  }
  try { kill(-pid, 'SIGKILL'); return; }
  catch (groupError) {
    try { kill(pid, 'SIGKILL'); } catch (directError) {
      if ((directError as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw new AggregateError([groupError, directError], `failed to terminate process tree ${pid}`);
      }
      if ((groupError as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
    if ((groupError as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new Error(`failed to terminate process group ${pid}: ${(groupError as Error).message}`);
  }
}

export interface ProcessRow { pid: number; ppid: number; pgid: number; birthIdentity?: string }
export interface ProcessLifecycleAdapter {
  inspect(): ProcessRow[];
  signal(pid: number, signal: NodeJS.Signals): void;
  probe(pid: number): boolean;
}
export interface RunEntryLifecycleOptions {
  adapter?: ProcessLifecycleAdapter;
  cleanupBudgetMs?: number;
  retryIntervalMs?: number;
}
const TERMINATION_VERIFY_TIMEOUT_MS = 2_000;
const TERMINATION_VERIFY_INTERVAL_MS = 20;
const PROCESS_INSPECTION_TIMEOUT_MS = 500;

/**
 * `lstart` is the per-process birth wall-clock and is the portable birth fact
 * that distinguishes a reused numeric PID from the PID we originally captured.
 * It is requested LAST because its value contains spaces: the first three
 * whitespace-separated tokens are the numeric columns and the entire remainder
 * of the line is the birth identity, so a positional split never mis-attributes
 * a date fragment to a numeric column.
 */
export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    const birthIdentity = match[4].replace(/\s+/g, ' ');
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    if (!birthIdentity) continue;
    rows.push({ pid, ppid, pgid, birthIdentity });
  }
  return rows;
}

const PROCESS_INSPECTION_FIELDS = 'pid=,ppid=,pgid=,lstart=';

function readProcessRows(): ProcessRow[] {
  return parseProcessRows(execFileSync('ps', ['-axo', PROCESS_INSPECTION_FIELDS], { encoding: 'utf8', timeout: PROCESS_INSPECTION_TIMEOUT_MS }));
}

function signalIgnoringMissing(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

export const DEFAULT_PROCESS_LIFECYCLE_ADAPTER: ProcessLifecycleAdapter = Object.freeze({
  inspect: readProcessRows,
  signal: signalIgnoringMissing,
  probe(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  },
});

/**
 * Ownership is keyed on (pid, birthIdentity), never on the bare numeric PID.
 * If a captured PID is later observed carrying a different birth identity the
 * kernel has recycled that number onto an unrelated process, so ownership of
 * that number is permanently revoked: it is dropped from the captured set, is
 * never re-adopted (not even as the root row), is never signalled, and never
 * counts as a live termination target. Rows whose birth identity is unknown on
 * both sides fall back to numeric identity so adapters that do not report a
 * birth fact keep their previous behaviour.
 */
function birthIdentityMatches(captured: ProcessRow, observed: ProcessRow): boolean {
  if (captured.birthIdentity === undefined || observed.birthIdentity === undefined) return true;
  return captured.birthIdentity === observed.birthIdentity;
}

class ProcessTreeLifecycle {
  private readonly known = new Map<number, ProcessRow>();
  private readonly revoked = new Set<number>();
  private readonly errors: Error[] = [];
  private monitor: ReturnType<typeof setInterval> | undefined;
  private terminating = false;
  private exceededBudget = false;
  private ownPgid: number | undefined;

  constructor(
    private readonly rootPid: number,
    private readonly adapter: ProcessLifecycleAdapter,
    private readonly cleanupBudgetMs: number,
    private readonly retryIntervalMs: number,
  ) {
    this.known.set(rootPid, { pid: rootPid, ppid: 0, pgid: rootPid });
  }

  private record(error: unknown): void { this.errors.push(error as Error); }

  /**
   * Revoke every captured PID whose currently observed birth identity differs
   * from the one we captured. Revocation is permanent so a later inspection
   * cannot re-adopt the recycled number.
   */
  private revokeReusedPids(rows: readonly ProcessRow[]): void {
    for (const row of rows) {
      const captured = this.known.get(row.pid);
      if (!captured || birthIdentityMatches(captured, row)) continue;
      this.known.delete(row.pid);
      this.revoked.add(row.pid);
    }
  }

  private capture(): number {
    const rows = this.adapter.inspect();
    this.revokeReusedPids(rows);
    const before = this.known.size;
    this.ownPgid = rows.find(row => row.pid === process.pid)?.pgid ?? this.ownPgid;
    const root = rows.find(row => row.pid === this.rootPid);
    // The root row is adopted on the same (pid, birthIdentity) terms as any
    // descendant: a recycled root PID must not be re-adopted.
    if (root && !this.revoked.has(root.pid)) this.known.set(root.pid, root);
    const activeParents = new Set(rows.filter(row => {
      const captured = this.known.get(row.pid);
      return captured !== undefined && captured.pgid === row.pgid && birthIdentityMatches(captured, row);
    }).map(row => row.pid));
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (activeParents.has(row.ppid) && !activeParents.has(row.pid) && !this.revoked.has(row.pid)) {
        this.known.set(row.pid, row);
        activeParents.add(row.pid);
        changed = true;
      }
    }
    return this.known.size - before;
  }

  async prepare(): Promise<boolean> {
    while (!this.terminating) {
      try { this.capture(); return true; }
      catch (error) { this.record(error); await new Promise(resolveWait => setTimeout(resolveWait, this.retryIntervalMs)); }
    }
    return false;
  }

  startMonitoring(): void {
    if (this.monitor || this.terminating) return;
    this.monitor = setInterval(() => {
      try { this.capture(); } catch (error) { this.record(error); }
    }, this.retryIntervalMs);
  }

  private stopMonitoring(): void {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
  }

  private signalKnown(signal: NodeJS.Signals): boolean {
    let allSucceeded = true;
    const groups = new Map<number, number[]>();
    for (const row of this.known.values()) {
      if (row.pgid <= 0 || this.revoked.has(row.pid)) continue;
      const members = groups.get(row.pgid) ?? [];
      members.push(row.pid);
      groups.set(row.pgid, members);
    }
    for (const [pgid, members] of groups) {
      if (pgid === this.ownPgid) {
        for (const pid of members) {
          try { this.adapter.signal(pid, signal); }
          catch (error) { this.record(new Error(`${signal} pid ${pid}: ${(error as Error).message}`)); allSucceeded = false; }
        }
        continue;
      }
      try { this.adapter.signal(-pgid, signal); }
      catch (groupError) {
        this.record(new Error(`${signal} group ${pgid}: ${(groupError as Error).message}`));
        for (const pid of members) {
          try { this.adapter.signal(pid, signal); }
          catch (error) { this.record(new Error(`${signal} pid ${pid}: ${(error as Error).message}`)); allSucceeded = false; }
        }
      }
    }
    return allSucceeded;
  }

  private liveTargetIds(): number[] {
    // A process-group probe can report EPERM for a group containing only
    // unreaped zombies on macOS. The stable frozen snapshots above guarantee
    // that every owned group member is captured, so captured PIDs are the
    // portable terminal-liveness authority; PGIDs remain termination targets.
    // Re-check birth identity first: a captured PID that has been recycled onto
    // an unrelated process must be revoked here rather than probed as "live"
    // and then SIGKILLed. Inspection failure is not treated as revocation, so a
    // transient ps failure can never silently drop a genuinely owned child.
    try { this.revokeReusedPids(this.adapter.inspect()); }
    catch (error) { this.record(error); }
    const ids = new Set<number>(this.known.keys());
    const live: number[] = [];
    for (const id of ids) {
      if (this.revoked.has(id)) continue;
      try { if (this.adapter.probe(id)) live.push(id); }
      catch (error) { this.record(error); live.push(id); }
    }
    return live;
  }

  async terminateAndVerify(): Promise<void> {
    if (this.terminating) throw new Error('process-tree termination re-entered without shared promise');
    this.terminating = true;
    this.stopMonitoring();
    const deadline = performance.now() + this.cleanupBudgetMs;
    let stableInspections = 0;

    // Quarantine the known tree, then require two stable successful snapshots.
    // Inspection failures keep the promise pending and therefore keep scheduler
    // ownership; they never publish a terminal result with an unknown child.
    while (stableInspections < 2) {
      const frozen = this.signalKnown('SIGSTOP');
      try {
        const added = this.capture();
        stableInspections = frozen && added === 0 ? stableInspections + 1 : 0;
      } catch (error) { this.record(error); stableInspections = 0; }
      if (performance.now() >= deadline) this.exceededBudget = true;
      if (stableInspections < 2) await new Promise(resolveWait => setTimeout(resolveWait, this.retryIntervalMs));
    }

    this.signalKnown('SIGKILL');
    while (true) {
      const live = this.liveTargetIds();
      if (!live.length) break;
      for (const id of live) {
        try { this.adapter.signal(id, 'SIGKILL'); } catch (error) { this.record(new Error(`SIGKILL target ${id}: ${(error as Error).message}`)); }
      }
      if (performance.now() >= deadline) this.exceededBudget = true;
      await new Promise(resolveWait => setTimeout(resolveWait, this.retryIntervalMs));
    }

    if (this.errors.length || this.exceededBudget) {
      const budget = this.exceededBudget ? `; exceeded ${this.cleanupBudgetMs}ms cleanup budget` : '';
      const details = [...new Set(this.errors.map(error => error.message))].join('; ');
      throw new AggregateError(this.errors, `process-tree cleanup recovered fail-closed after ${this.errors.length} lifecycle error(s)${budget}${details ? `: ${details}` : ''}`);
    }
  }
}

/**
 * Timeout/cancellation cleanup is a terminal-result barrier. Snapshot the full
 * wrapper hierarchy while its root still owns it, freeze the discovered PIDs,
 * terminate every captured process group (including children that called
 * setsid), and verify that no captured PID remains before returning.
 */
export async function terminateProcessTreeAndVerify(pid: number | undefined, platform = process.platform, options: RunEntryLifecycleOptions = {}): Promise<void> {
  if (!pid) return;
  if (platform === 'win32') {
    killProcessTree(pid);
    const deadline = performance.now() + TERMINATION_VERIFY_TIMEOUT_MS;
    while (performance.now() < deadline) {
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
      await new Promise(resolveWait => setTimeout(resolveWait, TERMINATION_VERIFY_INTERVAL_MS));
    }
    throw new Error(`live process remains after Windows tree termination: ${pid}`);
  }

  const lifecycle = new ProcessTreeLifecycle(
    pid,
    options.adapter ?? DEFAULT_PROCESS_LIFECYCLE_ADAPTER,
    options.cleanupBudgetMs ?? TERMINATION_VERIFY_TIMEOUT_MS,
    options.retryIntervalMs ?? TERMINATION_VERIFY_INTERVAL_MS,
  );
  await lifecycle.prepare();
  await lifecycle.terminateAndVerify();
}

function requestInterrupt(signal: NodeJS.Signals): void {
  interruptSignal = signal;
  for (const terminate of activeTerminators.values()) void terminate().catch(error => { interruptError ??= error as Error; });
}
export function interruptForTest(signal: NodeJS.Signals = 'SIGTERM'): void { requestInterrupt(signal); }
export function resetInterruptForTest(): void { interruptSignal = undefined; interruptError = undefined; }

export async function runEntry(entry: FullSuiteEntry, cwd: string, npmCommand = 'npm', onSpawn?: () => void, lifecycleOptions: RunEntryLifecycleOptions = {}): Promise<FullSuiteResult> {
  const started = performance.now();
  const tempRoot = mkdtempSync(join(tmpdir(), 'lattice-full-suite-member-'));
  const cleanupManifest = cleanupManifestForEntry(entry, cwd);
  const preexisting = cleanupManifest.filter(target => target.existedBefore);
  if (preexisting.length) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(`runner-cleanable target pre-existed before spawn: ${JSON.stringify(preexisting)}`);
  }
  const ownershipToken = `full-suite-${process.pid}-${Date.now()}-${createHash('sha256').update(tempRoot).digest('hex').slice(0, 12)}`;
  return await new Promise((finish) => {
    const usePosixTime = process.platform !== 'win32' && existsSync('/usr/bin/time') && npmCommand === 'npm';
    const command = usePosixTime ? '/usr/bin/time' : npmCommand;
    const timingPath = join(tempRoot, 'cpu.time');
    const commandArgs = usePosixTime ? ['-p', '-o', timingPath, npmCommand, 'run', entry.name] : ['run', entry.name];
    const child = spawn(command, commandArgs, {
      cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LATTICE_FULL_SUITE_TEMP_ROOT: tempRoot, LATTICE_FULL_SUITE_OWNERSHIP_TOKEN: ownershipToken, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot },
    });
    const lifecycleAdapter = lifecycleOptions.adapter ?? DEFAULT_PROCESS_LIFECYCLE_ADAPTER;
    const lifecycle = process.platform === 'win32' || !child.pid ? undefined : new ProcessTreeLifecycle(
      child.pid,
      lifecycleAdapter,
      lifecycleOptions.cleanupBudgetMs ?? TERMINATION_VERIFY_TIMEOUT_MS,
      lifecycleOptions.retryIntervalMs ?? TERMINATION_VERIFY_INTERVAL_MS,
    );
    let output = '';
    const append = (chunk: unknown) => { output = (output + String(chunk)).slice(-MAX_OUTPUT_BYTES); };
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    let settled = false;
    let terminationPromise: Promise<void> | undefined;
    const ensureTerminated = () => terminationPromise ??= lifecycle
      ? lifecycle.terminateAndVerify()
      : terminateProcessTreeAndVerify(child.pid, process.platform, lifecycleOptions);
    activeTerminators.set(child, ensureTerminated);
    let launchFreezeError: Error | undefined;
    if (lifecycle && child.pid) {
      try { lifecycleAdapter.signal(-child.pid, 'SIGSTOP'); }
      catch (error) { launchFreezeError = error as Error; }
    }
    if (interruptSignal || schedulerCancellationReason) void ensureTerminated().catch(error => { interruptError ??= error as Error; });
    onSpawn?.();
    const done = (result: FullSuiteResult) => {
      if (settled) return; settled = true; clearTimeout(timer); activeTerminators.delete(child);
      result = {
        cpu: { capability: 'unavailable', userSeconds: null, systemSeconds: null },
        assertionInventory: [], detailedAssertions: null, canonicalMemberAssertionId: entry.name, mutationInventory: [], summaryMarkerPresent: false, inventorySource: 'runner-terminal',
        failureOutcome: { status: result.status, reason: result.reason ?? null },
        ...result,
      };
      const cleanupOutcomes = result.status === 'PASS'
        ? cleanupManifest.map(target => existsSync(target.path) ? { path: target.path, outcome: 'residue' as const, detail: 'member reported PASS with owned resource residue' } : { path: target.path, outcome: 'absent' as const })
        : cleanupOwnedTargets(cleanupManifest, ownershipToken);
      if (cleanupOutcomes.some(outcome => outcome.outcome === 'residue')) result = { ...result, status: 'FAIL', reason: `owned resource cleanup failed: ${cleanupOutcomes.filter(outcome => outcome.outcome === 'residue').map(outcome => `${outcome.path}: ${outcome.detail}`).join('; ')}` };
      try { rmSync(tempRoot, { recursive: true }); }
      catch (error) { result = { ...result, status: 'FAIL', reason: `owned temp cleanup failed: ${(error as Error).message}` }; }
      finish({ ...result, tempRoot, cleanupManifest, cleanupOutcomes });
    };
    const elapsed = () => performance.now() - started;
    const timer = setTimeout(async () => {
      try { await ensureTerminated(); done({ name: entry.name, status: 'TIMEOUT', durationMs: elapsed(), output, reason: `exceeded ${entry.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` }); }
      catch (error) { done({ name: entry.name, status: 'FAIL', durationMs: elapsed(), output, reason: `timeout cleanup failed: ${(error as Error).message}` }); }
    }, entry.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on('error', (error) => done({ name: entry.name, status: 'FAIL', durationMs: elapsed(), output, reason: error.message }));
    child.on('exit', async (code, signal) => {
      let completionCleanupError: Error | undefined;
      try { await ensureTerminated(); } catch (error) { completionCleanupError = error as Error; }
      const timing = usePosixTime && existsSync(timingPath) ? readFileSync(timingPath, 'utf8') : '';
      const cpuMatch = timing.match(/^real\s+[0-9.]+\s*\nuser\s+([0-9.]+)\s*\nsys\s+([0-9.]+)\s*$/);
      const markerLine = output.split(/\r?\n/).find(line => line.startsWith('LATTICE_FULL_SUITE_SUMMARY='));
      let marker: { assertions?: string[]; mutations?: string[] } | undefined;
      try { marker = markerLine ? JSON.parse(markerLine.slice('LATTICE_FULL_SUITE_SUMMARY='.length)) : undefined; } catch { marker = undefined; }
      const status = interruptError || completionCleanupError ? 'FAIL' : interruptSignal || schedulerCancellationReason ? 'INTERRUPTED' : code === 0 ? 'PASS' : 'FAIL';
      const reason = interruptError ? `interrupt cleanup failed: ${interruptError.message}`
        : completionCleanupError ? `completion cleanup failed: ${completionCleanupError.message}`
        : interruptSignal ? `runner received ${interruptSignal}` : schedulerCancellationReason ?? (code === 0 ? undefined : signal ? `signal ${signal}` : `exit code ${code}`);
      const outputSignatures = observedOutputSignatures(output);
      const markerAssertions = marker?.assertions ?? [];
      done({
      name: entry.name,
      status,
      durationMs: elapsed(), output,
      reason,
      cpu: { capability: usePosixTime ? 'posix-time' : 'unavailable', userSeconds: cpuMatch ? Number(cpuMatch[1]) : null, systemSeconds: cpuMatch ? Number(cpuMatch[2]) : null },
      assertionInventory: [...markerAssertions, ...outputSignatures, `terminal-exit:${status}:${entry.name}`],
      detailedAssertions: [...markerAssertions, ...outputSignatures],
      canonicalMemberAssertionId: entry.name,
      mutationInventory: marker?.mutations ?? [],
      failureOutcome: { status, reason: reason ?? null },
      summaryMarkerPresent: Boolean(marker),
      inventorySource: marker ? 'explicit-marker+output-signature' : 'output-signature',
    });
    });
    void (async () => {
      if (!lifecycle) return;
      if (launchFreezeError) {
        try { await ensureTerminated(); } catch {}
        return;
      }
      if (terminationPromise || interruptSignal || schedulerCancellationReason) {
        if (!terminationPromise) void ensureTerminated().catch(error => { interruptError ??= error as Error; });
        return;
      }
      const prepared = await lifecycle.prepare();
      if (!prepared || terminationPromise || interruptSignal || schedulerCancellationReason) {
        if (!terminationPromise && (interruptSignal || schedulerCancellationReason)) void ensureTerminated().catch(error => { interruptError ??= error as Error; });
        return;
      }
      try {
        lifecycleAdapter.signal(-child.pid!, 'SIGCONT');
        lifecycle.startMonitoring();
      } catch (error) {
        void ensureTerminated().catch(() => {});
      }
    })();
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
  const pending = entries.map((entry, index) => ({ entry, index })).sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0) || a.index - b.index).map(({ entry }) => entry);
  const running = new Map<Promise<void>, FullSuiteEntry>();
  const resourceBlockedAt = new Map<string, number>();
  const results: FullSuiteResult[] = [];
  let terminalFailureName: string | undefined;
  schedulerCancellationReason = undefined;
  const compatible = (entry: FullSuiteEntry) => [...running.values()].every((other) => !claimsConflict(entry, other));
  const launch = (entry: FullSuiteEntry) => {
    const blockedAt = resourceBlockedAt.get(entry.name);
    const lockWaitMs = blockedAt === undefined ? 0 : performance.now() - blockedAt;
    let task!: Promise<void>;
    task = execute(entry).then((result) => {
      if (!result || result.name !== entry.name || !['PASS', 'FAIL', 'TIMEOUT', 'INTERRUPTED'].includes(result.status)) throw new Error(`missing or invalid terminal result for ${entry.name}`);
      const effective = terminalFailureName && result.status === 'PASS'
        ? { ...result, status: 'INTERRUPTED' as const, reason: `cancelled after terminal failure ${terminalFailureName}`, failureOutcome: { status: 'INTERRUPTED' as const, reason: `cancelled after terminal failure ${terminalFailureName}` } }
        : result;
      results.push({ ...effective, declaredResources: entry.resources, acquiredResources: entry.resources.map((claim) => claim.canonicalKey!), lockWaitMs });
      if (!terminalFailureName && (result.status === 'FAIL' || result.status === 'TIMEOUT')) {
        terminalFailureName = result.name;
        schedulerCancellationReason = `cancelled after terminal failure ${result.name}`;
        for (const terminate of activeTerminators.values()) void terminate().catch(error => { interruptError ??= error as Error; });
      }
    }).finally(() => { running.delete(task); });
    running.set(task, entry);
  };
  while (pending.length || running.size) {
    if (terminalFailureName && pending.length) for (const entry of pending.splice(0)) results.push({ name: entry.name, status: 'INTERRUPTED', durationMs: 0, output: '', reason: `cancelled after terminal failure ${terminalFailureName}`, declaredResources: entry.resources, acquiredResources: [], lockWaitMs: 0, cpu: { capability: 'unavailable', userSeconds: null, systemSeconds: null }, assertionInventory: [], mutationInventory: [], failureOutcome: { status: 'INTERRUPTED', reason: `cancelled after terminal failure ${terminalFailureName}` } });
    if (interruptSignal && pending.length) for (const entry of pending.splice(0)) results.push({ name: entry.name, status: 'INTERRUPTED', durationMs: 0, output: '', reason: `runner received ${interruptSignal}`, declaredResources: entry.resources, acquiredResources: [], lockWaitMs: 0, cpu: { capability: 'unavailable', userSeconds: null, systemSeconds: null }, assertionInventory: [], mutationInventory: [], failureOutcome: { status: 'INTERRUPTED', reason: `runner received ${interruptSignal}` } });
    let launched = false;
    while (!terminalFailureName && running.size < jobs) {
      for (const candidate of pending) if (!compatible(candidate) && !resourceBlockedAt.has(candidate.name)) resourceBlockedAt.set(candidate.name, performance.now());
      const index = pending.findIndex(compatible); if (index < 0) break;
      launch(pending.splice(index, 1)[0]!); launched = true;
    }
    if (running.size) await Promise.race(running.keys());
    else if (!launched && pending.length) throw new Error(`resource scheduler deadlock at ${pending[0]!.name}`);
  }
  const byName = new Map(results.map((result) => [result.name, result]));
  schedulerCancellationReason = undefined;
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
  // This is deliberately the first executable preflight: stale source/build
  // material must fail before argument parsing, inventory reads, or spawning.
  execFileSync(process.execPath, ['scripts/verify-full-suite-build-binding.mjs'], { cwd, stdio: 'pipe' });
  const args = parseRunnerArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const serialReference = [pkg.scripts['test:serial-reference-prefix'], pkg.scripts['test:serial-reference']].filter(Boolean).join(' && ');
  if (!serialReference) throw new Error('missing test:serial-reference membership authority');
  FULL_SUITE_ENTRIES = canonicalizeEntries(entriesFromSerialReference(serialReference, pkg.scripts), cwd);
  validateInventory(FULL_SUITE_ENTRIES, serialReference, pkg.scripts);
  const jobs = args.jobs ?? DEFAULT_JOBS;
  const startIdentity = readIdentity(cwd);
  const jsonOutput = args.jsonOutput ? validateJsonOutputPath(cwd, args.jsonOutput, process.env.LATTICE_FULL_SUITE_OUTPUT_ROOT) : undefined;
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
  if (jsonOutput) writeResultArtifact(jsonOutput, {
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
    baselineComparison: {
      historicalSerialMs: 1_688_918,
      currentMs: durationMs,
      speedup: 1_688_918 / Math.max(1, durationMs),
      inventoryCount: results.length,
    },
    cpuInventory: {
      capability: process.platform === 'win32' ? 'unavailable' : 'posix-time',
      membersMeasured: results.filter(result => result.cpu?.userSeconds !== null).length,
      userSeconds: results.reduce((sum, result) => sum + (result.cpu?.userSeconds ?? 0), 0),
      systemSeconds: results.reduce((sum, result) => sum + (result.cpu?.systemSeconds ?? 0), 0),
    },
    summaryInventory: {
      explicitMarkers: results.filter(result => result.summaryMarkerPresent).map(result => result.name),
      outputDerived: results.filter(result => !result.summaryMarkerPresent).map(result => result.name),
    },
    results,
  });
  const postWriteIdentity = readIdentity(cwd);
  if (identityChanged(endIdentity, postWriteIdentity)) {
    process.stderr.write('\nfull-suite identity drift: output write changed HEAD/material\n');
    process.exitCode = 1;
  }
  if (interruptSignal) process.exitCode = interruptSignal === 'SIGINT' ? 130 : 143;
  else if (failures.length || interruptError || identityDrift || budgetBreached) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main().catch((error) => { process.stderr.write(`full-suite: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });

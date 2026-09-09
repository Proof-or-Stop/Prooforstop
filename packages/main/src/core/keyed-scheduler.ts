/**
 * Keyed parallel scheduler shared by the full test suite runner and routine
 * validate. Admission control is declaration-driven: an entry may only run
 * concurrently with entries whose canonical resource keys do not conflict.
 *
 * Resource ownership is shared across scheduler calls in this process. Results
 * and cancellation remain per-call; this is not a cross-process lock.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { KEYED_SCHEDULER_RUNTIME_POLICY, MACHINE_HEAVY_RESOURCE_POLICY, MACHINE_FIXED_PORT_RUNTIME_POLICY } from './runtime-fact-registry.js';

export type ResourceClass = 'git-common-dir' | 'fixed-path' | 'fixed-port' | 'runtime-lock' | 'main-write-lock' | 'machine-cpu' | 'machine-process' | 'machine-validation';
export type ResourceAccess = 'shared' | 'exclusive';
export interface ResourceClaim { class: ResourceClass; key: string; access: ResourceAccess; canonicalKey?: string; ownership?: 'runner-cleanable' }

export const RESOURCE_CLASSES: ResourceClass[] = ['git-common-dir', 'fixed-path', 'fixed-port', 'runtime-lock', 'main-write-lock', 'machine-cpu', 'machine-process', 'machine-validation'];
export const RESOURCE_ACCESSES: ResourceAccess[] = ['shared', 'exclusive'];
export const OWNED_RESOURCE_CLASSES: ResourceClass[] = ['fixed-path', 'runtime-lock', 'main-write-lock'];
export const MAX_JOBS = 64;

export const SCHEDULED_STATUSES = ['PASS', 'FAIL', 'TIMEOUT', 'INTERRUPTED'] as const;
export type ScheduledStatus = (typeof SCHEDULED_STATUSES)[number];

export const CANCELLATION_POLICIES = ['cancel-on-first-failure', 'run-all'] as const;
export type CancellationPolicy = (typeof CANCELLATION_POLICIES)[number];

/** Minimum shape the scheduler needs from a caller's entry record. */
export interface SchedulableEntry { name: string; resources: ResourceClaim[]; priority?: number }
/** Minimum shape the scheduler needs from a caller's terminal result record. */
export interface SchedulableResult {
  name: string;
  status: ScheduledStatus;
  reason?: string;
  declaredResources?: ResourceClaim[];
  acquiredResources?: string[];
  lockWaitMs?: number;
}

export interface KeyedSchedulerOptions<TEntry extends SchedulableEntry, TResult extends SchedulableResult> {
  /**
   * `cancel-on-first-failure`: the first FAIL/TIMEOUT is terminal; pending entries
   * are never launched and are reported cancelled.
   * `run-all`: every entry runs to its own terminal state regardless of failures.
   */
  cancellation: CancellationPolicy;
  /** Builds the terminal record for an entry cancelled before it ever launched. */
  cancelledResult?: (entry: TEntry, reason: string) => TResult;
  /** Rewrites a result that completed successfully after cancellation began. */
  cancelCompletedResult?: (result: TResult, reason: string) => TResult;
  /** Observes the transition into cancellation (callers kill live children here). */
  onCancellation?: (reason: string, cause: TResult) => void;
  /** External cancellation source (e.g. a signal handler); returns a reason when active. */
  externalCancellation?: () => string | undefined;
}

export function validateResourceClaims(claims: ResourceClaim[], owner: string): void {
  for (const claim of claims) {
    if (!RESOURCE_CLASSES.includes(claim.class)) throw new Error(`unknown resource class for ${owner}: ${claim.class}`);
    if (!RESOURCE_ACCESSES.includes(claim.access)) throw new Error(`unknown resource access for ${owner}: ${claim.access}`);
    if (claim.class === 'machine-validation' && (claim.key !== MACHINE_FIXED_PORT_RUNTIME_POLICY.barrierKey || claim.access !== 'shared')) throw new Error(`invalid machine validation barrier for ${owner}`);
    if (claim.class === 'machine-cpu' || claim.class === 'machine-process') {
      const key = claim.class === 'machine-cpu' ? MACHINE_HEAVY_RESOURCE_POLICY.cpuKey : MACHINE_HEAVY_RESOURCE_POLICY.processKey;
      if (claim.key !== key || claim.access !== MACHINE_HEAVY_RESOURCE_POLICY.access) throw new Error(`invalid exclusive machine resource for ${owner}: ${claim.class}`);
    }
    if (!claim.key.trim()) throw new Error(`empty resource key for ${owner}`);
    if (claim.ownership && claim.ownership !== 'runner-cleanable') throw new Error(`unknown resource ownership for ${owner}: ${claim.ownership}`);
    if (claim.ownership && (claim.access !== 'exclusive' || !OWNED_RESOURCE_CLASSES.includes(claim.class))) throw new Error(`runner-cleanable resource must be an exclusive owned path for ${owner}`);
  }
}

export function parsePositiveInteger(value: string | undefined, label: string, maximum = MAX_JOBS): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a finite positive integer <= ${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new Error(`${label} must be a finite positive integer <= ${maximum}`);
  return parsed;
}

export function pathIsContained(ownershipRoot: string, candidate: string, pathApi: Pick<typeof import('node:path'), 'relative' | 'isAbsolute'> = { relative, isAbsolute }): boolean {
  const rel = pathApi.relative(ownershipRoot, candidate);
  return rel === '' || (!rel.startsWith('..') && !pathApi.isAbsolute(rel));
}

export function canonicalFilesystemPath(cwd: string, key: string, allowOutsideOwnershipRoot = false): string {
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

export function canonicalizeEntries<TEntry extends SchedulableEntry>(entries: TEntry[], cwd: string): TEntry[] {
  return entries.map((entry) => {
    validateResourceClaims(entry.resources, entry.name);
    const resources = entry.resources.map((claim) => {
      if (claim.ownership === 'runner-cleanable') assertOwnedPathHasNoSymlink(cwd, claim.key);
      let value: string;
      if (claim.class === 'fixed-port') {
        const port = parsePositiveInteger(claim.key, `${entry.name} fixed port`, 65_535);
        value = String(port);
      } else if (claim.class === 'machine-cpu' || claim.class === 'machine-process' || claim.class === 'machine-validation') {
        value = claim.key;
      } else if (claim.class === 'git-common-dir') {
        const repository = canonicalFilesystemPath(cwd, claim.key);
        const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repository, encoding: 'utf8' }).trim();
        value = canonicalFilesystemPath(repository, common, true);
      } else value = canonicalFilesystemPath(cwd, claim.key);
      return { ...claim, canonicalKey: `${claim.class}:${value}` };
    });
    // Only the resources field is rewritten; every other caller-owned field is preserved.
    return { ...entry, resources } as TEntry;
  });
}

export function claimsConflict(left: SchedulableEntry, right: SchedulableEntry): boolean {
  for (const a of left.resources) for (const b of right.resources) {
    if (!a.canonicalKey || !b.canonicalKey) throw new Error('resource claims must be canonicalized before scheduling');
    if (a.canonicalKey === b.canonicalKey && (a.access === 'exclusive' || b.access === 'exclusive')) return true;
  }
  return false;
}

// Reserve before invoking user code, and release even if it throws synchronously.
// Waiters observe only availability, never another batch's result or rejection.
const processResourceOwners = new Set<SchedulableEntry>();
const resourceWaiters = new Set<() => void>();
function waitForProcessResources(pollCancellation: boolean): Promise<void> {
  return new Promise(resolveWait => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      if (timer) clearTimeout(timer);
      resourceWaiters.delete(wake);
      resolveWait();
    };
    resourceWaiters.add(wake);
    if (pollCancellation) timer = setTimeout(wake, KEYED_SCHEDULER_RUNTIME_POLICY.blockedCancellationPollMs);
  });
}

export async function runScheduled<TEntry extends SchedulableEntry, TResult extends SchedulableResult>(
  entries: TEntry[],
  jobs: number,
  execute: (entry: TEntry) => Promise<TResult>,
  options: KeyedSchedulerOptions<TEntry, TResult>,
): Promise<TResult[]> {
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > MAX_JOBS) throw new Error(`jobs must be an integer between 1 and ${MAX_JOBS}`);
  // Runtime re-validation of the declared policy: the enum is not only a type,
  // because internal callers can reach this function without a schema parse.
  if (!CANCELLATION_POLICIES.includes(options.cancellation)) throw new Error(`unknown cancellation policy: ${options.cancellation}`);
  const cancellable = options.cancellation === 'cancel-on-first-failure' || Boolean(options.externalCancellation);
  if (cancellable && !options.cancelledResult) throw new Error('cancelledResult is required when cancellation can occur');
  for (const entry of entries) for (const claim of entry.resources) if (!claim.canonicalKey) throw new Error(`uncanonicalized resource for ${entry.name}`);

  // Results and cancellation belong only to this invocation.
  const pending = entries.map((entry, index) => ({ entry, index })).sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0) || a.index - b.index).map(({ entry }) => entry);
  const running = new Map<Promise<void>, TEntry>();
  const resourceBlockedAt = new Map<string, number>();
  const results: TResult[] = [];
  let terminalFailureName: string | undefined;
  let cancellationReason: string | undefined;

  const cancelCompleted = options.cancelCompletedResult ?? ((result: TResult, reason: string) => ({ ...result, status: 'INTERRUPTED' as const, reason }) as TResult);
  const compatible = (entry: TEntry) => [...processResourceOwners].every((other) => !claimsConflict(entry, other));
  const launch = (entry: TEntry) => {
    const blockedAt = resourceBlockedAt.get(entry.name);
    const lockWaitMs = blockedAt === undefined ? 0 : performance.now() - blockedAt;
    const reservation = { name: entry.name, resources: entry.resources.map(claim => ({ ...claim })) };
    processResourceOwners.add(reservation);
    let task!: Promise<void>;
    task = Promise.resolve().then(() => execute(entry)).then((result) => {
      if (!result || result.name !== entry.name || !SCHEDULED_STATUSES.includes(result.status)) throw new Error(`missing or invalid terminal result for ${entry.name}`);
      const effective = terminalFailureName && result.status === 'PASS'
        ? cancelCompleted(result, `cancelled after terminal failure ${terminalFailureName}`)
        : result;
      results.push({ ...effective, declaredResources: entry.resources, acquiredResources: entry.resources.map((claim) => claim.canonicalKey!), lockWaitMs } as TResult);
      if (options.cancellation === 'cancel-on-first-failure' && !terminalFailureName && (result.status === 'FAIL' || result.status === 'TIMEOUT')) {
        terminalFailureName = result.name;
        cancellationReason = `cancelled after terminal failure ${result.name}`;
        options.onCancellation?.(cancellationReason, result);
      }
    }).finally(() => {
      running.delete(task);
      processResourceOwners.delete(reservation);
      for (const wake of [...resourceWaiters]) wake();
    });
    running.set(task, entry);
  };
  while (pending.length || running.size) {
    const cancelReason = cancellationReason ?? options.externalCancellation?.();
    if (cancelReason && pending.length) for (const entry of pending.splice(0)) results.push(options.cancelledResult!(entry, cancelReason));
    let launched = false;
    while (!terminalFailureName && running.size < jobs) {
      for (const candidate of pending) if (!compatible(candidate) && !resourceBlockedAt.has(candidate.name)) resourceBlockedAt.set(candidate.name, performance.now());
      const index = pending.findIndex(compatible); if (index < 0) break;
      launch(pending.splice(index, 1)[0]!); launched = true;
    }
    if (running.size) await Promise.race(running.keys());
    else if (!launched && pending.length) await waitForProcessResources(Boolean(options.externalCancellation));
  }
  const byName = new Map(results.map((result) => [result.name, result]));
  return entries.map((entry) => byName.get(entry.name)!).filter(Boolean);
}

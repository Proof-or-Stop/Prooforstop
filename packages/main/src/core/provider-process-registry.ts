/**
 * Canonical, ledger-independent provider-process capacity registry.
 *
 * Admission is an atomic exclusive create of one of a fixed set of numbered
 * slots. Usage accounting may be disabled; this registry never is. A recorded
 * live pid is never reclaimed because of age alone, and release is guarded by
 * the acquire-minted ownership token.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  acquireMkdirLock,
  type ExistingMkdirLockSnapshot,
  type ExistingMkdirLockState,
} from './mkdir-lock.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { readBrandEnv } from './brand-env.js';

// B-137a main-merge fix: main narrowed STATE_DIR_NAMES to the canonical
// '.proof-or-stop' only, so a hardcoded '.lattice' runtime path is no longer
// matched by the runtime-artifact registry's stateDirPrefix entries. Slots
// written there were therefore neither materialHash-excluded nor gitignored and
// showed up as uncommitted SOURCE. Derive the canonical state dir.
const PROVIDER_PROCESS_SLOTS_RELATIVE = join(PROOF_OR_STOP_DIR, 'runtime', 'provider-process-slots');
export const PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT = 4;
export const PROVIDER_PROCESS_SLOT_STALE_MS_DEFAULT = 6 * 60 * 60 * 1000;

export interface ProviderProcessLiveDescriptor {
  pid: number;
  startedAt: string;
  host: string;
  storyId: string | null;
  agentType: string;
}

export interface ProviderProcessSlotMeta extends ProviderProcessLiveDescriptor {}

export interface ProviderProcessSlotFileMeta extends ProviderProcessSlotMeta {
  token: string;
  providerPid?: number;
  providerPgid?: number;
  providerSpawnedAt?: string;
  providerStartFingerprint?: string;
  providerProcessGroupIsolated?: boolean;
}

export interface AcquiredProviderProcessSlot {
  file: string;
  token: string;
}

export interface ProviderRegistryLockTiming {
  deadlineMs?: number;
  staleMs?: number;
  pollMs?: number;
}

export interface ProviderRegistryMutationOps {
  unlink(file: string): void;
}

/** Test-only observation/mutation seams for a replacement between stale-read and reclaim. */
export interface ProviderRegistryScanHooks {
  beforeReclaimRecheck?(file: string): void;
  unlinkForReclaim?(file: string): void;
}

const DEFAULT_PROVIDER_REGISTRY_MUTATION_OPS: ProviderRegistryMutationOps = {
  unlink: unlinkSync,
};

type SlotOccupant =
  | { state: 'valid'; pid: number; token: string | null; meta: Record<string, unknown> }
  | { state: 'corrupt'; identity: string }
  | { state: 'missing' };

function corruptSlotIdentity(file: string, raw: string): string {
  try {
    const stat = statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${raw}`;
  } catch (error) {
    return `unstatable:${(error as NodeJS.ErrnoException).code ?? 'unknown'}:${raw}`;
  }
}

function ownString(value: Record<string, unknown>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
  return typeof value[key] === 'string' ? value[key] as string : null;
}

function ownNumber(value: Record<string, unknown>, key: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
  return typeof value[key] === 'number' && Number.isInteger(value[key]) ? value[key] as number : null;
}

function readSlotOccupant(file: string): SlotOccupant {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'corrupt', identity: corruptSlotIdentity(file, '') };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: 'corrupt', identity: corruptSlotIdentity(file, raw) };
    }
    const meta = parsed as Record<string, unknown>;
    const pid = ownNumber(meta, 'pid');
    if (pid === null) return { state: 'corrupt', identity: corruptSlotIdentity(file, raw) };
    return { state: 'valid', pid, token: ownString(meta, 'token'), meta };
  } catch {
    return { state: 'corrupt', identity: corruptSlotIdentity(file, raw) };
  }
}

function sameSlotOccupant(left: SlotOccupant, right: SlotOccupant): boolean {
  if (left.state !== right.state) return false;
  if (left.state === 'valid' && right.state === 'valid') {
    return left.pid === right.pid && left.token === right.token;
  }
  if (left.state === 'corrupt' && right.state === 'corrupt') {
    return left.identity === right.identity;
  }
  return true;
}

function probeProcessSignal(pidOrGroup: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pidOrGroup, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return probeProcessSignal(pid) !== 'dead';
}

function processGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1 || process.platform === 'win32') return false;
  return probeProcessSignal(-pgid) !== 'dead';
}

function observeSlotStartFingerprint(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return null;
  try {
    const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function slotReclaimable(occupant: SlotOccupant, file: string, now: number, staleMs: number): boolean {
  if (occupant.state === 'missing') return true;
  if (occupant.state === 'valid') {
    const isolated = occupant.meta.providerProcessGroupIsolated === true;
    const providerPgid = ownNumber(occupant.meta, 'providerPgid');
    // Once the admission has transferred to an isolated provider group, the
    // group—not the supervising worker—is the capacity owner. A crashed worker
    // may leave children alive, so reclaim only after the exact PGID disappears.
    if (isolated && providerPgid !== null && processGroupAlive(providerPgid)) return false;
    if (!pidAlive(occupant.pid)) return true;
    const recorded = ownString(occupant.meta, 'providerStartFingerprint');
    if (!recorded || recorded.startsWith('spawn-observed:')) return false;
    const live = observeSlotStartFingerprint(occupant.pid);
    if (live === null) return false;
    return live !== recorded;
  }
  try {
    const ageMs = now - statSync(file).mtimeMs;
    return !Number.isFinite(ageMs) || ageMs > staleMs;
  } catch {
    // Fail closed: an existing slot we cannot stat still occupies capacity.
    return false;
  }
}

export function providerProcessSlotsDir(root: string): string {
  return join(resolveCanonicalRuntimeProjectRoot(root), PROVIDER_PROCESS_SLOTS_RELATIVE);
}

export function resolveProviderProcessMaxConcurrent(env: NodeJS.ProcessEnv): number {
  // B-137a main-merge fix: this read the RETIRED env name while the rest of the
  // runtime emits PROOF_OR_STOP_*. The cap could therefore NEVER be configured --
  // every caller silently got the default, so the concurrency safety control was
  // inert. readBrandEnv resolves the canonical name.
  const raw = readBrandEnv('HOST_RUN_MAX_CONCURRENT', env);
  if (typeof raw !== 'string' || raw.trim().length === 0) return PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT;
  const value = Number(raw.trim());
  return Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT;
}

export function resolveProviderProcessSlotStaleMs(env: NodeJS.ProcessEnv): number {
  // B-137a main-merge fix: same retired-name defect as the cap resolver above.
  const raw = readBrandEnv('HOST_RUN_SLOT_STALE_MS', env);
  if (typeof raw !== 'string' || raw.trim().length === 0) return PROVIDER_PROCESS_SLOT_STALE_MS_DEFAULT;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : PROVIDER_PROCESS_SLOT_STALE_MS_DEFAULT;
}

export function writeProviderProcessSlotExclusive(
  file: string,
  meta: ProviderProcessSlotFileMeta,
): boolean {
  try {
    writeFileSync(file, JSON.stringify(meta), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

interface ProviderProcessSlotScan {
  live: ProviderProcessLiveDescriptor[];
  occupiedCount: number;
}

function scanProviderProcessSlotsUnlocked(
  dir: string,
  now: number,
  staleMs: number,
  hooks: ProviderRegistryScanHooks = {},
): ProviderProcessSlotScan {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { live: [], occupiedCount: 0 };
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`provider-process-registry slots directory unreadable (${code}): ${detail}`);
  }
  const live: ProviderProcessLiveDescriptor[] = [];
  let occupiedCount = 0;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    const occupant = readSlotOccupant(file);
    if (slotReclaimable(occupant, file, now, staleMs)) {
      hooks.beforeReclaimRecheck?.(file);
      const rechecked = readSlotOccupant(file);
      if (occupant.state !== 'missing' && sameSlotOccupant(rechecked, occupant)) {
        try { (hooks.unlinkForReclaim ?? unlinkSync)(file); } catch { /* re-read below decides occupancy */ }
        // A failed unlink is not a benign reclaim. Re-read its exact path: it
        // only stops consuming capacity once absence is proven. This covers an
        // EACCES/unlink failure as well as a concurrent replacement.
        const afterUnlink = readSlotOccupant(file);
        if (afterUnlink.state === 'missing') continue;
        occupiedCount += 1;
        if (afterUnlink.state === 'valid') {
          live.push({
            pid: afterUnlink.pid,
            startedAt: ownString(afterUnlink.meta, 'startedAt') ?? '',
            host: ownString(afterUnlink.meta, 'host') ?? '',
            storyId: ownString(afterUnlink.meta, 'storyId'),
            agentType: ownString(afterUnlink.meta, 'agentType') ?? '',
          });
        }
        continue;
      }
      // A changed occupant is never ours to reclaim. It consumes capacity even
      // if a second observation looks reclaimable: retrying here could admit a
      // slot-0 holder beside a replacement in a high-index slot.
      if (rechecked.state === 'missing') continue;
      occupiedCount += 1;
      if (rechecked.state === 'valid') {
        live.push({
          pid: rechecked.pid,
          startedAt: ownString(rechecked.meta, 'startedAt') ?? '',
          host: ownString(rechecked.meta, 'host') ?? '',
          storyId: ownString(rechecked.meta, 'storyId'),
          agentType: ownString(rechecked.meta, 'agentType') ?? '',
        });
      }
      continue;
    }
    // A fresh malformed slot has no safe descriptor to show to callers, but
    // cannot be reclaimed either. It must still consume capacity: otherwise a
    // cap lowered below a non-reclaimable high index can admit past its limit.
    occupiedCount += 1;
    if (occupant.state !== 'valid') continue;
    live.push({
      pid: occupant.pid,
      startedAt: ownString(occupant.meta, 'startedAt') ?? '',
      host: ownString(occupant.meta, 'host') ?? '',
      storyId: ownString(occupant.meta, 'storyId'),
      agentType: ownString(occupant.meta, 'agentType') ?? '',
    });
  }
  return { live, occupiedCount };
}

function currentProcessStartTimeMs(): number {
  return Math.floor(Date.now() - process.uptime() * 1_000);
}

function sameProcessStart(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined) return true;
  return Math.abs(left - right) <= 2_000;
}

type ProviderRegistryLockPidState = 'active' | 'stale' | 'unknown';

export interface ProviderRegistryLockObservationOps {
  inspectPid?: (pid: number) => ProviderRegistryLockPidState;
  observeProcessStartTimeMs?: (pid: number) => number | undefined;
}

function inspectProviderRegistryLockPid(pid: number): ProviderRegistryLockPidState {
  try {
    process.kill(pid, 0);
    return 'active';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'stale';
    if (code === 'EPERM') return 'active';
    return 'unknown';
  }
}

/**
 * Best-effort foreign-PID start identity, using ps elapsed time rather than a
 * signal or a provider launch. An unavailable platform/process observation is
 * deliberately not treated as proof of staleness.
 */
function observeProviderRegistryProcessStartTimeMs(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return undefined;
  try {
    const raw = execFileSync('ps', ['-o', 'etimes=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const elapsedSeconds = Number(raw);
    return Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0
      ? Math.floor(Date.now() - elapsedSeconds * 1_000)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify an existing registry lock with PID-reuse protection for every local
 * holder, not only this process. If a persisted start identity cannot be read
 * back safely after the PID was observed live, retain it as active rather than
 * falling through to mkdir-lock's age-based unknown-lock reclamation.
 */
export function classifyProviderRegistryLock(
  snapshot: ExistingMkdirLockSnapshot,
  ops: ProviderRegistryLockObservationOps = {},
): ExistingMkdirLockState {
  const holder = snapshot.holder;
  if (!holder || holder.hostname !== hostname()) return 'unknown';
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return 'unknown';
  const pidState = (ops.inspectPid ?? inspectProviderRegistryLockPid)(holder.pid);
  if (pidState !== 'active') return pidState;
  if (holder.processStartTimeMs !== undefined) {
    const observedStart = (ops.observeProcessStartTimeMs ?? observeProviderRegistryProcessStartTimeMs)(holder.pid);
    // The PID liveness probe succeeded. A missing start-time observation does
    // not demonstrate reuse, so fail closed: generic unknown-lock aging must
    // not reclaim a potentially live provider-registry lock.
    if (observedStart === undefined) return 'active';
    if (!sameProcessStart(holder.processStartTimeMs, observedStart)) return 'stale';
  }
  return 'active';
}

function withProviderRegistryLock<T>(
  dir: string,
  fn: () => T,
  timing: ProviderRegistryLockTiming = {},
): T {
  const lock = acquireMkdirLock(`${dir}.lock`, {
    label: 'provider-process-registry',
    deadlineMs: timing.deadlineMs ?? 30_000,
    staleMs: timing.staleMs ?? 10_000,
    pollMs: timing.pollMs ?? 10,
    requireHolderToken: true,
    classifyExistingLock: classifyProviderRegistryLock,
    holderInfo: {
      pid: process.pid,
      hostname: hostname(),
      command: 'provider-process-registry mutation',
      acquiredAt: new Date().toISOString(),
      lockId: randomUUID(),
      processStartTimeMs: currentProcessStartTimeMs(),
    },
  });
  try {
    return fn();
  } finally {
    lock.release();
  }
}

export function scanLiveProviderProcessSlots(
  dir: string,
  now: number,
  staleMs: number,
  lockTiming: ProviderRegistryLockTiming = {},
): ProviderProcessLiveDescriptor[] {
  return withProviderRegistryLock(dir, () => scanProviderProcessSlotsUnlocked(dir, now, staleMs).live, lockTiming);
}

export function acquireProviderProcessSlot(
  dir: string,
  cap: number,
  staleMs: number,
  now: number,
  meta: ProviderProcessSlotMeta,
  lockTiming: ProviderRegistryLockTiming = {},
  scanHooks: ProviderRegistryScanHooks = {},
): AcquiredProviderProcessSlot | null {
  mkdirSync(dir, { recursive: true });
  const boundedCap = Number.isFinite(cap) && Number.isInteger(cap) && cap > 0
    ? cap
    : PROVIDER_PROCESS_MAX_CONCURRENT_DEFAULT;
  return withProviderRegistryLock(dir, () => {
    const scan = scanProviderProcessSlotsUnlocked(dir, now, staleMs, scanHooks);
    if (scan.occupiedCount >= boundedCap) return null;
    const token = randomUUID();
    const record: ProviderProcessSlotFileMeta = { ...meta, token };
    for (let index = 0; index < boundedCap; index += 1) {
      const file = join(dir, `slot-${index}.json`);
      if (writeProviderProcessSlotExclusive(file, record)) return { file, token };
      const judged = readSlotOccupant(file);
      if (!slotReclaimable(judged, file, now, staleMs)) continue;
      if (judged.state !== 'missing') {
        if (!sameSlotOccupant(readSlotOccupant(file), judged)) continue;
        try { (scanHooks.unlinkForReclaim ?? unlinkSync)(file); } catch { /* absence is proven below */ }
        // Do not move to another index after a failed reclaim: a live,
        // corrupt, or inaccessible entry remains capacity until a fresh scan
        // can prove it absent.
        if (readSlotOccupant(file).state !== 'missing') continue;
      }
      if (writeProviderProcessSlotExclusive(file, record)) return { file, token };
    }
    return null;
  }, lockTiming);
}

export function releaseProviderProcessSlot(
  file: string | null,
  token: string | null,
  lockTiming: ProviderRegistryLockTiming = {},
  mutationOps: ProviderRegistryMutationOps = DEFAULT_PROVIDER_REGISTRY_MUTATION_OPS,
): void {
  if (!file || !token) return;
  const dir = dirname(file);
  withProviderRegistryLock(dir, () => {
    const occupant = readSlotOccupant(file);
    if (occupant.state !== 'valid' || occupant.token !== token) return;
    mutationOps.unlink(file);
  }, lockTiming);
}

/**
 * B-137a F-119: BEST-EFFORT release for `finally` blocks.
 *
 * Two correct-but-opposed requirements meet here:
 *   1. A release failure must be OBSERVABLE, not a silent capacity leak --
 *      releaseProviderProcessSlot therefore throws, and a registry smoke pins
 *      that ("slot unlink mutation failure must be observable instead of
 *      silently leaking capacity").
 *   2. Every production release happens in a bare `finally` (host-run,
 *      autopilot-executor, codex-review-leaf, provider-process-admission), and
 *      a throw from `finally` REPLACES the in-flight exception -- hiding the
 *      real provider failure -- or turns a successful run into a hard error.
 *      host-run.ts's original releaseSlot wrapped its body in try/catch for
 *      exactly this reason; a refactor dropped that.
 *
 * Swallowing inside the primitive would satisfy (2) by destroying (1). So the
 * primitive keeps throwing and `finally` callers use this wrapper, which
 * reports the failure through onFailure instead of hijacking control flow.
 * Capacity is still reclaimable: pid-death detection and the orphan backstop
 * recover a leaked slot, whereas a masked exception is unrecoverable.
 */
export function releaseProviderProcessSlotBestEffort(
  file: string | null,
  token: string | null,
  onFailure: (error: unknown) => void = defaultReleaseFailureReporter,
  lockTiming: ProviderRegistryLockTiming = {},
  mutationOps: ProviderRegistryMutationOps = DEFAULT_PROVIDER_REGISTRY_MUTATION_OPS,
): void {
  try {
    releaseProviderProcessSlot(file, token, lockTiming, mutationOps);
  } catch (error) {
    // Never rethrow: this runs in finally. Reporting must not fail either.
    try {
      onFailure(error);
    } catch { /* a broken reporter must not mask the caller's exception */ }
  }
}

function defaultReleaseFailureReporter(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `⚠ provider process slot release failed (capacity is reclaimed by pid-death / orphan backstop): ${detail}\n`,
  );
}

export function transferProviderProcessSlotToProvider(
  file: string | null,
  token: string | null,
  identity: {
    pid: number;
    pgid: number | null;
    spawnedAt: string;
    startFingerprint: string | null;
    processGroupIsolated: boolean;
  },
  lockTiming: ProviderRegistryLockTiming = {},
): boolean {
  if (!file || !token) return false;
  if (
    !Number.isInteger(identity.pid) || identity.pid <= 0
    || !identity.processGroupIsolated
    || !Number.isInteger(identity.pgid) || (identity.pgid ?? 0) <= 0
  ) return false;
  const dir = dirname(file);
  return withProviderRegistryLock(dir, () => {
    const occupant = readSlotOccupant(file);
    if (occupant.state !== 'valid' || occupant.token !== token) return false;
    const next: ProviderProcessSlotFileMeta = {
      ...(occupant.meta as unknown as ProviderProcessSlotFileMeta),
      pid: identity.pid,
      providerPid: identity.pid,
      providerPgid: identity.pgid!,
      providerSpawnedAt: identity.spawnedAt,
      providerStartFingerprint: identity.startFingerprint ?? undefined,
      providerProcessGroupIsolated: true,
      token,
    };
    const temporary = `${file}.${token}.transfer`;
    writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      // Registry lock + exact token check makes this replacement ownership-safe.
      renameSync(temporary, file);
    } finally {
      try { unlinkSync(temporary); } catch { /* rename already consumed it */ }
    }
    return true;
  }, lockTiming);
}

export type ProviderExecutionSurfaceStatus =
  | 'managed'
  | 'admission_only'
  | 'adapter_only'
  | 'readiness_probe'
  | 'legacy_unmanaged';

export interface ProviderExecutionSurface {
  path: string;
  status: ProviderExecutionSurfaceStatus;
  admissionOwner: string | null;
  note: string;
}

/**
 * Conservative source classifier used by the contract smoke. Any production
 * file that imports a provider adapter, is itself an adapter, or combines a
 * child-process API with provider vocabulary must have an explicit inventory
 * row. False positives are classified, never silently excluded, so adding a
 * new direct provider spawn in a new file makes the contract fail closed.
 */
export function isProviderExecutionSurfaceCandidate(relativePath: string, source: string): boolean {
  if (!relativePath.endsWith('.ts')) return false;
  if (/(?:^|\/)(?:tasks|tests|generated)(?:\/|$)/.test(relativePath)) return false;
  if (relativePath === 'core/provider-process-registry.ts') return false;
  if (/^providers\/(?:codex-cli|claude-cli|gemini-cli)\.ts$/.test(relativePath)) return true;
  if (/providers\/(?:codex-cli|claude-cli|gemini-cli)\.js/.test(source)) return true;
  if (/\brunHostRun\s*\(/.test(source)) return true;
  // B-137a: strip documentation filename references before the provider-word
  // scan. The words are matched case-insensitively, so a prose citation of
  // "CLAUDE.md" (the project convention doc, referenced by many core modules)
  // read as a provider reference: any file that both used child_process for git
  // and cited that doc became an "unclassified provider execution surface".
  // scope-contract.ts tripped exactly this way on a comment citing the handler
  // convention -- a docs citation, not a provider workload. Several already
  // inventoried files (audit-scan, audit-trigger, rollout-check,
  // runtime-environment-checks) match for the same non-reason. Stripping only
  // "<provider>.md" filenames keeps every real provider reference intact,
  // including CLAUDE_CLI, claudeCli, 'claude' and providers/claude-cli.js.
  const withoutDocReferences = source.replace(/\b(?:codex|claude|agy|gemini|antigravity)\.md\b/gi, '');
  // Demand a real child-process launch whose *argument* carries provider
  // identity. A module can legitimately run Git (or its own lifecycle hooks)
  // while describing Codex or Claude elsewhere in comments and diagnostics;
  // treating that co-occurrence as a provider launch made the inventory claim
  // false positives. Preserve identifier forms such as `claudeCli`, command
  // variables such as `const command = 'codex'; spawn(command)`, and the
  // common mapping/resolver forms by tracing the first argument one bounded
  // lexical hop before classifying an otherwise unresolved launch conservatively.
  const importsChildProcess = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*)(['"])(?:node:)?child_process\1/.test(source);
  if (!importsChildProcess) return false;
  const launchApi = '(?:spawn|spawnSync|execFile|execFileSync|execSync|exec)';
  const launchApiNames = new Set<string>();
  const aliasNames = new Set<string>();
  const bindDirectChildProcessLaunchApis = (bindings: string): void => {
    for (const binding of bindings.split(',')) {
      const match = binding.trim().match(/^(spawn|spawnSync|execFile|execFileSync|execSync|exec)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!match) continue;
      launchApiNames.add(match[2] ?? match[1]!);
    }
  };
  // Only propagate a bare `spawn`/`exec*` assignment when that identifier was
  // actually bound from child_process. A file may import `execFile` while its
  // own unrelated `spawn` factory is in scope; treating that local name as the
  // Node API would create a false provider-execution surface.
  const childProcessNamedImport = /\bimport\s*\{([^}]*)\}\s*from\s*(['"])(?:node:)?child_process\2/g;
  const childProcessRequireDestructure = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*(['"])(?:node:)?child_process\2\s*\)/g;
  for (const pattern of [childProcessNamedImport, childProcessRequireDestructure]) {
    for (const match of withoutDocReferences.matchAll(pattern)) bindDirectChildProcessLaunchApis(match[1]!);
  }
  const aliasPatterns = [
    new RegExp(`\\b${launchApi}\\s+as\\s+([A-Za-z_$][\\w$]*)`, 'g'),
    new RegExp(`\\b${launchApi}\\s*:\\s*([A-Za-z_$][\\w$]*)`, 'g'),
    new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[A-Za-z_$][\\w$]*\\s*\\.\\s*${launchApi}\\b`, 'g'),
  ];
  for (const pattern of aliasPatterns) {
    for (const match of withoutDocReferences.matchAll(pattern)) aliasNames.add(match[1]!);
  }
  // Comments are not launch sites. Strip them only after collecting import and
  // alias bindings, because an import / alias itself is source syntax rather
  // than a comment-derived provider word.
  const launchSource = withoutDocReferences.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
  // A direct API import may be assigned to a local launch variable before it
  // is called (`const launch = spawn; launch('codex')`).  This is still a
  // child_process execution surface, not an application-level wrapper. Follow
  // only identifier-to-identifier assignments and only while their right side
  // is a known launch API/alias; the bounded fixed point covers a short alias
  // chain without treating arbitrary assignments as process launchers.
  const aliasAssignment = /\b([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g;
  for (let pass = 0; pass < 4; pass += 1) {
    let added = false;
    for (const match of launchSource.matchAll(aliasAssignment)) {
      const [, assignedName, sourceName] = match;
      if (!assignedName || !sourceName || aliasNames.has(assignedName)) continue;
      if (launchApiNames.has(sourceName) || aliasNames.has(sourceName)) {
        aliasNames.add(assignedName);
        added = true;
      }
    }
    if (!added) break;
  }
  const aliasApi = [...aliasNames].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const launchCallee = aliasApi.length > 0
    ? `(?:${launchApi}|[A-Za-z_$][\\w$]*\\s*\\.\\s*${launchApi}|${aliasApi})`
    : `(?:${launchApi}|[A-Za-z_$][\\w$]*\\s*\\.\\s*${launchApi})`;
  const providerToken = /(?:codex|claude|agy|gemini|antigravity)/i;
  const launchCall = new RegExp(`\\b${launchCallee}\\s*\\(\\s*([^,\\r\\n)]*)`, 'g');
  const sourceNamesProvider = (name: string): boolean => {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Bounded object-map lookup: `const PROVIDER_COMMAND = { codex: ... }`
    // plus `const command = PROVIDER_COMMAND[host]` must not hide a spawn.
    const objectMap = new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\s*=\\s*\\{[\\s\\S]{0,8192}?(?:codex|claude|agy|gemini|antigravity)`, 'i');
    if (objectMap.test(launchSource)) return true;
    // Bounded resolver lookup: `command = resolveProviderCommand(host)` and
    // a local resolver body with provider selection are likewise a provider
    // command even when no literal reaches spawn's first argument.
    const resolver = new RegExp(`\\b(?:function\\s+${escapedName}\\s*\\([^)]*\\)\\s*\\{|(?:const|let|var)\\s+${escapedName}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{?)[\\s\\S]{0,8192}?(?:codex|claude|agy|gemini|antigravity)`, 'i');
    return resolver.test(launchSource);
  };
  for (const match of launchSource.matchAll(launchCall)) {
    const firstArgument = match[1]!.trim();
    if (providerToken.test(firstArgument)) return true;
    // Handle direct forms too: `spawn(PROVIDER_COMMANDS[host], ...)` and
    // `spawn(resolveProviderCommand(host), ...)` do not allocate a neutral
    // local identifier for the one-hop initializer logic below.
    const directMapName = firstArgument.match(/^([A-Za-z_$][\w$]*)\s*(?:\[|\.)/)?.[1];
    if (directMapName && sourceNamesProvider(directMapName)) return true;
    const directResolverName = firstArgument.match(/^([A-Za-z_$][\w$]*)\s*\(/)?.[1];
    if (directResolverName && sourceNamesProvider(directResolverName)) return true;
    const identifier = firstArgument.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
    if (!identifier) continue;
    const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const initializer = new RegExp(`\\b(?:const|let|var)\\s+${escapedIdentifier}\\s*=\\s*([^;\\r\\n]+)`, 'i').exec(launchSource)?.[1];
    if (!initializer) continue;
    if (providerToken.test(initializer)) return true;
    const mapName = initializer.match(/^([A-Za-z_$][\w$]*)\s*(?:\[|\.)/)?.[1];
    if (mapName && sourceNamesProvider(mapName)) return true;
    const resolverName = initializer.match(/^([A-Za-z_$][\w$]*)\s*\(/)?.[1];
    if (resolverName && sourceNamesProvider(resolverName)) return true;
  }
  return false;
}

/** Auditable inventory; the source-contract smoke rejects unclassified spawns. */
export const PROVIDER_EXECUTION_SURFACES: readonly ProviderExecutionSurface[] = Object.freeze([
  { path: 'core/managed-host-run.ts', status: 'managed', admissionOwner: 'core/provider-process-registry.ts', note: 'Detached durable owner delegates its provider spawn through runHostRun.' },
  { path: 'core/host-run.ts', status: 'admission_only', admissionOwner: 'core/provider-process-registry.ts', note: 'Canonical low-level launch owns shared admission for every provider spawn while remaining outside ManagedHostRun durable lifecycle.' },
  { path: 'core/codex-review-leaf.ts', status: 'admission_only', admissionOwner: 'core/provider-process-registry.ts', note: 'Legacy standalone leaf remains bounded and admitted; formal durable review uses ManagedHostRun.' },
  { path: 'core/autopilot-executor.ts', status: 'admission_only', admissionOwner: 'core/provider-process-registry.ts', note: 'Repair provider is not a formal reviewer run but still acquires shared capacity.' },
  // B-137a main-merge fix: main renamed lattice-dispatch.ts ->
  // proof-or-stop-dispatch.ts, so this inventory entry no longer matched the
  // real file and the contract refused it as an unclassified provider surface.
  { path: 'core/proof-or-stop-dispatch.ts', status: 'admission_only', admissionOwner: 'core/provider-process-admission.ts', note: 'General Codex, Gemini, and Claude work dispatches are admitted but are not formal reviewer evidence.' },
  { path: 'core/planned-steps-executor.ts', status: 'admission_only', admissionOwner: 'core/provider-process-admission.ts', note: 'General planned and repair provider steps share admission without claiming durable review ownership.' },
  { path: 'core/acceptance-rollout.ts', status: 'readiness_probe', admissionOwner: null, note: 'Git/process verification only; provider words are evidence labels, not provider workloads.' },
  { path: 'core/audit-meta-store.ts', status: 'readiness_probe', admissionOwner: null, note: 'Git metadata probe only.' },
  { path: 'core/audit-scan.ts', status: 'readiness_probe', admissionOwner: null, note: 'Repository audit subprocesses only.' },
  { path: 'core/audit-trigger.ts', status: 'readiness_probe', admissionOwner: null, note: 'Audit trigger subprocesses only.' },
  { path: 'core/codex-adapter-checks.ts', status: 'readiness_probe', admissionOwner: null, note: 'Bounded Codex adapter/version verification; never review authority.' },
  { path: 'core/finding-verify.ts', status: 'readiness_probe', admissionOwner: null, note: 'Finding reproduction command probe only.' },
  { path: 'core/learning-store.ts', status: 'readiness_probe', admissionOwner: null, note: 'Git worktree discovery only.' },
  { path: 'core/proof-or-stop-parallel-wave.ts', status: 'readiness_probe', admissionOwner: null, note: 'Process helpers coordinate local wave state; provider labels do not launch reviewer workloads.' },
  { path: 'core/managed-assets.ts', status: 'readiness_probe', admissionOwner: null, note: 'Asset verification subprocesses only.' },
  { path: 'core/native-review-evidence.ts', status: 'readiness_probe', admissionOwner: null, note: 'Native-host provenance reads the live process ancestry; it never launches a provider workload.' },
  { path: 'core/review-escalation.ts', status: 'readiness_probe', admissionOwner: null, note: 'Git/evidence subprocess checks only; actual providers are launched elsewhere.' },
  { path: 'core/runtime-environment-checks.ts', status: 'readiness_probe', admissionOwner: null, note: 'Bounded environment/version probes only.' },
  { path: 'core/rollout-check.ts', status: 'readiness_probe', admissionOwner: null, note: 'Rollout Git checks only.' },
  { path: 'core/worktree-policy.ts', status: 'readiness_probe', admissionOwner: null, note: 'Git worktree policy probes only.' },
  { path: 'handlers/candidate-spec-routing.ts', status: 'admission_only', admissionOwner: 'core/provider-process-registry.ts', note: 'Semantic proposal routing calls runHostRun directly, so it receives canonical pre-spawn admission without claiming ManagedHostRun lifecycle ownership.' },
  { path: 'handlers/codex-adapter.ts', status: 'readiness_probe', admissionOwner: null, note: 'Exposes adapter verification, not provider review execution.' },
  { path: 'handlers/cross-host-review.ts', status: 'managed', admissionOwner: 'core/managed-host-run.ts', note: 'Cross-host Codex review submits or resumes one durable ManagedHostRun.' },
  { path: 'handlers/proof-or-stop-handoff.ts', status: 'readiness_probe', admissionOwner: null, note: 'Handoff serialization and Git inspection only.' },
  { path: 'handlers/quorum-submit.ts', status: 'readiness_probe', admissionOwner: null, note: 'Consumes signed reviewer facts; it never launches a provider.' },
  { path: 'handlers/review-preflight.ts', status: 'readiness_probe', admissionOwner: null, note: 'Preflight inspection only.' },
  { path: 'handlers/validate-lint.ts', status: 'readiness_probe', admissionOwner: null, note: 'Configured lint command execution only.' },
  { path: 'providers/codex-cli.ts', status: 'adapter_only', admissionOwner: null, note: 'Low-level bounded adapter; callers own shared admission.' },
  { path: 'providers/claude-cli.ts', status: 'adapter_only', admissionOwner: null, note: 'Low-level bounded adapter and probe; callers own shared admission.' },
  { path: 'providers/gemini-cli.ts', status: 'adapter_only', admissionOwner: null, note: 'Low-level bounded adapter; callers own shared admission.' },
  { path: 'core/host-execution-readiness.ts', status: 'readiness_probe', admissionOwner: null, note: 'Bounded capability probe, never a provider workload or review evidence.' },
  { path: 'index.ts', status: 'adapter_only', admissionOwner: null, note: 'Package export barrel references provider adapters but never launches a process.' },
  { path: 'init-assets.ts', status: 'adapter_only', admissionOwner: null, note: 'Generates host adapter scripts and documentation templates; template child-process text is not executed by this module.' },
]);

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  executeQuorumSmokeCase,
  quorumSmokeMinimalEnvironment,
  quorumSmokeProtectedRepositoryRoots,
  quorumSmokeRepositoryRoot,
  QUORUM_SMOKE_CALLBACK_TRACE_SCHEMA,
  type QuorumSmokeCaseRegistration,
} from './quorum-submit-smoke-case-catalog.js';
import { disposeQuorumSmokeFixtureRuntimePool } from './quorum-submit-smoke-fixture.js';

const RUN_SCHEMA = 'proof-or-stop.quorum-smoke-run.v1';
const REAL_SENTINELS = new Set(['qsm-009', 'qsm-013', 'qsm-046', 'qsm-063']);

export const MAX_QUORUM_SMOKE_JOBS = 8;
export const QUORUM_SMOKE_PARALLEL_CAPABILITY = {
  schema: 'proof-or-stop.quorum-smoke-parallel-capability.v1',
  shardCount: 4,
  workerModel: 'one-process-per-shard',
  tempIsolation: 'parent-owned-roots-v1',
} as const;

const RESOURCE_TRACE_SCHEMA = 'proof-or-stop.quorum-smoke-resource-trace.v1';
const WORKER_PROCESS_MARKER_ENV = 'PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER';

interface OwnedDirectory {
  path: string;
  dev: number;
  ino: number;
}

interface OwnedProcessGroup {
  pid: number;
  pgid: number;
  birthIdentity: string;
  marker: string;
  child: Pick<ChildProcess, 'pid' | 'spawnfile'>;
}

type ProcessKill = (pid: number, signal: NodeJS.Signals | 0) => void;
type WindowsTaskkill = (pid: number) => void;

export function signalQuorumSmokeProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  dependencies: {
    platform?: NodeJS.Platform;
    kill?: ProcessKill;
    taskkill?: WindowsTaskkill;
  } = {},
): 'signalled' | 'absent' {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('quorum smoke process-tree pid is invalid');
  const platform = dependencies.platform ?? process.platform;
  const kill = dependencies.kill ?? process.kill;
  const taskkill = dependencies.taskkill ?? ((target: number) => {
    execFileSync('taskkill', ['/PID', String(target), '/T', '/F'], {
      env: quorumSmokeMinimalEnvironment(),
      stdio: 'ignore',
    });
  });
  if (platform === 'win32' && (signal === 'SIGSTOP' || signal === 'SIGCONT')) {
    throw new Error(`quorum smoke refuses POSIX-only ${signal} on win32`);
  }
  try {
    if (platform === 'win32') taskkill(pid);
    else kill(-pid, signal);
    return 'signalled';
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return 'absent';
    throw new Error(`failed to signal quorum smoke process tree ${pid} on ${platform}`, { cause: error });
  }
}

export interface QuorumSmokeProcessIdentity {
  pid: number;
  ppid: number;
  birthIdentity: string;
  marker?: string;
  state?: string;
}

interface DescendantReaperDependencies {
  platform?: NodeJS.Platform;
  snapshot?: () => readonly QuorumSmokeProcessIdentity[];
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  taskkill?: WindowsTaskkill;
  pause?: (milliseconds: number) => Promise<void>;
  initialIdentities?: readonly QuorumSmokeProcessIdentity[];
  initialIdentitiesAreStopped?: boolean;
  marker?: string;
}

interface DescendantTracker {
  capture(): void;
  killCurrent(): void;
  freeze(): void;
  stop(): {
    identities: QuorumSmokeProcessIdentity[];
    healthy: boolean;
    identitiesAreStopped: boolean;
  };
}

function snapshotProcessIdentities(platform: NodeJS.Platform): QuorumSmokeProcessIdentity[] {
  if (platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process "
      + '| Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 2_000,
      env: quorumSmokeMinimalEnvironment(),
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
      throw new Error('could not snapshot Windows quorum smoke descendants', {
        cause: result.error ?? new Error(String(result.stderr ?? `exit ${result.status}`)),
      });
    }
    const raw = result.stdout.trim();
    if (raw.length === 0) return [];
    const parsed: unknown = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row: any) => ({
      pid: Number(row?.ProcessId),
      ppid: Number(row?.ParentProcessId),
      birthIdentity: String(row?.CreationDate ?? ''),
      marker: typeof row?.CommandLine === 'string' ? row.CommandLine : undefined,
    })).filter(row => row.pid !== result.pid);
  }
  const result = spawnSync('ps', ['eww', '-axo', 'pid=,ppid=,lstart=,state=,command='], {
    encoding: 'utf8',
    env: quorumSmokeMinimalEnvironment({ LC_ALL: 'C' }),
    maxBuffer: 8 * 1024 * 1024,
    timeout: 2_000,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('could not snapshot POSIX quorum smoke descendants', {
      cause: result.error ?? new Error(String(result.stderr ?? `exit ${result.status}`)),
    });
  }
  const rows: QuorumSmokeProcessIdentity[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.*?)\s*$/.exec(line);
    if (!match) throw new Error('POSIX process snapshot contained an unparseable row');
    const row = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      birthIdentity: match[3],
      state: match[4],
      marker: match[5],
    };
    if (row.pid !== result.pid) rows.push(row);
  }
  return rows;
}

function startDescendantTracker(
  rootPid: number,
  marker?: string,
  dependencies: DescendantReaperDependencies = {},
): DescendantTracker {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) {
    throw new Error('quorum smoke descendant-tracker root pid is invalid');
  }
  const platform = dependencies.platform ?? process.platform;
  const snapshot = dependencies.snapshot ?? (() => snapshotProcessIdentities(platform));
  const signal = dependencies.signal ?? ((pid: number, selectedSignal: NodeJS.Signals) => {
    process.kill(pid, selectedSignal);
  });
  const captured = new Map<string, QuorumSmokeProcessIdentity>();
  let healthy = true;
  let stopped = false;
  let frozen = false;
  let freezePerformed = false;
  const identityKey = (row: QuorumSmokeProcessIdentity): string => `${row.pid}:${row.birthIdentity}`;
  const capture = (): void => {
    if (stopped || freezePerformed) return;
    try {
      const rows = validatedProcessSnapshot(snapshot);
      for (const identity of ownedDescendantIdentities(rootPid, rows, marker)) {
        captured.set(identityKey(identity), identity);
      }
    } catch {
      healthy = false;
    }
  };
  capture();
  // PowerShell/CIM snapshots are materially heavier than ps snapshots.  Both
  // cadences are shorter than the bounded helper grace used by the worker
  // contract, and every captured identity is re-authenticated before signal.
  const interval = setInterval(capture, platform === 'win32' ? 1_250 : 750);
  interval.unref();
  return {
    capture,
    killCurrent: () => {
      if (stopped || freezePerformed || platform === 'win32') return;
      // Timeout/cancel cleanup must not manufacture stopped survivors. While
      // the worker root is still alive, repeatedly authenticate the current
      // descendant tree and kill leaves before their parents. Captured exact
      // identities remain available to the bounded post-terminal reaper.
      for (let round = 0; round < 3; round += 1) {
        try {
          const rows = validatedProcessSnapshot(snapshot);
          const current = ownedDescendantIdentities(rootPid, rows, marker)
            .filter(identity => !identity.state?.startsWith('Z'));
          for (const identity of current) captured.set(identityKey(identity), identity);
          if (current.length === 0) return;
          for (const identity of [...current].reverse()) {
            try {
              const freshRows = validatedProcessSnapshot(snapshot);
              const fresh = freshRows.find(row => row.pid === identity.pid);
              const stillOwned = fresh?.birthIdentity === identity.birthIdentity
                && ownedDescendantIdentities(rootPid, freshRows, marker).some(row => (
                  row.pid === identity.pid && row.birthIdentity === identity.birthIdentity
                ));
              if (stillOwned) signal(identity.pid, 'SIGKILL');
            } catch (error) {
              if (errorCode(error) !== 'ESRCH') healthy = false;
            }
          }
        } catch {
          healthy = false;
          return;
        }
      }
    },
    freeze: () => {
      if (stopped || freezePerformed) return;
      freezePerformed = true;
      try {
        const rows = validatedProcessSnapshot(snapshot);
        const current = ownedDescendantIdentities(rootPid, rows, marker);
        if (platform === 'win32') {
          for (const identity of current) captured.set(identityKey(identity), identity);
        } else {
          captured.clear();
          for (const identity of current) {
            try {
              process.kill(identity.pid, 'SIGSTOP');
              captured.set(identityKey(identity), identity);
            } catch (error) {
              if (errorCode(error) !== 'ESRCH') healthy = false;
            }
          }
          frozen = true;
        }
      } catch {
        healthy = false;
      }
    },
    stop: () => {
      if (!frozen) capture();
      stopped = true;
      clearInterval(interval);
      return {
        identities: [...captured.values()],
        healthy,
        identitiesAreStopped: frozen,
      };
    },
  };
}

function validatedProcessSnapshot(
  snapshot: () => readonly QuorumSmokeProcessIdentity[],
): QuorumSmokeProcessIdentity[] {
  const rows = [...snapshot()];
  const seen = new Set<number>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0
      || !Number.isSafeInteger(row.ppid) || row.ppid < 0
      || typeof row.birthIdentity !== 'string' || row.birthIdentity.length === 0
      || seen.has(row.pid)) {
      throw new Error('quorum smoke process snapshot has an invalid or duplicate identity');
    }
    seen.add(row.pid);
  }
  return rows;
}

function descendantIdentities(
  rootPid: number,
  rows: readonly QuorumSmokeProcessIdentity[],
): QuorumSmokeProcessIdentity[] {
  const byParent = new Map<number, QuorumSmokeProcessIdentity[]>();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const descendants: QuorumSmokeProcessIdentity[] = [];
  const visited = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent) ?? []) {
      if (visited.has(child.pid)) throw new Error('quorum smoke process snapshot contains a parent cycle');
      visited.add(child.pid);
      descendants.push(child);
      queue.push(child.pid);
    }
  }
  return descendants;
}

function ownedDescendantIdentities(
  rootPid: number,
  rows: readonly QuorumSmokeProcessIdentity[],
  marker?: string,
): QuorumSmokeProcessIdentity[] {
  const owned = new Map<number, QuorumSmokeProcessIdentity>();
  for (const identity of descendantIdentities(rootPid, rows)) owned.set(identity.pid, identity);
  if (marker) {
    for (const identity of rows) {
      if (identity.marker?.trim() === marker
        || identity.marker?.includes(`${WORKER_PROCESS_MARKER_ENV}=${marker}`)) {
        owned.set(identity.pid, identity);
      }
    }
  }
  owned.delete(rootPid);
  return [...owned.values()];
}

async function reapWorkerDescendants(
  rootPid = process.pid,
  dependencies: DescendantReaperDependencies = {},
  initialIdentities: readonly QuorumSmokeProcessIdentity[] = [],
  initialIdentitiesAreStopped = false,
  marker?: string,
): Promise<{ reaped: boolean; survivorPids: number[] }> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) {
    throw new Error('quorum smoke descendant-reaper root pid is invalid');
  }
  const platform = dependencies.platform ?? process.platform;
  const snapshot = dependencies.snapshot ?? (() => snapshotProcessIdentities(platform));
  const signal = dependencies.signal ?? ((pid: number, selectedSignal: NodeJS.Signals) => {
    process.kill(pid, selectedSignal);
  });
  const taskkill = dependencies.taskkill ?? ((pid: number) => {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      env: quorumSmokeMinimalEnvironment(),
      stdio: 'ignore',
    });
  });
  const pause = dependencies.pause ?? ((milliseconds: number) => new Promise(resolvePause => {
    setTimeout(resolvePause, milliseconds);
  }));
  const captured = new Map<string, QuorumSmokeProcessIdentity>();
  const stopped = new Set<string>();
  const strongWindowsCapture = new Set<string>();
  let operationFailed = false;
  const identityKey = (row: QuorumSmokeProcessIdentity): string => `${row.pid}:${row.birthIdentity}`;
  for (const identity of initialIdentities) {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 1
      || !Number.isSafeInteger(identity.ppid) || identity.ppid < 0
      || typeof identity.birthIdentity !== 'string' || identity.birthIdentity.length === 0) {
      throw new Error('quorum smoke initial descendant identity is invalid');
    }
    const key = identityKey(identity);
    captured.set(key, identity);
    if (initialIdentitiesAreStopped) stopped.add(key);
    if (platform === 'win32') strongWindowsCapture.add(key);
  }
  const authenticate = (identity: QuorumSmokeProcessIdentity): boolean => {
    const rows = validatedProcessSnapshot(snapshot);
    const current = rows.find(row => row.pid === identity.pid);
    if (!current || current.birthIdentity !== identity.birthIdentity) return false;
    const stillOwned = ownedDescendantIdentities(rootPid, rows, marker).some(row => (
      row.pid === identity.pid && row.birthIdentity === identity.birthIdentity
    ));
    if (stillOwned || stopped.has(identityKey(identity))
      || strongWindowsCapture.has(identityKey(identity))) return true;
    // POSIX ps eww carries the inherited per-worker UUID even after reparent.
    // A sampled pid/lstart pair alone is intentionally not authority to signal:
    // if neither live ancestry nor the current marker survives, cleanup fails
    // closed instead of risking a reused PID.
    return Boolean(marker
      && current.marker?.includes(`${WORKER_PROCESS_MARKER_ENV}=${marker}`));
  };
  const stopIdentity = (identity: QuorumSmokeProcessIdentity): void => {
    try {
      if (!authenticate(identity)) return;
      if (platform === 'win32') taskkill(identity.pid);
      else {
        signal(identity.pid, 'SIGSTOP');
        stopped.add(identityKey(identity));
      }
    } catch (error) {
      if (errorCode(error) !== 'ESRCH') operationFailed = true;
    }
  };
  let stableRounds = 0;
  for (let round = 0; round < 6 && stableRounds < 2; round += 1) {
    let descendants: QuorumSmokeProcessIdentity[];
    try {
      descendants = ownedDescendantIdentities(rootPid, validatedProcessSnapshot(snapshot), marker);
    } catch {
      return { reaped: false, survivorPids: [...new Set([...captured.values()].map(row => row.pid))] };
    }
    let additions = 0;
    for (const descendant of descendants) {
      const key = identityKey(descendant);
      if (!captured.has(key)) {
        captured.set(key, descendant);
        additions += 1;
      }
    }
    if (platform === 'win32') {
      const descendantPids = new Set(descendants.map(row => row.pid));
      for (const descendant of descendants) {
        if (descendant.ppid === rootPid || !descendantPids.has(descendant.ppid)) stopIdentity(descendant);
      }
    } else {
      for (const descendant of descendants) stopIdentity(descendant);
    }
    stableRounds = additions === 0 ? stableRounds + 1 : 0;
    await pause(15);
  }
  if (platform !== 'win32') {
    for (const identity of captured.values()) {
      try {
        if (authenticate(identity)) signal(identity.pid, 'SIGKILL');
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') operationFailed = true;
      }
    }
  }
  let survivorPids: number[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const rows = validatedProcessSnapshot(snapshot);
      const lateDescendants = ownedDescendantIdentities(rootPid, rows, marker);
      for (const descendant of lateDescendants) captured.set(identityKey(descendant), descendant);
      const currentByPid = new Map(rows.map(row => [row.pid, row]));
      const survivors = [...captured.values()].filter(identity => (
        currentByPid.get(identity.pid)?.birthIdentity === identity.birthIdentity
          && !currentByPid.get(identity.pid)?.state?.startsWith('Z')
      ));
      survivorPids = [...new Set(survivors.map(row => row.pid))];
      if (survivors.length === 0 && lateDescendants.length === 0) {
        return { reaped: !operationFailed, survivorPids: [] };
      }
      if (platform === 'win32') {
        const descendantPids = new Set(lateDescendants.map(row => row.pid));
        for (const descendant of lateDescendants) {
          if (descendant.ppid === rootPid || !descendantPids.has(descendant.ppid)) stopIdentity(descendant);
        }
        for (const survivor of survivors) {
          if (!lateDescendants.some(row => row.pid === survivor.pid)) stopIdentity(survivor);
        }
      } else {
        for (const survivor of survivors) {
          try {
            if (authenticate(survivor)) signal(survivor.pid, 'SIGKILL');
          } catch (error) {
            if (errorCode(error) !== 'ESRCH') operationFailed = true;
          }
        }
      }
    } catch {
      return { reaped: false, survivorPids };
    }
    await pause(25);
  }
  return { reaped: false, survivorPids };
}

export async function reapQuorumSmokeWorkerDescendants(
  rootPid = process.pid,
  dependencies: DescendantReaperDependencies = {},
): Promise<{ reaped: boolean; survivorPids: number[] }> {
  return reapWorkerDescendants(
    rootPid,
    dependencies,
    dependencies.initialIdentities ?? [],
    dependencies.initialIdentitiesAreStopped ?? false,
    dependencies.marker,
  );
}

interface CoordinatorOptions {
  registrations: readonly QuorumSmokeCaseRegistration[];
  jobs: number;
  timeoutMs: number;
  context?: Record<string, any>;
}

function traceSnapshot(path: unknown, label: string): { digest: string; lineCount: number } {
  if (typeof path !== 'string') {
    return { digest: createHash('sha256').update(Buffer.alloc(0)).digest('hex'), lineCount: 0 };
  }
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error(`${label} path must be absolute, normalized, and canonical`);
  }
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) && fsConstants.O_NOFOLLOW > 0
    ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.nlink !== 1
      || rebound.isSymbolicLink() || !rebound.isFile()
      || rebound.dev !== opened.dev || rebound.ino !== opened.ino || rebound.nlink !== 1) {
      throw new Error(`${label} changed before its identity-bound snapshot`);
    }
    const bytes = readFileSync(fd);
    const raw = bytes.toString('utf8');
    const lineCount = raw.length === 0 ? 0 : raw.split('\n').filter(Boolean).length;
    return { digest: createHash('sha256').update(bytes).digest('hex'), lineCount };
  } finally {
    closeSync(fd);
  }
}

function parseBoundTrace(raw: unknown, label: string): Record<string, any>[] {
  if (typeof raw !== 'string' || raw.length === 0 || !raw.endsWith('\n')) {
    throw new Error(`${label} raw bytes must be non-empty newline-terminated JSONL`);
  }
  const lines = raw.slice(0, -1).split('\n');
  if (lines.some(line => line.length === 0)) throw new Error(`${label} contains an empty JSONL row`);
  return lines.map((line, index) => {
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('row is not an object');
      return row as Record<string, any>;
    } catch (error) {
      throw new Error(`${label} row ${index + 1} is invalid JSON`, { cause: error });
    }
  });
}

function strictChild(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(rel);
}

function checkedDirectory(path: string, label: string): OwnedDirectory {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute normalized path`);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} must be a real directory`);
  const canonical = realpathSync(path);
  if (canonical !== path) throw new Error(`${label} must already be canonical`);
  return { path: canonical, dev: entry.dev, ino: entry.ino };
}

function removeTreeNoFollow(path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    unlinkSync(path);
    return;
  }
  for (const name of readdirSync(path)) removeTreeNoFollow(join(path, name));
  rmdirSync(path);
}

function assertOwnedDirectoryIdentity(owner: OwnedDirectory, label: string): void {
  const entry = lstatSync(owner.path);
  if (entry.isSymbolicLink() || !entry.isDirectory()
    || entry.dev !== owner.dev || entry.ino !== owner.ino
    || realpathSync(owner.path) !== owner.path) {
    throw new Error(`${label} identity changed before cleanup`);
  }
}

function removeOwnedDirectory(owner: OwnedDirectory, base: OwnedDirectory, label: string): void {
  assertOwnedDirectoryIdentity(base, 'quorum smoke parent-owned temp base');
  assertOwnedDirectoryIdentity(owner, label);
  if (!strictChild(base.path, owner.path)) throw new Error(`${label} escaped its parent-owned base`);
  removeTreeNoFollow(owner.path);
}

function removeOwnedBase(owner: OwnedDirectory, label: string): void {
  assertOwnedDirectoryIdentity(owner, label);
  removeTreeNoFollow(owner.path);
}

function pathIsAbsent(path: string, label: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    throw new Error(`${label} absence could not be established`, { cause: error });
  }
}

function createFreshOwnedDirectory(prefix: string, label: string): OwnedDirectory {
  const path = mkdtempSync(prefix);
  let provisional: OwnedDirectory | undefined;
  try {
    const entry = lstatSync(path);
    provisional = { path, dev: entry.dev, ino: entry.ino };
    return checkedDirectory(path, label);
  } catch (error) {
    if (!provisional) {
      try {
        const recovered = lstatSync(path);
        if (recovered.isSymbolicLink() || !recovered.isDirectory() || realpathSync(path) !== path) {
          throw new Error(`${label} allocation path cannot be safely re-identified`);
        }
        provisional = { path, dev: recovered.dev, ino: recovered.ino };
      } catch (identityError) {
        if (errorCode(identityError) === 'ENOENT') throw error;
        throw new Error(`${label} allocation identity is unknown; cleanup was refused`, {
          cause: new AggregateError([error, identityError]),
        });
      }
    }
    try {
      removeOwnedBase(provisional, `${label} failed allocation`);
    } catch (cleanupError) {
      throw new Error(`${label} allocation and cleanup both failed`, {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw error;
  }
}

function ancestorContainsGitControlEntry(path: string): boolean {
  let cursor = path;
  while (true) {
    try {
      lstatSync(join(cursor, '.git'));
      return true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw new Error('quorum smoke could not inspect ambient temp Git ancestry', { cause: error });
      }
    }
    try {
      const head = lstatSync(join(cursor, 'HEAD'));
      const objects = lstatSync(join(cursor, 'objects'));
      if (!head.isSymbolicLink() && head.isFile()
        && !objects.isSymbolicLink() && objects.isDirectory()) return true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw new Error('quorum smoke could not inspect ambient temp bare-Git ancestry', { cause: error });
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function ambientTempParentIsInsideGitRepository(path: string): boolean {
  const discovery = spawnSync(
    'git',
    ['--no-optional-locks', '-C', path, 'rev-parse', '--absolute-git-dir'],
    {
      encoding: 'utf8',
      env: quorumSmokeMinimalEnvironment({
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    },
  );
  if (discovery.error) {
    throw new Error('quorum smoke could not bound ambient temp Git discovery', {
      cause: discovery.error,
    });
  }
  if (discovery.status === 0) {
    const gitDirectory = discovery.stdout.trim();
    if (!gitDirectory || !isAbsolute(gitDirectory)) {
      throw new Error('quorum smoke ambient temp Git discovery returned a malformed boundary');
    }
    return true;
  }
  if (discovery.status === 128 && !ancestorContainsGitControlEntry(path)) return false;
  throw new Error(
    `quorum smoke ambient temp Git discovery failed closed (status ${String(discovery.status)})`,
  );
}

function createOwnedTempBase(): { base: OwnedDirectory; removeBase: boolean } {
  const inherited = process.env.PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE;
  const protectedRoots = quorumSmokeProtectedRepositoryRoots();
  const overlapsProtectedRoot = (path: string): boolean => protectedRoots.some(root => (
    containedBy(root, path) || containedBy(path, root)
  ));
  let base: OwnedDirectory;
  if (inherited) {
    base = checkedDirectory(inherited, 'quorum smoke owned temp base');
    if (overlapsProtectedRoot(base.path)) {
      throw new Error('quorum smoke owned temp base overlaps the repository or git common directory');
    }
    if (ambientTempParentIsInsideGitRepository(base.path)) {
      throw new Error('quorum smoke owned temp base overlaps an external Git repository');
    }
  } else {
    const tempParent = checkedDirectory(realpathSync(tmpdir()), 'quorum smoke ambient temp parent');
    // Refuse before mkdtemp: allocating and then deleting inside a worktree is
    // already a protected write even if the final tree looks unchanged. A temp
    // parent that merely CONTAINS a worktree (for example a managed review's
    // worktree registered under the shared TMPDIR) is not refused: the fresh
    // mkdtemp child below cannot be inside that sibling, and the created base is
    // still checked against every protected root in both directions.
    if (protectedRoots.some(root => containedBy(root, tempParent.path))) {
      throw new Error('quorum smoke ambient temp parent overlaps the repository or git common directory');
    }
    if (ambientTempParentIsInsideGitRepository(tempParent.path)) {
      throw new Error('quorum smoke ambient temp parent overlaps an external Git repository');
    }
    base = createFreshOwnedDirectory(
      join(tempParent.path, 'proof-or-stop-quorum-workers-'),
      'quorum smoke owned temp base',
    );
  }
  try {
    const repositoryRoot = realpathSync(process.cwd());
    if (base.path === repositoryRoot || strictChild(base.path, repositoryRoot) || strictChild(repositoryRoot, base.path)) {
      throw new Error('quorum smoke owned temp base overlaps the repository or git common directory');
    }
    if (overlapsProtectedRoot(base.path)) {
      throw new Error('quorum smoke owned temp base overlaps the repository or git common directory');
    }
    return { base, removeBase: !inherited };
  } catch (error) {
    if (!inherited) {
      try { removeOwnedBase(base, 'rejected quorum smoke owned temp base'); }
      catch (cleanupError) {
        throw new Error('quorum smoke owned temp base rejection cleanup failed', {
          cause: new AggregateError([error, cleanupError]),
        });
      }
    }
    throw error;
  }
}

function createWorkerRoot(base: OwnedDirectory, shardId: string): OwnedDirectory {
  assertOwnedDirectoryIdentity(base, 'quorum smoke parent-owned temp base');
  const safeShard = shardId.replace(/[^a-z0-9-]/gi, '-');
  const root = createFreshOwnedDirectory(join(base.path, `worker-${safeShard}-`), `worker ${shardId} temp root`);
  if (strictChild(base.path, root.path)) return root;
  try { removeOwnedDirectory(root, base, `escaped worker ${shardId} temp root`); }
  catch (cleanupError) {
    throw new Error('worker temp root escaped and could not be cleaned', { cause: cleanupError });
  }
  throw new Error('worker temp root escaped its parent-owned base');
}

function containedBy(root: string, candidate: string): boolean {
  return root === candidate || strictChild(root, candidate);
}

export interface QuorumSmokeProtectedMutationResult {
  clean: boolean;
  eventCount: number;
  paths: string[];
  errors: string[];
  baselineDigest: string;
  finalDigest: string;
  stateMatched: boolean;
  frameworkTracePaths: string[];
  /** Tolerated append-only host activity log writes (never counted in eventCount). */
  hostActivityPaths?: string[];
}

function protectedStateDigest(identities: readonly OwnedDirectory[]): string {
  const digest = createHash('sha256');
  const gitEnvironment = quorumSmokeMinimalEnvironment({
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
  });
  for (const identity of identities) {
    assertOwnedDirectoryIdentity(identity, 'quorum smoke protected-state root');
    digest.update(`${identity.path}\0${identity.dev}\0${identity.ino}\0`);
    try {
      const inside = execFileSync('git', ['--no-optional-locks', '-C', identity.path, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8', env: gitEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (inside !== 'true') throw new Error('not a worktree');
      digest.update(execFileSync(
        'git', ['--no-optional-locks', '-C', identity.path, 'rev-parse', 'HEAD'],
        { encoding: 'buffer', env: gitEnvironment, stdio: ['ignore', 'pipe', 'pipe'] },
      ));
      const staged = execFileSync(
        'git', ['--no-optional-locks', '-C', identity.path, 'ls-files', '--stage', '-z'],
        { encoding: 'buffer', env: gitEnvironment, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      digest.update(staged);
      const files = execFileSync(
        'git', ['--no-optional-locks', '-C', identity.path, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { encoding: 'utf8', env: gitEnvironment, stdio: ['ignore', 'pipe', 'pipe'] },
      ).split('\0').filter(Boolean);
      for (const name of files) {
        const candidate = resolve(identity.path, name);
        if (!containedBy(identity.path, candidate)) throw new Error('untracked path escaped worktree');
        let entry;
        try { entry = lstatSync(candidate); }
        catch (error) {
          if (errorCode(error) === 'ENOENT') {
            digest.update(`${name}\0missing\0`);
            continue;
          }
          throw error;
        }
        digest.update(`${name}\0${entry.mode}\0${entry.size}\0`);
        if (entry.isFile() && !entry.isSymbolicLink()) digest.update(readFileSync(candidate));
        else if (entry.isSymbolicLink()) digest.update(readlinkSync(candidate));
      }
    } catch {
      // Git common directories are not worktrees. Their top-level identity is
      // paired with recursive kernel events; refs/HEAD are additionally bound.
      for (const name of readdirSync(identity.path).sort()) {
        const candidate = join(identity.path, name);
        const entry = lstatSync(candidate);
        digest.update(`${name}\0${entry.mode}\0${entry.size}\0${entry.mtimeMs}\0`);
        if (entry.isFile() && !entry.isSymbolicLink()
          && (name === 'HEAD' || name === 'packed-refs')) digest.update(readFileSync(candidate));
      }
    }
  }
  return digest.digest('hex');
}

function authenticatedRuntimeTraceFragment(candidate: string, traceFile: string | undefined): boolean {
  if (!traceFile || !isAbsolute(traceFile) || resolve(traceFile) !== traceFile
    || dirname(candidate) !== dirname(traceFile) || !candidate.startsWith(`${traceFile}.`)) return false;
  const suffix = candidate.slice(traceFile.length + 1);
  const match = /^(\d+)\.(\d+)\.([a-f0-9]+)\.json$/.exec(suffix);
  if (!match) return false;
  try {
    const entry = lstatSync(candidate);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return false;
    const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>;
    return parsed.pid === Number(match[1]) && parsed.traceRoot === basename(traceFile);
  } catch {
    return false;
  }
}

/**
 * Host activity logs are gitignored, append-only bookkeeping written by host
 * tool hooks (for example a Claude Code PostToolUse logger) while an operator keeps
 * working in the same worktree. An append to one of them is not a smoke mutation.
 * Only appends are tolerated: each log present when the guard starts is snapshotted
 * (size + digest), and at close the file must still start with those exact bytes.
 * A log first created during the run is tolerated only at an enumerated location.
 * Any other path, a rewrite, a truncation or a look-alike name stays a mutation.
 */
const HOST_ACTIVITY_LOG_RELATIVE_PATHS = ['.proof-or-stop/activity.jsonl', 'docs/story/activity.jsonl'] as const;
const HOST_ACTIVITY_LOG_STORY_DIRS = ['.proof-or-stop/story/actives', 'docs/story/actives'] as const;

interface HostActivityLogBaseline { size: number; digest: string; dev: number; ino: number; mode: number; uid: number; gid: number }
/** 'absent' = proven missing; 'ineligible' = present but not a plain readable file, never exempt. */
type HostActivityLogState = HostActivityLogBaseline | 'absent' | 'ineligible';

/**
 * Read a host activity log by its own identity: no symlink is followed, only a regular
 * file is accepted, and the device/inode pair is returned so a later read can prove the
 * SAME file grew rather than a replacement carrying the original prefix.
 */
function readHostActivityLogFile(path: string): { bytes: Buffer; dev: number; ino: number; mode: number; uid: number; gid: number } | 'absent' | 'ineligible' {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'ineligible';
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return 'ineligible';
    return { bytes: readFileSync(fd), dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid };
  } catch {
    return 'ineligible';
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

function hostActivityLogCandidates(root: string): string[] {
  const candidates: string[] = HOST_ACTIVITY_LOG_RELATIVE_PATHS.map(path => join(root, path));
  for (const dir of HOST_ACTIVITY_LOG_STORY_DIRS) {
    let stories: string[] = [];
    try { stories = readdirSync(join(root, dir)); } catch { /* absent */ }
    for (const story of stories) candidates.push(join(root, dir, story, 'activity.jsonl'));
  }
  return candidates;
}

function isHostActivityLogPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate).split('\\').join('/');
  if ((HOST_ACTIVITY_LOG_RELATIVE_PATHS as readonly string[]).includes(rel)) return true;
  return HOST_ACTIVITY_LOG_STORY_DIRS.some(dir => new RegExp(`^${dir.replace(/[.]/g, '\\.')}/[^/]+/activity\\.jsonl$`).test(rel));
}

function snapshotHostActivityLogs(roots: readonly string[]): Map<string, HostActivityLogState> {
  const baselines = new Map<string, HostActivityLogState>();
  for (const root of roots) {
    for (const candidate of hostActivityLogCandidates(root)) {
      const read = readHostActivityLogFile(candidate);
      // Only a proven missing file is 'absent' (an append-created log is tolerated);
      // anything unreadable stays ineligible so it can never be exempted later.
      baselines.set(candidate, read === 'absent' || read === 'ineligible'
        ? read
        : {
          size: read.bytes.length, digest: createHash('sha256').update(read.bytes).digest('hex'),
          dev: read.dev, ino: read.ino, mode: read.mode, uid: read.uid, gid: read.gid,
        });
    }
  }
  return baselines;
}

/**
 * Does `current` extend `previous`? Same file (device, inode), same metadata, and
 * strictly more bytes whose prefix is unchanged.
 */
function hostActivityStateExtends(previous: HostActivityLogBaseline, current: { bytes: Buffer; dev: number; ino: number; mode: number; uid: number; gid: number }): boolean {
  if (current.dev !== previous.dev || current.ino !== previous.ino) return false;
  if (current.mode !== previous.mode || current.uid !== previous.uid || current.gid !== previous.gid) return false;
  if (current.bytes.length <= previous.size) return false;
  return createHash('sha256').update(current.bytes.subarray(0, previous.size)).digest('hex') === previous.digest;
}

function hostActivityStateOf(read: { bytes: Buffer; dev: number; ino: number; mode: number; uid: number; gid: number }): HostActivityLogBaseline {
  return {
    size: read.bytes.length, digest: createHash('sha256').update(read.bytes).digest('hex'),
    dev: read.dev, ino: read.ino, mode: read.mode, uid: read.uid, gid: read.gid,
  };
}

function isToleratedHostActivityAppend(
  root: string,
  candidate: string,
  baselines: ReadonlyMap<string, HostActivityLogState>,
): boolean {
  if (!isHostActivityLogPath(root, candidate) || !baselines.has(candidate)) return false;
  const baseline = baselines.get(candidate);
  if (baseline === undefined || baseline === 'ineligible') return false;
  const current = readHostActivityLogFile(candidate);
  if (current === 'absent' || current === 'ineligible') return false; // deleted, replaced by a link, or unreadable
  // Created during the run as a plain file: only a log that actually received a line
  // is an append; an empty creation is a mutation like any other.
  if (baseline === 'absent') return current.bytes.length > 0;
  // The same file must have grown, keeping its identity, metadata and prefix: a
  // replacement, an in-place rewrite or a metadata change is a structural mutation.
  return hostActivityStateExtends(baseline, current);
}

/**
 * Observe the caller-selected protected roots for the complete worker window.
 * A before/after status check cannot detect write-then-restore or
 * create-then-delete behavior; the watcher makes either action a negative
 * resource witness even when final bytes are clean.
 */
export function createQuorumSmokeProtectedMutationGuard(
  protectedRoots: readonly string[] = quorumSmokeProtectedRepositoryRoots(),
): { close(): Promise<QuorumSmokeProtectedMutationResult> } {
  if (!Array.isArray(protectedRoots) || protectedRoots.length === 0) {
    throw new Error('quorum smoke protected mutation guard requires repository roots');
  }
  const identities = [...new Set(protectedRoots)].map((root) => (
    checkedDirectory(root, 'quorum smoke protected mutation root')
  ));
  const watchers: FSWatcher[] = [];
  const paths = new Set<string>();
  const errors: string[] = [];
  let closed = false;
  const baselineDigest = protectedStateDigest(identities);
  const hostActivityBaselines = snapshotHostActivityLogs(identities.map(identity => identity.path));
  // Accepted limitation: this is observation-based, not operation-level attribution.
  // If the platform coalesces a destructive step and a later append into a single
  // notification, that sequence is indistinguishable from an append here. The durable
  // remedy is the host not writing into the repository during a validation at all.
  // Every observed state of an exempt log must extend the previous one. Comparing only
  // the final bytes cannot tell an append from a destructive rewrite followed by an
  // append; observing each notification catches the destructive step itself. A log whose
  // observed sequence ever breaks is tainted and can never be exempted afterwards.
  const hostActivityObserved = new Map<string, HostActivityLogState>(hostActivityBaselines);
  const hostActivityTainted = new Set<string>();
  const observeHostActivity = (root: string, candidate: string): void => {
    if (!isHostActivityLogPath(root, candidate) || !hostActivityObserved.has(candidate)) return;
    if (hostActivityTainted.has(candidate)) return;
    const previous = hostActivityObserved.get(candidate);
    const read = readHostActivityLogFile(candidate);
    if (read === 'absent') { hostActivityTainted.add(candidate); return; } // removed mid-run
    if (read === 'ineligible' || previous === undefined || previous === 'ineligible') {
      hostActivityTainted.add(candidate);
      return;
    }
    if (previous === 'absent' ? read.bytes.length === 0 : !hostActivityStateExtends(previous, read)) {
      hostActivityTainted.add(candidate);
      return;
    }
    hostActivityObserved.set(candidate, hostActivityStateOf(read));
  };
  try {
    for (const identity of identities) {
      const watcher = watch(identity.path, { recursive: true, persistent: false }, (eventType, filename) => {
        const candidate = filename === null ? identity.path : resolve(identity.path, String(filename));
        if (!containedBy(identity.path, candidate)) {
          errors.push(`watch event escaped protected root ${identity.path}`);
          return;
        }
        paths.add(candidate);
        observeHostActivity(identity.path, candidate);
        if (eventType !== 'change' && eventType !== 'rename') {
          errors.push(`unknown protected-root watch event ${String(eventType)}`);
        }
      });
      watcher.on('error', (error) => errors.push(
        `protected-root watcher failed for ${identity.path}: ${error.message}`,
      ));
      watchers.push(watcher);
    }
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw new Error('quorum smoke could not establish recursive protected-root watchers', { cause: error });
  }
  return {
    async close(): Promise<QuorumSmokeProtectedMutationResult> {
      if (closed) throw new Error('quorum smoke protected mutation guard was already closed');
      // Allow queued kernel notifications to reach JavaScript before closing.
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
      closed = true;
      for (const watcher of watchers) watcher.close();
      for (const identity of identities) {
        try { assertOwnedDirectoryIdentity(identity, 'quorum smoke protected mutation root'); }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      }
      let finalDigest = '';
      try { finalDigest = protectedStateDigest(identities); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      const exactFrameworkTracePaths = [...paths].filter(candidate => (
        authenticatedRuntimeTraceFragment(candidate, process.env.PROOF_OR_STOP_RUNTIME_TRACE_FILE)
      ));
      const traceDirectory = process.env.PROOF_OR_STOP_RUNTIME_TRACE_FILE
        ? dirname(process.env.PROOF_OR_STOP_RUNTIME_TRACE_FILE) : undefined;
      const frameworkTracePaths = [...paths].filter(candidate => (
        exactFrameworkTracePaths.includes(candidate)
          || (exactFrameworkTracePaths.length > 0 && candidate === traceDirectory)
      )).sort();
      const hostActivityPaths = [...paths].filter(candidate => identities.some(identity => (
        containedBy(identity.path, candidate)
          && !hostActivityTainted.has(candidate)
          && isToleratedHostActivityAppend(identity.path, candidate, hostActivityBaselines)
      )));
      const unownedPaths = [...paths]
        .filter(candidate => !frameworkTracePaths.includes(candidate) && !hostActivityPaths.includes(candidate))
        .sort();
      const stateMatched = baselineDigest === finalDigest;
      return {
        clean: unownedPaths.length === 0 && errors.length === 0 && stateMatched,
        eventCount: unownedPaths.length,
        paths: unownedPaths,
        errors,
        baselineDigest,
        finalDigest,
        stateMatched,
        frameworkTracePaths,
        hostActivityPaths: hostActivityPaths.sort(),
      };
    },
  };
}

export function validateQuorumSmokeResourceTrace({
  claims,
  trace,
  repositoryRoot,
  proof,
}: {
  claims: readonly Record<string, unknown>[];
  trace: Record<string, any>;
  repositoryRoot: string;
  proof: {
    expectedCaseIds: readonly string[];
    callbackEvents: readonly Record<string, any>[];
    callbackTraceRaw: string;
    report: Record<string, any>;
  };
}): void {
  const claim = claims[0];
  if (claims.length !== 1 || !claim
    || claim.class !== 'git-common-dir' || claim.key !== '.' || claim.access !== 'shared'
    || Object.keys(claim).sort().join(',') !== 'access,class,key') {
    throw new Error('quorum smoke resource claims must be the exact shared repository-read claim');
  }
  if (!proof || !Array.isArray(proof.expectedCaseIds) || proof.expectedCaseIds.length === 0
    || !Array.isArray(proof.callbackEvents) || !proof.report || typeof proof.report !== 'object') {
    throw new Error('resource trace requires trusted expected IDs, callback events, and parent report proof');
  }
  const expectedIds = [...proof.expectedCaseIds];
  const validExpectedCaseId = (id: unknown): id is string => typeof id === 'string'
    && (/^qsm-\d{3}$/.test(id) || /^quorum:scenario-[1-4]$/.test(id));
  if (new Set(expectedIds).size !== expectedIds.length
    || expectedIds.some(id => !validExpectedCaseId(id))) {
    throw new Error('resource trace trusted expected case identities are invalid');
  }
  const callbackEvents = parseBoundTrace(proof.callbackTraceRaw, 'trusted callback trace');
  const resourceAccesses = parseBoundTrace(trace.raw, 'trusted resource trace');
  if (JSON.stringify(callbackEvents) !== JSON.stringify(proof.callbackEvents)) {
    throw new Error('trusted callback trace raw bytes disagree with parsed callback events');
  }
  if (JSON.stringify(resourceAccesses) !== JSON.stringify(trace.accesses)) {
    throw new Error('trusted resource trace raw bytes disagree with parsed resource accesses');
  }
  const repository = checkedDirectory(repositoryRoot, 'resource trace repository root').path;
  if (typeof trace.ownedTempBase !== 'string') throw new Error('resource trace owned temp base is missing');
  const base = checkedDirectory(trace.ownedTempBase, 'resource trace owned temp base');
  if (containedBy(repository, base.path) || containedBy(base.path, repository)) {
    throw new Error('resource trace owned temp base overlaps the repository');
  }
  if (typeof trace.nonce !== 'string' || !trace.nonce
    || typeof trace.runId !== 'string' || !trace.runId
    || !Array.isArray(trace.ownedTempRoots) || trace.ownedTempRoots.length === 0
    || !Array.isArray(trace.accesses) || trace.accesses.length === 0) {
    throw new Error('resource trace envelope is incomplete');
  }
  const report = proof.report;
  const reportResults = Array.isArray(report.results) ? report.results : [];
  const reportShards = Array.isArray(report.shards) ? report.shards : [];
  const reportedIdentities = Array.isArray(report.ownedTempRootIdentities)
    ? report.ownedTempRootIdentities : [];
  const sorted = (values: readonly string[]): string[] => [...values].sort();
  if (report.schema !== RUN_SCHEMA || report.runId !== trace.runId
    || report.callbackTraceNonce !== trace.nonce || report.ok !== true || report.status !== 'PASS'
    || report.retryCount !== 0 || report.processTreeReaped !== true
    || report.orphanedDescendants !== false || !zeroResidue(report.residue)
    || report.protectedMutationGuard?.clean !== true
    || report.protectedMutationGuard?.eventCount !== 0
    || !Array.isArray(report.protectedMutationGuard?.paths)
    || report.protectedMutationGuard.paths.length !== 0
    || !Array.isArray(report.protectedMutationGuard?.errors)
    || report.protectedMutationGuard.errors.length !== 0
    || report.protectedMutationGuard?.stateMatched !== true
    || typeof report.protectedMutationGuard?.baselineDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(report.protectedMutationGuard.baselineDigest)
    || report.protectedMutationGuard?.finalDigest !== report.protectedMutationGuard.baselineDigest
    || !Array.isArray(report.protectedMutationGuard?.frameworkTracePaths)
    || report.callbackTraceDigest !== createHash('sha256').update(proof.callbackTraceRaw).digest('hex')
    || report.callbackTraceCount !== callbackEvents.length
    || report.resourceTraceDigest !== createHash('sha256').update(trace.raw).digest('hex')
    || report.resourceTraceCount !== resourceAccesses.length
    || report.ownedTempBase !== trace.ownedTempBase
    || !Array.isArray(report.ownedTempRoots)
    || JSON.stringify(sorted(report.ownedTempRoots)) !== JSON.stringify(sorted(trace.ownedTempRoots))
    || reportResults.length !== expectedIds.length
    || JSON.stringify(sorted(reportResults.map((row: Record<string, any>) => row.caseId)))
      !== JSON.stringify(sorted(expectedIds))) {
    throw new Error('resource trace proof does not bind the authentic parent run and exact case set');
  }
  const roots = trace.ownedTempRoots.map((value: unknown) => {
    if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value
      || !strictChild(base.path, value)) throw new Error('resource trace root escaped its owned temp base');
    if (!pathIsAbsent(value, `resource trace root ${value}`)) {
      throw new Error(`resource trace root was not cleaned: ${value}`);
    }
    return value;
  });
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (containedBy(roots[left], roots[right]) || containedBy(roots[right], roots[left])) {
        throw new Error('resource trace contains overlapping owned roots');
      }
    }
  }
  const identityByRoot = new Map<string, { dev: number; ino: number }>();
  for (const identity of reportedIdentities) {
    if (!identity || typeof identity.path !== 'string' || !roots.includes(identity.path)
      || !Number.isSafeInteger(identity.dev) || identity.dev < 0
      || !Number.isSafeInteger(identity.ino) || identity.ino <= 0
      || identityByRoot.has(identity.path)) {
      throw new Error('resource trace proof contains an invalid or duplicate allocated-root identity');
    }
    identityByRoot.set(identity.path, { dev: identity.dev, ino: identity.ino });
  }
  if (identityByRoot.size !== roots.length) {
    throw new Error('resource trace proof omitted a parent-allocated worker-root identity');
  }
  const shardByCase = new Map<string, { pid: number; root: string; dev: number; ino: number }>();
  for (const shard of reportShards) {
    const identity = identityByRoot.get(shard?.ownedTempRoot);
    if (!shard || typeof shard.shardId !== 'string' || !Array.isArray(shard.caseIds)
      || !Number.isSafeInteger(shard.workerPid) || shard.workerPid <= 1
      || !identity || shard.ownedTempRootDev !== identity.dev || shard.ownedTempRootIno !== identity.ino
      || shard.status !== 'PASS' || shard.attempts !== 1 || shard.retryCount !== 0
      || shard.processTreeReaped !== true || shard.orphanedDescendants !== false
      || !zeroResidue(shard.residue)) {
      throw new Error('resource trace proof contains an invalid shard/process/allocation binding');
    }
    for (const caseId of shard.caseIds) {
      if (!expectedIds.includes(caseId) || shardByCase.has(caseId)) {
        throw new Error('resource trace proof duplicates or invents a shard case binding');
      }
      shardByCase.set(caseId, {
        pid: shard.workerPid,
        root: shard.ownedTempRoot,
        dev: identity.dev,
        ino: identity.ino,
      });
    }
  }
  if (shardByCase.size !== expectedIds.length) {
    throw new Error('resource trace proof omitted an expected shard case binding');
  }
  const resultByCase = new Map<string, Record<string, any>>();
  for (const result of reportResults) {
    if (!result || resultByCase.has(result.caseId)) {
      throw new Error('resource trace proof contains duplicate result identities');
    }
    resultByCase.set(result.caseId, result);
  }
  const trustedCallbacks = new Map<string, {
    pid: number;
    start: number;
    end: number;
    root: string;
    dev: number;
    ino: number;
  }>();
  if (callbackEvents.length !== expectedIds.length * 2) {
    throw new Error('resource trace proof must contain exactly one callback start and end per case');
  }
  for (const caseId of expectedIds) {
    const result = resultByCase.get(caseId);
    const shard = shardByCase.get(caseId);
    const events = callbackEvents.filter(event => event?.caseId === caseId);
    const starts = events.filter(event => event.phase === 'start');
    const ends = events.filter(event => event.phase === 'end');
    const start = starts[0];
    const end = ends[0];
    if (!result || !shard || starts.length !== 1 || ends.length !== 1
      || events.some(event => event.schema !== QUORUM_SMOKE_CALLBACK_TRACE_SCHEMA
        || event.nonce !== trace.nonce || event.runId !== trace.runId)
      || result.status !== 'PASS' || result.attempts !== 1 || result.workerPid !== shard.pid
      || result.callbackTraceNonce !== trace.nonce
      || !Number.isSafeInteger(result.startedAtMs) || !Number.isSafeInteger(result.endedAtMs)
      || !Number.isSafeInteger(start?.atMs) || !Number.isSafeInteger(end?.atMs)
      || start.pid !== shard.pid || end.pid !== shard.pid || end.status !== 'PASS'
      || result.startedAtMs > start.atMs || start.atMs > end.atMs || end.atMs > result.endedAtMs) {
      throw new Error(`resource trace proof is not callback/result/shard bound for ${caseId}`);
    }
    trustedCallbacks.set(caseId, { ...shard, start: start.atMs, end: end.atMs });
  }
  if (callbackEvents.some(event => !expectedIds.includes(event?.caseId))) {
    throw new Error('resource trace proof contains an unexpected callback identity');
  }
  let repositoryReads = 0;
  let fixtureWrites = 0;
  const repositoryReadsByCase = new Map<string, number>();
  const callbackPids = new Map<string, number>();
  const rootIdentities = new Map<string, string>();
  for (const access of resourceAccesses) {
    if (!access || access.schema !== RESOURCE_TRACE_SCHEMA || access.nonce !== trace.nonce
      || access.runId !== trace.runId || typeof access.caseId !== 'string' || !expectedIds.includes(access.caseId)
      || !Number.isSafeInteger(access.pid) || access.pid <= 1
      || !Number.isSafeInteger(access.atMs) || access.atMs <= 0
      || !['read', 'write'].includes(access.op) || typeof access.path !== 'string'
      || !isAbsolute(access.path) || resolve(access.path) !== access.path
      || typeof access.workerRoot !== 'string' || !roots.includes(access.workerRoot)
      || !Number.isSafeInteger(access.workerRootDev) || access.workerRootDev < 0
      || !Number.isSafeInteger(access.workerRootIno) || access.workerRootIno <= 0) {
      throw new Error('resource trace access is malformed or not nonce/run/callback bound');
    }
    const trusted = trustedCallbacks.get(access.caseId);
    if (!trusted || access.pid !== trusted.pid || access.workerRoot !== trusted.root
      || access.workerRootDev !== trusted.dev || access.workerRootIno !== trusted.ino
      || access.atMs < trusted.start || access.atMs > trusted.end) {
      throw new Error(`resource trace access is not bound to trusted execution for ${access.caseId}`);
    }
    const rootIdentity = `${access.workerRootDev}:${access.workerRootIno}`;
    const priorIdentity = rootIdentities.get(access.workerRoot);
    if (priorIdentity !== undefined && priorIdentity !== rootIdentity) {
      throw new Error(`resource trace changed owned-root identity for ${access.workerRoot}`);
    }
    rootIdentities.set(access.workerRoot, rootIdentity);
    const priorPid = callbackPids.get(access.caseId);
    if (priorPid !== undefined && priorPid !== access.pid) {
      throw new Error(`resource trace changed worker pid inside callback ${access.caseId}`);
    }
    callbackPids.set(access.caseId, access.pid);
    const repositoryPath = containedBy(repository, access.path);
    if (repositoryPath) {
      if (access.resource !== 'repository' || access.op !== 'read') {
        throw new Error('resource trace attempted a repository write or mismapped repository access');
      }
      const canonical = realpathSync(access.path);
      if (!containedBy(repository, canonical)) throw new Error('resource trace repository read escaped by realpath');
      repositoryReads += 1;
      repositoryReadsByCase.set(access.caseId, (repositoryReadsByCase.get(access.caseId) ?? 0) + 1);
      continue;
    }
    if (access.resource === 'repository') {
      throw new Error('resource trace repository read escaped the repository');
    }
    if (access.resource !== 'fixture' || access.op !== 'write') {
      throw new Error('resource trace worker-temp access must be a fixture write');
    }
    if (!containedBy(access.workerRoot, access.path)) {
      throw new Error('resource trace fixture write escaped all worker-owned roots');
    }
    fixtureWrites += 1;
  }
  const directFixtures = Number(report.fixtureSummary?.directFixtures);
  const directFixtureCleanups = Number(report.fixtureSummary?.directFixtureCleanups);
  const expectedFixtureWrites = Number(report.fixtureSummary?.builds)
    + Number(report.fixtureSummary?.clones)
    + directFixtures;
  if (repositoryReads !== expectedIds.length
    || expectedIds.some(caseId => repositoryReadsByCase.get(caseId) !== 1)) {
    throw new Error('resource trace requires exactly one real repository read per expected callback');
  }
  if (!Number.isSafeInteger(directFixtures) || directFixtures < 0
    || !Number.isSafeInteger(directFixtureCleanups) || directFixtureCleanups !== directFixtures
    || !Number.isSafeInteger(expectedFixtureWrites) || expectedFixtureWrites <= 0
    || fixtureWrites !== expectedFixtureWrites) {
    throw new Error('resource trace fixture writes must exactly match parent fixture build and clone counts');
  }
  if (rootIdentities.size !== roots.length || readdirSync(base.path).length !== 0) {
    throw new Error('resource trace did not cover every cleaned worker root or left owned-base residue');
  }
}

function ownedProcessGroup(
  child: Pick<ChildProcess, 'pid' | 'spawnfile'>,
  marker: string,
): OwnedProcessGroup | undefined {
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || child.spawnfile !== process.execPath) {
    return undefined;
  }
  try {
    const identity = snapshotProcessIdentities(process.platform).find(row => row.pid === pid);
    if (!identity || !identity.marker?.includes(marker)) return undefined;
    return { pid, pgid: pid, birthIdentity: identity.birthIdentity, marker, child };
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function processGroupExists(owner: OwnedProcessGroup): boolean {
  if (owner.pid !== owner.pgid || owner.child.pid !== owner.pid || owner.pid <= 1) {
    throw new Error('quorum smoke worker process-group ownership changed');
  }
  try {
    process.kill(process.platform === 'win32' ? owner.pid : -owner.pgid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    throw new Error(`cannot establish worker process-group liveness: ${errorCode(error) ?? 'unknown error'}`, {
      cause: error,
    });
  }
}

function ownedProcessGroupLeaderIsCurrent(owner: OwnedProcessGroup): boolean {
  try {
    const current = snapshotProcessIdentities(process.platform).find(row => row.pid === owner.pid);
    return Boolean(current
      && current.birthIdentity === owner.birthIdentity
      && current.marker?.includes(owner.marker));
  } catch {
    return false;
  }
}

function signalOwnedProcessGroup(owner: OwnedProcessGroup, signal: NodeJS.Signals): boolean {
  if (!ownedProcessGroupLeaderIsCurrent(owner)) return false;
  try {
    return signalQuorumSmokeProcessTree(owner.pid, signal) === 'signalled';
  } catch { return false; }
}

async function waitForOwnedProcessGroupExit(owner: OwnedProcessGroup, attempts = 8): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (!processGroupExists(owner)) return true;
    } catch {
      return false;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return false;
}

async function reapOwnedProcessGroup(owner: OwnedProcessGroup | undefined): Promise<boolean> {
  if (!owner) return false;
  try {
    if (!processGroupExists(owner)) return true;
  } catch {
    return false;
  }
  if (!ownedProcessGroupLeaderIsCurrent(owner)) return false;
  if (!signalOwnedProcessGroup(owner, 'SIGTERM')) return false;
  if (await waitForOwnedProcessGroupExit(owner)) return true;
  if (!signalOwnedProcessGroup(owner, 'SIGKILL')) return false;
  return waitForOwnedProcessGroupExit(owner);
}

function createWorkerEnvironment(
  workerRoot: OwnedDirectory,
  workerEnv: Readonly<Record<string, string>>,
  workerProcessMarker: string,
  runId: string,
  fault?: { kind: string; caseId: string },
): Record<string, string> {
  for (const key of Object.keys(workerEnv)) {
    if (key.toUpperCase().startsWith('GIT_')) {
      throw new Error(`quorum smoke worker environment refuses ambient Git key ${key}`);
    }
  }
  const home = join(workerRoot.path, '.home');
  const xdgConfig = join(workerRoot.path, '.xdg-config');
  const template = join(workerRoot.path, '.git-template');
  const templateHooks = join(template, 'hooks');
  for (const [path, label] of [
    [home, 'worker HOME'],
    [xdgConfig, 'worker XDG config'],
    [template, 'worker Git template'],
    [templateHooks, 'worker Git template hooks'],
  ] as const) {
    mkdirSync(path, { mode: 0o700 });
    checkedDirectory(path, label);
  }
  const globalGitConfig = join(workerRoot.path, '.gitconfig');
  writeFileSync(globalGitConfig, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const inheritedNodeOptions = process.env.NODE_OPTIONS;
  const environment = quorumSmokeMinimalEnvironment({
    // The worker root is identified by the explicit --title argv below and by
    // WORKER_PROCESS_MARKER_ENV. Propagating that title through NODE_OPTIONS
    // rewrites every short-argv Node descendant and can truncate an enclosing
    // exact-HEAD process-tree marker before application code starts.
    NODE_OPTIONS: inheritedNodeOptions,
    PROOF_OR_STOP_RUNTIME_TRACE_FILE: process.env.PROOF_OR_STOP_RUNTIME_TRACE_FILE,
    PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER: process.env.PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER,
    CI: process.env.CI,
    ...workerEnv,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalGitConfig,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TEMPLATE_DIR: template,
    [WORKER_PROCESS_MARKER_ENV]: workerProcessMarker,
    PROOF_OR_STOP_QUORUM_SMOKE_RUN_ID: runId,
    PROOF_OR_STOP_QUORUM_SMOKE_REPOSITORY_ROOT: quorumSmokeRepositoryRoot(),
    ...(fault ? {
      PROOF_OR_STOP_QUORUM_SMOKE_FAULT_KIND: fault.kind,
      PROOF_OR_STOP_QUORUM_SMOKE_FAULT_CASE_ID: fault.caseId,
    } : {}),
  });
  return environment;
}

export function runQuorumSmokeWorkerProcess(
  executable: string,
  args: string[],
  runId: string,
  timeoutMs: number,
  workerEnv: Record<string, string>,
  abortSignal: AbortSignal,
  fault?: { kind: string; caseId: string },
): Promise<{
  status: number | null;
  output: string;
  pid: number;
  timedOut: boolean;
  cancelled: boolean;
  processTreeReaped: boolean;
  spawnError?: unknown;
}> {
  return new Promise((resolveWorker) => {
    const workerProcessMarker = `proof-or-stop-qsm-${randomUUID()}`;
    const ownedRootInput = workerEnv.PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE;
    if (!ownedRootInput) {
      throw new Error('quorum smoke worker process requires a parent-owned temp root');
    }
    const workerRoot = checkedDirectory(ownedRootInput, 'quorum smoke worker process temp root');
    const environment = createWorkerEnvironment(workerRoot, workerEnv, workerProcessMarker, runId, fault);
    const child = spawn(process.execPath, [`--title=${workerProcessMarker}`, executable, ...args], {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    const processGroup = ownedProcessGroup(child, workerProcessMarker);
    const descendantTracker = processGroup
      ? startDescendantTracker(processGroup.pid, workerProcessMarker)
      : undefined;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let terminationStarted = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const terminateChild = (reason: 'timeout' | 'cancel'): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      if (reason === 'timeout') timedOut = true;
      else cancelled = true;
      descendantTracker?.capture();
      // TERM-first avoids manufacturing an indefinitely stopped process if the
      // coordinator itself disappears during the grace window. The live
      // tracker first kills the currently authenticated descendants while the
      // root ancestry is still provable; every later group signal performs a
      // fresh birth-identity + marker check instead of reusing old authority.
      descendantTracker?.killCurrent();
      if (processGroup) signalOwnedProcessGroup(processGroup, 'SIGTERM');
      forceTimer ??= setTimeout(() => {
        descendantTracker?.capture();
        if (processGroup) signalOwnedProcessGroup(processGroup, 'SIGKILL');
      }, 250);
    };
    const onAbort = (): void => terminateChild('cancel');
    const removeHandlers = (): void => abortSignal.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => terminateChild('timeout'), timeoutMs);
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
    const finalizeWorker = async (
      status: number | null,
      spawnError?: unknown,
      boundedExit = false,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      removeHandlers();
      if (boundedExit) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      const pid = child.pid ?? 0;
      const tracked = descendantTracker?.stop()
        ?? { identities: [], healthy: false, identitiesAreStopped: false };
      const descendantCleanup = await reapWorkerDescendants(
        pid,
        {},
        tracked.identities,
        tracked.identitiesAreStopped,
        workerProcessMarker,
      ).catch(() => ({ reaped: false, survivorPids: [] }));
      const processGroupReaped = processGroup
        ? (await waitForOwnedProcessGroupExit(processGroup, 20))
        : child.pid === undefined;
      resolveWorker({
        status,
        output: Buffer.concat(chunks).toString('utf8'),
        pid,
        timedOut,
        cancelled,
        processTreeReaped: processGroupReaped && descendantCleanup.reaped && tracked.healthy,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    };
    child.once('error', (error) => { void finalizeWorker(null, error, true); });
    child.once('exit', (status) => setImmediate(() => { void finalizeWorker(status, undefined, true); }));
    child.once('close', (status) => { void finalizeWorker(status); });
  });
}

function zeroResidue(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const residue = value as Record<string, unknown>;
  return ['temp', 'process', 'ticket', 'quarantine'].every(key => residue[key] === 0);
}

function validateCliWorkerReport({
  report,
  worker,
  registrations,
  shardId,
  wholeShard,
  runId,
  callbackNonce,
  workerRoot,
}: {
  report: Record<string, any>;
  worker: Awaited<ReturnType<typeof runQuorumSmokeWorkerProcess>>;
  registrations: readonly QuorumSmokeCaseRegistration[];
  shardId: string;
  wholeShard: boolean;
  runId: string;
  callbackNonce?: string;
  workerRoot: OwnedDirectory;
}): Record<string, any>[] {
  const expectedById = new Map(registrations.map(registration => [registration.id, registration]));
  const rows = Array.isArray(report.results) ? report.results : [];
  const resultIds = rows.map((row: Record<string, any>) => row.caseId);
  const expectedShardId = wholeShard ? shardId : undefined;
  const envelopeValid = report.schema === RUN_SCHEMA && report.runId === runId
    && report.mode === 'worker' && report.coordinator === 'in-process'
    && report.executionKind === 'real-case-bodies' && report.parentPid === worker.pid
    && report.jobs === 1 && report.retryCount === 0
    && report.callbackTraceNonce === callbackNonce
    && report.shardId === expectedShardId
    && report.processTreeReaped === true && report.orphanedDescendants === false
    && zeroResidue(report.residue)
    && report.ownedTempBase === workerRoot.path
    && Array.isArray(report.ownedTempRoots) && report.ownedTempRoots.length === 0
    && typeof report.callbackTraceDigest === 'string' && /^[a-f0-9]{64}$/.test(report.callbackTraceDigest)
    && worker.spawnError === undefined && !worker.timedOut && !worker.cancelled && worker.processTreeReaped
    && rows.length === expectedById.size && new Set(resultIds).size === resultIds.length;
  const rowsValid = rows.every((row: Record<string, any>) => {
    const expected = expectedById.get(row.caseId);
    const pass = row.status === 'PASS';
    return Boolean(expected)
      && ['PASS', 'FAIL', 'TIMEOUT'].includes(row.status)
      && row.title === expected?.title && row.domain === expected?.domain && row.shard === expected?.shard
      && row.attempts === 1 && row.workerPid === worker.pid
      && Number.isSafeInteger(row.startedAtMs) && row.startedAtMs > 0
      && Number.isSafeInteger(row.endedAtMs) && row.endedAtMs >= row.startedAtMs
      && row.callbackTraceNonce === callbackNonce
      && (pass ? row.marker === `CASE_PASS ${row.caseId}` : row.marker === undefined);
  });
  const derivedStatus = rows.length > 0 && rows.every((row: Record<string, any>) => row.status === 'PASS')
    ? 'PASS'
    : rows.some((row: Record<string, any>) => row.status === 'TIMEOUT') ? 'TIMEOUT' : 'FAIL';
  const summary = report.fixtureSummary;
  const summaryValid = summary && typeof summary === 'object'
    && ['profiles', 'builds', 'clones', 'directFixtures', 'directFixtureCleanups']
      .every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0)
    && summary.directFixtureCleanups === summary.directFixtures
    && (summary.ownedTempBase === undefined || summary.ownedTempBase === workerRoot.path);
  const markerIds = worker.output.split(/\r?\n/)
    .filter(line => line.startsWith('CASE_PASS '))
    .map(line => line.slice('CASE_PASS '.length))
    .sort();
  const expectedMarkerIds = rows.filter((row: Record<string, any>) => row.status === 'PASS')
    .map((row: Record<string, any>) => row.caseId).sort();
  const sentinelIds = worker.output.split(/\r?\n/)
    .filter(line => /^REAL_SENTINEL qsm-\d{3}$/.test(line))
    .map(line => line.slice('REAL_SENTINEL '.length)).sort();
  const expectedSentinelIds = expectedMarkerIds.filter(id => REAL_SENTINELS.has(id)).sort();
  if (!envelopeValid || !rowsValid || !summaryValid
    || report.status !== derivedStatus || report.ok !== (derivedStatus === 'PASS')
    || (report.ok === true) !== (worker.status === 0)
    || JSON.stringify(markerIds) !== JSON.stringify(expectedMarkerIds)
    || JSON.stringify(sentinelIds) !== JSON.stringify(expectedSentinelIds)) {
    throw new Error(`quorum smoke worker shard ${shardId} returned an invalid report`);
  }
  return rows;
}

async function runCliShardCoordinator({
  registrations,
  jobs,
  timeoutMs,
  context,
  runId,
  callbackTrace,
  resourceTrace,
}: {
  registrations: readonly QuorumSmokeCaseRegistration[];
  jobs: number;
  timeoutMs: number;
  context: Record<string, any>;
  runId: string;
  callbackTrace?: { file: string; nonce: string };
  resourceTrace?: { file: string };
}): Promise<Record<string, any>> {
  const executable = process.argv[1];
  if (!executable) throw new Error('quorum smoke CLI path is unavailable');
  const groups = new Map<string, QuorumSmokeCaseRegistration[]>();
  for (const registration of registrations) {
    const group = groups.get(registration.shard) ?? [];
    group.push(registration);
    groups.set(registration.shard, group);
  }
  const work = [...groups.entries()];
  const workerRoots: OwnedDirectory[] = [];
  const resultsById = new Map<string, Record<string, any>>();
  const fixtureSummaries: Record<string, any>[] = [];
  const shardReports: Record<string, any>[] = [];
  const shardStates: Array<{
    shardId: string;
    registrations: QuorumSmokeCaseRegistration[];
    workerRoot?: OwnedDirectory;
    child?: Awaited<ReturnType<typeof runQuorumSmokeWorkerProcess>>;
    childReport?: Record<string, any>;
    childReportValidated?: boolean;
    failure?: unknown;
    tempCleaned?: boolean;
    processTreeReaped: boolean;
  }> = [];
  const abortController = new AbortController();
  let processTreeReaped = true;
  let interruptedExitCode: number | null = null;
  let nextIndex = 0;
  let active = 0;
  let maxConcurrent = 0;
  let stopped = false;
  let coordinatorFailure: unknown;
  let protectedMutationResult: QuorumSmokeProtectedMutationResult = {
    clean: false,
    eventCount: 0,
    paths: [],
    errors: ['protected mutation guard was not established'],
    baselineDigest: '',
    finalDigest: '',
    stateMatched: false,
    frameworkTracePaths: [],
  };

  const interrupt = (exitCode: number): void => {
    if (interruptedExitCode === null) {
      interruptedExitCode = exitCode;
      process.exitCode = exitCode;
    }
    stopped = true;
    abortController.abort();
  };
  const onTerminate = (): void => interrupt(143);
  const onInterrupt = (): void => interrupt(130);
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onInterrupt);
  let temp: ReturnType<typeof createOwnedTempBase> | undefined;
  let protectedMutationGuard: ReturnType<typeof createQuorumSmokeProtectedMutationGuard> | undefined;
  try {
    temp = createOwnedTempBase();
    assertOwnedDirectoryIdentity(temp.base, 'quorum smoke parent-owned temp base');
    if (readdirSync(temp.base.path).length !== 0) {
      throw new Error('quorum smoke owned temp base must be empty before worker allocation');
    }
    // The command declares shared access to the Git common directory, so writes
    // made there by an independent Story are not evidence that this smoke run
    // mutated its own checkout. Protect the active worktree itself; its digest
    // still binds HEAD, index, tracked bytes, and untracked bytes.
    protectedMutationGuard = createQuorumSmokeProtectedMutationGuard([
      quorumSmokeRepositoryRoot(),
    ]);
  } catch (error) {
    let terminalError = error;
    if (temp?.removeBase) {
      try { removeOwnedBase(temp.base, 'rejected quorum smoke parent-owned temp base'); }
      catch (cleanupError) {
        terminalError = new Error('quorum smoke temp-base setup and cleanup both failed', {
          cause: new AggregateError([error, cleanupError]),
        });
      }
    }
    process.removeListener('SIGTERM', onTerminate);
    process.removeListener('SIGINT', onInterrupt);
    throw terminalError;
  }
  if (!temp) throw new Error('quorum smoke parent-owned temp base was not initialized');

  const runShard = async (shardId: string, shardRegistrations: QuorumSmokeCaseRegistration[]): Promise<void> => {
    const state: (typeof shardStates)[number] = {
      shardId,
      registrations: shardRegistrations,
      processTreeReaped: true,
    };
    shardStates.push(state);
    const wholeShard = shardRegistrations.length > 1;
    const selector = wholeShard
      ? `--worker-shard=${shardId}`
      : `--worker-case=${shardRegistrations[0].id}`;
    const cumulativeTimeoutMs = wholeShard
      ? timeoutMs * shardRegistrations.length + 5_000
      : timeoutMs + 1_000;
    let spawnAttempted = false;
    try {
      state.workerRoot = createWorkerRoot(temp.base, shardId);
      workerRoots.push(state.workerRoot);
      spawnAttempted = true;
      const workerRun = await runQuorumSmokeWorkerProcess(executable, [
        selector,
        '--jobs=1',
        `--case-timeout-ms=${timeoutMs}`,
        '--report=json',
      ], runId, cumulativeTimeoutMs, {
        TMPDIR: state.workerRoot.path,
        TMP: state.workerRoot.path,
        TEMP: state.workerRoot.path,
        PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: state.workerRoot.path,
        ...(callbackTrace ? {
          PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: callbackTrace.file,
          PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: callbackTrace.nonce,
        } : {}),
        ...(resourceTrace ? {
          PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE: resourceTrace.file,
        } : {}),
        ...(process.env.PROOF_OR_STOP_QUORUM_SMOKE_FIXTURE_TRACE_FILE ? {
          PROOF_OR_STOP_QUORUM_SMOKE_FIXTURE_TRACE_FILE:
            process.env.PROOF_OR_STOP_QUORUM_SMOKE_FIXTURE_TRACE_FILE,
        } : {}),
        ...(process.env.PROOF_OR_STOP_DYN5_CASE ? {
          PROOF_OR_STOP_DYN5_CASE: process.env.PROOF_OR_STOP_DYN5_CASE,
        } : {}),
      }, abortController.signal, context.fault);
      state.child = workerRun;
      state.processTreeReaped = workerRun.processTreeReaped;
      processTreeReaped &&= workerRun.processTreeReaped;
      if (workerRun.spawnError !== undefined) {
        throw new Error(`worker shard ${shardId} could not spawn`, { cause: workerRun.spawnError });
      }
      const reportLines = workerRun.output.split(/\r?\n/)
        .filter(line => line.startsWith('QUORUM_SMOKE_RUN_JSON '));
      const forwarded = workerRun.output.split(/\r?\n/)
        .filter(line => line.length > 0 && !line.startsWith('QUORUM_SMOKE_RUN_JSON '));
      if (reportLines.length !== 1) {
        throw new Error(`worker shard ${shardId} emitted ${reportLines.length} terminal reports`);
      }
      const parsedReport: unknown = JSON.parse(reportLines[0].slice('QUORUM_SMOKE_RUN_JSON '.length));
      if (!parsedReport || typeof parsedReport !== 'object' || Array.isArray(parsedReport)) {
        throw new Error(`worker shard ${shardId} emitted a non-object terminal report`);
      }
      state.childReport = parsedReport as Record<string, any>;
      if (state.childReport.processTreeReaped !== true || state.childReport.orphanedDescendants !== false) {
        state.processTreeReaped = false;
        processTreeReaped = false;
      }
      const childResults = validateCliWorkerReport({
        report: state.childReport,
        worker: workerRun,
        registrations: shardRegistrations,
        shardId,
        wholeShard,
        runId,
        callbackNonce: callbackTrace?.nonce,
        workerRoot: state.workerRoot,
      });
      state.childReportValidated = true;
      for (const row of childResults) resultsById.set(row.caseId, row);
      if (state.childReport.fixtureSummary) fixtureSummaries.push(state.childReport.fixtureSummary);
      if (forwarded.length > 0) process.stdout.write(`${forwarded.join('\n')}\n`);
    } catch (error) {
      state.failure = error;
      // A cancelled worker normally cannot finish an authenticated child
      // report.  Report authenticity determines the shard verdict, while the
      // parent-owned process runner independently determines whether cleanup
      // succeeded; do not turn a missing report into invented process residue.
      if ((spawnAttempted && !state.child) || (state.child && !state.child.processTreeReaped)) {
        state.processTreeReaped = false;
        processTreeReaped = false;
      }
      const status = state.child?.timedOut ? 'TIMEOUT' : 'FAIL';
      const failedAtMs = Date.now();
      for (const registration of shardRegistrations) {
        if (resultsById.has(registration.id)) continue;
        resultsById.set(registration.id, {
          caseId: registration.id,
          title: registration.title,
          domain: registration.domain,
          shard: registration.shard,
          status,
          attempts: 1,
          workerPid: state.child?.pid ?? 0,
          error,
          startedAtMs: failedAtMs,
          endedAtMs: failedAtMs,
          callbackTraceNonce: callbackTrace?.nonce,
        });
      }
    }
    const shardResults = shardRegistrations.map(row => resultsById.get(row.id)).filter(Boolean);
    const shardOk = state.failure === undefined && state.childReport?.ok === true
      && shardResults.every(row => row?.status === 'PASS');
    if (!shardOk) {
      coordinatorFailure ??= state.failure ?? new Error(`quorum smoke shard ${shardId} failed`);
      stopped = true;
      abortController.abort();
    }
  };

  const runners = Array.from({ length: Math.min(jobs, work.length) }, async () => {
    while (!stopped && nextIndex < work.length) {
      const [shardId, shardRegistrations] = work[nextIndex];
      nextIndex += 1;
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      try { await runShard(shardId, shardRegistrations); }
      catch (error) {
        coordinatorFailure ??= error;
        stopped = true;
        abortController.abort();
      }
      finally { active -= 1; }
    }
  });
  let tempResidue = 0;
  try {
    await Promise.allSettled(runners);
    try {
      protectedMutationResult = await protectedMutationGuard!.close();
      if (!protectedMutationResult.clean) {
        coordinatorFailure ??= new Error(
          `quorum smoke observed protected repository mutation: ${[
            ...protectedMutationResult.paths,
            ...protectedMutationResult.errors,
          ].join(', ') || 'unknown mutation'}`,
        );
      }
    } catch (error) {
      coordinatorFailure ??= error;
      protectedMutationResult = {
        clean: false,
        eventCount: 0,
        paths: [],
        errors: [error instanceof Error ? error.message : String(error)],
        baselineDigest: '',
        finalDigest: '',
        stateMatched: false,
        frameworkTracePaths: [],
      };
    }
    for (const state of shardStates) {
      if (state.workerRoot && state.processTreeReaped) {
        try {
          removeOwnedDirectory(state.workerRoot, temp.base, `worker ${state.shardId} temp root`);
          state.tempCleaned = pathIsAbsent(state.workerRoot.path, `worker ${state.shardId} temp root`);
        } catch (error) {
          state.failure ??= error;
          coordinatorFailure ??= error;
          state.tempCleaned = false;
        }
      } else {
        state.tempCleaned = state.workerRoot === undefined;
      }
      const shardResults = state.registrations.map(row => resultsById.get(row.id)).filter(Boolean);
      const shardOk = state.failure === undefined && state.childReport?.ok === true && state.tempCleaned
        && shardResults.every(row => row?.status === 'PASS');
      const shardStatus = shardOk ? 'PASS'
        : shardResults.some(row => row?.status === 'TIMEOUT') || state.child?.timedOut ? 'TIMEOUT' : 'FAIL';
      shardReports.push({
        shardId: state.shardId,
        workerPid: state.child?.pid ?? 0,
        ownedTempRoot: state.workerRoot?.path,
        ownedTempRootDev: state.workerRoot?.dev,
        ownedTempRootIno: state.workerRoot?.ino,
        status: shardStatus,
        attempts: 1,
        retryCount: 0,
        caseIds: state.registrations.map(row => row.id),
        sentinelCaseIds: state.registrations.filter(row => REAL_SENTINELS.has(row.id)).map(row => row.id),
        startedAtMs: Math.min(...shardResults.map(row => Number(row?.startedAtMs ?? Date.now()))),
        endedAtMs: Math.max(...shardResults.map(row => Number(row?.endedAtMs ?? Date.now()))),
        processTreeReaped: state.processTreeReaped,
        orphanedDescendants: !state.processTreeReaped,
        residue: {
          temp: state.tempCleaned ? 0 : 1,
          process: state.processTreeReaped ? 0 : 1,
          ticket: 0,
          quarantine: 0,
        },
      });
      if (!shardOk) coordinatorFailure ??= state.failure ?? new Error(`quorum smoke shard ${state.shardId} failed`);
    }
    let baseEntryCount = 1;
    try {
      assertOwnedDirectoryIdentity(temp.base, 'quorum smoke parent-owned temp base');
      baseEntryCount = readdirSync(temp.base.path).length;
    }
    catch (error) { coordinatorFailure ??= error; }
    let remainingRoots = 0;
    for (const root of workerRoots) {
      try { if (!pathIsAbsent(root.path, 'worker temp root')) remainingRoots += 1; }
      catch (error) {
        coordinatorFailure ??= error;
        remainingRoots += 1;
      }
    }
    tempResidue = Math.max(remainingRoots, baseEntryCount);
    if (temp.removeBase && tempResidue === 0) {
      try { removeOwnedBase(temp.base, 'quorum smoke parent-owned temp base'); }
      catch (error) {
        coordinatorFailure ??= error;
        tempResidue = 1;
      }
    }
  } finally {
    process.removeListener('SIGTERM', onTerminate);
    process.removeListener('SIGINT', onInterrupt);
  }
  const results = registrations.map(registration => resultsById.get(registration.id)).filter(Boolean);
  const ok = interruptedExitCode === null && coordinatorFailure === undefined
    && results.length === registrations.length
    && results.every(row => row?.status === 'PASS')
    && shardReports.length === work.length && shardReports.every(row => row.status === 'PASS')
    && tempResidue === 0 && processTreeReaped;
  const status = ok ? 'PASS' : results.some((row) => row?.status === 'TIMEOUT') ? 'TIMEOUT' : 'FAIL';
  const callbackTraceSnapshot = traceSnapshot(callbackTrace?.file, 'quorum smoke callback trace');
  const resourceTraceSnapshot = traceSnapshot(resourceTrace?.file, 'quorum smoke resource trace');
  return {
    schema: RUN_SCHEMA,
    runId,
    ok,
    status,
    jobs,
    parentPid: process.pid,
    mode: context.mode,
    coordinator: 'default-parent',
    ...(context.shardId ? { shardId: context.shardId } : {}),
    retryCount: 0,
    executionKind: 'real-case-bodies',
    callbackTraceNonce: callbackTrace?.nonce,
    callbackTraceDigest: callbackTraceSnapshot.digest,
    callbackTraceCount: callbackTraceSnapshot.lineCount,
    resourceTraceDigest: resourceTraceSnapshot.digest,
    resourceTraceCount: resourceTraceSnapshot.lineCount,
    protectedMutationGuard: protectedMutationResult,
    ownedTempBase: temp.base.path,
    ownedTempRoots: workerRoots.map(root => root.path),
    ownedTempRootIdentities: workerRoots.map(root => ({ path: root.path, dev: root.dev, ino: root.ino })),
    fixtureSummary: {
      profiles: fixtureSummaries.reduce((sum, row) => sum + Number(row.profiles ?? 0), 0),
      builds: fixtureSummaries.reduce((sum, row) => sum + Number(row.builds ?? 0), 0),
      clones: fixtureSummaries.reduce((sum, row) => sum + Number(row.clones ?? 0), 0),
      directFixtures: fixtureSummaries.reduce((sum, row) => sum + Number(row.directFixtures ?? 0), 0),
      directFixtureCleanups: fixtureSummaries.reduce(
        (sum, row) => sum + Number(row.directFixtureCleanups ?? 0), 0,
      ),
      ownedTempBase: temp.base.path,
    },
    results,
    shards: shardReports,
    maxConcurrent,
    processTreeReaped,
    orphanedDescendants: !processTreeReaped,
    residue: { temp: tempResidue, process: processTreeReaped ? 0 : 1, ticket: 0, quarantine: 0 },
  };
}

export async function runQuorumSmokeCoordinator({
  registrations,
  jobs,
  timeoutMs,
  context = {},
}: CoordinatorOptions): Promise<Record<string, any>> {
  if (!Array.isArray(registrations) || registrations.length === 0) {
    throw new Error('quorum smoke coordinator refuses an empty registration plan; zero cases executed');
  }
  const registrationIds = new Set<string>();
  for (const registration of registrations) {
    if (!registration || typeof registration.id !== 'string' || registration.id.length === 0
      || registrationIds.has(registration.id) || typeof registration.shard !== 'string'
      || registration.shard.length === 0) {
      throw new Error('quorum smoke coordinator requires unique executable registrations with a shard');
    }
    registrationIds.add(registration.id);
  }
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > MAX_QUORUM_SMOKE_JOBS) {
    throw new Error(`quorum smoke jobs must be between 1 and ${MAX_QUORUM_SMOKE_JOBS}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('quorum smoke timeout must be positive');
  const runId = String(context.runId ?? process.env.PROOF_OR_STOP_QUORUM_SMOKE_RUN_ID ?? `qsm-${randomUUID()}`);
  const callbackTrace = context.callbackTrace ?? (
    process.env.PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE
      && process.env.PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE
      ? {
          file: process.env.PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE,
          nonce: process.env.PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE,
        }
      : undefined
  );
  const resourceTrace = context.resourceTrace ?? (
    process.env.PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE
      ? { file: process.env.PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE }
      : undefined
  );
  if (context.execution === 'cli' && context.mode !== 'worker') {
    return runCliShardCoordinator({ registrations, jobs, timeoutMs, context, runId, callbackTrace, resourceTrace });
  }
  const results: Record<string, any>[] = new Array(registrations.length);
  let nextIndex = 0;
  let active = 0;
  let maxConcurrent = 0;
  let processTreeReaped = true;
  let interruptedExitCode: number | null = null;
  const workerDescendantTracker = context.execution === 'cli' && context.mode === 'worker'
    ? startDescendantTracker(process.pid, process.env[WORKER_PROCESS_MARKER_ENV])
    : undefined;

  const runOne = async (registration: QuorumSmokeCaseRegistration, index: number): Promise<void> => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    try {
      const controller = new AbortController();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const execution = executeQuorumSmokeCase({ registration, context, signal: controller.signal, runId, callbackTrace });
      const timeout = new Promise<{ timeout: true }>((resolveTimeout) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolveTimeout({ timeout: true });
        }, timeoutMs);
      });
      const outcome = await Promise.race([
        execution.then((value) => ({ value })).catch((error: unknown) => ({ error })),
        timeout,
      ]);
      if (timer) clearTimeout(timer);
      if ('timeout' in outcome) {
        let error: unknown;
        try { await execution; } catch (caught) { error = caught; }
        const detail = error as Record<string, any> | undefined;
        results[index] = {
          caseId: registration.id, title: registration.title, domain: registration.domain,
          shard: registration.shard, status: 'TIMEOUT', attempts: 1, error,
          startedAtMs: detail?.startedAtMs ?? Date.now(), endedAtMs: detail?.endedAtMs ?? Date.now(),
          workerPid: detail?.workerPid ?? process.pid, callbackTraceNonce: callbackTrace?.nonce,
        };
      } else if ('error' in outcome) {
        const detail = outcome.error as Record<string, any>;
        results[index] = {
          caseId: registration.id, title: registration.title, domain: registration.domain,
          shard: registration.shard, status: timedOut ? 'TIMEOUT' : 'FAIL', attempts: 1, error: outcome.error,
          startedAtMs: detail.startedAtMs ?? Date.now(), endedAtMs: detail.endedAtMs ?? Date.now(),
          workerPid: detail.workerPid ?? process.pid, callbackTraceNonce: callbackTrace?.nonce,
        };
      } else {
        const completed = outcome.value;
        results[index] = {
          caseId: registration.id, title: registration.title, domain: registration.domain,
          shard: registration.shard, status: 'PASS', attempts: 1, value: completed.value,
          startedAtMs: completed.startedAtMs, endedAtMs: completed.endedAtMs,
          workerPid: completed.workerPid, marker: completed.marker,
          callbackTraceNonce: callbackTrace?.nonce,
        };
        if (context.execution === 'cli') {
          console.log(completed.marker);
          if (REAL_SENTINELS.has(registration.id)) console.log(`REAL_SENTINEL ${registration.id}`);
        }
      }
    } catch (error) {
      results[index] = {
        caseId: registration.id, title: registration.title, domain: registration.domain,
        shard: registration.shard, status: 'FAIL', attempts: 1, error,
      };
    } finally {
      active -= 1;
    }
  };

  const runners = Array.from({ length: Math.min(jobs, registrations.length) }, async () => {
    while (nextIndex < registrations.length && interruptedExitCode === null) {
      const index = nextIndex;
      nextIndex += 1;
      await runOne(registrations[index], index);
    }
  });
  await Promise.all(runners);
  let fixtureSummary = {
    profiles: 0,
    builds: 0,
    clones: 0,
    directFixtures: 0,
    directFixtureCleanups: 0,
  } as Record<string, any>;
  let fixtureCleanupError: unknown;
  if (context.mode === 'worker') {
    try {
      fixtureSummary = await disposeQuorumSmokeFixtureRuntimePool();
    } catch (error) {
      fixtureCleanupError = error;
      const lastResult = [...results].reverse().find(Boolean);
      if (lastResult) {
        lastResult.status = 'FAIL';
        lastResult.error = error;
      }
    }
  }
  let descendantCleanupError: unknown;
  if (context.execution === 'cli' && context.mode === 'worker') {
    try {
      workerDescendantTracker?.freeze();
      const tracked = workerDescendantTracker?.stop()
        ?? { identities: [], healthy: false, identitiesAreStopped: false };
      const cleanup = await reapWorkerDescendants(
        process.pid,
        {},
        tracked.identities,
        tracked.identitiesAreStopped,
        process.env[WORKER_PROCESS_MARKER_ENV],
      );
      processTreeReaped = cleanup.reaped && tracked.healthy;
      if (!processTreeReaped) {
        descendantCleanupError = new Error(
          `quorum smoke worker left descendants: ${cleanup.survivorPids.join(',') || 'unknown'}`,
        );
      }
    } catch (error) {
      processTreeReaped = false;
      descendantCleanupError = error;
    }
  }
  const terminalResults = results.filter(Boolean);
  const ok = fixtureCleanupError === undefined && descendantCleanupError === undefined
    && interruptedExitCode === null && terminalResults.length === registrations.length
    && terminalResults.every((row) => row.status === 'PASS') && processTreeReaped;
  const status = ok ? 'PASS' : terminalResults.some((row) => row.status === 'TIMEOUT') ? 'TIMEOUT' : 'FAIL';
  const callbackTraceSnapshot = traceSnapshot(callbackTrace?.file, 'quorum smoke callback trace');
  const resourceTraceSnapshot = traceSnapshot(resourceTrace?.file, 'quorum smoke resource trace');
  return {
    schema: RUN_SCHEMA,
    runId,
    ok,
    status,
    jobs,
    parentPid: process.pid,
    mode: context.mode,
    coordinator: context.execution === 'cli' && context.mode !== 'worker' ? 'default-parent' : 'in-process',
    ...(context.shardId ? { shardId: context.shardId } : {}),
    retryCount: 0,
    executionKind: 'real-case-bodies',
    callbackTraceNonce: callbackTrace?.nonce,
    callbackTraceDigest: callbackTraceSnapshot.digest,
    callbackTraceCount: callbackTraceSnapshot.lineCount,
    resourceTraceDigest: resourceTraceSnapshot.digest,
    resourceTraceCount: resourceTraceSnapshot.lineCount,
    ownedTempBase: process.env.PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE,
    ownedTempRoots: [],
    fixtureSummary,
    cleanupErrors: [fixtureCleanupError, descendantCleanupError]
      .filter((error): error is unknown => error !== undefined)
      .map(error => error instanceof Error ? error.message : String(error)),
    results: terminalResults,
    maxConcurrent,
    processTreeReaped,
    orphanedDescendants: !processTreeReaped,
    residue: { temp: 0, process: processTreeReaped ? 0 : 1, ticket: 0, quarantine: 0 },
  };
}

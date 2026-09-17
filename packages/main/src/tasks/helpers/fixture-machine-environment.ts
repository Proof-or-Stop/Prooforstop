/** Test-only machine-registry namespace. Never imported by production executors. */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIXTURE_MACHINE_PREFIX = 'proof-or-stop-fixture-machine-';
const FIXTURE_MACHINE_OWNER_SCHEMA = 'proof-or-stop.fixture-machine-owner.v1';

/**
 * Bounds for fixture machine directories retained after a failed run. A
 * retained directory is diagnosis material, so it is removed only when nothing
 * can still use it: its recorded owner process is gone and the grace period has
 * passed, or (legacy, no owner record) it has been untouched for legacyMinAgeMs.
 * A live owner, a symlink or an unrelated directory is never removed.
 */
export const FIXTURE_MACHINE_RETENTION = {
  deadOwnerGraceMs: 10 * 60_000,
  legacyMinAgeMs: 6 * 3_600_000,
  maxRetainedDeadOwner: 20,
} as const;

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Newest modification time anywhere under a retained root (bounded walk, symlinks not
 * followed). A process still using the directory touches nested queue and cache
 * files, so the root's own timestamps alone could make an active directory look idle.
 */
function newestMtimeMs(root: string, maxEntries = 20_000): number {
  let newest = lstatSync(root).mtimeMs;
  const pending = [root];
  let visited = 0;
  const vanished = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: string[];
    // An entry we cannot inspect may hold recent activity, so an incomplete scan
    // never authorizes deletion: only a confirmed disappearance is skipped.
    try { entries = readdirSync(dir); } catch (error) { if (vanished(error)) continue; return Number.POSITIVE_INFINITY; }
    for (const name of entries) {
      if (++visited > maxEntries) return Number.POSITIVE_INFINITY; // too large to judge: treat as recent
      const path = join(dir, name);
      try {
        const stat = lstatSync(path);
        newest = Math.max(newest, stat.mtimeMs);
        if (stat.isDirectory()) pending.push(path);
      } catch (error) { if (!vanished(error)) return Number.POSITIVE_INFINITY; }
    }
  }
  return newest;
}

const OWNER_RECORD_MAX_BYTES = 64 * 1024;

/**
 * Read a retained directory's owner record without following symlinks and without
 * ever blocking: a FIFO or device named owner.json would otherwise hang every
 * fixture creation, since pruning runs synchronously on the creation path.
 * Returns the parsed record, `undefined` when absent, and 'unsafe' when something
 * is there that cannot be read as a plain record - an unsafe candidate is kept.
 */
function readFixtureMachineOwner(path: string): { schema?: unknown; pid?: unknown } | undefined | 'unsafe' {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? undefined : 'unsafe';
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > OWNER_RECORD_MAX_BYTES) return 'unsafe';
    const buffer = Buffer.alloc(Number(stat.size));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return JSON.parse(buffer.subarray(0, read).toString('utf8')) as { schema?: unknown; pid?: unknown };
  } catch {
    return 'unsafe';
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Best-effort pruning of retained fixture machine directories under `parent`. Never throws. */
export function pruneRetainedFixtureMachines(
  parent: string = tmpdir(),
  options: { now?: number; exclude?: string } = {},
): { removed: string[] } {
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(parent).filter(name => name.startsWith(FIXTURE_MACHINE_PREFIX)); } catch { return { removed }; }
  const deadOwner: Array<{ path: string; mtimeMs: number }> = [];
  const remove = (path: string) => {
    try { rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); removed.push(path); } catch { /* best effort */ }
  };
  for (const name of names) {
    const path = join(parent, name);
    if (path === options.exclude) continue;
    try {
      if (!lstatSync(path).isDirectory()) continue; // symlinks and files are never followed or removed
      const owner = readFixtureMachineOwner(join(path, 'owner.json'));
      if (owner === 'unsafe') continue; // unreadable owner record: keep the directory
      const pid = typeof owner?.pid === 'number' ? owner.pid : undefined;
      const recognized = owner !== undefined && owner !== null
        && owner.schema === FIXTURE_MACHINE_OWNER_SCHEMA
        && pid !== undefined && Number.isSafeInteger(pid) && pid > 0;
      // Uncertain ownership never authorizes deletion: a present but unrecognized
      // record (unknown schema, wrong shape, unusable pid) keeps the directory. The
      // age rule applies only when no owner record exists at all (legacy directories).
      if (owner !== undefined && !recognized) continue;
      const age = now - newestMtimeMs(path);
      if (recognized) {
        if (processAlive(pid!) || age < FIXTURE_MACHINE_RETENTION.deadOwnerGraceMs) continue;
        deadOwner.push({ path, mtimeMs: now - age });
      } else if (age >= FIXTURE_MACHINE_RETENTION.legacyMinAgeMs) {
        remove(path);
      }
    } catch { /* unreadable entries are left alone */ }
  }
  deadOwner.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of deadOwner.slice(FIXTURE_MACHINE_RETENTION.maxRetainedDeadOwner)) remove(entry.path);
  return { removed };
}

export function createFixtureMachineEnvironment(): { env: NodeJS.ProcessEnv; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), FIXTURE_MACHINE_PREFIX));
  writeFileSync(join(root, 'owner.json'), JSON.stringify({ schema: FIXTURE_MACHINE_OWNER_SCHEMA, pid: process.pid, createdAtMs: Date.now() }), { mode: 0o600 });
  pruneRetainedFixtureMachines(tmpdir(), { exclude: root });
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const preload = join(root, 'preload.mjs');
  // A concrete path in the preload makes every descendant use the same pool.
  // HOME and os.homedir remain untouched: this isolates registries, not credentials.
  writeFileSync(preload, `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
const original = os.userInfo;
os.userInfo = (...args) => ({ ...original(...args), homedir: ${JSON.stringify(home)} });
syncBuiltinESMExports();
`, { mode: 0o600 });
  const flag = `--import=${pathToFileURL(preload).href}`;
  return {
    root,
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, flag].filter(Boolean).join(' ') },
    cleanup: () => {
      const entries = readdirSync(home, { recursive: true });
      if (entries.some(entry => /\.(ticket|choosing)$|(?:^|[\\/])slot-\d+\.json$/.test(String(entry)))) {
        throw new Error(`fixture machine still has admission records; retained ${root}`);
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Observe only the disposable fixture cache after its native children close. */
export function inspectFixtureCompileCache(directory: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      files++;
      bytes += statSync(join(entry.parentPath, entry.name)).size;
    }
  }
  return { files, bytes };
}

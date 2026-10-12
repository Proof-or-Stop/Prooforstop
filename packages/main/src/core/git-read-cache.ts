import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { gitEnvironmentRedirected } from './git-inert-environment.js';
import { envDerived, trackProcessEnvWrites } from './process-env-version.js';
import { currentRefStateWitness, gitFreshReadsActive } from './git-ref-witness-memo.js';
import { fallbackGlobalAttributes, fallbackSystemAttributes, gitReadKey, repositoryDirs, setupAnswerReusable, type AttributeLocations, type ReadKey } from './git-read-cache-keys.js';

/**
 * Lab framework-perf (old-PoS runs 59-61, framework-perf.md): one `next --run`
 * call runs every step in its own CLI process, and every process re-asked git
 * the same questions: in the lifecycle harness 55 % of all git child processes
 * (11-14 ms each, 57 % of CLI time) repeated an answer an earlier process or
 * an earlier gate of the same process already had. The per-process memos
 * (git-ref-witness-memo, git-object-read-memo, git-tree-observation) only
 * cover call sites routed through observedGit and die with the process.
 *
 * This module sits BELOW every call site: installed once at CLI start, it
 * wraps child_process.execFileSync / spawnSync for `git` and answers a read
 * only when git-read-cache-keys.ts names its exact witness (object ids, the
 * exact refs it names, a ref prefix, the repository setup, or the complete ref
 * state re-checked after the producing run). Every witness is recomputed from
 * the filesystem on every lookup. Keys also hold the real cwd, the full argv
 * and the environment (every variable except ones git never reads: PWD,
 * OLDPWD, SHLVL, _ and the framework's own PROOF_OR_STOP_* / LATTICE_* /
 * CODEX_* / npm_* / NODE_*).
 *
 * Answers persist under <common git dir>/info/proof-or-stop-cache/git-read-v1/
 * (info/: the ref-state witness stats the git directory itself but of info/
 * only grafts) so the following step's process reuses them; a torn or
 * corrupted line fails its digest and is ignored. Writing there grants
 * nothing new: a process that can write the git directory can already rewrite
 * the refs and objects these reads report.
 *
 * Never answered from the cache (git runs exactly as before): anything that
 * reads the index or working tree, failures (except a pure "no": exit 1 with
 * no output from `merge-base --is-ancestor` / `symbolic-ref -q`), signals,
 * timeouts, spawn or buffer errors, stdin-fed calls, calls whose stdout is not
 * piped, shell calls, a redirected git environment, signature-verification
 * formats (%G), answers larger than the caller's maxBuffer, and every read
 * inside withFreshGitReads / withoutGitObservation (launch-time rereads).
 * This is never a verdict cache: every gate still evaluates every rule; only
 * identical git bytes are reused.
 *
 * PROOF_OR_STOP_GIT_READ_CACHE=0 turns the cache off (spawn counting for the
 * next --run step diagnostics stays on); =memory keeps it process-local.
 */

type Buf = Buffer;
interface Entry { out: Buf; err: Buf | null; status: 0 | 1; attr?: string }
interface Store { entries: Map<string, Entry>; offset: number }
interface Plan { key: string; file: string; dir: string | null; read: ReadKey & { cwd: string; argv: string[]; bare: string[] } }

export const GIT_READ_CACHE_DIR = join('info', 'proof-or-stop-cache', 'git-read-v1');
const MAX_PERSIST_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES: Record<string, number> = { objects: 64 * 1024 * 1024, refs: 16 * 1024 * 1024, setup: 4 * 1024 * 1024 };
const MAX_REFS_FILES = 256;
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_BUFFER = 1024 * 1024;
const VOLATILE_ENV = /^(?:PWD|OLDPWD|SHLVL|_|PROOF_OR_STOP_.*|LATTICE_.*|CODEX_.*|npm_.*|NODE_.*)$/;

export interface GitSpawnCounters { gitSpawns: number; gitMs: number; gitCacheHits: number; otherSpawns: number; otherMs: number }
const counters: GitSpawnCounters = { gitSpawns: 0, gitMs: 0, gitCacheHits: 0, otherSpawns: 0, otherMs: 0 };
/** Child processes this process started (and git reads answered from the cache) since install. */
export function gitSpawnCounters(): GitSpawnCounters { return { ...counters }; }

const stores = new Map<string, Store>();
let memoryBytes = 0;
let installed = false;
let mode: 'off' | 'memory' | 'disk' = 'off';

export function gitReadCacheMode(env: NodeJS.ProcessEnv = process.env): 'off' | 'memory' | 'disk' {
  const raw = (env.PROOF_OR_STOP_GIT_READ_CACHE ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'off' || raw === 'false') return 'off';
  if (raw === 'memory') return 'memory';
  return 'disk';
}

const sha = (text: string | Buf) => createHash('sha256').update(text).digest('hex');

function envKey(env: NodeJS.ProcessEnv): string {
  const rows: string[] = [];
  for (const name of Object.keys(env)) {
    const value = env[name];
    if (value === undefined || VOLATILE_ENV.test(name)) continue;
    rows.push(`${name}=${value}`);
  }
  rows.sort();
  return sha(rows.join('\0'));
}
// Rebuilt only when process.env may have changed (process-env-version.ts).
const processEnvKey = envDerived(() => envKey(process.env));

function memoryStore(id: string): Store {
  let store = stores.get(id);
  if (!store) { store = { entries: new Map(), offset: 0 }; stores.set(id, store); }
  return store;
}

const lineDigest = (key: string, o: string, e: string | null, s: number, a: string | null) => sha(`${key}\0${o}\0${e ?? ''}\0${s}\0${a ?? ''}`).slice(0, 32);

/** Read lines other processes appended since this process last read the file. */
function refreshFromDisk(path: string, store: Store): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size <= store.offset) return;
    const chunk = Buffer.alloc(size - store.offset);
    const read = readSync(fd, chunk, 0, chunk.length, store.offset);
    const end = chunk.subarray(0, read).lastIndexOf(0x0a);
    if (end < 0) return;
    store.offset += end + 1;
    for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
      try {
        const row = JSON.parse(line) as { k: string; o: string; e: string | null; s?: number; a?: string | null; d: string };
        const status = row.s === 1 ? 1 : 0;
        const attr = typeof row.a === 'string' ? row.a : null;
        if (typeof row.k !== 'string' || typeof row.o !== 'string' || lineDigest(row.k, row.o, row.e, status, attr) !== row.d) continue;
        // A row with captured stderr serves every caller shape; one without serves stdout-only callers.
        const known = store.entries.get(row.k);
        if (!known || (known.err === null && row.e !== null) || (attr !== null && known.attr !== attr)) {
          remember(store, row.k, { out: Buffer.from(row.o, 'base64'), err: row.e === null ? null : Buffer.from(row.e, 'base64'), status, ...(attr !== null ? { attr } : {}) });
        }
      } catch { /* torn or foreign line: ignored */ }
    }
  } catch { /* no file yet or unreadable: memory only */ } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function remember(store: Store, key: string, entry: Entry): void {
  const bytes = entry.out.length + (entry.err?.length ?? 0) + key.length;
  if (memoryBytes + bytes > MAX_MEMORY_BYTES) return;
  store.entries.set(key, entry);
  memoryBytes += bytes;
}

function persist(plan: Plan, entry: Entry): void {
  if (!plan.dir) return;
  const size = entry.out.length + (entry.err?.length ?? 0);
  if (size > MAX_PERSIST_ENTRY_BYTES) return;
  try {
    const path = join(plan.dir, plan.file);
    let existing = 0;
    try { existing = statSync(path).size; } catch {
      mkdirSync(plan.dir, { recursive: true, mode: 0o700 });
      if (plan.file.startsWith('refs-')) pruneRefsFiles(plan.dir);
    }
    const cap = MAX_FILE_BYTES[plan.file.split(/[-.]/)[0]!] ?? MAX_FILE_BYTES.setup!;
    if (existing + size * 1.4 + 512 > cap) return;
    const o = entry.out.toString('base64');
    const e = entry.err === null ? null : entry.err.toString('base64');
    const a = entry.attr ?? null;
    appendFileSync(path, `${JSON.stringify({ k: plan.key, o, e, s: entry.status, ...(a !== null ? { a } : {}), d: lineDigest(plan.key, o, e, entry.status, a) })}\n`, { mode: 0o600 });
  } catch { /* the cache is an optimisation: never fail the call */ }
}

function pruneRefsFiles(dir: string): void {
  try {
    const files = readdirSync(dir).filter(name => name.startsWith('refs-'));
    if (files.length < MAX_REFS_FILES) return;
    const aged = files.map(name => { try { return { name, at: statSync(join(dir, name)).mtimeMs }; } catch { return { name, at: 0 }; } })
      .sort((a, b) => a.at - b.at);
    for (const row of aged.slice(0, Math.ceil(aged.length / 2))) try { unlinkSync(join(dir, row.name)); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

interface CallShape { cwd: string; env: NodeJS.ProcessEnv | undefined; encoding: BufferEncoding | 'buffer' | undefined; maxBuffer: number; stdoutIgnored: boolean; stderr: string; forwardsStderr: boolean }

function stdioOf(stdio: unknown, index: number): string {
  if (stdio === undefined || stdio === null) return 'pipe';
  if (typeof stdio === 'string') return stdio === 'overlapped' ? 'pipe' : stdio;
  if (Array.isArray(stdio)) {
    const value = stdio[index];
    if (value === undefined || value === null) return 'pipe';
    return typeof value === 'string' ? (value === 'overlapped' ? 'pipe' : value) : 'other';
  }
  return 'other';
}

/** The call's options when it is a cacheable shape, else undefined (git runs as is). */
function callShape(options: Record<string, unknown> | undefined, api: 'execFileSync' | 'spawnSync'): CallShape | undefined {
  const opts = options ?? {};
  if (opts.input !== undefined || opts.shell || opts.argv0 !== undefined || opts.uid !== undefined || opts.gid !== undefined) return undefined;
  const stdout = stdioOf(opts.stdio, 1);
  if (stdout !== 'pipe' && stdout !== 'ignore') return undefined;
  const stderr = stdioOf(opts.stdio, 2);
  if (stderr !== 'pipe' && stderr !== 'ignore' && !(api === 'execFileSync' && stderr === 'inherit')) return undefined;
  const env = opts.env as NodeJS.ProcessEnv | undefined;
  if (env !== undefined && (typeof env !== 'object' || env === null || gitEnvironmentRedirected(env))) return undefined;
  if (env === undefined && gitEnvironmentRedirected()) return undefined;
  const encoding = opts.encoding as CallShape['encoding'];
  if (encoding !== undefined && encoding !== 'buffer' && !Buffer.isEncoding(encoding)) return undefined;
  const maxBuffer = typeof opts.maxBuffer === 'number' && opts.maxBuffer > 0 ? opts.maxBuffer : DEFAULT_MAX_BUFFER;
  // execFileSync without a stdio option forwards the child's stderr to ours.
  const forwardsStderr = api === 'execFileSync' && (opts.stdio === undefined || stderr === 'inherit');
  const cwd = typeof opts.cwd === 'string' ? opts.cwd : opts.cwd instanceof URL ? opts.cwd.pathname : process.cwd();
  return { cwd, env, encoding, maxBuffer, stdoutIgnored: stdout === 'ignore', stderr, forwardsStderr };
}

let attributeLocations: AttributeLocations | undefined;

function planFor(args: readonly string[], shape: CallShape): Plan | undefined {
  if (mode === 'off' || gitFreshReadsActive()) return undefined;
  let read;
  try { read = gitReadKey(shape.cwd, args, attributeLocations); } catch { return undefined; }
  if (!read) return undefined;
  // A diff answer is reused only when its output paths' attributes can be witnessed: a stdout-ignored caller has no output to check.
  if (read.outputWitness && shape.stdoutIgnored) return undefined;
  const env = shape.env === undefined || shape.env === process.env ? processEnvKey() : envKey(shape.env);
  // An answer produced with stdout ignored has no bytes: it never serves a caller that reads stdout.
  const key = sha(JSON.stringify([read.kind, read.witness, read.cwd, read.argv, env, shape.stdoutIgnored]));
  return { key, file: read.file, dir: mode === 'disk' ? join(read.commonDir, GIT_READ_CACHE_DIR) : null, read };
}

function lookup(plan: Plan, shape: CallShape): Entry | undefined {
  const store = memoryStore(`${plan.dir ?? 'memory'}\0${plan.file}`);
  let entry = store.entries.get(plan.key);
  if (!entry && plan.dir) {
    refreshFromDisk(join(plan.dir, plan.file), store);
    entry = store.entries.get(plan.key);
  }
  if (!entry || entry.out.length > shape.maxBuffer || (entry.err && entry.err.length > shape.maxBuffer)) return undefined;
  if (plan.read.outputWitness) {
    let attr: string | undefined;
    try { attr = plan.read.outputWitness(entry.out); } catch { attr = undefined; }
    if (attr === undefined || attr !== entry.attr) return undefined;
  }
  return entry;
}

function keep(plan: Plan, produced: Entry): void {
  let entry = produced;
  if (entry.status === 1 && (!plan.read.refusalIsAnswer || entry.out.length || entry.err?.length)) return;
  if (plan.read.kind === 'setup' && !setupAnswerReusable(plan.read.bare, entry.out)) return;
  if (plan.read.outputWitness) {
    let attr: string | undefined;
    try { attr = plan.read.outputWitness(entry.out); } catch { attr = undefined; }
    if (attr === undefined) return;
    entry = { ...entry, attr };
  }
  if (plan.read.recheck) {
    const after = currentRefStateWitness(plan.read.recheck.cwd);
    if (!after || after.witness !== plan.read.recheck.value) return;
  }
  remember(memoryStore(`${plan.dir ?? 'memory'}\0${plan.file}`), plan.key, entry);
  persist(plan, entry);
}

const encode = (bytes: Buf, encoding: CallShape['encoding']): Buf | string =>
  encoding === undefined || encoding === 'buffer' ? Buffer.from(bytes) : bytes.toString(encoding);
const toBuffer = (value: unknown, encoding: CallShape['encoding']): Buf | null =>
  value === null || value === undefined ? null : Buffer.isBuffer(value) ? value : Buffer.from(String(value), encoding && encoding !== 'buffer' ? encoding : 'utf8');

/** The error execFileSync throws for a git exit 1 with no output (node's checkExecSyncError shape). */
function refusalError(file: string, argv: readonly string[], shape: CallShape): Error {
  const empty = shape.stdoutIgnored ? null : encode(Buffer.alloc(0), shape.encoding);
  const stderr = shape.stderr === 'ignore' ? null : encode(Buffer.alloc(0), shape.encoding);
  return Object.assign(new Error(`Command failed: ${[file, ...argv].join(' ')}`), { status: 1, signal: null, output: [null, empty, stderr], pid: 0, stdout: empty, stderr });
}

/** A git refusal this module may keep: exit 1, no signal, no output (callers get the same error again). */
function quietRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as { status?: unknown; signal?: unknown; code?: unknown; stdout?: unknown; stderr?: unknown };
  const empty = (value: unknown) => value === null || value === undefined || (typeof value === 'string' ? value.length === 0 : Buffer.isBuffer(value) && value.length === 0);
  return failure.status === 1 && (failure.signal === null || failure.signal === undefined) && failure.code === undefined && empty(failure.stdout) && empty(failure.stderr);
}

const isGit = (file: unknown) => typeof file === 'string' && (file === 'git' || basename(file) === 'git');

/**
 * Install once per process (CLI start, managed supervisor). Idempotent. Counts
 * the child processes it sees (for the next --run step diagnostics) even with
 * the cache off.
 */
export function installGitReadCache(env: NodeJS.ProcessEnv = process.env): void {
  if (installed) return;
  installed = true;
  mode = gitReadCacheMode(env);
  trackProcessEnvWrites();
  const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const originalExecFileSync = childProcess.execFileSync as unknown as (...args: unknown[]) => unknown;
  const originalSpawnSync = childProcess.spawnSync as unknown as (...args: unknown[]) => import('node:child_process').SpawnSyncReturns<Buffer | string>;
  const originalSpawn = childProcess.spawn as unknown as (...args: unknown[]) => import('node:child_process').ChildProcess;
  const count = (git: boolean, ms: number) => {
    if (git) { counters.gitSpawns++; counters.gitMs += ms; } else { counters.otherSpawns++; counters.otherMs += ms; }
  };
  const timed = <T>(git: boolean, run: () => T): T => {
    const started = performance.now();
    try { return run(); } finally { count(git, performance.now() - started); }
  };
  const split = (args: unknown, options: unknown): [string[] | undefined, Record<string, unknown> | undefined] =>
    Array.isArray(args) ? [args as string[], options as Record<string, unknown> | undefined]
      : [undefined, (args && typeof args === 'object' ? args : undefined) as Record<string, unknown> | undefined];

  function execFileSync(this: unknown, file: unknown, args?: unknown, options?: unknown): unknown {
    const git = isGit(file);
    const [argv, opts] = split(args, options);
    const passThrough = () => timed(git, () => originalExecFileSync.call(this, file, args, options));
    if (!git || !argv || argv.some(arg => typeof arg !== 'string')) return passThrough();
    const shape = callShape(opts, 'execFileSync');
    const plan = shape && planFor(argv, shape);
    if (!shape || !plan) return passThrough();
    const known = lookup(plan, shape);
    if (known) {
      counters.gitCacheHits++;
      if (known.status === 1) throw refusalError(file as string, argv, shape);
      if (shape.forwardsStderr && known.err?.length) process.stderr.write(known.err);
      return shape.stdoutIgnored ? null : encode(known.out, shape.encoding);
    }
    if (!shape.forwardsStderr) {
      let out: unknown;
      try { out = passThrough(); } catch (error) {
        if (plan.read.refusalIsAnswer && quietRefusal(error)) keep(plan, { out: Buffer.alloc(0), err: shape.stderr === 'ignore' ? null : Buffer.alloc(0), status: 1 });
        throw error;
      }
      const bytes = shape.stdoutIgnored ? Buffer.alloc(0) : toBuffer(out, shape.encoding);
      if (bytes) keep(plan, { out: bytes, err: null, status: 0 });
      return out;
    }
    // stderr reaches the user: capture it so a later hit shows the same bytes.
    const stdin = stdioOf(opts?.stdio, 0);
    const run = timed(true, () => originalSpawnSync(file, argv, { ...(opts ?? {}), stdio: [stdin === 'other' ? 'pipe' : stdin, 'pipe', 'pipe'], encoding: 'buffer' }));
    if (run.error || run.status !== 0 || run.signal || !Buffer.isBuffer(run.stdout) || run.stdout.length > shape.maxBuffer) {
      // Let git fail (or overflow) exactly as the caller's execFileSync would.
      return passThrough();
    }
    const err = Buffer.isBuffer(run.stderr) ? run.stderr : Buffer.alloc(0);
    if (err.length) process.stderr.write(err);
    keep(plan, { out: run.stdout, err, status: 0 });
    return encode(run.stdout, shape.encoding);
  }

  function spawnSync(this: unknown, file: unknown, args?: unknown, options?: unknown): unknown {
    const git = isGit(file);
    const [argv, opts] = split(args, options);
    const passThrough = () => timed(git, () => originalSpawnSync.call(this, file, args, options));
    if (!git || !argv || argv.some(arg => typeof arg !== 'string')) return passThrough();
    const shape = callShape(opts, 'spawnSync');
    const plan = shape && planFor(argv, shape);
    if (!shape || !plan) return passThrough();
    const known = lookup(plan, shape);
    if (known && (shape.stderr === 'ignore' || known.err !== null)) {
      counters.gitCacheHits++;
      const stdout = shape.stdoutIgnored ? null : encode(known.out, shape.encoding);
      const stderr = shape.stderr === 'ignore' ? null : encode(known.err!, shape.encoding);
      return { pid: 0, output: [null, stdout, stderr], stdout, stderr, status: known.status, signal: null };
    }
    const run = passThrough();
    if (!run.error && !run.signal && (run.status === 0 || run.status === 1)) {
      const out = shape.stdoutIgnored ? Buffer.alloc(0) : toBuffer(run.stdout, shape.encoding);
      const err = shape.stderr === 'ignore' ? null : toBuffer(run.stderr, shape.encoding) ?? Buffer.alloc(0);
      if (out) keep(plan, { out, err, status: run.status as 0 | 1 });
    }
    return run;
  }

  function spawn(this: unknown, file: unknown, args?: unknown, options?: unknown): unknown {
    const started = performance.now();
    const child = originalSpawn.call(this, file, args, options);
    const git = isGit(file);
    child.once('close', () => count(git, performance.now() - started));
    return child;
  }

  // Attribute file locations for the diff kind, read through this cache (setup
  // kind: env + config identity). A git without these variables (< 2.42) is
  // remembered once per process and the filesystem fallback is used instead.
  const unsupportedVars = new Set<string>();
  const gitVar = (name: string, cwd: string): string | null | undefined => {
    if (unsupportedVars.has(name)) return null;
    try {
      const out = execFileSync.call(undefined, 'git', ['var', name], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) as string;
      return out.trim() || undefined;
    } catch (error) {
      if ((error as { status?: unknown }).status !== undefined) unsupportedVars.add(name);
      return undefined;
    }
  };
  attributeLocations = {
    system: cwd => {
      const path = gitVar('GIT_ATTR_SYSTEM', cwd);
      return path === null ? fallbackSystemAttributes() : path === undefined ? undefined : [path];
    },
    global: cwd => {
      const path = gitVar('GIT_ATTR_GLOBAL', cwd);
      if (path !== null) return path === undefined ? undefined : [path];
      const dirs = repositoryDirs(cwd);
      return dirs ? fallbackGlobalAttributes(dirs) : undefined;
    },
  };
  childProcess.execFileSync = Object.assign(execFileSync, childProcess.execFileSync) as unknown as typeof childProcess.execFileSync;
  childProcess.spawnSync = Object.assign(spawnSync, childProcess.spawnSync) as unknown as typeof childProcess.spawnSync;
  childProcess.spawn = Object.assign(spawn, childProcess.spawn) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
}

/** Test hook: forget the in-memory stores (the on-disk files stay). */
export function resetGitReadCacheMemory(): void {
  stores.clear();
  memoryBytes = 0;
}

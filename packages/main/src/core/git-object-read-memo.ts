import { execFileSync } from 'node:child_process';
import { gitEnvironmentRedirected } from './git-inert-environment.js';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { observedGit } from './git-tree-observation.js';

/**
 * Process-local memo of read-only git output addressed only by full object
 * ids (commit subjects/parents/changed paths, `<oid>:<path>` blobs, ancestry
 * and rev-list between two object ids). Such bytes are a function of the
 * object ids alone unless the repository redirects objects (replace refs,
 * grafts, a shallow boundary) or the environment reroutes git (any GIT_*
 * variable other than the inert editor/pager/identity ones), so the memo is used only when a fresh probe per call site shows
 * none of these. Only successful output is kept; failures always rerun. This
 * is never a verdict cache: callers re-evaluate every rule on every call and
 * still resolve live state (HEAD, material, story files) themselves.
 */
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OID_PATH = /^(?:[0-9a-f]{40}|[0-9a-f]{64}):[^\0]+$/;
const MAX_ENTRIES = 4096;
const MAX_BYTES = 32 * 1024 * 1024;
const memo = new Map<string, string>();
let memoBytes = 0;

/** Exact argv shapes admitted to the memo; everything else runs git every time. */
export function isObjectAddressedGitRead(argv: readonly string[]): boolean {
  const [sub, a, b, c, d, ...rest] = argv;
  switch (sub) {
    case 'show':
      if (a === '-s') return (b === '--format=%s' || b === '--format=%P') && OID.test(c ?? '') && d === undefined;
      return OID_PATH.test(a ?? '') && b === undefined;
    case 'diff-tree':
      return a === '--no-commit-id' && b === '--name-only' && c === '-r' && OID.test(d ?? '') && rest.length === 0;
    case 'ls-tree':
      return a === '--name-only' && OID.test(b ?? '') && c === '--' && typeof d === 'string' && d.length > 0 && rest.length === 0;
    case 'merge-base':
      return a === '--is-ancestor' && OID.test(b ?? '') && OID.test(c ?? '') && d === undefined;
    case 'rev-list':
      return a === '--reverse' && typeof b === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})\.\.(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(b) && c === undefined;
    default:
      return false;
  }
}

/**
 * A reader for one verification walk in gitCwd. The redirection probe runs
 * once per walk (and once per synchronous observation when the walk runs
 * inside one); when anything could redirect objects the reader never uses the
 * memo. `run` must be the caller's own read-only git invocation for argv and
 * return git's raw stdout.
 */
export type ObjectAddressedGitReader = (argv: string[], run: () => string) => string;

export function objectAddressedGitReader(gitCwd: string): ObjectAddressedGitReader {
  const direct = (argv: string[], run: () => string): string => observedGit(gitCwd, argv, run);
  if (gitEnvironmentRedirected()) return direct;
  const cwd = resolve(gitCwd);
  let commonDir: string;
  try {
    const probeArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
    commonDir = observedGit(cwd, probeArgs, () => spawnGit(cwd, probeArgs)).trim();
    if (!isAbsolute(commonDir)) return direct;
    // Grafts and a shallow boundary rewrite parents; replace refs rewrite objects.
    if (existsSync(join(commonDir, 'shallow')) || existsSync(join(commonDir, 'info', 'grafts'))) return direct;
    const replaceArgs = ['for-each-ref', '--format=%(refname)', 'refs/replace/'];
    if (observedGit(cwd, replaceArgs, () => spawnGit(cwd, replaceArgs)).trim() !== '') return direct;
  } catch {
    return direct;
  }
  return (argv, run) => {
    if (!isObjectAddressedGitRead(argv)) return direct(argv, run);
    const key = JSON.stringify([commonDir, argv]);
    const known = memo.get(key);
    if (known !== undefined) return known;
    const value = direct(argv, run);
    remember(key, value);
    return value;
  };
}

function remember(key: string, value: string): void {
  const bytes = Buffer.byteLength(value);
  if (bytes > MAX_BYTES) return;
  while (memo.size && (memo.size >= MAX_ENTRIES || memoBytes + bytes > MAX_BYTES)) {
    const oldest = memo.keys().next().value!;
    memoBytes -= Buffer.byteLength(memo.get(oldest)!);
    memo.delete(oldest);
  }
  memo.set(key, value);
  memoBytes += bytes;
}

function spawnGit(cwd: string, argv: string[]): string {
  return execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

import { execSync } from 'child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const rootProbes = new Map<string, { identity: string; output: string }>();

// GIT_* variables that only steer interactive/authoring behaviour (editor,
// pager, prompts, identity, transport). None of them changes repository
// discovery, ref storage or ref resolution, so they cannot change what
// `git rev-parse --show-toplevel` / `--abbrev-ref HEAD` print. Agent hosts set
// some of them (e.g. GIT_EDITOR=true) on every process; treating them as
// routing disabled the file-based fast paths below for every call.
const NON_ROUTING_GIT_ENV = new Set([
  'GIT_PAGER', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
]);

/** True when a GIT_* variable could reroute repository discovery or ref reads. */
function gitEnvironmentMayRouteRepository(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.keys(env).some(key => key.startsWith('GIT_') && !NON_ROUTING_GIT_ENV.has(key) && env[key]);
}

// Command-scoped config injected through the environment (agent hosts set
// e.g. GIT_CONFIG_COUNT=2 credential.interactive=false on every process). It
// can change discovery (core.worktree), so it is not "non-routing"; but its
// exact values are part of the cached root probe's identity below, so a cached
// answer is reused only under the identical injected config. Blanket-disabling
// the cache for it re-ran `git rev-parse --show-toplevel` 11-22 times per
// `next` decision (next-driver-cost repeated-command budget, lab critic-import-loop).
const IDENTITY_KEYED_GIT_ENV = /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/;

/** Recheck filesystem bindings without a subprocess. Unbounded config includes
 * and explicit Git environment routing use the uncached authoritative probe. */
function rootProbeIdentity(cwd: string): string | undefined {
  try {
    const env = process.env;
    const keyed = Object.keys(env).filter(key => IDENTITY_KEYED_GIT_ENV.test(key)).sort();
    const routing: NodeJS.ProcessEnv = { ...env };
    for (const key of keyed) delete routing[key];
    if (gitEnvironmentMayRouteRepository(routing)) return undefined;
    const parts: string[] = [realpathSync(cwd), JSON.stringify(keyed.map(key => [key, env[key] ?? '']))];
    const config = (path: string): boolean => {
      if (!existsSync(path)) { parts.push(path, '<absent>'); return true; }
      if (statSync(path).size > 1024 * 1024) return false;
      const bytes = readFileSync(path, 'utf8');
      if (/^\s*\[\s*include(?:if)?\b/im.test(bytes)) return false;
      parts.push(path, bytes); return true;
    };
    for (const path of ['/etc/gitconfig', '/opt/homebrew/etc/gitconfig', join(homedir(), '.gitconfig'), join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git/config')]) {
      if (!config(path)) return undefined;
    }
    for (let candidate = parts[0];;) {
      const marker = join(candidate, '.git');
      if (existsSync(marker)) {
        let gitDir = marker;
        if (statSync(marker).isFile()) {
          const pointer = readFileSync(marker, 'utf8').trim();
          if (!pointer.startsWith('gitdir: ')) return undefined;
          parts.push(pointer);
          gitDir = resolve(candidate, pointer.slice(8));
        }
        gitDir = realpathSync(gitDir);
        const stat = statSync(gitDir);
        parts.push(marker, gitDir, String(stat.dev), String(stat.ino));
        for (const file of ['config', 'config.worktree', 'HEAD', 'commondir']) if (!config(join(gitDir, file))) return undefined;
        const commonFile = join(gitDir, 'commondir');
        if (existsSync(commonFile) && !config(resolve(gitDir, readFileSync(commonFile, 'utf8').trim(), 'config'))) return undefined;
        return JSON.stringify(parts);
      }
      parts.push(marker, '<absent>');
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  } catch { return undefined; }
}

export function isNotGitRepoError(err: unknown): boolean {
  const msg = String((err as any)?.stderr || (err as any)?.message || err || '').toLowerCase();
  return msg.includes('not a git repository') || msg.includes('not in a git directory');
}

export function gitProbe(
  command: string,
  opts: { cwd?: string; encoding?: BufferEncoding } = {},
): { ok: true; output: string } | { ok: false; reason: 'not_git' | 'git_error'; error: string } {
  try {
    const cwd = command === 'git rev-parse --show-toplevel'
      ? realpathSync(opts.cwd ?? process.cwd()) : (opts.cwd ?? process.cwd());
    const identity = command === 'git rev-parse --show-toplevel' ? rootProbeIdentity(cwd) : undefined;
    const prior = identity === undefined ? undefined : rootProbes.get(cwd);
    if (prior?.identity === identity && prior) return { ok: true, output: prior.output };
    const output = execSync(command, {
      cwd: opts.cwd,
      encoding: opts.encoding || 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (identity !== undefined) {
      if (rootProbes.size >= 128) rootProbes.delete(rootProbes.keys().next().value!);
      rootProbes.set(cwd, { identity, output });
    }
    return { ok: true, output };
  } catch (e) {
    return {
      ok: false,
      reason: isNotGitRepoError(e) ? 'not_git' : 'git_error',
      error: String((e as any)?.stderr || (e as any)?.message || e || ''),
    };
  }
}

export function isGitRepository(cwd: string): boolean {
  return gitProbe('git rev-parse --show-toplevel', { cwd }).ok;
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const STORY_BRANCH_PREFIX = 'story/';

function statOrNull(path: string): Stats | null {
  return lstatSync(path, { throwIfNoEntry: false }) ?? null;
}

/** Common directory of a git directory (linked worktrees point at the main one). */
function commonGitDir(gitDir: string): string {
  const pointer = join(gitDir, 'commondir');
  return existsSync(pointer) ? resolve(gitDir, readFileSync(pointer, 'utf8').trim()) : gitDir;
}

/** git's is_git_directory(): HEAD plus objects/ and refs/ (through commondir). */
function looksLikeGitDirectory(dir: string): boolean {
  if (!statOrNull(join(dir, 'HEAD'))?.isFile()) return false;
  const common = commonGitDir(dir);
  return !!statOrNull(join(common, 'objects'))?.isDirectory() && !!statOrNull(join(common, 'refs'))?.isDirectory();
}

/** Loose ref file state: absent, a direct object id, or anything else (symref/garbage). */
function looseRef(dir: string, ref: string): 'absent' | 'direct' | 'other' {
  const stat = statOrNull(join(dir, ref));
  if (!stat) return 'absent';
  if (!stat.isFile()) return 'other';
  return OBJECT_ID.test(readFileSync(join(dir, ref), 'utf8').trim()) ? 'direct' : 'other';
}

/**
 * Answer, from the repository files alone, the only branch question CLI startup
 * asks: would `git rev-parse --abbrev-ref HEAD` (run in `cwd`) print a
 * `story/...` branch, and which one?
 *   string    -> git would print exactly this `story/...` branch
 *   null      -> git would print something else, or fail (detached, unborn,
 *                other branch, not a repository)
 *   undefined -> not provable from files; the caller must ask git.
 * Every state the files cannot settle exactly (routing GIT_* environment,
 * foreign ownership / safe.directory, repository extensions such as reftable,
 * config includes, symbolic branch refs, a crossed filesystem boundary, an
 * ambiguous short name that git would print as `heads/...`) returns undefined,
 * so the git answer is never guessed. Pinned against real git by
 * tasks/startup-git-spawns-smoke.ts.
 */
export function readStoryBranchFromGitFiles(cwd: string): string | null | undefined {
  try {
    if (gitEnvironmentMayRouteRepository()) return undefined;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid === undefined) return undefined;
    let dir = realpathSync(cwd);
    const device = statSync(dir).dev;
    let top: string;
    let gitDir: string;
    let gitFile: Stats | null = null;
    for (;;) {
      if (looksLikeGitDirectory(dir)) return undefined; // bare / inside a git dir
      const marker = join(dir, '.git');
      const stat = statOrNull(marker);
      if (stat?.isFile()) {
        const pointer = readFileSync(marker, 'utf8').trim();
        if (!pointer.startsWith('gitdir: ')) return undefined;
        gitDir = resolve(dir, pointer.slice('gitdir: '.length).trim());
        if (!looksLikeGitDirectory(gitDir)) return undefined;
        gitFile = stat;
        top = dir;
        break;
      }
      if (stat?.isDirectory() && looksLikeGitDirectory(marker)) { gitDir = marker; top = dir; break; }
      if (stat && !stat.isDirectory()) return undefined;
      const parent = dirname(dir);
      if (parent === dir) return null; // git: not a git repository
      if (statSync(parent).dev !== device) return undefined; // git stops at filesystem boundaries
      dir = parent;
    }
    const common = commonGitDir(gitDir);
    // git refuses repositories owned by someone else unless safe.directory says otherwise.
    for (const owned of [statSync(top), statSync(gitDir), statSync(common), gitFile]) {
      if (owned && owned.uid !== uid) return undefined;
    }
    for (const config of [join(common, 'config'), join(gitDir, 'config.worktree')]) {
      if (!existsSync(config)) continue;
      const text = readFileSync(config, 'utf8');
      if (/^\s*\[\s*(?:extensions|include(?:if)?)\b/im.test(text)) return undefined;
      const version = /^\s*repositoryformatversion\s*=\s*(\S+)/im.exec(text)?.[1];
      if (version !== undefined && version !== '0' && version !== '1') return undefined;
    }
    const headStat = statOrNull(join(gitDir, 'HEAD'));
    if (!headStat?.isFile()) return undefined;
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (OBJECT_ID.test(head)) return null; // detached: git prints HEAD
    const symbolic = /^ref:\s*(refs\/heads\/\S+)$/.exec(head);
    if (!symbolic) return undefined;
    const ref = symbolic[1];
    const packedRefs = existsSync(join(common, 'packed-refs'))
      ? new Set(readFileSync(join(common, 'packed-refs'), 'utf8').split('\n')
        .map(line => /^[0-9a-f]{40}(?:[0-9a-f]{24})? (\S+)$/.exec(line)?.[1]).filter((name): name is string => !!name))
      : new Set<string>();
    const loose = looseRef(common, ref);
    if (loose === 'other') return undefined; // symbolic branch ref: git follows it
    if (loose === 'absent' && !packedRefs.has(ref)) return null; // unborn: git fails
    const name = ref.slice('refs/heads/'.length);
    if (!name.startsWith(STORY_BRANCH_PREFIX)) return null;
    // Strict --abbrev-ref prints `heads/<name>` when <name> also resolves through
    // any other rev-parse rule; defer to git whenever such a ref could exist.
    for (const other of [name, `refs/${name}`, `refs/tags/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`]) {
      if (packedRefs.has(other) || existsSync(join(common, other)) || existsSync(join(gitDir, other))) return undefined;
    }
    return name;
  } catch {
    return undefined;
  }
}

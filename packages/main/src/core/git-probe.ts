import { execSync } from 'child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const rootProbes = new Map<string, { identity: string; output: string }>();

/** Recheck filesystem bindings without a subprocess. Unbounded config includes
 * and explicit Git environment routing use the uncached authoritative probe. */
function rootProbeIdentity(cwd: string): string | undefined {
  try {
    if (Object.keys(process.env).some(key => key.startsWith('GIT_') && key !== 'GIT_PAGER' && process.env[key])) return undefined;
    const parts: string[] = [realpathSync(cwd)];
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

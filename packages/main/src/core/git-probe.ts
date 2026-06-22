import { execSync } from 'child_process';

export function isNotGitRepoError(err: unknown): boolean {
  const msg = String((err as any)?.stderr || (err as any)?.message || err || '').toLowerCase();
  return msg.includes('not a git repository') || msg.includes('not in a git directory');
}

export function gitProbe(
  command: string,
  opts: { cwd?: string; encoding?: BufferEncoding } = {},
): { ok: true; output: string } | { ok: false; reason: 'not_git' | 'git_error'; error: string } {
  try {
    const output = execSync(command, {
      cwd: opts.cwd,
      encoding: opts.encoding || 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
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

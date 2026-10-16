/**
 * Leaf module (no project imports): the `-U0` diffs of a run's commits from ONE git call per process, shared by the
 * old-PoS run-55 repair test integrity check (core/resolved-finding-guard.ts) and lab run110's out-of-scope pin-test
 * check (core/scope-pin-test.ts) so the second check adds no git spawn.
 */
import { execFileSync } from 'node:child_process';

const cache = new Map<string, string>();

/** The `-U0` diffs of `commits` (old to new), each after a NUL + hash line; '' when git fails. */
export function commitsDiffText(gitCwd: string, commits: readonly string[]): string {
  const key = `${gitCwd}\0${commits.join(',')}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let text = '';
  try {
    text = execFileSync('git', ['show', '-U0', '--no-renames', '--format=%x00%H', ...commits],
      { cwd: gitCwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { text = ''; }
  cache.set(key, text);
  return text;
}

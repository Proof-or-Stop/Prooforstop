/**
 * The material commit a managed code-writing run (implementer / finding
 * repair) left on its Story branch: the newest commit reachable from HEAD of
 * the run's cwd, committed inside the run's window [createdAt, terminalAt],
 * that touches a non-metadata path. Used to name "the earlier run and its
 * commit" in owner-facing status and refusals; it decides nothing.
 */
import { execFileSync } from 'node:child_process';

import { isMaterialExcludedPath } from './material-path-policy.js';

export function managedRunMaterialCommit(args: {
  root: string; gitCwd: string; createdAt: string; terminalAt: string;
}): string | null {
  const since = Math.floor(Date.parse(args.createdAt) / 1000);
  const until = Math.ceil(Date.parse(args.terminalAt) / 1000);
  if (!Number.isFinite(since) || !Number.isFinite(until)) return null;
  let log = '';
  try {
    log = execFileSync('git', ['log', `--max-age=${since}`, `--min-age=${until}`, '--format=%x00%H', '--name-only', 'HEAD'],
      { cwd: args.gitCwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  for (const block of log.split('\0').filter(Boolean)) {
    const [commit, ...paths] = block.split('\n').map(row => row.trim()).filter(Boolean);
    if (commit && paths.some(path => !isMaterialExcludedPath(path, args.root))) return commit.slice(0, 7);
  }
  return null;
}

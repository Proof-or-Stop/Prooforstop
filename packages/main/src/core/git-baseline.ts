import { execFileSync } from 'node:child_process';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function isStoryRef(ref: string): boolean {
  return /^refs\/heads\/story\//.test(ref)
    || /^refs\/remotes\/[^/]+\/story\//.test(ref)
    || /^story\//.test(ref)
    || /^[^/]+\/story\//.test(ref);
}

/** Resolve the repository's actual integration branch without inventing a local main alias. */
export function resolveRepositoryBaseline(gitCwd: string, head = 'HEAD'): { ref: string; mergeBase: string } | undefined {
  const candidates: string[] = [];
  const add = (ref: string | undefined): void => {
    const candidate = ref?.trim() ?? '';
    if (candidate && !isStoryRef(candidate) && !candidates.includes(candidate)) candidates.push(candidate);
  };
  let remoteHead: string | undefined;
  try { remoteHead = git(gitCwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']); } catch { /* no remote HEAD */ }
  let primaryBranch: string | undefined;
  try {
    const primary = git(gitCwd, ['worktree', 'list', '--porcelain']).split(/\n\n+/)[0] ?? '';
    primaryBranch = primary.split('\n').find(line => line.startsWith('branch '))?.slice('branch '.length);
  } catch { /* no trustworthy worktree inventory */ }
  let linkedWorktree = false;
  try {
    const gitDir = git(gitCwd, ['rev-parse', '--absolute-git-dir']);
    const commonDir = git(gitCwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    linkedWorktree = gitDir !== commonDir;
  } catch { /* conventional fallbacks remain available */ }
  // Local integration can advance without publishing. Only the same primary
  // branch containing the remote tip may supersede origin/HEAD in a linked
  // worktree; remote-ahead, diverged and ordinary-checkout policy is unchanged.
  if (linkedWorktree && primaryBranch?.startsWith('refs/heads/') && !isStoryRef(primaryBranch)
    && remoteHead === 'refs/remotes/origin/' + primaryBranch.slice('refs/heads/'.length)) {
    try {
      const remoteCommit = git(gitCwd, ['rev-parse', '--verify', '--end-of-options', `${remoteHead}^{commit}`]);
      const localCommit = git(gitCwd, ['rev-parse', '--verify', '--end-of-options', `${primaryBranch}^{commit}`]);
      git(gitCwd, ['merge-base', '--is-ancestor', remoteCommit, localCommit]);
      add(primaryBranch);
    } catch { /* retain remote-first ordering unless local containment is proven */ }
  }
  add(remoteHead);
  if (linkedWorktree) add(primaryBranch);
  for (const fallback of ['refs/heads/main', 'refs/remotes/origin/main', 'refs/heads/master', 'refs/remotes/origin/master']) add(fallback);
  if (!linkedWorktree) add(primaryBranch);
  for (const ref of candidates) {
    try {
      git(gitCwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
      const mergeBase = git(gitCwd, ['merge-base', ref, head]);
      if (mergeBase) return { ref, mergeBase };
    } catch { /* try the next conventional baseline */ }
  }
  return undefined;
}

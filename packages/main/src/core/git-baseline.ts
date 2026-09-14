import { execFileSync } from 'node:child_process';
import { observedGit } from './git-tree-observation.js';

function git(cwd: string, args: string[], deadlineMs?: number): string {
  const remaining = deadlineMs === undefined ? undefined : Math.floor(deadlineMs - performance.now());
  if (remaining !== undefined && (!Number.isFinite(remaining) || remaining <= 0)) throw new Error('Git baseline observation budget exhausted');
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...(remaining === undefined ? {} : { timeout: remaining }), stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function isStoryRef(ref: string): boolean {
  return /^refs\/heads\/story\//.test(ref)
    || /^refs\/remotes\/[^/]+\/story\//.test(ref)
    || /^story\//.test(ref)
    || /^[^/]+\/story\//.test(ref);
}

/** Resolve the repository's actual integration branch without inventing a local main alias. */
export type RepositoryBaselineCache = Map<string, readonly { ref: string; commit: string }[]>;
export function resolveRepositoryBaseline(gitCwd: string, head = 'HEAD', options: { deadlineMs?: number; candidateCache?: RepositoryBaselineCache } = {}): { ref: string; mergeBase: string; commit?: string } | undefined {
  // Optional monotonic deadline applies to the entire resolution, including
  // unsuccessful fallbacks; an expired budget never starts another subprocess.
  // Every probe here is a read-only ref resolution; one synchronous observation shares it.
  const probe = (cwd: string, args: string[]): string => observedGit(cwd, args, () => git(cwd, args, options.deadlineMs));
  // Read both paths in one subprocess. Ambiguous newline-containing output
  // retains the independent probes instead of changing linked-checkout policy.
  const directories = (): { common: string; gitDir: string } => {
    const rows = probe(gitCwd, ['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir']).split('\n');
    if (rows.length === 2 && rows.every(Boolean)) return { gitDir: rows[0], common: rows[1] };
    return { gitDir: probe(gitCwd, ['rev-parse', '--absolute-git-dir']),
      common: probe(gitCwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']) };
  };
  // Only callers owning a single observation snapshot provide this cache. Keep
  // ordinary and linked checkout policy separate, and still check each HEAD's
  // ancestry. A cached ref's commit is fixed for that snapshot, not a moving ref.
  let cacheKey: string | undefined;
  let observedLinked: boolean | undefined;
  const selectCached = (refs: readonly { ref: string; commit: string }[]) => {
    for (const candidate of refs) {
      try {
        const mergeBase = probe(gitCwd, ['merge-base', candidate.commit, head]);
        if (mergeBase) return { ...candidate, mergeBase };
      } catch { /* an unrelated HEAD must not borrow another worktree's ancestry */ }
    }
    return undefined;
  };
  if (options.candidateCache) {
    try {
      const { common, gitDir } = directories();
      observedLinked = common !== gitDir;
      cacheKey = JSON.stringify([common, observedLinked]);
      const cached = options.candidateCache.get(cacheKey);
      if (cached !== undefined) return selectCached(cached);
    } catch { return undefined; }
  }
  const candidates: string[] = [];
  const add = (ref: string | undefined): void => {
    const candidate = ref?.trim() ?? '';
    if (candidate && !isStoryRef(candidate) && !candidates.includes(candidate)) candidates.push(candidate);
  };
  let remoteHead: string | undefined;
  try { remoteHead = probe(gitCwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']); } catch { /* no remote HEAD */ }
  let primaryBranch: string | undefined;
  const readPrimaryBranch = (): string | undefined => {
    try {
      const primary = probe(gitCwd, ['worktree', 'list', '--porcelain']).split(/\n\n+/)[0] ?? '';
      return primary.split('\n').find(line => line.startsWith('branch '))?.slice('branch '.length);
    } catch { return undefined; }
  };
  let linkedWorktree = observedLinked ?? false;
  if (observedLinked === undefined) try {
    const { gitDir, common } = directories();
    linkedWorktree = gitDir !== common;
  } catch { /* conventional fallbacks remain available */ }
  // Ordinary direct calls need inventory only if all conventional candidates fail.
  if (linkedWorktree || options.candidateCache) primaryBranch = readPrimaryBranch();
  // Local integration can advance without publishing. Only the same primary
  // branch containing the remote tip may supersede origin/HEAD in a linked
  // worktree; remote-ahead, diverged and ordinary-checkout policy is unchanged.
  if (linkedWorktree && primaryBranch?.startsWith('refs/heads/') && !isStoryRef(primaryBranch)
    && remoteHead === 'refs/remotes/origin/' + primaryBranch.slice('refs/heads/'.length)) {
    try {
      const remoteCommit = probe(gitCwd, ['rev-parse', '--verify', '--end-of-options', `${remoteHead}^{commit}`]);
      const localCommit = probe(gitCwd, ['rev-parse', '--verify', '--end-of-options', `${primaryBranch}^{commit}`]);
      probe(gitCwd, ['merge-base', '--is-ancestor', remoteCommit, localCommit]);
      add(primaryBranch);
    } catch { /* retain remote-first ordering unless local containment is proven */ }
  }
  add(remoteHead);
  if (linkedWorktree) add(primaryBranch);
  for (const fallback of ['refs/heads/main', 'refs/remotes/origin/main', 'refs/heads/master', 'refs/remotes/origin/master']) add(fallback);
  if (!linkedWorktree && options.candidateCache) add(primaryBranch);
  if (options.candidateCache && cacheKey !== undefined) {
    const refs: { ref: string; commit: string }[] = [];
    for (const ref of candidates) {
      try { refs.push({ ref, commit: probe(gitCwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]) }); }
      catch { /* unavailable refs stay ineligible */ }
    }
    // Never cache an incomplete scan caused by exhaustion.
    if (options.deadlineMs !== undefined && performance.now() >= options.deadlineMs) return undefined;
    options.candidateCache.set(cacheKey, refs);
    return selectCached(refs);
  }
  // Append a lazy final fallback without memoizing any moving branch.
  const directCandidates = function* () {
    yield* candidates;
    if (!linkedWorktree) {
      const primary = readPrimaryBranch();
      if (primary && !isStoryRef(primary) && !candidates.includes(primary)) yield primary;
    }
  };
  for (const ref of directCandidates()) {
    try {
      // merge-base itself rejects missing refs and non-commit objects. Keep
      // the live ref resolution here; do not cache a moving baseline.
      const mergeBase = probe(gitCwd, ['merge-base', '--end-of-options', ref, head]);
      if (mergeBase) return { ref, mergeBase };
    } catch { /* try the next conventional baseline */ }
  }
  return undefined;
}

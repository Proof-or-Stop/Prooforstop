import { execFileSync } from 'node:child_process';
import type { StoryInfo } from './types.js';
import { resolveRepositoryBaseline } from './git-baseline.js';
import { observedGit } from './git-tree-observation.js';

export interface StoryIntegrationTarget {
  parentBranch: string;
  parentCommitAtCreation: string;
  source: 'creation_branch' | 'repository_baseline';
  deliveryMode: 'merge_to_parent';
}

/** Read-only ref probes only (rev-parse, symbolic-ref): see git-tree-observation. */
function git(cwd: string, args: string[]): string {
  return observedGit(cwd, args, () => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })).trim();
}

export function localIntegrationBranchNameForRef(ref: string): string | undefined {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/remotes/')) return ref.split('/').slice(3).join('/');
  return ref && !ref.startsWith('refs/') ? ref : undefined;
}

function validIntegrationBranch(branch: string | undefined): branch is string {
  return Boolean(branch && branch !== 'HEAD' && !/^(?:story|codex|lab)\//.test(branch));
}

function repositoryBaselineIntegrationTarget(gitCwd: string): StoryIntegrationTarget | undefined {
  const baseline = resolveRepositoryBaseline(gitCwd);
  const branch = baseline ? localIntegrationBranchNameForRef(baseline.ref) : undefined;
  if (!validIntegrationBranch(branch)) return undefined;
  try {
    return {
      parentBranch: branch,
      parentCommitAtCreation: git(gitCwd, ['rev-parse', '--verify', `${baseline!.ref}^{commit}`]),
      source: 'repository_baseline',
      deliveryMode: 'merge_to_parent',
    };
  } catch {
    return undefined;
  }
}

/** Capture the branch that owns Story delivery before a Story worktree exists. */
export function captureStoryIntegrationTarget(gitCwd: string): StoryIntegrationTarget | undefined {
  try {
    const branch = git(gitCwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (validIntegrationBranch(branch)) {
      return {
        parentBranch: branch,
        parentCommitAtCreation: git(gitCwd, ['rev-parse', '--verify', 'HEAD^{commit}']),
        source: 'creation_branch',
        deliveryMode: 'merge_to_parent',
      };
    }
  } catch { /* detached or non-git creation falls through to repository policy */ }

  return repositoryBaselineIntegrationTarget(gitCwd);
}

/** Resolve a frozen target, with repository-policy fallback for pre-field Stories. */
export function resolveStoryIntegrationTarget(
  gitCwd: string,
  story?: Pick<StoryInfo, 'integrationTarget'> | null,
): StoryIntegrationTarget | undefined {
  const stored = story?.integrationTarget;
  if (stored && validIntegrationBranch(stored.parentBranch)) return stored;
  return repositoryBaselineIntegrationTarget(gitCwd);
}

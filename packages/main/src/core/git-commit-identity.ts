/**
 * Proof-or-Stop creates its own metadata commits (story bootstrap, metadata
 * auto-commits, lifecycle transactions). In a fresh container nobody has run
 * `git config user.name/user.email` and git cannot auto-detect an address
 * (`unable to auto-detect email address (got 'root@<id>.(none)')`), so the
 * first such commit failed and the owner had to discover the fix by hand
 * (run 14: INIT_CHECK refused).
 *
 * When — and only when — git cannot resolve a committer or author identity
 * for the repository, set a repository-local identity once (shared by every
 * linked worktree through the common config) and say so with the command to
 * change it. An identity that already resolves (local, global, system, or the
 * GIT_* environment) is never touched.
 */
import { execFileSync } from 'node:child_process';

export const POS_DEFAULT_GIT_IDENTITY = { name: 'Proof-or-Stop', email: 'proof-or-stop@localhost' } as const;

export interface GitCommitIdentityResult {
  status: 'present' | 'configured' | 'failed';
  message?: string;
}

function resolves(gitCwd: string, variable: 'GIT_COMMITTER_IDENT' | 'GIT_AUTHOR_IDENT'): boolean {
  try {
    execFileSync('git', ['var', variable], { cwd: gitCwd, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function localValue(gitCwd: string, key: 'user.name' | 'user.email'): string {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export function ensureGitCommitIdentity(gitCwd: string): GitCommitIdentityResult {
  if (resolves(gitCwd, 'GIT_COMMITTER_IDENT') && resolves(gitCwd, 'GIT_AUTHOR_IDENT')) return { status: 'present' };
  try {
    if (!localValue(gitCwd, 'user.name')) execFileSync('git', ['config', '--local', 'user.name', POS_DEFAULT_GIT_IDENTITY.name], { cwd: gitCwd, stdio: 'ignore' });
    if (!localValue(gitCwd, 'user.email')) execFileSync('git', ['config', '--local', 'user.email', POS_DEFAULT_GIT_IDENTITY.email], { cwd: gitCwd, stdio: 'ignore' });
  } catch (error) {
    return { status: 'failed', message: `git has no commit identity and Proof-or-Stop could not set one: ${error instanceof Error ? error.message : String(error)}. Fix: git config user.name '<name>' && git config user.email '<email>'` };
  }
  if (!resolves(gitCwd, 'GIT_COMMITTER_IDENT') || !resolves(gitCwd, 'GIT_AUTHOR_IDENT')) {
    return { status: 'failed', message: "git still has no commit identity (check GIT_AUTHOR_*/GIT_COMMITTER_* overrides). Fix: git config user.name '<name>' && git config user.email '<email>'" };
  }
  return {
    status: 'configured',
    message: `git had no commit identity; Proof-or-Stop set this repository's local identity to ${POS_DEFAULT_GIT_IDENTITY.name} <${POS_DEFAULT_GIT_IDENTITY.email}> for its commits. Change it any time: git config user.name '<name>' && git config user.email '<email>'`,
  };
}

/** Best effort: set the identity when missing and print one line about it to stderr. */
export function ensureGitCommitIdentityNotice(gitCwd: string): void {
  const result = ensureGitCommitIdentity(gitCwd);
  if (result.message) process.stderr.write(`${result.status === 'configured' ? 'ℹ' : '⚠'} ${result.message}\n`);
}

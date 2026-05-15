/**
 * B-8db9 CHK-003 — DONE-only committed-check for declared artifacts.
 *
 * HIGH gap closed: `declared_artifact_changes` is `blocking:false` in
 * dirty-gate-policy, so an UNCOMMITTED declared artifact passes the DONE dirty
 * gate — but `git merge` does not carry uncommitted files into main, so the
 * declared deliverable vanishes silently. This module adds a DONE-only gate row
 * that requires every `declared-artifacts.json` entry path to be either
 * committed-and-clean or absent.
 *
 * This does NOT touch `dirty-gate-policy.ts` — REVIEW/TEST keep treating
 * `declared_artifact_changes` as non-blocking. The committed-check is an
 * additive DONE-stage row only.
 *
 * Layering: the committed-state evaluation is split into
 *   - `evaluateDeclaredArtifactCommitState` — pure fn over an injected
 *     per-path `GitPathState`, trivially logic-testable;
 *   - `gitDeclaredArtifactPathState` — the I/O wrapper that runs git.
 *
 * preMortem #2 anchor: a git-ignored declared path is a hard block with an
 * explicit message — a deliverable artifact must live on a commit-able path.
 */

import { execFileSync } from 'child_process';

/**
 * Observable git state of a single declared path. `tracked`/`dirty`/`ignored`
 * are mutually-informative facts read straight off git; `exists` reflects the
 * working tree.
 */
export interface GitPathState {
  /** Path is listed by `git ls-files` (committed / staged into the index). */
  tracked: boolean;
  /** Path appears in `git status --porcelain` (uncommitted change/untracked). */
  dirty: boolean;
  /** Path is matched by `.gitignore` (`git check-ignore`). */
  ignored: boolean;
  /** Path exists in the working tree. */
  exists: boolean;
}

export type DeclaredArtifactCommitStatus =
  | 'committed-clean'
  | 'dirty'
  | 'untracked'
  | 'git-ignored'
  | 'absent';

export interface DeclaredArtifactCommitEntry {
  path: string;
  status: DeclaredArtifactCommitStatus;
  /** True when this entry must block DONE. */
  blocking: boolean;
}

export interface DeclaredArtifactCommitResult {
  total: number;
  /** Count of entries that are committed-clean or absent (acceptable). */
  ok: number;
  entries: DeclaredArtifactCommitEntry[];
  blockers: DeclaredArtifactCommitEntry[];
}

/**
 * Pure classification of one declared path from its observed git state.
 *
 * - tracked + clean                  → ok (committed-and-clean).
 * - tracked + dirty                  → block (uncommitted change to a
 *                                       declared deliverable).
 * - git-ignored (and NOT tracked)    → block (preMortem #2: deliverables must
 *                                       live on a commit-able path).
 * - untracked (exists, not tracked)  → block (declared deliverable never
 *                                       committed).
 * - absent (does not exist)          → ok (declaration cleaned up — temp
 *                                       output that was removed is acceptable).
 */
export function classifyDeclaredArtifactCommitState(state: GitPathState): DeclaredArtifactCommitStatus {
  // Check tracked FIRST: a file already committed into the index IS a
  // committed deliverable regardless of what `.gitignore` later says. Git
  // keeps honouring a tracked path even after a matching ignore rule is added,
  // so a tracked file must classify by its dirty/clean state, never as
  // `git-ignored`. (F-001: declared artifact committed, then .gitignore
  // updated — the file is still committed-clean, not a blocking bad
  // declaration.)
  if (state.tracked) {
    return state.dirty ? 'dirty' : 'committed-clean';
  }
  // Not tracked: a git-ignored path can never be committed, so flag it so the
  // operator removes the bad declaration. The `ignored` classification only
  // applies to UNTRACKED files.
  if (state.ignored) return 'git-ignored';
  if (!state.exists) return 'absent';
  // exists but not tracked and not ignored → untracked.
  return 'untracked';
}

function isBlockingStatus(status: DeclaredArtifactCommitStatus): boolean {
  return status === 'dirty' || status === 'untracked' || status === 'git-ignored';
}

/**
 * Pure evaluator over declared paths + an injected per-path git-state lookup.
 * I/O-free so logic tests can drive every status branch with a stub map.
 */
export function evaluateDeclaredArtifactCommitState(
  paths: string[],
  stateOf: (path: string) => GitPathState,
): DeclaredArtifactCommitResult {
  const entries: DeclaredArtifactCommitEntry[] = paths.map((path) => {
    const status = classifyDeclaredArtifactCommitState(stateOf(path));
    return { path, status, blocking: isBlockingStatus(status) };
  });
  const blockers = entries.filter((e) => e.blocking);
  return {
    total: entries.length,
    ok: entries.filter((e) => !e.blocking).length,
    entries,
    blockers,
  };
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (e: any) {
    // `git check-ignore` exits non-zero (1) when the path is NOT ignored — that
    // is a normal answer, not an error. `git ls-files` on an absent path simply
    // returns empty. We surface ok=false only so callers can default safely.
    return { ok: false, stdout: typeof e?.stdout === 'string' ? e.stdout : '' };
  }
}

/**
 * I/O wrapper: read the observable git state of one path under `projectRoot`.
 *
 *  - tracked  : `git ls-files --error-unmatch -- <path>` succeeds.
 *  - dirty    : `git status --porcelain -- <path>` prints a row.
 *  - ignored  : `git check-ignore -q -- <path>` exits 0.
 *  - exists   : working-tree file existence.
 */
export function gitDeclaredArtifactPathState(projectRoot: string, path: string): GitPathState {
  const tracked = runGit(['ls-files', '--error-unmatch', '--', path], projectRoot).ok;
  const statusResult = runGit(['status', '--porcelain=v1', '--', path], projectRoot);
  const dirty = statusResult.ok && statusResult.stdout.split('\n').some((line) => line.trim().length > 0);
  // `git check-ignore -q` exits 0 when ignored, 1 when not ignored.
  const ignored = runGit(['check-ignore', '-q', '--', path], projectRoot).ok;
  // A tracked file is present in the index; an untracked file shows up in
  // `git status` — so working-tree existence is derivable without node:fs.
  const exists = tracked || dirty;
  return { tracked, dirty, ignored, exists };
}

/** Human-readable, gate-row-ready label for a single status. */
export function describeDeclaredArtifactCommitStatus(status: DeclaredArtifactCommitStatus): string {
  switch (status) {
    case 'committed-clean':
      return 'committed-and-clean';
    case 'dirty':
      return 'uncommitted (dirty)';
    case 'untracked':
      return 'uncommitted (untracked)';
    case 'git-ignored':
      return 'git-ignored';
    case 'absent':
      return 'absent (cleaned up)';
  }
}

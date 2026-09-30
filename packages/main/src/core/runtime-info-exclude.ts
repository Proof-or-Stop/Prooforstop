/**
 * Keep Proof-or-Stop's own runtime artifacts out of `git status` without
 * editing the project's tracked `.gitignore`.
 *
 * `proof-or-stop init` merges the runtime ignore block into `.gitignore`, but a
 * project may not commit that edit (a benchmark freezes `.gitignore` as a
 * control file; a team may simply decline it). A Story branch created from such
 * a HEAD has no runtime block, so `.proof-or-stop/activity.jsonl`,
 * `.proof-or-stop/runtime/`, `evidence/`, `locks/`, `usage/` and the nested
 * `.worktrees/` directory show as untracked and every raw clean-status gate
 * refuses on files the framework wrote itself (run 11, 2026-09-30).
 *
 * Git also reads `$GIT_COMMON_DIR/info/exclude`: untracked, local to the
 * clone, shared by every linked worktree, and never part of a commit. PoS
 * writes one marked block there. The patterns are exactly
 * `listRuntimeArtifactIgnorePatterns()` (the runtime-artifact registry, the
 * same source `.gitignore` merging uses) plus the configured Story worktree
 * directory. Lines outside the block are never touched; the block is replaced
 * in place when the registry changes and can be deleted by hand.
 *
 * Precedence is git's: a tracked `.gitignore` rule (including a negation)
 * overrides `info/exclude`, and tracked files are never hidden, so product
 * files and committed Story metadata stay exactly as visible as before. The
 * registry's own negations keep `.proof-or-stop/story/actives/**` visible.
 *
 * Best effort by design: failure to write returns a reason and never blocks
 * the command that called it.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { listRuntimeArtifactIgnorePatterns } from './runtime-artifact-registry.js';
import { loadConfig } from './config.js';

export const RUNTIME_INFO_EXCLUDE_BLOCK_START = '# proof-or-stop runtime artifacts (managed by Proof-or-Stop; git info/exclude)';
export const RUNTIME_INFO_EXCLUDE_BLOCK_END = '# /proof-or-stop runtime artifacts (managed by Proof-or-Stop; git info/exclude)';

export interface RuntimeInfoExcludeResult {
  status: 'written' | 'unchanged' | 'skipped';
  path?: string;
  reason?: string;
}

function gitLine(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** `/<dir>/` for a configured worktree directory inside the repository, else null. */
function worktreeDirPattern(toplevel: string, projectRoot: string): string | null {
  let dir: string | undefined;
  try { dir = loadConfig(projectRoot).worktreeDir; } catch { dir = undefined; }
  const absolute = resolve(projectRoot, dir || '.worktrees');
  const rel = relative(toplevel, absolute).replace(/\\/g, '/');
  if (!rel || rel === '.' || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) return null;
  return `/${rel.replace(/\/+$/, '')}/`;
}

/** The exact managed block lines (markers included) for this repository. */
export function renderRuntimeInfoExcludeBlock(extraPatterns: readonly string[] = []): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const pattern of [...listRuntimeArtifactIgnorePatterns(), ...extraPatterns]) {
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    lines.push(pattern);
  }
  return [RUNTIME_INFO_EXCLUDE_BLOCK_START, ...lines, RUNTIME_INFO_EXCLUDE_BLOCK_END].join('\n');
}

/** Replace (or append) the managed block; every other line is preserved byte for byte. */
export function mergeRuntimeInfoExclude(existing: string, block: string): string {
  const lines = existing.split('\n');
  const start = lines.indexOf(RUNTIME_INFO_EXCLUDE_BLOCK_START);
  const end = start >= 0 ? lines.indexOf(RUNTIME_INFO_EXCLUDE_BLOCK_END, start + 1) : -1;
  if (start >= 0 && end > start) {
    return [...lines.slice(0, start), block, ...lines.slice(end + 1)].join('\n');
  }
  const base = existing.replace(/\n+$/, '');
  return `${base}${base ? '\n\n' : ''}${block}\n`;
}

/**
 * Idempotently install the runtime block in the repository's shared
 * `info/exclude`. `cwd` may be the main checkout or any linked worktree; only a
 * project rooted at the Git top level is handled (the registry patterns are
 * top-level relative, like the `.gitignore` block they mirror).
 */
export function ensureRuntimeInfoExclude(cwd: string): RuntimeInfoExcludeResult {
  try {
    let toplevel: string;
    let commonDir: string;
    try {
      toplevel = realpathSync(gitLine(cwd, ['rev-parse', '--show-toplevel']));
      commonDir = resolve(cwd, gitLine(cwd, ['rev-parse', '--git-common-dir']));
    } catch {
      return { status: 'skipped', reason: 'not a git worktree' };
    }
    const projectRoot = realpathSync(cwd);
    if (projectRoot !== toplevel) {
      return { status: 'skipped', reason: `project root ${projectRoot} is not the git top level ${toplevel}` };
    }
    const path = join(commonDir, 'info', 'exclude');
    let existing = '';
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) return { status: 'skipped', path, reason: 'info/exclude is not a regular file' };
      existing = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const worktrees = worktreeDirPattern(toplevel, projectRoot);
    const merged = mergeRuntimeInfoExclude(existing, renderRuntimeInfoExcludeBlock(worktrees ? [worktrees] : []));
    if (merged === existing) return { status: 'unchanged', path };
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.proof-or-stop-${process.pid}.tmp`;
    writeFileSync(temporary, merged);
    renameSync(temporary, path);
    return { status: 'written', path };
  } catch (error) {
    return { status: 'skipped', reason: error instanceof Error ? error.message : String(error) };
  }
}

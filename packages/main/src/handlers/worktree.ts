
import { execFileSync, execSync } from 'child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, relative, isAbsolute, resolve, sep } from 'path';
import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT } from './context.js';
import { createStoryActor, getStateName, getGuardFailureReason } from '../core/machine.js';
import type { StoryPhase } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { summarizeParallelPolicy } from '../core/parallel-policy.js';

export interface GlobalKoalaLinkRepairOptions {
  globalPackagePath?: string;
  unlinkImpl?: typeof unlinkSync;
  symlinkImpl?: typeof symlinkSync;
}

export interface GlobalKoalaLinkRepairResult {
  action: 'relinked' | 'skipped';
  message: string;
}

function isPathInside(child: string, parent: string): boolean {
  const childResolved = resolve(child);
  const parentResolved = resolve(parent);
  return childResolved === parentResolved || childResolved.startsWith(parentResolved.endsWith(sep) ? parentResolved : `${parentResolved}${sep}`);
}

function resolveGlobalCorePackagePath(options: GlobalKoalaLinkRepairOptions = {}): string | null {
  if (options.globalPackagePath) return options.globalPackagePath;
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return join(globalRoot, '@koala-agent', 'core');
  } catch {
    return null;
  }
}

/**
 * DONE cleanup may delete a story worktree that was used as `npm link` target.
 * Only rewrite the global package symlink when it clearly points inside the
 * worktree being deleted; all other installs are left untouched.
 */
export function repairGlobalKoalaLinkBeforeWorktreeDelete(
  worktreePath: string,
  mainRepoRoot: string,
  options: GlobalKoalaLinkRepairOptions = {},
): GlobalKoalaLinkRepairResult {
  const globalPackagePath = resolveGlobalCorePackagePath(options);
  if (!globalPackagePath) {
    return { action: 'skipped', message: 'global @koala-agent/core path not found, skipping relink' };
  }

  let stat;
  try {
    stat = lstatSync(globalPackagePath);
  } catch {
    return { action: 'skipped', message: `global @koala-agent/core does not exist: ${globalPackagePath}` };
  }
  if (!stat.isSymbolicLink()) {
    return { action: 'skipped', message: `global @koala-agent/core is not a symlink, skipping relink: ${globalPackagePath}` };
  }

  const rawTarget = readlinkSync(globalPackagePath);
  const target = isAbsolute(rawTarget) ? rawTarget : resolve(dirname(globalPackagePath), rawTarget);
  if (!isPathInside(target, worktreePath)) {
    return { action: 'skipped', message: `global @koala-agent/core does not point to current worktree, skipping relink: ${target}` };
  }

  const mainPackagePath = join(mainRepoRoot, 'packages', 'main');
  if (!existsSync(mainPackagePath)) {
    return { action: 'skipped', message: `main repo packages/main does not exist, skipping relink: ${mainPackagePath}` };
  }

  const unlinkImpl = options.unlinkImpl ?? unlinkSync;
  const symlinkImpl = options.symlinkImpl ?? symlinkSync;
  try {
    unlinkImpl(globalPackagePath);
    symlinkImpl(mainPackagePath, globalPackagePath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `global @koala-agent/core currently points to the worktree pending deletion, relink to main repo failed. Blocked deletion of ${worktreePath}. ` +
      `Please fix ${globalPackagePath} -> ${mainPackagePath} first and retry. Reason: ${reason}`,
    );
  }
  return { action: 'relinked', message: `✓ global @koala-agent/core has been relinked from story worktree to ${mainPackagePath}` };
}

/**
 * B-9e4a CHK-001 (F-003): A freshly created git worktree does NOT inherit the
 * main repo's `node_modules` (git worktree only checks out tracked files, and
 * `node_modules` is gitignored). Without it, `tsc` / `koala validate` fail with
 * unresolved-dependency errors. Detect the gap so worktree creation never reports
 * "development environment is ready" alone while dependencies are actually missing.
 *
 * Returns true when a `node_modules` entry exists directly under `parentDir`.
 * Uses `lstatSync` (does NOT follow symlinks) so both a real directory AND a
 * symlink count as present. ENOENT / permission errors → treated as missing.
 */
function hasNodeModules(parentDir: string): boolean {
  try {
    lstatSync(join(parentDir, 'node_modules'));
    return true;
  } catch {
    return false;
  }
}

/** A directory entry exists (real dir, not following symlinks gives a node either way). */
function dirExists(p: string): boolean {
  try {
    const stat = lstatSync(p);
    return stat.isDirectory() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * B-9e4a CHK-001: Build a remediation warning if the worktree (or a key
 * subpackage like packages/main) is missing node_modules. Returns null when
 * dependencies are present, or when detection cannot run.
 *
 * Fail-safe contract: spaces / special chars / permission errors must never
 * throw out of here. Per-path probes degrade to "missing" (→ warning), and a
 * top-level guard returns null on any truly unexpected failure so worktree
 * creation is never crashed by this advisory check.
 */
export function detectMissingNodeModulesWarning(worktreePath: string): string | null {
  try {
    const missing: string[] = [];
    if (!hasNodeModules(worktreePath)) missing.push('worktree root');

    // Only probe known key subpackages that actually exist in this worktree, so
    // non-monorepo projects don't get spurious packages/main warnings.
    const keySubpackages = ['packages/main'];
    for (const rel of keySubpackages) {
      const subDir = join(worktreePath, ...rel.split('/'));
      if (dirExists(subDir) && !hasNodeModules(subDir)) {
        missing.push(`${rel}/node_modules`);
      }
    }

    if (missing.length === 0) return null;

    return [
      `⚠ worktree missing node_modules: ${missing.join(', ')}`,
      `  Missing dependencies will cause tsc / koala validate to fail to resolve modules.`,
      `  → Remediation (recommended): cd ${worktreePath} && npm install`,
      `  → Advanced optional: manually symlink main repo node_modules to this worktree`,
    ].join('\n');
  } catch {
    // Last-resort guard: never let an advisory check crash worktree creation.
    return null;
  }
}

export function createWorktreeHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;

  function git(cmd: string, cwd?: string): string {
    return execSync(`git ${cmd}`, {
      cwd: cwd || root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  /**
   * B-0975 fix: `git worktree remove --force` on Windows can transiently fail
   * with "Permission denied" when another process (logger hook, llmlog writer,
   * antivirus) still holds a handle to a file inside the worktree. The lock
   * typically clears in <1s. Retry a few times with short backoffs before
   * surfacing the failure to the user.
   *
   * Applies to both `worktree remove` and `worktree remove --force`. On
   * non-Windows platforms the first attempt almost always succeeds, so the
   * retry loop is effectively a no-op.
   */
  function worktreeRemoveWithRetry(wtPath: string, opts: { force?: boolean } = {}): void {
    const flag = opts.force ? ' --force' : '';
    const delays = [0, 300, 800, 1500];
    let lastErr: unknown;
    for (const delay of delays) {
      if (delay > 0) {
        const until = Date.now() + delay;
        while (Date.now() < until) { /* busy-wait; execSync is already sync */ }
      }
      try {
        execFileSync('git', ['worktree', 'remove', ...(opts.force ? ['--force'] : []), wtPath], {
          cwd: root,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        });
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  function gitErrorMessage(e: any): string {
    return String(e?.stderr || e?.stdout || e?.message || e).trim();
  }

  function gitFile(args: string[], cwd = root, env?: NodeJS.ProcessEnv): string {
    return execFileSync('git', args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  function gitRefExists(ref: string, cwd = root): boolean {
    try {
      gitFile(['rev-parse', '--verify', ref], cwd);
      return true;
    } catch {
      return false;
    }
  }

  function gitTreePathExists(ref: string, relPath: string, cwd = root): boolean {
    try {
      gitFile(['cat-file', '-e', `${ref}:${relPath}`], cwd);
      return true;
    } catch {
      return false;
    }
  }

  function createScopedStoryBootstrapCommit(args: {
    storyId: string;
    branch: string;
    storyRel: string;
    repoRoot: string;
  }): void {
    const { storyId, branch, storyRel, repoRoot } = args;
    const tempDir = mkdtempSync(join(tmpdir(), `koala-index-${storyId}-`));
    const indexFile = join(tempDir, 'index');
    try {
      const head = gitFile(['rev-parse', '--verify', 'HEAD'], repoRoot);
      const env = { GIT_INDEX_FILE: indexFile };
      gitFile(['read-tree', 'HEAD'], repoRoot, env);
      gitFile(['add', '--', storyRel], repoRoot, env);
      const tree = gitFile(['write-tree'], repoRoot, env);
      const commit = gitFile(['commit-tree', tree, '-p', head, '-m', `koala: story ${storyId} init`], repoRoot);
      gitFile(['update-ref', `refs/heads/${branch}`, commit], repoRoot);
    } finally {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* DEBUG: temp index cleanup best effort */ }
    }
  }

  function getRepoRoot(): string {
    try {
      return execSync('git rev-parse --show-toplevel', { cwd: root, encoding: 'utf-8' }).trim();
    } catch {
      return root;
    }
  }

  /** Resolve the worktree.path stored in story (may be relative or absolute) to an absolute path */
  function resolveWorktreePath(storedPath: string): string {
    if (isAbsolute(storedPath)) return storedPath;
    return join(getRepoRoot(), storedPath);
  }

  function branchExists(branch: string): boolean {
    try {
      execFileSync('git', ['rev-parse', '--verify', `${branch}^{commit}`], {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  type WorktreeRegistryEntry = {
    path: string;
    branch?: string;
    head?: string;
    prunable?: boolean;
  };

  function listWorktreeRegistry(): WorktreeRegistryEntry[] {
    try {
      const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const entries: WorktreeRegistryEntry[] = [];
      let current: WorktreeRegistryEntry | null = null;
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
          if (current) entries.push(current);
          current = { path: line.slice('worktree '.length).trim() };
        } else if (current && line.startsWith('branch ')) {
          current.branch = line.slice('branch '.length).trim();
        } else if (current && line.startsWith('HEAD ')) {
          current.head = line.slice('HEAD '.length).trim();
        } else if (current && line.startsWith('prunable')) {
          current.prunable = true;
        }
      }
      if (current) entries.push(current);
      return entries;
    } catch { /* PROBE: non-git or old git */ }
    return [];
  }

  function findWorktreePathByBranch(branch: string): string | null {
    const branchRef = `refs/heads/${branch}`;
    const entry = listWorktreeRegistry().find(e => e.branch === branchRef || e.branch === branch);
    return entry?.path || null;
  }

  function findWorktreeResidue(storyId: string, branch: string, worktreePath?: string): string | null {
    const branchRef = `refs/heads/${branch}`;
    const expectedPath = worktreePath?.replace(/\\/g, '/');
    for (const entry of listWorktreeRegistry()) {
      const entryPath = entry.path.replace(/\\/g, '/');
      if (entry.branch === branchRef || entry.branch === branch) return entry.path;
      if (expectedPath && entryPath === expectedPath) return entry.path;
      if (basename(entry.path) === storyId) return entry.path;
    }
    return null;
  }

  function isUsableGitWorktree(worktreePath: string): boolean {
    try {
      return gitFile(['rev-parse', '--is-inside-work-tree'], worktreePath) === 'true';
    } catch {
      return false;
    }
  }

  function pruneWorktreeRegistry(): void {
    git('worktree prune --expire now');
  }

  function removeStaleWorktreeAdminDirs(storyId: string, branch: string, worktreePath?: string): string[] {
    const removed: string[] = [];
    const branchRef = `refs/heads/${branch}`;
    const expectedPath = worktreePath ? resolve(worktreePath).replace(/\\/g, '/') : null;
    let commonDir: string;
    try {
      commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
    } catch {
      return removed;
    }
    const adminBase = isAbsolute(commonDir) ? join(commonDir, 'worktrees') : join(root, commonDir, 'worktrees');
    let names: string[] = [];
    try {
      names = readdirSync(adminBase);
    } catch {
      return removed;
    }
    for (const name of names) {
      const adminDir = join(adminBase, name);
      let matches = name === storyId;
      try {
        const gitdir = readFileSync(join(adminDir, 'gitdir'), 'utf-8').trim();
        const gitdirPath = gitdir.endsWith('/.git') || gitdir.endsWith('\\.git') ? dirname(gitdir) : gitdir;
        if (expectedPath && resolve(gitdirPath).replace(/\\/g, '/') === expectedPath) matches = true;
      } catch { /* PROBE: malformed stale worktree metadata */ }
      try {
        const head = readFileSync(join(adminDir, 'HEAD'), 'utf-8').trim();
        if (head === `ref: ${branchRef}` || head === `ref: ${branch}`) matches = true;
      } catch { /* PROBE: malformed stale worktree metadata */ }
      if (!matches) continue;
      try {
        rmSync(adminDir, { recursive: true, force: true });
        removed.push(adminDir);
      } catch {
        // MUTATION: caller verifies registry afterward and reports a hard failure.
      }
    }
    return removed;
  }

  function removePathWithTimeout(path: string): void {
    execFileSync('rm', ['-rf', path], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
  }

  function purgeSafeInitCommit(storyId: string, storyRel: string): string {
    const dirtyOutsideStory = git('status --porcelain')
      .split('\n')
      .filter(Boolean)
      .filter(line => {
        const status = line.slice(0, 2);
        const path = line[2] === ' ' ? line.slice(3) : line.slice(2);
        if (status === '??') return false;
        return path && !path.startsWith(storyRel);
      });
    if (dirtyOutsideStory.length > 0) {
      return `⚠ main init commit not cleaned up: workspace has changes outside ${storyRel} (${dirtyOutsideStory.slice(0, 3).join(', ')})`;
    }

    let subject = '';
    let files: string[] = [];
    try {
      subject = git('log -1 --pretty=%s');
      files = git('diff-tree --no-commit-id --name-only -r HEAD')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
    } catch {
      return '⚠ Uncleaned main init commit: cannot read HEAD';
    }

    const safeSubject = subject === `koala: story ${storyId} init` || subject.includes(storyId);
    const safeFiles = files.length > 0 && files.every(path => path.startsWith(storyRel));
    if (!safeSubject || !safeFiles) {
      return `⚠ Uncleaned main init commit: HEAD does not look like a pure metadata init commit for ${storyId}`;
    }

    git('reset --hard HEAD~1');
    return `✓ main init commit safely rolled back: ${subject}`;
  }

  function commitDiscardMetadata(storyId: string, storyRel: string): string {
    try {
      const dirty = git(`status --porcelain -- "${storyRel}"`);
      if (!dirty) return '';
      git(`add "${storyRel}"`);
      const staged = git(`diff --cached --name-only -- "${storyRel}"`);
      if (!staged) return '';
      git(`-c commit.gpgsign=false commit -m "koala: discard ${storyId}" --only -- "${storyRel}"`);
      const after = git(`status --porcelain -- "${storyRel}"`);
      if (after) {
        throw new Error(`story metadata still dirty:\n${after}`);
      }
      return `✓ discard metadata committed: koala: discard ${storyId}`;
    } catch (e: any) {
      throw new Error(
        `story_discard: discard metadata could not be committed, discard aborted.\n` +
        `story: ${storyRel}\nReason: ${gitErrorMessage(e)}\n` +
        `→ Please resolve and retry, or manually commit/rollback ${storyRel}.`,
      );
    }
  }

  /**
   * B-5fa4 CHK-003: Check for unpushed commits before worktree cleanup.
   * Uses execFileSync to avoid shell injection. Returns a warning string
   * or null if no unpushed commits (or if origin doesn't exist).
   */
  function checkUnpushedCommits(worktreePath: string, branch: string): { count: number; warning: string | null } {
    try {
      // Check if origin remote exists at all
      execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: worktreePath,
        encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    } catch {
      // No origin remote — local-only repo, skip check
      return { count: 0, warning: null };
    }

    try {
      // Check if origin has this branch
      execFileSync('git', ['rev-parse', '--verify', `origin/${branch}`], {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // origin doesn't track this branch — all local commits are "unpushed"
      // but this is expected for story branches, skip
      return { count: 0, warning: null };
    }

    try {
      const log = execFileSync('git', ['log', `origin/${branch}..HEAD`, '--oneline'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (!log) return { count: 0, warning: null };
      const count = log.split('\n').filter(Boolean).length;
      return {
        count,
        warning: `\u26a0 ${count} unpushed commit(s) on branch ${branch} will be lost after cleanup`,
      };
    } catch {
      // git log failed — don't block, just skip
      return { count: 0, warning: null };
    }
  }

  /**
   * B-5fa4 CHK-003: Detect sharedHotspots overlap between the current story
   * and other active stories. Returns a warning string or null.
   */
  function checkParallelSafety(storyId: string): string | null {
    const allStoryIds = store.listStoryIds();
    const allStories = allStoryIds
      .map((id) => {
        try { return store.readStory(id); } catch { return null; }
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    const currentStory = allStories.find((s) => s.storyId === storyId);
    if (!currentStory) return null;

    // If no sharedHotspots on current story, nothing to check
    if (!currentStory.sharedHotspots || currentStory.sharedHotspots.length === 0) {
      return null;
    }

    // Check if there are actual hotspot conflicts involving this story
    const terminalPhases = new Set(['DONE', 'DISCARDED']);
    const myHotspots = new Set(currentStory.sharedHotspots);
    const conflicts: Array<{ storyId: string; files: string[] }> = [];

    for (const other of allStories) {
      if (other.storyId === storyId || terminalPhases.has(other.phase)) continue;
      if (!other.sharedHotspots) continue;
      const overlap = other.sharedHotspots.filter((hp) => myHotspots.has(hp));
      if (overlap.length > 0) {
        conflicts.push({ storyId: other.storyId, files: overlap });
      }
    }

    if (conflicts.length === 0) return null;

    const lines = [
      `\u26a0 parallelSafety: ${storyId} shares hotspot files with other active stories:`,
    ];
    for (const c of conflicts) {
      lines.push(`  ${c.storyId}: ${c.files.join(', ')}`);
    }
    lines.push('  Consider coordinating changes to avoid merge conflicts.');
    lines.push('');
    lines.push(summarizeParallelPolicy(allStories));
    return lines.join('\n');
  }

  return {
    dev_start(args: { storyId: string }): string {
      const story = store.readStory(args.storyId);

      // If worktree already exists, return the path directly
      if (story.worktree) {
        const absPath = resolveWorktreePath(story.worktree.path);
        if (existsSync(absPath)) {
          return `Story ${args.storyId} worktree already exists\nPath: ${absPath}\nBranch: ${story.worktree.branch}`;
        }
        // worktree directory no longer exists, clean up the record
        story.worktree = undefined;
      }

      // Reject nesting when already inside a worktree
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
        if (branch.startsWith('worktree-')) {
          throw new Error('Already in a worktree, do not nest. Just develop in the current directory');
        }
      } catch (e: any) {
        if (e.message?.includes('Already in a worktree')) throw e;
      }

      // INIT_CHECK is the standard entry for creating worktrees; PLAN/DEV also allowed (backward compat / manual recovery)
      const allowedPhases: StoryPhase[] = ['INIT_CHECK', 'PLAN', 'DEV'];
      if (!allowedPhases.includes(story.phase)) {
        throw new Error(`Story ${args.storyId} is currently in phase ${story.phase}, requires INIT_CHECK / PLAN / DEV to create worktree`);
      }

      const branch = `story/${args.storyId}`;
      // Create worktree with git repo root (not project root, to avoid nesting under subprojects)
      const repoRoot = getRepoRoot();
      const worktreeDir = loadConfig(root).worktreeDir || '.worktrees';
      const worktreePath = join(repoRoot, worktreeDir, args.storyId);
      const relWorktreePath = relative(repoRoot, worktreePath).replace(/\\/g, '/');
      const storyRel = `${store.storyDirRel().replace(/\/$/, '')}/${args.storyId}`;

      // B-7eed: Write the story.worktree field into story index.json first, then git add/commit,
      // to avoid writeStory leaving the main repo working tree dirty after commit (which would cause subsequent DONE
      // phase `git merge story/B-xxx` to report "local changes would be overwritten").
      const now = new Date().toISOString();
      story.worktree = { path: relWorktreePath, branch, createdAt: now };
      if (!story.startedAt) story.startedAt = now;
      store.writeStory(args.storyId, story);

      // INIT_CHECK bootstrap must not advance or stage the user's current
      // branch. Build a scoped tree with only this story directory in a
      // temporary git index, then point story/B-* at that commit.
      if (gitRefExists(branch, repoRoot)) {
        const storyIndexRel = `${storyRel}/index.json`;
        if (!gitTreePathExists(branch, storyIndexRel, repoRoot)) {
          story.worktree = undefined;
          store.writeStory(args.storyId, story);
          throw new Error(
            `Branch ${branch} already exists but does not contain ${storyIndexRel}. ` +
            `This usually indicates a stale/dirty branch is being reused; please delete or repair the branch and retry.`,
          );
        }
      } else {
        try {
          createScopedStoryBootstrapCommit({ storyId: args.storyId, branch, storyRel, repoRoot });
        } catch (e: any) {
          story.worktree = undefined;
          store.writeStory(args.storyId, story);
          throw new Error(
            `Unable to create scoped story bootstrap commit for ${branch}: ${gitErrorMessage(e)}. ` +
            `Please confirm the current repo has at least one commit and ${storyRel} can be git added.`,
          );
        }
      }

      // Create worktree
      git(`worktree add "${worktreePath}" ${branch}`);

      // B-5fa4 CHK-003: parallelSafety check at worktree creation
      const parallelWarning = checkParallelSafety(args.storyId);

      // B-9e4a CHK-001 (F-003): warn when the fresh worktree lacks node_modules,
      // which would otherwise make tsc / koala validate fail with unresolved deps.
      const nodeModulesWarning = detectMissingNodeModulesWarning(worktreePath);

      // Dependency check
      let depsWarning = '';
      if (story.depends && story.depends.length > 0) {
        const unfinished: string[] = [];
        for (const depId of story.depends) {
          try {
            const dep = store.readStory(depId);
            if (dep.phase !== 'DONE') unfinished.push(`${depId}(${dep.phase})`);
          } catch {
            unfinished.push(`${depId}(not found)`);
          }
        }
        if (unfinished.length > 0) {
          depsWarning = `\n⚠ Dependencies not finished: ${unfinished.join(', ')}`;
        }
      }

      return [
        `Story ${args.storyId} development environment is ready`,
        `Branch: ${branch}`,
        `Path: ${worktreePath}`,
        `→ cd ${worktreePath} to enter the worktree for development; run all koala commands in this directory`,
        `→ sub agent should not use isolation:"worktree", run directly in the main agent's worktree`,
        `→ checklist_get(${args.storyId}) to view pending development items`,
        `→ After development completes, call dev_finish(${args.storyId}) to merge back to the main branch`,
        nodeModulesWarning || '',
        parallelWarning || '',
        depsWarning,
      ].filter(Boolean).join('\n');
    },

    dev_finish(args: { storyId: string }): string {
      const story = store.readStory(args.storyId);

      if (!story.worktree) {
        throw new Error(`Story ${args.storyId} has no active worktree`);
      }

      const wtPath = resolveWorktreePath(story.worktree.path);

      // Check whether the worktree exists
      if (!existsSync(wtPath)) {
        story.worktree = undefined;
        store.writeStory(args.storyId, story);
        throw new Error(`Worktree directory ${wtPath} does not exist, record cleared`);
      }

      // Auto-commit files generated at runtime under the story directory (review.json, etc.)
      const storyDir = join(store.storyDirRel(), args.storyId);
      try {
        git(`add ${storyDir}`, wtPath);
        const staged = git('diff --cached --name-only', wtPath);
        if (staged) {
          git(`commit -m "koala: auto-add story files for ${args.storyId}"`, wtPath);
        }
      } catch { /* no new files is fine */ }

      // Check whether the worktree has uncommitted changes
      const wtStatus = git('status --porcelain', wtPath);
      if (wtStatus) {
        throw new Error(
          `Worktree has uncommitted changes, please commit first:\n${wtStatus}`
        );
      }

      // Advance to TEST (if currently in DEV)
      if (story.phase === 'DEV') {
        const actor = createStoryActor(args.storyId, store, story.phase, root);
        actor.start();
        actor.send({ type: 'CODE_REVIEW' });
        const newState = getStateName(actor);
        actor.stop();

        if (newState === 'DEV') {
          // guard failed, give the reason
          const reason = getGuardFailureReason(args.storyId, store, 'TEST', root);
          throw new Error(`Cannot advance to TEST: ${reason || 'checklist not all completed'}`);
        }

        story.phase = newState as StoryPhase;
        if (!story.events) story.events = [];
        story.events.push(collectContext('TEST', 'advance'));
        store.writeStory(args.storyId, story);
      }

      const results: string[] = [
        `✓ Story ${args.storyId} development complete, entered TEST`,
        `Worktree preserved for testing: ${wtPath}`,
        `→ Run tests in the worktree`,
        `→ After all tests pass, call dev_merge(${args.storyId}) to merge back to the main branch`,
      ];

      return results.join('\n');
    },

    dev_merge(args: { storyId: string }): string {
      const story = store.readStory(args.storyId);

      if (!story.worktree) {
        throw new Error(`Story ${args.storyId} has no active worktree`);
      }

      const wtPath = resolveWorktreePath(story.worktree.path);
      const { branch } = story.worktree;

      // Check whether the worktree exists
      if (!existsSync(wtPath)) {
        story.worktree = undefined;
        store.writeStory(args.storyId, story);
        throw new Error(`Worktree directory ${wtPath} does not exist; record cleaned up`);
      }

      // Automatically commit runtime-generated files under the story directory (review.json, etc.)
      const storyDir = join(store.storyDirRel(), args.storyId);
      try {
        git(`add ${storyDir}`, wtPath);
        const staged = git('diff --cached --name-only', wtPath);
        if (staged) {
          git(`commit -m "koala: auto-add story files for ${args.storyId}"`, wtPath);
        }
      } catch { /* It's fine if there are no new files */ }

      // Check whether the worktree has uncommitted changes
      const wtStatus = git('status --porcelain', wtPath);
      if (wtStatus) {
        throw new Error(
          `Worktree has uncommitted changes; please commit first:\n${wtStatus}`
        );
      }

      // Must be in TEST or a later phase
      if (story.phase !== 'TEST' && story.phase !== 'DONE') {
        throw new Error(`Story ${args.storyId} is currently in phase ${story.phase}; you need to dev_finish first to enter TEST`);
      }

      // Try advancing to DONE (gate checks that tests pass + bugs are fixed)
      if (story.phase === 'TEST') {
        const actor = createStoryActor(args.storyId, store, story.phase, root);
        actor.start();
        actor.send({ type: 'FINISH' });
        const newState = getStateName(actor);
        actor.stop();

        if (newState === 'TEST') {
          const reason = getGuardFailureReason(args.storyId, store, 'DONE', root);
          throw new Error(`Cannot merge: ${reason || 'tests did not all pass or there are unfixed bugs'}`);
        }

        story.phase = newState as StoryPhase;
        if (!story.events) story.events = [];
        story.events.push(collectContext('DONE', 'advance'));
      }

      const mainBranch = git('rev-parse --abbrev-ref HEAD');
      const results: string[] = [];

      // B-5fa4 CHK-003: warn about unpushed commits before cleanup
      const unpushed = checkUnpushedCommits(wtPath, branch);
      if (unpushed.warning) {
        results.push(unpushed.warning);
      }

      // Merge into the main branch
      try {
        git(`merge ${branch} --no-ff -m "merge: ${args.storyId} ${story.title}"`);
        results.push(`✓ Branch ${branch} has been merged into ${mainBranch}`);
      } catch (e: any) {
        throw new Error(
          `Merge conflict, please resolve manually:\ngit merge ${branch}\n${e.stderr || e.message}`
        );
      }

      // Clean up worktree (B-0975: retry transient Permission denied locks on Windows)
      worktreeRemoveWithRetry(wtPath);
      results.push(`✓ Worktree ${wtPath} cleaned up`);

      // Delete branch
      try {
        git(`branch -d ${branch}`);
        results.push(`✓ Branch ${branch} deleted`);
      } catch {
        results.push(`⚠ Branch ${branch} not deleted (may have unmerged commits)`);
      }

      // Clean up story records
      story.worktree = undefined;
      story.endedAt = new Date().toISOString();
      store.writeStory(args.storyId, story);
      results.push(`✓ Story ${args.storyId} completed (DONE)`);

      return results.join('\n');
    },

    /** Discard story: callable at any phase, forcibly cleans up worktree and branch */
    story_discard(args: { storyId: string; reason?: string; force?: boolean; purge?: boolean }): string {
      const story = store.readStory(args.storyId);

      if (story.phase === 'DONE') {
        throw new Error(`Story ${args.storyId} is already DONE, cannot discard (revert completed stories via git revert)`);
      }
      const wasDiscarded = story.phase === 'DISCARDED';

      const results: string[] = [];
      const fallbackBranch = `story/${args.storyId}`;
      const branch = story.worktree?.branch || fallbackBranch;
      const detectedWorktreePath = story.worktree?.path
        ? resolveWorktreePath(story.worktree.path)
        : findWorktreeResidue(args.storyId, branch) || findWorktreePathByBranch(branch);

      // Clean up worktree (if it exists). Any cleanup failure fails closed: do not write
      // DISCARDED, do not delete metadata, do not output a fake "cleaned up" success.
      if (detectedWorktreePath) {
        const wtPath = detectedWorktreePath;
        if (existsSync(wtPath)) {
          const usableGitWorktree = isUsableGitWorktree(wtPath);
          if (!usableGitWorktree && !args.force) {
            throw new Error(
              `Worktree git metadata is corrupted, cannot safely check for uncommitted changes:\n` +
              `${wtPath}\n` +
              `→ If you confirm this is a residual directory and want to discard it, retry with force:true: koala story_discard '{"storyId":"${args.storyId}","force":true}'`,
            );
          }

          let removeFailure: string | null = null;
          if (!usableGitWorktree) {
            try {
              removePathWithTimeout(wtPath);
              results.push(`✓ invalid worktree residue cleaned up: ${wtPath}`);
            } catch (rmError: any) {
              throw new Error(
                `story_discard: invalid worktree residue cleanup failed, discard stopped to avoid leaving half-cleaned state.\n` +
                `worktree: ${wtPath}\nbranch: ${branch}\nreason: ${removeFailure}\n` +
                `directory cleanup also failed: ${gitErrorMessage(rmError)}`,
              );
            }
          } else {
            if (!args.force) {
              // B-5fa4 CHK-003: warn about unpushed commits before discard cleanup
              const unpushed = checkUnpushedCommits(wtPath, branch);
              if (unpushed.warning) {
                results.push(unpushed.warning);
              }

              // Check uncommitted changes. force:true is the user's explicit confirmation to discard, must not get stuck on git status failure first.
              const wtStatus = git('status --porcelain', wtPath);
              if (wtStatus) {
                throw new Error(
                  `Worktree has uncommitted changes:\n${wtStatus}\n→ If you confirm discarding, retry with force:true: koala story_discard '{"storyId":"${args.storyId}","force":true}'`
                );
              }
            }

            // Force remove worktree (B-0975: retry on Windows Permission denied transient lock)
            // If git remove has already made the registry prunable / 0000000, but
            // the directory still has residue, continue with rm + prune instead of pushing cleanup responsibility to the user.
            try {
              worktreeRemoveWithRetry(wtPath, { force: true });
              results.push(`✓ Worktree ${wtPath} cleaned up`);
            } catch (e: any) {
              removeFailure = gitErrorMessage(e);
              try {
                removePathWithTimeout(wtPath);
              } catch (rmError: any) {
                throw new Error(
                  `story_discard: worktree removal failed, discard stopped to avoid leaving half-cleaned state.\n` +
                  `worktree: ${wtPath}\nbranch: ${branch}\nreason: ${removeFailure}\n` +
                  `directory cleanup also failed: ${gitErrorMessage(rmError)}`,
                );
              }
            }
          }

          try {
            const removedAdmins = removeStaleWorktreeAdminDirs(args.storyId, branch, wtPath);
            if (removedAdmins.length > 0) results.push(`✓ stale git worktree admin cleaned up: ${removedAdmins.join(', ')}`);
            pruneWorktreeRegistry();
            if (removeFailure || findWorktreeResidue(args.storyId, branch, wtPath)) {
              results.push(`✓ stale worktree metadata pruned: ${wtPath}`);
            }
          } catch (e: any) {
            if (!removeFailure) removeFailure = 'git worktree remove succeeded but prune failed';
            throw new Error(
              `story_discard: metadata prune failed after worktree cleanup, discard stopped.\n` +
              `worktree: ${wtPath}\nbranch: ${branch}\nremove status: ${removeFailure}\nprune reason: ${gitErrorMessage(e)}`,
            );
          }

          if (removeFailure && findWorktreeResidue(args.storyId, branch, wtPath)) {
            try {
              pruneWorktreeRegistry();
            } catch (e: any) {
              throw new Error(
                `story_discard: metadata prune failed after worktree removal failed, discard stopped.\n` +
                `worktree: ${wtPath}\nbranch: ${branch}\nremove reason: ${removeFailure}\nprune reason: ${gitErrorMessage(e)}`,
              );
            }
            if (!existsSync(wtPath) && findWorktreeResidue(args.storyId, branch, wtPath)) {
              const removedAdmins = removeStaleWorktreeAdminDirs(args.storyId, branch, wtPath);
              if (removedAdmins.length > 0) results.push(`✓ stale git worktree admin cleaned: ${removedAdmins.join(', ')}`);
            }
          }
        } else {
          let pruneFailure: string | null = null;
          try {
            pruneWorktreeRegistry();
            results.push(`✓ stale worktree metadata pruned: ${wtPath}`);
          } catch (e: any) {
            pruneFailure = gitErrorMessage(e);
          }
          if (findWorktreeResidue(args.storyId, branch, wtPath)) {
            const removedAdmins = removeStaleWorktreeAdminDirs(args.storyId, branch, wtPath);
            if (removedAdmins.length > 0) results.push(`✓ stale git worktree admin cleaned: ${removedAdmins.join(', ')}`);
            try {
              pruneWorktreeRegistry();
              results.push(`✓ stale worktree metadata pruned: ${wtPath}`);
              pruneFailure = null;
            } catch (e: any) {
              pruneFailure = pruneFailure || gitErrorMessage(e);
            }
          }
          if (pruneFailure && findWorktreeResidue(args.storyId, branch, wtPath)) {
            throw new Error(
              `story_discard: worktree path does not exist but git metadata prune failed, discard stopped.\n` +
              `worktree: ${wtPath}\nbranch: ${branch}\nreason: ${pruneFailure}\n` +
              `→ Close the process occupying the repository and retry.`,
            );
          }
        }

        const pathStillExists = existsSync(wtPath);
        const lingeringWorktreePath = findWorktreeResidue(args.storyId, branch, wtPath);
        if (pathStillExists || lingeringWorktreePath) {
          try {
            pruneWorktreeRegistry();
          } catch (e: any) {
            throw new Error(
              `story_discard: re-check after worktree cleanup failed, metadata prune also failed, discard stopped.\n` +
              `worktree: ${wtPath}\nbranch: ${branch}\nreason: ${gitErrorMessage(e)}`,
            );
          }
          if (!existsSync(wtPath) && findWorktreeResidue(args.storyId, branch, wtPath)) {
            const removedAdmins = removeStaleWorktreeAdminDirs(args.storyId, branch, wtPath);
            if (removedAdmins.length > 0) results.push(`✓ stale git worktree admin cleaned: ${removedAdmins.join(', ')}`);
          }
        }

        const finalPathStillExists = existsSync(wtPath);
        const finalLingeringWorktreePath = findWorktreeResidue(args.storyId, branch, wtPath);
        if (finalPathStillExists || finalLingeringWorktreePath) {
          throw new Error(
            `story_discard: worktree re-check still has residue, discard stopped.\n` +
            `worktree: ${wtPath}${finalPathStillExists ? ' (path still exists)' : ''}\n` +
            `branch: ${branch}${finalLingeringWorktreePath ? ` (${finalLingeringWorktreePath})` : ''}\n` +
            `→ Close the process occupying this worktree and retry story_discard.`,
          );
        }

        // Force delete branch
        try {
          git(`branch -D ${branch}`);
          results.push(`✓ Branch ${branch} deleted`);
        } catch (e: any) {
          if (branchExists(branch)) {
            throw new Error(
              `story_discard: Failed to delete branch ${branch}, discard stopped.\nReason: ${gitErrorMessage(e)}`,
            );
          }
          results.push(`✓ Branch ${branch} does not exist`);
        }

        story.worktree = undefined;
      } else if (branchExists(branch)) {
        try {
          git(`branch -D ${branch}`);
          results.push(`✓ Branch ${branch} deleted`);
        } catch (e: any) {
          throw new Error(
            `story_discard: Failed to delete branch ${branch}, discard stopped.\nReason: ${gitErrorMessage(e)}`,
          );
        }
      }

      if (args.purge) {
        const storyRel = `${loadConfig(root).storyDir.replace(/\\/g, '/')}/${args.storyId}`;
        rmSync(join(root, storyRel), { recursive: true, force: true });
        results.push(`✓ Story metadata cleaned: ${storyRel}`);
        results.push(purgeSafeInitCommit(args.storyId, storyRel));
        return results.join('\n');
      }

      // Record discard event
      const storyRel = `${loadConfig(root).storyDir.replace(/\\/g, '/')}/${args.storyId}`;
      const now = new Date().toISOString();
      story.phase = 'DISCARDED';
      if (!story.endedAt) story.endedAt = now;
      if (!story.events) story.events = [];
      if (!wasDiscarded) {
        const event = collectContext('DISCARDED', 'discard');
        if (args.reason) event.reason = args.reason;
        story.events.push(event);
      }
      store.writeStory(args.storyId, story);
      const metadataCommit = commitDiscardMetadata(args.storyId, storyRel);
      if (metadataCommit) results.push(metadataCommit);

      results.push(wasDiscarded
        ? `✓ Story ${args.storyId} is already DISCARDED; residuals checked/cleaned`
        : `✓ Story ${args.storyId} marked as DISCARDED${args.reason ? ` (reason: ${args.reason})` : ''}`);
      return results.join('\n');
    },
  };
}

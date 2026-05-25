
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
    return { action: 'skipped', message: 'global @koala-agent/core path 未找到，跳过 relink' };
  }

  let stat;
  try {
    stat = lstatSync(globalPackagePath);
  } catch {
    return { action: 'skipped', message: `global @koala-agent/core 不存在: ${globalPackagePath}` };
  }
  if (!stat.isSymbolicLink()) {
    return { action: 'skipped', message: `global @koala-agent/core 不是 symlink，跳过 relink: ${globalPackagePath}` };
  }

  const rawTarget = readlinkSync(globalPackagePath);
  const target = isAbsolute(rawTarget) ? rawTarget : resolve(dirname(globalPackagePath), rawTarget);
  if (!isPathInside(target, worktreePath)) {
    return { action: 'skipped', message: `global @koala-agent/core 未指向当前 worktree，跳过 relink: ${target}` };
  }

  const mainPackagePath = join(mainRepoRoot, 'packages', 'main');
  if (!existsSync(mainPackagePath)) {
    return { action: 'skipped', message: `主仓 packages/main 不存在，跳过 relink: ${mainPackagePath}` };
  }

  const unlinkImpl = options.unlinkImpl ?? unlinkSync;
  const symlinkImpl = options.symlinkImpl ?? symlinkSync;
  try {
    unlinkImpl(globalPackagePath);
    symlinkImpl(mainPackagePath, globalPackagePath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `global @koala-agent/core 当前指向待删除 worktree，relink 到主仓失败，已阻止删除 ${worktreePath}。` +
      `请先修复 ${globalPackagePath} -> ${mainPackagePath} 后重试。原因: ${reason}`,
    );
  }
  return { action: 'relinked', message: `✓ global @koala-agent/core 已从 story worktree relink 到 ${mainPackagePath}` };
}

/**
 * B-9e4a CHK-001 (F-003): A freshly created git worktree does NOT inherit the
 * main repo's `node_modules` (git worktree only checks out tracked files, and
 * `node_modules` is gitignored). Without it, `tsc` / `koala validate` fail with
 * unresolved-dependency errors. Detect the gap so worktree creation never reports
 * "开发环境已就绪" alone while dependencies are actually missing.
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
    if (!hasNodeModules(worktreePath)) missing.push('worktree 根');

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
      `⚠ worktree 缺 node_modules: ${missing.join(', ')}`,
      `  缺依赖会导致 tsc / koala validate 解析不到模块而失败。`,
      `  → 补救（推荐）：cd ${worktreePath} && npm install`,
      `  → 高级可选：手动 symlink 主仓 node_modules 到此 worktree`,
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

  /** 将 story 里存的 worktree.path（可能是相对或绝对）解析为绝对路径 */
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
      return `⚠ 未清理 main init commit：工作区有非 ${storyRel} 改动 (${dirtyOutsideStory.slice(0, 3).join(', ')})`;
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
      return '⚠ 未清理 main init commit：无法读取 HEAD';
    }

    const safeSubject = subject === `koala: story ${storyId} init` || subject.includes(storyId);
    const safeFiles = files.length > 0 && files.every(path => path.startsWith(storyRel));
    if (!safeSubject || !safeFiles) {
      return `⚠ 未清理 main init commit：HEAD 不像 ${storyId} 的纯 metadata init commit`;
    }

    git('reset --hard HEAD~1');
    return `✓ main init commit 已安全回退: ${subject}`;
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
      return `✓ discard metadata 已提交: koala: discard ${storyId}`;
    } catch (e: any) {
      throw new Error(
        `story_discard: discard metadata 无法提交，已停止 discard。\n` +
        `story: ${storyRel}\n原因: ${gitErrorMessage(e)}\n` +
        `→ 请处理后重试，或手动提交/回滚 ${storyRel}。`,
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

      // 已有 worktree 则直接返回路径
      if (story.worktree) {
        const absPath = resolveWorktreePath(story.worktree.path);
        if (existsSync(absPath)) {
          return `Story ${args.storyId} worktree 已存在\n路径: ${absPath}\n分支: ${story.worktree.branch}`;
        }
        // worktree 目录不存在了，清理记录
        story.worktree = undefined;
      }

      // 已在 worktree 里时拒绝嵌套
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
        if (branch.startsWith('worktree-')) {
          throw new Error('已在 worktree 中，不要嵌套创建。直接在当前目录开发即可');
        }
      } catch (e: any) {
        if (e.message?.includes('已在 worktree')) throw e;
      }

      // INIT_CHECK 是创建 worktree 的标准入口；PLAN/DEV 也允许（向后兼容/手动恢复）
      const allowedPhases: StoryPhase[] = ['INIT_CHECK', 'PLAN', 'DEV'];
      if (!allowedPhases.includes(story.phase)) {
        throw new Error(`Story ${args.storyId} 当前阶段 ${story.phase}，需要 INIT_CHECK / PLAN / DEV 才能创建 worktree`);
      }

      const branch = `story/${args.storyId}`;
      // 用 git repo root 创建 worktree（不用 project root，避免在子项目下嵌套）
      const repoRoot = getRepoRoot();
      const worktreeDir = loadConfig(root).worktreeDir || '.worktrees';
      const worktreePath = join(repoRoot, worktreeDir, args.storyId);
      const relWorktreePath = relative(repoRoot, worktreePath).replace(/\\/g, '/');
      const storyRel = `${store.storyDirRel().replace(/\/$/, '')}/${args.storyId}`;

      // B-7eed: 先把 story.worktree 字段写进 story index.json，再 git add/commit，
      // 避免 commit 后 writeStory 留下主仓库 working tree 脏（会导致后续 DONE
      // 阶段 `git merge story/B-xxx` 报 "local changes would be overwritten"）。
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
            `分支 ${branch} 已存在，但不包含 ${storyIndexRel}。` +
            `这通常表示旧/脏分支被复用；请先删除或修复该分支后重试。`,
          );
        }
      } else {
        try {
          createScopedStoryBootstrapCommit({ storyId: args.storyId, branch, storyRel, repoRoot });
        } catch (e: any) {
          story.worktree = undefined;
          store.writeStory(args.storyId, story);
          throw new Error(
            `无法为 ${branch} 创建 scoped story bootstrap commit：${gitErrorMessage(e)}。` +
            `请确认当前仓库至少已有一个提交，且 ${storyRel} 可被 git add。`,
          );
        }
      }

      // 创建 worktree
      git(`worktree add "${worktreePath}" ${branch}`);

      // B-5fa4 CHK-003: parallelSafety check at worktree creation
      const parallelWarning = checkParallelSafety(args.storyId);

      // B-9e4a CHK-001 (F-003): warn when the fresh worktree lacks node_modules,
      // which would otherwise make tsc / koala validate fail with unresolved deps.
      const nodeModulesWarning = detectMissingNodeModulesWarning(worktreePath);

      // 依赖检查
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
          depsWarning = `\n⚠ 依赖未完成: ${unfinished.join(', ')}`;
        }
      }

      return [
        `Story ${args.storyId} 开发环境已就绪`,
        `分支: ${branch}`,
        `路径: ${worktreePath}`,
        `→ cd ${worktreePath} 进入 worktree 开发，所有 koala 命令在此目录执行`,
        `→ sub agent 不要使用 isolation:"worktree"，直接在主 agent 的 worktree 中跑`,
        `→ checklist_get(${args.storyId}) 查看待开发项`,
        `→ 开发完成后调用 dev_finish(${args.storyId}) 合并回主分支`,
        nodeModulesWarning || '',
        parallelWarning || '',
        depsWarning,
      ].filter(Boolean).join('\n');
    },

    dev_finish(args: { storyId: string }): string {
      const story = store.readStory(args.storyId);

      if (!story.worktree) {
        throw new Error(`Story ${args.storyId} 没有活跃的 worktree`);
      }

      const wtPath = resolveWorktreePath(story.worktree.path);

      // 检查 worktree 是否存在
      if (!existsSync(wtPath)) {
        story.worktree = undefined;
        store.writeStory(args.storyId, story);
        throw new Error(`Worktree 目录 ${wtPath} 不存在，已清理记录`);
      }

      // 自动提交 story 目录下的运行时产生的文件（review.json 等）
      const storyDir = join(store.storyDirRel(), args.storyId);
      try {
        git(`add ${storyDir}`, wtPath);
        const staged = git('diff --cached --name-only', wtPath);
        if (staged) {
          git(`commit -m "koala: auto-add story files for ${args.storyId}"`, wtPath);
        }
      } catch { /* 没有新文件也没关系 */ }

      // 检查 worktree 是否有未提交的改动
      const wtStatus = git('status --porcelain', wtPath);
      if (wtStatus) {
        throw new Error(
          `Worktree 有未提交的改动，请先 commit:\n${wtStatus}`
        );
      }

      // 推进到 TEST（如果当前在 DEV）
      if (story.phase === 'DEV') {
        const actor = createStoryActor(args.storyId, store, story.phase, root);
        actor.start();
        actor.send({ type: 'CODE_REVIEW' });
        const newState = getStateName(actor);
        actor.stop();

        if (newState === 'DEV') {
          // guard 失败，给出原因
          const reason = getGuardFailureReason(args.storyId, store, 'TEST', root);
          throw new Error(`无法推进到 TEST: ${reason || 'checklist 未全部完成'}`);
        }

        story.phase = newState as StoryPhase;
        if (!story.events) story.events = [];
        story.events.push(collectContext('TEST', 'advance'));
        store.writeStory(args.storyId, story);
      }

      const results: string[] = [
        `✓ Story ${args.storyId} 开发完成，已进入 TEST`,
        `Worktree 保留供测试使用: ${wtPath}`,
        `→ 在 worktree 中运行测试`,
        `→ 测试全部通过后调用 dev_merge(${args.storyId}) 合并回主分支`,
      ];

      return results.join('\n');
    },

    dev_merge(args: { storyId: string }): string {
      const story = store.readStory(args.storyId);

      if (!story.worktree) {
        throw new Error(`Story ${args.storyId} 没有活跃的 worktree`);
      }

      const wtPath = resolveWorktreePath(story.worktree.path);
      const { branch } = story.worktree;

      // 检查 worktree 是否存在
      if (!existsSync(wtPath)) {
        story.worktree = undefined;
        store.writeStory(args.storyId, story);
        throw new Error(`Worktree 目录 ${wtPath} 不存在，已清理记录`);
      }

      // 自动提交 story 目录下的运行时产生的文件（review.json 等）
      const storyDir = join(store.storyDirRel(), args.storyId);
      try {
        git(`add ${storyDir}`, wtPath);
        const staged = git('diff --cached --name-only', wtPath);
        if (staged) {
          git(`commit -m "koala: auto-add story files for ${args.storyId}"`, wtPath);
        }
      } catch { /* 没有新文件也没关系 */ }

      // 检查 worktree 是否有未提交的改动
      const wtStatus = git('status --porcelain', wtPath);
      if (wtStatus) {
        throw new Error(
          `Worktree 有未提交的改动，请先 commit:\n${wtStatus}`
        );
      }

      // 必须在 TEST 或更后的阶段
      if (story.phase !== 'TEST' && story.phase !== 'DONE') {
        throw new Error(`Story ${args.storyId} 当前阶段 ${story.phase}，需要先 dev_finish 进入 TEST`);
      }

      // 尝试推进到 DONE（门禁检查测试通过 + bug 修复）
      if (story.phase === 'TEST') {
        const actor = createStoryActor(args.storyId, store, story.phase, root);
        actor.start();
        actor.send({ type: 'FINISH' });
        const newState = getStateName(actor);
        actor.stop();

        if (newState === 'TEST') {
          const reason = getGuardFailureReason(args.storyId, store, 'DONE', root);
          throw new Error(`无法合并: ${reason || '测试未全部通过或存在未修复 bug'}`);
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

      // merge 到主分支
      try {
        git(`merge ${branch} --no-ff -m "merge: ${args.storyId} ${story.title}"`);
        results.push(`✓ 分支 ${branch} 已合并到 ${mainBranch}`);
      } catch (e: any) {
        throw new Error(
          `合并冲突，请手动解决:\ngit merge ${branch}\n${e.stderr || e.message}`
        );
      }

      // 清理 worktree（B-0975: Windows 上 Permission denied 瞬时锁重试）
      worktreeRemoveWithRetry(wtPath);
      results.push(`✓ Worktree ${wtPath} 已清理`);

      // 删除分支
      try {
        git(`branch -d ${branch}`);
        results.push(`✓ 分支 ${branch} 已删除`);
      } catch {
        results.push(`⚠ 分支 ${branch} 未删除（可能有未合并的提交）`);
      }

      // 清理 story 记录
      story.worktree = undefined;
      story.endedAt = new Date().toISOString();
      store.writeStory(args.storyId, story);
      results.push(`✓ Story ${args.storyId} 已完成 (DONE)`);

      return results.join('\n');
    },

    /** 废弃 story：任意阶段均可调用，强制清理 worktree 和分支 */
    story_discard(args: { storyId: string; reason?: string; force?: boolean; purge?: boolean }): string {
      const story = store.readStory(args.storyId);

      if (story.phase === 'DONE') {
        throw new Error(`Story ${args.storyId} 已 DONE，不能 discard（已完成的 story 请通过 git revert 撤销）`);
      }
      const wasDiscarded = story.phase === 'DISCARDED';

      const results: string[] = [];
      const fallbackBranch = `story/${args.storyId}`;
      const branch = story.worktree?.branch || fallbackBranch;
      const detectedWorktreePath = story.worktree?.path
        ? resolveWorktreePath(story.worktree.path)
        : findWorktreeResidue(args.storyId, branch) || findWorktreePathByBranch(branch);

      // 清理 worktree（如果存在）。任何清理失败都 fail closed：不写
      // DISCARDED，不删除 metadata，不输出“已清理”的伪成功。
      if (detectedWorktreePath) {
        const wtPath = detectedWorktreePath;
        if (existsSync(wtPath)) {
          const usableGitWorktree = isUsableGitWorktree(wtPath);
          if (!usableGitWorktree && !args.force) {
            throw new Error(
              `Worktree git metadata 已损坏，无法安全检查未提交改动:\n` +
              `${wtPath}\n` +
              `→ 如确认这是残留目录并要丢弃，加 force:true 重试：koala story_discard '{"storyId":"${args.storyId}","force":true}'`,
            );
          }

          let removeFailure: string | null = null;
          if (!usableGitWorktree) {
            try {
              removePathWithTimeout(wtPath);
              results.push(`✓ invalid worktree residue 已清理: ${wtPath}`);
            } catch (rmError: any) {
              throw new Error(
                `story_discard: invalid worktree residue 清理失败，已停止 discard，避免留下半清理状态。\n` +
                `worktree: ${wtPath}\nbranch: ${branch}\n原因: ${removeFailure}\n` +
                `目录清理也失败: ${gitErrorMessage(rmError)}`,
              );
            }
          } else {
            if (!args.force) {
              // B-5fa4 CHK-003: warn about unpushed commits before discard cleanup
              const unpushed = checkUnpushedCommits(wtPath, branch);
              if (unpushed.warning) {
                results.push(unpushed.warning);
              }

              // 检查未提交改动。force:true 是用户明确确认丢弃，不能先因 git status 失败卡死。
              const wtStatus = git('status --porcelain', wtPath);
              if (wtStatus) {
                throw new Error(
                  `Worktree 有未提交的改动:\n${wtStatus}\n→ 如确认丢弃，加 force:true 重试：koala story_discard '{"storyId":"${args.storyId}","force":true}'`
                );
              }
            }

            // 强制移除 worktree（B-0975: Windows Permission denied 瞬时锁重试）
            // 如果 git remove 已经把 registry 弄成 prunable / 0000000，但
            // 目录仍有残留，则继续 rm + prune，而不是把清理责任推给用户。
            try {
              worktreeRemoveWithRetry(wtPath, { force: true });
              results.push(`✓ Worktree ${wtPath} 已清理`);
            } catch (e: any) {
              removeFailure = gitErrorMessage(e);
              try {
                removePathWithTimeout(wtPath);
              } catch (rmError: any) {
                throw new Error(
                  `story_discard: worktree 移除失败，已停止 discard，避免留下半清理状态。\n` +
                  `worktree: ${wtPath}\nbranch: ${branch}\n原因: ${removeFailure}\n` +
                  `目录清理也失败: ${gitErrorMessage(rmError)}`,
                );
              }
            }
          }

          try {
            const removedAdmins = removeStaleWorktreeAdminDirs(args.storyId, branch, wtPath);
            if (removedAdmins.length > 0) results.push(`✓ stale git worktree admin 已清理: ${removedAdmins.join(', ')}`);
            pruneWorktreeRegistry();
            if (removeFailure || findWorktreeResidue(args.storyId, branch, wtPath)) {
              results.push(`✓ stale worktree metadata 已 prune: ${wtPath}`);
            }
          } catch (e: any) {
            if (!removeFailure) removeFailure = 'git worktree remove succeeded but prune failed';
            throw new Error(
              `story_discard: worktree cleanup 后 metadata prune 失败，已停止 discard。\n` +
              `worktree: ${wtPath}\nbranch: ${branch}\nremove 状态: ${removeFailure}\nprune 原因: ${gitErrorMessage(e)}`,
            );
          }

          if (removeFailure && findWorktreeResidue(args.storyId, branch, wtPath)) {
            try {
              pruneWorktreeRegistry();
            } catch (e: any) {
              throw new Error(
                `story_discard: worktree 移除失败后 metadata prune 失败，已停止 discard。\n` +
                `worktree: ${wtPath}\nbranch: ${branch}\nremove 原因: ${removeFailure}\nprune 原因: ${gitErrorMessage(e)}`,
              );
            }
            if (!existsSync(wtPath) && findWorktreeResidue(args.storyId, branch, wtPath)) {
              const removedAdmins = removeStaleWorktreeAdminDirs(args.storyId, branch, wtPath);
              if (removedAdmins.length > 0) results.push(`✓ stale git worktree admin 已清理: ${removedAdmins.join(', ')}`);
            }
          }
        } else {
          let pruneFailure: string | null = null;
          try {
            pruneWorktreeRegistry();
            results.push(`✓ stale worktree metadata 已 prune: ${wtPath}`);
          } catch (e: any) {
            pruneFailure = gitErrorMessage(e);
          }
          if (findWorktreeResidue(args.storyId, branch, wtPath)) {
            const removedAdmins = removeStaleWorktreeAdminDirs(args.storyId, branch, wtPath);
            if (removedAdmins.length > 0) results.push(`✓ stale git worktree admin 已清理: ${removedAdmins.join(', ')}`);
            try {
              pruneWorktreeRegistry();
              results.push(`✓ stale worktree metadata 已 prune: ${wtPath}`);
              pruneFailure = null;
            } catch (e: any) {
              pruneFailure = pruneFailure || gitErrorMessage(e);
            }
          }
          if (pruneFailure && findWorktreeResidue(args.storyId, branch, wtPath)) {
            throw new Error(
              `story_discard: worktree 路径不存在但 git metadata prune 失败，已停止 discard。\n` +
              `worktree: ${wtPath}\nbranch: ${branch}\n原因: ${pruneFailure}\n` +
              `→ 关闭占用该仓库的进程后重试。`,
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
              `story_discard: worktree 清理后复查失败，metadata prune 也失败，已停止 discard。\n` +
              `worktree: ${wtPath}\nbranch: ${branch}\n原因: ${gitErrorMessage(e)}`,
            );
          }
          if (!existsSync(wtPath) && findWorktreeResidue(args.storyId, branch, wtPath)) {
            const removedAdmins = removeStaleWorktreeAdminDirs(args.storyId, branch, wtPath);
            if (removedAdmins.length > 0) results.push(`✓ stale git worktree admin 已清理: ${removedAdmins.join(', ')}`);
          }
        }

        const finalPathStillExists = existsSync(wtPath);
        const finalLingeringWorktreePath = findWorktreeResidue(args.storyId, branch, wtPath);
        if (finalPathStillExists || finalLingeringWorktreePath) {
          throw new Error(
            `story_discard: worktree 复查仍有残留，已停止 discard。\n` +
            `worktree: ${wtPath}${finalPathStillExists ? ' (path still exists)' : ''}\n` +
            `branch: ${branch}${finalLingeringWorktreePath ? ` (${finalLingeringWorktreePath})` : ''}\n` +
            `→ 关闭占用该 worktree 的进程后重试 story_discard。`,
          );
        }

        // 强制删除分支
        try {
          git(`branch -D ${branch}`);
          results.push(`✓ 分支 ${branch} 已删除`);
        } catch (e: any) {
          if (branchExists(branch)) {
            throw new Error(
              `story_discard: 分支 ${branch} 删除失败，已停止 discard。\n原因: ${gitErrorMessage(e)}`,
            );
          }
          results.push(`✓ 分支 ${branch} 已不存在`);
        }

        story.worktree = undefined;
      } else if (branchExists(branch)) {
        try {
          git(`branch -D ${branch}`);
          results.push(`✓ 分支 ${branch} 已删除`);
        } catch (e: any) {
          throw new Error(
            `story_discard: 分支 ${branch} 删除失败，已停止 discard。\n原因: ${gitErrorMessage(e)}`,
          );
        }
      }

      if (args.purge) {
        const storyRel = `${loadConfig(root).storyDir.replace(/\\/g, '/')}/${args.storyId}`;
        rmSync(join(root, storyRel), { recursive: true, force: true });
        results.push(`✓ Story metadata 已清理: ${storyRel}`);
        results.push(purgeSafeInitCommit(args.storyId, storyRel));
        return results.join('\n');
      }

      // 记录 discard 事件
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
        ? `✓ Story ${args.storyId} 已是 DISCARDED；残留已检查/清理`
        : `✓ Story ${args.storyId} 已标记为 DISCARDED${args.reason ? ` (原因: ${args.reason})` : ''}`);
      return results.join('\n');
    },
  };
}


import { execFileSync, execSync } from 'child_process';
import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'fs';
import { dirname, join, relative, isAbsolute, resolve, sep } from 'path';
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
        git(`worktree remove${flag} "${wtPath}"`);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
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

      // B-7eed: 先把 story.worktree 字段写进 story index.json，再 git add/commit，
      // 避免 commit 后 writeStory 留下主仓库 working tree 脏（会导致后续 DONE
      // 阶段 `git merge story/B-xxx` 报 "local changes would be overwritten"）。
      const now = new Date().toISOString();
      story.worktree = { path: relWorktreePath, branch, createdAt: now };
      if (!story.startedAt) story.startedAt = now;
      store.writeStory(args.storyId, story);

      // 先 commit story/metadata 文件，确保 worktree 能看到
      // B-5246: fresh `git init` 仓库还没有任何 commit；`git branch story/B-xxx`
      // 在没有 HEAD 的情况下会 `fatal: not a valid object name: 'main'`。
      // 用 `git add -A` + `git commit --allow-empty` 在 worktree 之前确保至少有
      // 一个 root commit 存在，这样 `git branch` 就能从当前 HEAD 创建。
      try {
        // 用 -A 而不是只 add docs/story —— 新项目里 koala.config.json 等也需要进入 worktree
        git(`add -A`);
        git(`commit -m "koala: story ${args.storyId} init" --allow-empty`);
      } catch { /* 没有改动也没关系 */ }

      // 创建分支（如果不存在）
      // B-5246: 在 fresh 仓库上 `git branch <name>` 仍可能因为 HEAD 是 unborn 状态而失败。
      // 改用 `git branch <name> HEAD` 显式指向 HEAD；如果 HEAD 还是 unborn 就先用 checkout
      // 创建一个空的 root branch。
      try {
        git(`rev-parse --verify ${branch}`);
      } catch {
        try {
          git(`branch ${branch}`);
        } catch {
          // Fallback: HEAD 还没有任何 commit。强制创建一个空的 root commit 再分支。
          try {
            git(`commit --allow-empty -m "koala: bootstrap empty root for ${args.storyId}"`);
            git(`branch ${branch}`);
          } catch (e: any) {
            throw new Error(
              `无法在仓库根创建 worktree 分支 ${branch}：${e.message}。可能是仓库尚未 git init / 没有任何提交。先 git commit 一次再重试。`,
            );
          }
        }
      }

      // 创建 worktree
      git(`worktree add "${worktreePath}" ${branch}`);

      // B-5fa4 CHK-003: parallelSafety check at worktree creation
      const parallelWarning = checkParallelSafety(args.storyId);

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
    story_discard(args: { storyId: string; reason?: string; force?: boolean }): string {
      const story = store.readStory(args.storyId);

      if (story.phase === 'DONE') {
        throw new Error(`Story ${args.storyId} 已 DONE，不能 discard（已完成的 story 请通过 git revert 撤销）`);
      }
      if (story.phase === 'DISCARDED') {
        return `Story ${args.storyId} 已是 DISCARDED 状态，无需重复操作`;
      }

      const results: string[] = [];

      // 清理 worktree（如果存在）
      if (story.worktree) {
        const wtPath = resolveWorktreePath(story.worktree.path);
        const { branch } = story.worktree;

        if (existsSync(wtPath)) {
          // B-5fa4 CHK-003: warn about unpushed commits before discard cleanup
          const unpushed = checkUnpushedCommits(wtPath, branch);
          if (unpushed.warning) {
            results.push(unpushed.warning);
          }

          // 检查未提交改动
          const wtStatus = git('status --porcelain', wtPath);
          if (wtStatus && !args.force) {
            throw new Error(
              `Worktree 有未提交的改动:\n${wtStatus}\n→ 如确认丢弃，加 force:true 重试：koala story_discard '{"storyId":"${args.storyId}","force":true}'`
            );
          }

          // 强制移除 worktree（B-0975: Windows Permission denied 瞬时锁重试）
          try {
            worktreeRemoveWithRetry(wtPath, { force: true });
            results.push(`✓ Worktree ${wtPath} 已清理`);
          } catch (e: any) {
            results.push(`⚠ worktree 移除失败: ${e.message}`);
          }
        }

        // 强制删除分支
        try {
          git(`branch -D ${branch}`);
          results.push(`✓ 分支 ${branch} 已删除`);
        } catch {
          results.push(`⚠ 分支 ${branch} 未删除（可能已不存在）`);
        }

        story.worktree = undefined;
      }

      // 记录 discard 事件
      const now = new Date().toISOString();
      story.phase = 'DISCARDED';
      story.endedAt = now;
      if (!story.events) story.events = [];
      const event = collectContext('DISCARDED', 'discard');
      if (args.reason) event.reason = args.reason;
      story.events.push(event);
      store.writeStory(args.storyId, story);

      results.push(`✓ Story ${args.storyId} 已标记为 DISCARDED${args.reason ? ` (原因: ${args.reason})` : ''}`);
      return results.join('\n');
    },
  };
}

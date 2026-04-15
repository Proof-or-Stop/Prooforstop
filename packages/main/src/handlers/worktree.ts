
import { execSync } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, relative, isAbsolute } from 'path';
import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT } from './context.js';
import { createStoryActor, getStateName, getPhaseInvariantStatus } from '../core/machine.js';
import type { StoryPhase } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { formatPhaseGateDecision } from '../core/phase-protocol.js';
import { getStoryWorktreeRuntime, getRepoRoot, resolveLinkedWorktreePath, resolveLinkedWorktreeStoryPath } from '../core/worktree-runtime.js';

export function createWorktreeHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;
  const BOOTSTRAP_LOCK_TIMEOUT_MS = 10_000;
  const BOOTSTRAP_LOCK_STALE_MS = 30_000;

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

  function shellQuote(value: string): string {
    return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
  }

  function waitMs(ms: number): void {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* busy-wait; execSync is already sync */ }
  }

  function canonicalPath(path: string): string {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  }

  function getGitCommonDir(): string {
    try {
      const topLevel = canonicalPath(execSync('git rev-parse --show-toplevel', { cwd: root, encoding: 'utf-8' }).trim());
      const commonDir = execSync('git rev-parse --git-common-dir', { cwd: root, encoding: 'utf-8' }).trim();
      return canonicalPath(isAbsolute(commonDir) ? commonDir : join(topLevel, commonDir));
    } catch {
      return canonicalPath(join(root, '.git'));
    }
  }

  function repoRoot(): string {
    try {
      const commonDir = getGitCommonDir();
      if (commonDir.endsWith('/.git') || commonDir.endsWith('\\.git')) {
        return dirname(commonDir);
      }
    } catch { /* PROBE */ }
    return getRepoRoot(root);
  }

  /** 将 story 里存的 worktree.path（可能是相对或绝对）解析为绝对路径 */
  function resolveWorktreePath(storedPath: string): string {
    if (isAbsolute(storedPath)) return storedPath;
    return join(repoRoot(), storedPath);
  }

  function commitContainsPath(revision: string, targetPath: string): boolean {
    try {
      const output = git(`ls-tree -r --name-only ${revision} -- ${shellQuote(targetPath)}`);
      return output.split('\n').some(line => line.trim() === targetPath);
    } catch {
      return false;
    }
  }

  function getBootstrapStagePaths(storyId: string, repoRoot: string): string[] {
    const config = loadConfig(root);
    const storyDir = canonicalPath(join(root, config.storyDir, storyId));
    const stagePaths = [relative(repoRoot, storyDir).replace(/\\/g, '/')];
    const configPath = canonicalPath(join(root, 'koala.config.json'));
    if (existsSync(configPath)) {
      stagePaths.push(relative(repoRoot, configPath).replace(/\\/g, '/'));
    }
    return stagePaths;
  }

  function acquireBootstrapLock(storyId: string): () => void {
    const lockPath = join(getGitCommonDir(), 'koala', 'init-check.bootstrap.lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    const delays = [0, 100, 250, 500, 1000, 1500, 2500, 3500];

    for (const delay of delays) {
      if (delay > 0) waitMs(delay);
      try {
        const fd = openSync(lockPath, 'wx');
        try {
          writeFileSync(fd, JSON.stringify({
            storyId,
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
          }) + '\n', 'utf-8');
        } finally {
          closeSync(fd);
        }

        return () => {
          try {
            unlinkSync(lockPath);
          } catch (e: any) {
            if (e?.code !== 'ENOENT') throw e;
          }
        };
      } catch (e: any) {
        if (e?.code !== 'EEXIST') {
          throw new Error(`无法获取 INIT_CHECK bootstrap 锁 ${lockPath}: ${e.message || String(e)}`);
        }
        try {
          const ageMs = Date.now() - statSync(lockPath).mtimeMs;
          if (ageMs > BOOTSTRAP_LOCK_STALE_MS) {
            try {
              unlinkSync(lockPath);
            } catch { /* PROBE: another process may have released or replaced the stale lock */ }
          }
        } catch { /* PROBE: lock file disappeared while checking staleness */ }
      }
    }

    throw new Error(
      `INIT_CHECK bootstrap 正在被其他 story 串行执行（>${BOOTSTRAP_LOCK_TIMEOUT_MS}ms）\n` +
      `lock: ${lockPath}\n` +
      `→ 稍后重试 story_advance --phase=INIT_CHECK。若确认持锁进程已退出，可删除该 lock 后重试`
    );
  }

  return {
    dev_start(args: { storyId: string }): string {
      const story = store.readStory(args.storyId);
      const runtime = getStoryWorktreeRuntime(args.storyId, store, root);

      // 已有 worktree 则直接返回路径
      if (story.worktree) {
        const linkedPath = resolveLinkedWorktreePath(runtime);
        if (runtime.linkedPath && runtime.canRepairPath) {
          const repaired = store.readStory(args.storyId);
          const existingWorktree = repaired.worktree;
          if (!existingWorktree) {
            throw new Error(`Story ${args.storyId} 缺少 worktree 记录，无法修正漂移`);
          }
          repaired.worktree = {
            path: resolveLinkedWorktreeStoryPath(runtime) || existingWorktree.path,
            branch: existingWorktree.branch,
            createdAt: existingWorktree.createdAt,
          };
          store.writeStory(args.storyId, repaired);
          return [
            `Story ${args.storyId} worktree 已恢复`,
            `路径: ${linkedPath}`,
            `分支: ${repaired.worktree.branch}`,
            '⚠ 检测到 story.worktree.path 漂移，已按 git worktree list 自动修正',
          ].join('\n');
        }
        if (linkedPath && existsSync(linkedPath)) {
          return [
            `Story ${args.storyId} worktree 已存在`,
            `路径: ${linkedPath}`,
            `分支: ${story.worktree.branch}`,
            ...(runtime.drift ? ['⚠ story.worktree.path 与 git linked worktree 不一致，请同步修正'] : []),
          ].join('\n');
        }
        if (runtime.status === 'orphaned') {
          throw new Error(
            `Story ${args.storyId} 记录的 worktree 目录仍存在，但 git registry 没有匹配项\n` +
            `路径: ${runtime.recordedAbsPath}\n` +
            `→ 先检查 git worktree list / git worktree repair；若目录是残留，再清理后重试`
          );
        }
        // worktree 目录与 git registry 都不存在了，清理记录后重建
        if (!runtime.linkedPath && !runtime.recordedExists) {
          story.worktree = undefined;
          store.writeStory(args.storyId, story);
        }
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
      const repoRootPath = repoRoot();
      const worktreeDir = loadConfig(root).worktreeDir || '.worktrees';
      const worktreePath = join(repoRootPath, worktreeDir, args.storyId);
      const relWorktreePath = relative(repoRootPath, worktreePath).replace(/\\/g, '/');
      const storyIndexPath = relative(
        repoRootPath,
        canonicalPath(join(root, loadConfig(root).storyDir, args.storyId, 'index.json')),
      ).replace(/\\/g, '/');
      const stagePaths = getBootstrapStagePaths(args.storyId, repoRootPath);
      const releaseBootstrapLock = acquireBootstrapLock(args.storyId);

      try {
        const now = new Date().toISOString();
        const lockedStory = store.readStory(args.storyId);
        lockedStory.worktree = { path: relWorktreePath, branch, createdAt: now };
        if (!lockedStory.startedAt) lockedStory.startedAt = now;
        store.writeStory(args.storyId, lockedStory);

        git(`add -- ${stagePaths.map(shellQuote).join(' ')}`);
        const staged = git(`diff --cached --name-only -- ${stagePaths.map(shellQuote).join(' ')}`);
        if (!staged.split('\n').some(line => line.trim() === storyIndexPath)) {
          throw new Error(
            `bootstrap staged changes missing ${storyIndexPath}\n` +
            `staged:\n${staged || '(none)'}`
          );
        }

        try {
          git(`commit -m ${shellQuote(`koala: story ${args.storyId} init`)}`);
        } catch (e: any) {
          throw new Error(`无法提交 ${args.storyId} 的 bootstrap metadata：${e.message || String(e)}`);
        }

        const commitSha = git('rev-parse HEAD');
        if (!commitContainsPath(commitSha, storyIndexPath)) {
          throw new Error(`bootstrap commit ${commitSha} 不包含 ${storyIndexPath}`);
        }

        let branchExists = true;
        try {
          git(`rev-parse --verify ${branch}`);
        } catch {
          branchExists = false;
        }

        if (!branchExists) {
          try {
            git(`branch ${branch} ${commitSha}`);
          } catch (e: any) {
            throw new Error(
              `无法在仓库根创建 worktree 分支 ${branch}：${e.message || String(e)}。` +
              `可能是仓库尚未 git init / 没有任何提交。先 git commit 一次再重试。`
            );
          }
        }

        const branchSha = git(`rev-parse --verify ${branch}`);
        if (!commitContainsPath(branchSha, storyIndexPath)) {
          throw new Error(
            `现有分支 ${branch} 指向的 commit ${branchSha} 不包含 ${storyIndexPath}\n` +
            `→ 这通常说明之前并发 INIT_CHECK 曾从旧 HEAD 分叉。请清理该分支/坏 worktree 后重试`
          );
        }

        git(`worktree add ${shellQuote(worktreePath)} ${branch}`);
      } catch (e) {
        if (!existsSync(worktreePath)) {
          const freshStory = store.readStory(args.storyId);
          freshStory.worktree = undefined;
          store.writeStory(args.storyId, freshStory);
        }
        throw e;
      } finally {
        releaseBootstrapLock();
      }

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
      const storyDir = join('docs', 'story', 'actives', args.storyId);
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
        const actor = createStoryActor(args.storyId, store, story.phase);
        actor.start();
        actor.send({ type: 'REVIEW' });
        const newState = getStateName(actor);
        actor.stop();

        if (newState === 'DEV') {
          // guard 失败，给出原因
          const reason = formatPhaseGateDecision(getPhaseInvariantStatus(args.storyId, store, 'TEST'));
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
      const storyDir = join('docs', 'story', 'actives', args.storyId);
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
        const actor = createStoryActor(args.storyId, store, story.phase);
        actor.start();
        actor.send({ type: 'FINISH' });
        const newState = getStateName(actor);
        actor.stop();

        if (newState === 'TEST') {
          const reason = formatPhaseGateDecision(getPhaseInvariantStatus(args.storyId, store, 'DONE'));
          throw new Error(`无法合并: ${reason || '测试未全部通过或存在未修复 bug'}`);
        }

        story.phase = newState as StoryPhase;
        if (!story.events) story.events = [];
        story.events.push(collectContext('DONE', 'advance'));
      }

      const mainBranch = git('rev-parse --abbrev-ref HEAD');
      const results: string[] = [];

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
    story_discard(args: { storyId: string; reason?: string; force?: boolean; dryRun?: boolean; confirm?: boolean }): string {
      const story = store.readStory(args.storyId);

      if (story.phase === 'DONE') {
        throw new Error(`Story ${args.storyId} 已 DONE，不能 discard（已完成的 story 请通过 git revert 撤销）`);
      }
      if (story.phase === 'DISCARDED') {
        return `Story ${args.storyId} 已是 DISCARDED 状态，无需重复操作`;
      }

      if (args.dryRun) {
        const plan: string[] = [`[DRY-RUN] story_discard ${args.storyId} would:`];
        if (story.worktree) {
          const wtPath = resolveWorktreePath(story.worktree.path);
          const { branch } = story.worktree;
          if (existsSync(wtPath)) {
            plan.push(`- remove linked worktree: ${wtPath}`);
          } else {
            plan.push(`- worktree already missing: ${wtPath}`);
          }
          plan.push(`- delete branch if present: ${branch}`);
        } else {
          plan.push('- no active worktree recorded');
        }
        plan.push(`- mark story phase as DISCARDED${args.reason ? ` (reason: ${args.reason})` : ''}`);
        plan.push('- append discard event to story history');
        plan.push('→ 加 --confirm 真实执行');
        return plan.join('\n');
      }

      const results: string[] = [];

      // 清理 worktree（如果存在）
      if (story.worktree) {
        const wtPath = resolveWorktreePath(story.worktree.path);
        const { branch } = story.worktree;

        if (existsSync(wtPath)) {
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

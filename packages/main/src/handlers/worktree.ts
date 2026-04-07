
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, relative, isAbsolute } from 'path';
import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT } from './context.js';
import { createStoryActor, getStateName, getGuardFailureReason } from '../core/machine.js';
import type { StoryPhase } from '../core/types.js';
import { loadConfig } from '../core/config.js';

export function createWorktreeHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;

  function git(cmd: string, cwd?: string): string {
    return execSync(`git ${cmd}`, {
      cwd: cwd || root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
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

      // 记录到 story
      const now = new Date().toISOString();
      story.worktree = { path: relWorktreePath, branch, createdAt: now };
      if (!story.startedAt) story.startedAt = now;
      store.writeStory(args.storyId, story);

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
          const reason = getGuardFailureReason(args.storyId, store, 'TEST');
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
          const reason = getGuardFailureReason(args.storyId, store, 'DONE');
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

      // 清理 worktree
      git(`worktree remove "${wtPath}"`);
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
          // 检查未提交改动
          const wtStatus = git('status --porcelain', wtPath);
          if (wtStatus && !args.force) {
            throw new Error(
              `Worktree 有未提交的改动:\n${wtStatus}\n→ 如确认丢弃，加 force:true 重试：koala story_discard '{"storyId":"${args.storyId}","force":true}'`
            );
          }

          // 强制移除 worktree
          try {
            git(`worktree remove --force "${wtPath}"`);
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

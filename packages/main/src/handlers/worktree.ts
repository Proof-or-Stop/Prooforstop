
import { execSync } from 'child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, relative, isAbsolute } from 'path';
import { tmpdir } from 'os';
import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT } from './context.js';
import { createStoryActor, getStateName, getPhaseInvariantStatus } from '../core/machine.js';
import type { StoryPhase } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { formatPhaseGateDecision } from '../core/phase-protocol.js';
import { getStoryWorktreeRuntime, getRepoRoot, resolveLinkedWorktreePath, resolveLinkedWorktreeStoryPath } from '../core/worktree-runtime.js';
import { collectBaselineRisk, renderBaselineRiskLines, type BaselineRisk } from '../core/baseline-risk.js';

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

  function gitWithEnv(cmd: string, cwd: string, extraEnv: NodeJS.ProcessEnv): string {
    return execSync(`git ${cmd}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
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

  function storyArtifactDir(storyId: string): string {
    const config = loadConfig(root);
    return join(root, config.storyDir, storyId);
  }

  function cleanupDiscardedStoryResidue(storyId: string, dryRun: boolean): string[] {
    const dir = storyArtifactDir(storyId);
    if (!existsSync(dir)) return [`✓ Story ${storyId} 没有残留目录需要清理`];

    const rel = relative(root, dir).split('\\').join('/');
    const status = git(`status --porcelain -- ${shellQuote(rel)}`);
    if (!status) {
      return [`⚠ Story ${storyId} 的目录仍被 git 跟踪，已保留: ${rel}`];
    }

    const lines = status.split('\n').filter(Boolean);
    const allUntracked = lines.every((line) => line.startsWith('?? '));
    if (!allUntracked) {
      throw new Error(
        `Story ${storyId} 的残留目录包含 tracked/staged 改动，拒绝自动清理:\n${status}\n` +
        `→ 先人工确认这些改动是否要保留，再重试 cleanupResidue`
      );
    }

    if (dryRun) return [`- remove untracked discarded story residue: ${rel}`];
    rmSync(dir, { recursive: true, force: true });
    return [`✓ 已清理 DISCARDED story 残留目录: ${rel}`];
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

  function hasPathChanges(cwd: string, targetPath: string): boolean {
    try {
      return git(`status --porcelain -- ${shellQuote(targetPath)}`, cwd).length > 0;
    } catch {
      return false;
    }
  }

  function renderInitCheckBootstrapPlan(args: {
    storyId: string;
    repoRootPath: string;
    worktreePath: string;
    branch: string;
    stagePaths: string[];
    baselineRisk: BaselineRisk;
    dryRun?: boolean;
  }): string {
    const prefix = args.dryRun ? '[DRY-RUN] ' : '';
    const lines = [
      `${prefix}INIT_CHECK bootstrap plan:`,
      `  - repo: ${args.repoRootPath}`,
      `  - worktree: ${args.worktreePath}`,
      `  - branch: ${args.branch}`,
      '  - write story.worktree metadata',
      `  - create bootstrap commit for ${args.branch} only (current branch HEAD stays unchanged)`,
      `  - git branch ${args.branch} <bootstrap-commit-with-story-metadata>`,
      `  - git worktree add "${args.worktreePath}" ${args.branch}`,
    ];
    const riskLines = renderBaselineRiskLines(args.baselineRisk, { includeVolatileSummary: true });
    if (riskLines.length > 0) {
      lines.push('', ...riskLines);
    }
    return lines.join('\n');
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

  function collectStoryBaselineRisk(storyId: string, repoRootPath = repoRoot()): BaselineRisk {
    const config = loadConfig(repoRootPath);
    return collectBaselineRisk(repoRootPath, {
      acceptedLocalPaths: config.baselineRiskAcceptedLocalPaths,
      excludePaths: getBootstrapStagePaths(storyId, repoRootPath),
    });
  }

  function createBootstrapBranchCommit(args: {
    repoRootPath: string;
    stagePaths: string[];
    storyId: string;
    storyIndexPath: string;
  }): string {
    const tempRoot = existsSync(getGitCommonDir())
      ? join(getGitCommonDir(), 'koala')
      : join(tmpdir(), 'koala');
    mkdirSync(tempRoot, { recursive: true });
    const tempDir = mkdtempSync(join(tempRoot, 'bootstrap-index-'));
    const tempIndexPath = join(tempDir, 'index');
    const tempEnv = { GIT_INDEX_FILE: tempIndexPath };

    try {
      const headSha = git('rev-parse HEAD', args.repoRootPath);
      gitWithEnv(`read-tree ${headSha}`, args.repoRootPath, tempEnv);
      gitWithEnv(`add -- ${args.stagePaths.map(shellQuote).join(' ')}`, args.repoRootPath, tempEnv);

      const staged = gitWithEnv(
        `diff --cached --name-only -- ${args.stagePaths.map(shellQuote).join(' ')}`,
        args.repoRootPath,
        tempEnv,
      );
      if (!staged.split('\n').some(line => line.trim() === args.storyIndexPath)) {
        throw new Error(
          `bootstrap staged changes missing ${args.storyIndexPath}\n` +
          `staged:\n${staged || '(none)'}`
        );
      }

      const treeSha = gitWithEnv('write-tree', args.repoRootPath, tempEnv);
      const commitSha = gitWithEnv(
        `commit-tree ${treeSha} -p ${headSha} -m ${shellQuote(`koala: story ${args.storyId} init`)}`,
        args.repoRootPath,
        tempEnv,
      );

      if (!commitContainsPath(commitSha, args.storyIndexPath)) {
        throw new Error(`bootstrap commit ${commitSha} 不包含 ${args.storyIndexPath}`);
      }

      return commitSha;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
    dev_start(args: { storyId: string; dryRun?: boolean; confirm?: boolean }): string {
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
            ...renderBaselineRiskLines(collectStoryBaselineRisk(args.storyId), { includeVolatileSummary: true }),
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
      // dryRun / 未 confirm 的预览场景允许从 INIT 看 bootstrap 计划，但不实际执行。
      const allowedPhases: StoryPhase[] = (args.dryRun || !args.confirm)
        ? ['INIT', 'INIT_CHECK', 'PLAN', 'DEV']
        : ['INIT_CHECK', 'PLAN', 'DEV'];
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
      const baselineRisk = collectStoryBaselineRisk(args.storyId, repoRootPath);

      const bootstrapPlan = renderInitCheckBootstrapPlan({
        storyId: args.storyId,
        repoRootPath,
        worktreePath,
        branch,
        stagePaths,
        baselineRisk,
        dryRun: args.dryRun,
      });
      if (args.dryRun) {
        return bootstrapPlan + '\n→ 这是 dry-run 预览。确认无误后，再带 confirm:true 真实执行 INIT_CHECK bootstrap';
      }
      if (!args.confirm) {
        throw new Error(
          `dev_start(${args.storyId}) 会自动写 story.worktree metadata，并为 story 分支创建 bootstrap git commit，默认已阻止。\n` +
          bootstrapPlan + '\n' +
          '→ 先传 dryRun:true 预览，确认后再传 confirm:true 真实执行'
        );
      }

      const releaseBootstrapLock = acquireBootstrapLock(args.storyId);

      try {
        const now = new Date().toISOString();
        const lockedStory = store.readStory(args.storyId);
        lockedStory.worktree = { path: relWorktreePath, branch, createdAt: now };
        if (!lockedStory.startedAt) lockedStory.startedAt = now;
        store.writeStory(args.storyId, lockedStory);

        let branchExists = true;
        try {
          git(`rev-parse --verify ${branch}`);
        } catch {
          branchExists = false;
        }

        if (!branchExists) {
          const commitSha = createBootstrapBranchCommit({
            repoRootPath,
            stagePaths,
            storyId: args.storyId,
            storyIndexPath,
          });
          try {
            git(`branch ${branch} ${commitSha}`);
          } catch (e: any) {
            throw new Error(
              `无法在仓库根创建 worktree 分支 ${branch}：${e.message || String(e)}。` +
              `可能是仓库尚未 git init / 没有任何提交。若要本地 git commit 初始化仓库，未经用户 confirm 不允许；确认后再重试。`
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
        ...renderBaselineRiskLines(baselineRisk, { includeVolatileSummary: true }),
        `→ cd ${worktreePath} 进入 worktree 开发，所有 koala 命令在此目录执行`,
        `→ sub agent 不要使用 isolation:"worktree"，直接在主 agent 的 worktree 中跑`,
        `→ checklist_get(${args.storyId}) 查看待开发项`,
        `→ 开发完成后调用 dev_finish(${args.storyId})。若后续路径会自动触发本地 git commit / git merge，未经 confirm 不允许`,
        depsWarning,
      ].filter(Boolean).join('\n');
    },

    dev_finish(args: { storyId: string; dryRun?: boolean; confirm?: boolean }): string {
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

      const storyDir = join(loadConfig(root).storyDir, args.storyId).replace(/\\/g, '/');
      const autoCommitStoryFiles = hasPathChanges(wtPath, storyDir);
      const finishPlanLines = [
        `${args.dryRun ? '[DRY-RUN] ' : ''}dev_finish(${args.storyId}) plan:`,
        `  - worktree: ${wtPath}`,
        ...(autoCommitStoryFiles
          ? [`  - git add ${storyDir}`, `  - git commit -m "koala: auto-add story files for ${args.storyId}"`]
          : ['  - no automatic git commit needed for story runtime files']),
        '  - advance story phase to TEST',
      ];
      if (args.dryRun) {
        return finishPlanLines.join('\n') + '\n→ 这是 dry-run 预览。若需要自动提交 story 运行时文件，再加 confirm:true 真实执行';
      }
      if (autoCommitStoryFiles && !args.confirm) {
        throw new Error(
          `dev_finish(${args.storyId}) 会自动 git add/git commit story 运行时文件，默认已阻止。\n` +
          finishPlanLines.join('\n') + '\n' +
          '→ 先传 dryRun:true 预览，确认后再传 confirm:true 真实执行'
        );
      }

      // 自动提交 story 目录下的运行时产生的文件（review.json 等）
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
        `→ 测试全部通过后如需自动收尾，先 dry-run 再 confirm 调用 dev_merge(${args.storyId})`,
      ];

      return results.join('\n');
    },

    dev_merge(args: { storyId: string; dryRun?: boolean; confirm?: boolean }): string {
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

      const storyDir = join(loadConfig(root).storyDir, args.storyId).replace(/\\/g, '/');
      const autoCommitStoryFiles = hasPathChanges(wtPath, storyDir);
      const currentMainBranch = git('rev-parse --abbrev-ref HEAD');
      const mergePlanLines = [
        `${args.dryRun ? '[DRY-RUN] ' : ''}dev_merge(${args.storyId}) plan:`,
        `  - main branch: ${currentMainBranch}`,
        `  - story branch: ${branch}`,
        `  - worktree: ${wtPath}`,
        ...(autoCommitStoryFiles
          ? [`  - git add ${storyDir}`, `  - git commit -m "koala: auto-add story files for ${args.storyId}"`]
          : ['  - no automatic git commit needed for story runtime files']),
        `  - git merge ${branch} --no-ff -m "merge: ${args.storyId} ${story.title}"`,
        `  - git worktree remove ${wtPath}`,
        `  - git branch -d ${branch}`,
        '  - persist story metadata as DONE and clear worktree record',
      ];
      if (args.dryRun) {
        return mergePlanLines.join('\n') + '\n→ 这是 dry-run 预览。确认无误后再传 confirm:true 真实执行';
      }
      if (!args.confirm) {
        throw new Error(
          `dev_merge(${args.storyId}) 会自动执行 git merge/worktree 清理/branch 删除${autoCommitStoryFiles ? '，并可能先自动提交 story 运行时文件' : ''}，默认已阻止。\n` +
          mergePlanLines.join('\n') + '\n' +
          '→ 先传 dryRun:true 预览，确认后再传 confirm:true 真实执行'
        );
      }

      // 自动提交 story 目录下的运行时产生的文件（review.json 等）
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

      const mainBranch = currentMainBranch;
      const results: string[] = [];

      // merge 到主分支
      try {
        git(`merge ${branch} --no-ff -m "merge: ${args.storyId} ${story.title}"`);
        results.push(`✓ 分支 ${branch} 已合并到 ${mainBranch}`);
      } catch (e: any) {
        throw new Error(
          `合并冲突。若要手动执行 git merge ${branch}，未经用户 confirm 不允许；确认后再解决:\n${e.stderr || e.message}`
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

    /**
     * @task B-4b17
     * @checklist CHK-001
     * @title story_discard dry-run preview and explicit confirm path
     * @type feature
     * @priority high
     * @description
     *   story_discard 属于 destructive 命令：会删除 linked worktree、删除分支并把
     *   story 标记为 DISCARDED。这里补上 dry-run 计划输出，让用户在 --confirm 前
     *   能先看到会改什么，并把真实执行与预览拆开。
     * @changes
     *   - [CHK-001] 支持 story_discard --dry-run 只预览 remove worktree / delete branch / discard story
     *   - [CHK-001] 真实执行路径保持在 confirm 之后，避免误触直接落盘
     * @test dangerous-command-guardrails
     */
    story_discard(args: { storyId: string; reason?: string; force?: boolean; dryRun?: boolean; confirm?: boolean; cleanupResidue?: boolean }): string {
      const story = store.readStory(args.storyId);

      if (story.phase === 'DONE') {
        throw new Error(`Story ${args.storyId} 已 DONE，不能 discard（已完成的 story 请通过 git revert 撤销）`);
      }
      if (story.phase === 'DISCARDED') {
        if (args.cleanupResidue) {
          const lines = args.dryRun
            ? [`[DRY-RUN] story_discard ${args.storyId} cleanup residue would:`, ...cleanupDiscardedStoryResidue(args.storyId, true), '→ 加 --confirm 真实执行']
            : cleanupDiscardedStoryResidue(args.storyId, false);
          return lines.join('\n');
        }
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

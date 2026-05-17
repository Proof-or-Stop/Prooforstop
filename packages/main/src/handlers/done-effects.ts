/**
 * B-9027 (Lifecycle Phase 2, Story 3b): done-effects — the DONE merge /
 * worktree cleanup pipeline of story_advance.
 *
 * The DONE pipeline was mechanically relocated here from
 * handlers/story-advance.ts with ZERO semantic change — step order, output
 * text, and failure semantics are byte-identical before and after the move
 * (Option A behavior-preserving extraction). story-advance.ts now delegates to
 * the two exported functions at the exact same call sites it ran them inline.
 *
 * The DONE pipeline straddles the actor.send boundary, so it is split into two
 * exported functions called at the same timing as the inline originals:
 *
 *   - runDonePreMergeGate    — block A: pre-merge gates that must run BEFORE
 *                              phase=DONE is persisted. Runs the done-oracle
 *                              gate, the F-020 stray-file dry-run, and the
 *                              merge-tree dry-run. Any failure throws while the
 *                              story is still TEST. Returns the rendered DONE
 *                              checklist string as an explicit value — the
 *                              caller holds it in a local variable across the
 *                              actor.send boundary (replaces the old global
 *                              cross-actor.send stash).
 *   - applyDoneMergeEffects  — block B: the real merge / worktree cleanup that
 *                              runs AFTER writeStory(phase=DONE). Step1 clears
 *                              the worktree field, Step2 commits metadata,
 *                              Step2.5 cleans stray whitelist files, Step3
 *                              merges the story branch, Step4 removes the
 *                              worktree, Step5 deletes the branch, then a
 *                              cleanupFailure throw and a non-blocking
 *                              maybeTriggerAudit. The caller passes in the
 *                              rendered checklist held since block A.
 *
 * Layering: this module lives in handlers/ (NOT core/) on purpose. It depends
 * on handler-only modules (phase-gates.ts, stray-file-cleanup.ts,
 * worktree.ts) and shares the layer with story-advance.ts. It must NOT import
 * handlers/story-advance.js (no circular import); story-advance imports
 * done-effects, never the reverse.
 */

import type { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { maybeTriggerAudit } from '../core/audit-trigger.js';
import { execFileSync, execSync } from 'child_process';
import { dirname, resolve, join } from 'path';
import { existsSync, rmSync } from 'fs';
import { cleanStrayWorktreeFiles } from './stray-file-cleanup.js';
import { repairGlobalKoalaLinkBeforeWorktreeDelete } from './worktree.js';
import { reportHealthIssue } from '../core/health.js';
import { runDoneOracleGate } from './phase-gates.js';
import { acquireMkdirLock, type AcquiredMkdirLock } from '../core/mkdir-lock.js';

// B-c622 CHK-004: DONE 阶段自动同步 main —— detect divergence + auto merge main.
// checkMainDivergence stays imported in story-advance.ts (it is a DONE
// pre-check that runs before actor.can() / before this module's gate);
// autoSyncMain lives here as a DONE-only helper.

/** Auto-sync main into the current branch. Returns success/failure + message. */
export function autoSyncMain(projectRoot: string): { ok: boolean; message: string } {
  // Try to fetch origin main first (fails silently for local-only repos)
  try {
    execSync('git fetch origin main:main', {
      cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { /* local-only repo or no remote — skip fetch */ }
  try {
    execSync('git merge main --no-edit', {
      cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, message: 'main 已自动同步到当前分支' };
  } catch {
    // conflict — abort merge to keep branch clean
    try {
      execSync('git merge --abort', {
        cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* abort failed — already clean */ }
    return { ok: false, message: 'merge main 有冲突（已 abort 保持分支干净）。\n→ 执�� git merge main，解决冲突后 git add + git commit，然后重跑 story_advance DONE' };
  }
}

function isRegisteredWorktree(repoRoot: string, worktreePath: string): boolean {
  try {
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const target = worktreePath.replace(/\\/g, '/');
    return raw
      .split(/\r?\n/)
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim().replace(/\\/g, '/'))
      .includes(target);
  } catch {
    return false;
  }
}

function pruneWorktreeRegistry(repoRoot: string): void {
  execFileSync('git', ['worktree', 'prune', '--expire', 'now'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

type DoneWorktreeContext = {
  invocationCwd: string;
  worktreeRoot: string;
  mainRepoRoot: string;
  branch: string;
};

const DONE_MAIN_MERGE_LOCK_STALE_MS = 120000;

export function doneMainMergeLockPath(projectRoot: string, invocationCwd = process.cwd()): string {
  const doneWorktree = detectDoneStoryWorktreeContext(invocationCwd);
  const mainRepoRoot = doneWorktree?.mainRepoRoot ?? projectRoot;
  return join(mainRepoRoot, '.koala', 'runtime', 'done-main-merge.lock');
}

export function acquireDoneMainMergeLock(
  storyId: string,
  projectRoot: string,
  invocationCwd = process.cwd(),
): AcquiredMkdirLock {
  const lockDir = doneMainMergeLockPath(projectRoot, invocationCwd);
  return acquireMkdirLock(lockDir, {
    label: 'DONE main merge',
    staleMs: DONE_MAIN_MERGE_LOCK_STALE_MS,
    failFastIfHeld: true,
    heldMessage:
      `DONE main merge lock is held by another Koala operation; story ${storyId} phase was not changed. ` +
      `Retry after the active DONE merge finishes.`,
  });
}

function samePath(a: string, b: string): boolean {
  return resolve(a).replace(/\\/g, '/') === resolve(b).replace(/\\/g, '/');
}

export function detectDoneStoryWorktreeContext(invocationCwd = process.cwd()): DoneWorktreeContext | null {
  try {
    const resolvedInvocationCwd = resolve(invocationCwd);
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const worktreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const commonDirRaw = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const mainRepoRoot = dirname(commonDirRaw);
    if (samePath(worktreeRoot, mainRepoRoot)) return null;

    return {
      invocationCwd: resolvedInvocationCwd,
      worktreeRoot: resolve(worktreeRoot),
      mainRepoRoot: resolve(mainRepoRoot),
      branch,
    };
  } catch {
    // PROBE: not in a git worktree or git metadata is unavailable.
    return null;
  }
}

export function assertDoneStoryBranchMatches(storyId: string, branch: string): void {
  const expectedBranch = `story/${storyId}`;
  if (branch !== expectedBranch) {
    throw new Error(
      `refusing DONE cleanup: detected branch ${branch} but expected ${expectedBranch}; ` +
      `merge/delete aborted before mutating story state.`,
    );
  }
}

function assertSafeResidualWorktreeRm(ctx: DoneWorktreeContext, target: string, wasRegisteredWorktree: boolean): void {
  if (!samePath(target, ctx.worktreeRoot)) {
    throw new Error(`refusing residual cleanup outside canonical worktree root: ${target}`);
  }
  if (!wasRegisteredWorktree) {
    throw new Error(`refusing residual cleanup for unregistered worktree path: ${target}`);
  }
  if (!samePath(ctx.invocationCwd, ctx.worktreeRoot) && samePath(target, ctx.invocationCwd)) {
    throw new Error(`refusing residual cleanup of nested invocation cwd: ${target}`);
  }
}

function assertDoneMergeCanApplyBeforeStateMutation(storyId: string, worktreePath: string, mainRepoRoot: string): void {
  try {
    execFileSync('git', ['merge-tree', '--write-tree', 'main', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    const detail = e?.stderr?.toString?.() || e?.stdout?.toString?.() || e?.message || String(e);
    throw new Error(
      `Cannot enter DONE: story/${storyId} 尚不能干净合并到 main；未修改 story phase。\n` +
      `${detail}\n\n` +
      `→ 在 worktree 内先解决与 main 的合并冲突，再重跑 story_advance --phase=DONE。\n` +
      `→ 可执行: cd "${worktreePath}" && git merge main\n` +
      `→ 主仓库: ${mainRepoRoot}`,
    );
  }
}

/**
 * Block A — DONE pre-merge gate.
 *
 * Runs BEFORE phase=DONE is persisted (story-advance.ts calls this just before
 * actor.send). Runs the done-oracle gate, the F-020 stray-file dry-run, and
 * the merge-tree dry-run. Any pre-merge gate failure throws while the story is
 * still TEST — phase=DONE is never written on failure.
 *
 * Returns the rendered DONE checklist string so the caller can hold it in a
 * local variable and pass it to applyDoneMergeEffects (replaces the old
 * cross-actor.send global stash).
 *
 * B-6974: this gate NO LONGER stops the actor on failure — actor lifecycle is
 * owned solely by transition-orchestrator.ts, which stops it in a single
 * finally on every exit path. The `actor` parameter is kept for signature
 * stability and is forwarded to runDoneOracleGate (which also no longer stops
 * it).
 */
export async function runDonePreMergeGate(
  storyId: string,
  store: StoryStore,
  root: string,
  actor: ReturnType<typeof import('../core/machine.js').createStoryActor>,
): Promise<string> {
  // B-c622 CL-006: autoSyncMain moved before actor.can() to fix TOCTOU.

  const rendered = runDoneOracleGate(storyId, store, root, actor);

  // F-020 (B-9d95 Round 1 review): stray-file 检测提前到 phase=DONE 落盘
  // 之前。原实现（Step 2.5，line 632 附近）在 story.phase=DONE +
  // story.worktree=undefined 已 writeStory 之后才跑，若 throw（非白名单
  // 未追踪文件）story 会卡 DONE（merge 未发生、worktree 还活着、没有
  // koala 自愈路径）。这里预检查：dry-run detection，发现 offender 立刻
  // throw，保留 phase=TEST 状态让 main agent 按错误提示修复后重跑。
  //
  // whitelist 文件在此**不删除**——只负责早期拦截。真正的 rm 延后到
  // Step 2.5 (actor.send 之后的 merge 流程) 做，因为此时才知道合并一定
  // 会发生。预检查只看"有没有 offender"：
  //   - 有 offender → throw（保留文件，不落盘 DONE）
  //   - 无 offender → 继续走完整流程，whitelist rm 在 Step 2.5 执行
  try {
    const doneWorktree = detectDoneStoryWorktreeContext();
    if (doneWorktree) {
      assertDoneStoryBranchMatches(storyId, doneWorktree.branch);
      // 仅 dry-run：用 git ls-files 读出未追踪文件，按白名单分类。
      // 发现 offender → throw（此时 story.phase 仍为 TEST）。无 offender
      // → 返回，不做任何删除，后续 Step 2.5 才会真的 rm whitelist 文件。
      const { mainRepoRoot, worktreeRoot } = doneWorktree;
      const storyDir = `${store.storyDirRel()}/${storyId}/`;
      if (existsSync(join(mainRepoRoot, storyDir))) {
        let raw = '';
        try {
          raw = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', storyDir], {
            cwd: mainRepoRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).toString();
        } catch { /* PROBE: 忽略，让 Step 2.5 兜底 */ }
        const relPaths = raw.split('\n').map(l => l.trim()).filter(Boolean);
        const { STRAY_FILE_WHITELIST: WL } = await import('./stray-file-cleanup.js');
        const offenders = relPaths.filter(rel => !WL.includes(rel.split('/').pop() || rel));
        if (offenders.length > 0) {
          // 复用 cleanStrayWorktreeFiles 的 throw 消息（单一真相源），
          // 传入 worktreePath 让消息含 git worktree remove / branch -d 指引。
          // B-6974: the actor-stop call this path used to make was removed —
          // actor lifecycle is owned solely by transition-orchestrator.ts,
          // which stops it in a single finally on every exit path (including
          // this thrown-error path).
          cleanStrayWorktreeFiles(mainRepoRoot, storyId, worktreeRoot);
          // cleanStrayWorktreeFiles 在有 offender 时必然 throw；能到这行
          // 说明逻辑偏离，fallback：主动抛错避免 phase 默认落盘。
          throw new Error(
            `Story ${storyId} DONE pre-merge stray 检测：检测到非白名单未追踪文件但 cleanStrayWorktreeFiles 未抛错（内部状态偏离），阻止推进。`,
          );
        }
      }
      assertDoneMergeCanApplyBeforeStateMutation(storyId, worktreeRoot, mainRepoRoot);
    }
  } catch (e: any) {
    // throw 的错误信息（含 stash / worktree remove 指引）直接冒给 caller，
    // 不吞。只有 git 探测本身的非 throw 失败被上面的 catch 吃掉。
    if (
      e?.message?.startsWith(`Story ${storyId} DONE `)
      || e?.message?.startsWith('Cannot enter DONE:')
      || e?.message?.startsWith('refusing DONE cleanup:')
    ) {
      throw e;
    }
    // 其他意外（如 import 失败 / unknown）转成可见错误
    throw new Error(`DONE pre-merge 预检查失败: ${e?.message ?? e}`);
  }

  return rendered;
}

/**
 * Block B — DONE merge / worktree cleanup effects.
 *
 * Runs AFTER writeStory(phase=DONE) (story-advance.ts calls this in the DONE
 * return segment). Performs the real git merge / worktree cleanup in the exact
 * step order of the inline original:
 *   Step1 clear story.worktree + writeStory
 *   Step2 commit story metadata
 *   Step2.5 cleanStrayWorktreeFiles (whitelist rm)
 *   Step3 git merge story branch into main
 *   Step4 worktree remove (+ rm -rf residue + prune)
 *   Step5 git branch -d
 *   cleanupFailure throw
 *   maybeTriggerAudit (non-blocking)
 *
 * `renderedChecklist` is the string returned by runDonePreMergeGate, held by
 * the caller across the actor.send boundary; it is prefixed onto the success
 * message via the returned `doneChecklistPrefix`.
 *
 * Returns the report pieces for the caller to splice into the advance success
 * message: `doneChecklistPrefix` (rendered checklist + blank lines) and
 * `doneMergeReport` (the merge log + optional audit hint).
 */
export async function applyDoneMergeEffects(
  storyId: string,
  store: StoryStore,
  story: StoryInfo,
  renderedChecklist: string | undefined,
): Promise<{ doneChecklistPrefix: string; doneMergeReport: string }> {
  let doneChecklistPrefix = '';
  let doneMergeReport = '';
  if (renderedChecklist) {
    doneChecklistPrefix = `${renderedChecklist}\n\n`;
  }

  // B-7eed: DONE 成功后自动 git merge 回 main + 清 worktree + 删 branch。
  // CLAUDE.md 承诺"内部自动合并"但旧代码没实现，每次 DONE 都要手动 cleanup。
  // 复用 dev_merge 的逻辑（worktree.ts:208）但从 story-advance 触发。
  //
  // 关键的执行顺序（不能乱）：
  //   1. 清 story.worktree 字段 + writeStory（在 worktree fs 内）
  //   2. git add + git commit 把这一步以及之前的 phase=DONE 改动都落到 story 分支
  //   3. cd 到主仓库根目录，git merge story 分支（worktree 内不能 merge 自己）
  //   4. worktree remove
  //   5. branch -d
  // 注意：不能依赖 story.worktree 字段——INIT_CHECK 把这个字段写到了 main
  // 仓库的 index.json，但 worktree 内 checkout 的版本是 INIT_CHECK 之前的，
  // 没有这个字段。所以 readStory(from worktree) 永远拿到 worktree=undefined。
  // 改为从 git 实际状态推断：调用 cwd、git 顶层 worktree、当前分支、git common dir。
  // DONE 可从 worktree 子目录触发，所以 cleanup 目标必须是 git top-level，
  // 不能把 process.cwd() 当作可删除路径。
  const doneWorktree = detectDoneStoryWorktreeContext();

  if (doneWorktree) {
    const mergeLines: string[] = [];
    const { branch, mainRepoRoot, worktreeRoot: wtPathAbs } = doneWorktree;
    assertDoneStoryBranchMatches(storyId, branch);
    {
      const runGitArgs = (gitArgs: string[], cwd: string): string =>
        execFileSync('git', gitArgs, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

      // Step 1: 清 story.worktree 字段 + endedAt + writeStory，让 metadata 落盘
      story.worktree = undefined;
      story.endedAt = story.endedAt || new Date().toISOString();
      store.writeStory(storyId, story);

      // Step 2: commit 所有 story metadata（phase=DONE + worktree=undefined +
      // endedAt + reviewer/test 产物）。dev_merge:228 用的是同一招。
      try {
        runGitArgs(['add', store.storyDirRel()], wtPathAbs);
        const staged = runGitArgs(['diff', '--cached', '--name-only'], wtPathAbs);
        if (staged) {
          runGitArgs(
            ['-c', 'commit.gpgsign=false', 'commit', '-m', `koala: mark ${storyId} DONE + clear worktree`],
            wtPathAbs,
          );
        }
      } catch { /* PROBE: 没东西 commit 也无所谓 */ }

      // Step 2.5 (B-9d95 CHK-003): merge 前清 stray whitelist 文件。
      // F-020: 非白名单 offender 检测已提前到 DONE gate（phase 落盘前），
      // 这里只负责 whitelist 自动 rm；理论上 offender 不可能到这行（上面
      // 已 throw），但保留 throw 路径作为 defense-in-depth。第三参数
      // wtPathAbs 用于 error message 的 worktree 清理指引（F-014）。
      const strayReport = cleanStrayWorktreeFiles(mainRepoRoot, storyId, wtPathAbs);
      for (const line of strayReport) mergeLines.push(line);

      // Step 3: 从主仓库根目录 merge story 分支。merge 冲突直接 throw 给上层
      // 让 agent 看到详细的手动 cleanup 步骤——phase 已经是 DONE，不回滚，但
      // 必须让 user 知道还有手动收尾要做。
      const mainBranch = runGitArgs(['rev-parse', '--abbrev-ref', 'HEAD'], mainRepoRoot);
      try {
        runGitArgs(
          ['-c', 'commit.gpgsign=false', 'merge', branch, '--no-ff', '-m', `merge: ${storyId} ${story.title}`],
          mainRepoRoot,
        );
        mergeLines.push(`✓ 分支 ${branch} 已合并到 ${mainBranch}`);
      } catch (e: any) {
        throw new Error(
          `Story ${storyId} 已标记为 DONE 但自动合并失败:\n` +
          `${e.stderr?.toString() || e.message}\n\n` +
          `请手动完成:\n` +
          `  cd "${mainRepoRoot}"\n` +
          `  git merge ${branch}\n` +
          `  git worktree remove --force "${wtPathAbs}"\n` +
          `  git branch -d ${branch}`,
        );
      }

      // Step 4: 清理 worktree
      let cleanupFailure: string | null = null;
      //
      // Two-step cleanup: `git worktree remove` deregisters the worktree
      // from git's internal list (so `git worktree list` no longer shows
      // it), then we `rm -rf` the directory to catch leftover files
      // that git didn't clean. Why the second step is needed:
      //
      // - activity.jsonl (Claude Code hook), tmp/llmlog.json and other
      //   gitignored runtime files are invisible to `git status` so git
      //   considers the worktree "dirty but all gitignored"
      // - with --force, git removes the worktree entry but leaves the
      //   directory (Windows + hook holding a file handle) or empty
      //   skeleton dirs behind
      // - result: `git worktree list` is clean but `.worktrees/B-xxx/`
      //   still exists with stray files
      //
      // The rm -rf is safe here because DONE gate already checked that
      // the working tree is clean AND the branch is merged into main —
      // anything left in the worktree is either gitignored runtime
      // state or genuine leakage we want to erase.
      if (existsSync(wtPathAbs) || isRegisteredWorktree(mainRepoRoot, wtPathAbs)) {
        const wasRegisteredWorktree = isRegisteredWorktree(mainRepoRoot, wtPathAbs);
        const repair = repairGlobalKoalaLinkBeforeWorktreeDelete(wtPathAbs, mainRepoRoot);
        if (repair.action === 'relinked') mergeLines.push(repair.message);
        let removeFailure: string | null = null;
        try {
          runGitArgs(['worktree', 'remove', wtPathAbs], mainRepoRoot);
          mergeLines.push(`✓ Worktree ${wtPathAbs} 已清理`);
        } catch {
          // worktree 内有 tmp/ llmlog 等运行时产物时 remove 会拒绝，用 --force
          try {
            runGitArgs(['worktree', 'remove', '--force', wtPathAbs], mainRepoRoot);
            mergeLines.push(`✓ Worktree ${wtPathAbs} 已强制清理`);
          } catch (e: any) {
            removeFailure = `git worktree remove failed: ${e.message}`;
            mergeLines.push(`⚠ Worktree 未清理: ${e.message}`);
          }
        }
        // Second step: rm -rf the directory if git left it behind.
        // This is the fix for "worktree folder still exists after
        // DONE merge" caused by activity.jsonl-style gitignored
        // leftovers from Claude Code hooks.
        if (existsSync(wtPathAbs)) {
          try {
            assertSafeResidualWorktreeRm(doneWorktree, wtPathAbs, wasRegisteredWorktree);
            rmSync(wtPathAbs, { recursive: true, force: true });
            mergeLines.push(`✓ Worktree 目录残留已清空`);
          } catch (e: any) {
            cleanupFailure = `worktree directory cleanup failed: ${e.message}`;
            mergeLines.push(`⚠ Worktree 目录残留清理失败: ${e.message}`);
          }
        }
        try {
          pruneWorktreeRegistry(mainRepoRoot);
          if (removeFailure && !existsSync(wtPathAbs) && !isRegisteredWorktree(mainRepoRoot, wtPathAbs)) {
            mergeLines.push(`✓ stale worktree registry 已 prune`);
          }
        } catch (e: any) {
          mergeLines.push(`⚠ git worktree prune 失败: ${e.message}`);
        }
        if (existsSync(wtPathAbs) && !cleanupFailure) {
          cleanupFailure = `worktree path still exists after cleanup: ${wtPathAbs}`;
        }
        if (isRegisteredWorktree(mainRepoRoot, wtPathAbs) && !cleanupFailure) {
          cleanupFailure = removeFailure || `worktree is still registered after cleanup: ${wtPathAbs}`;
          mergeLines.push(`⚠ Worktree 仍在 git registry 中: ${wtPathAbs}`);
        }
      }

      // Step 5: 删除分支
      try {
        runGitArgs(['branch', '-d', branch], mainRepoRoot);
        mergeLines.push(`✓ 分支 ${branch} 已删除`);
      } catch {
        mergeLines.push(`⚠ 分支 ${branch} 未删除（可能有未合并的提交）`);
      }

      if (cleanupFailure) {
        const err = new Error(cleanupFailure);
        reportHealthIssue('mutation:worktreeCleanup', err, {
          storyId,
          branch,
          worktreePath: wtPathAbs,
          mainRepoRoot,
        });
        throw new Error(
          `Story ${storyId} 已合并，但 worktree 清理未完成: ${cleanupFailure}\n` +
          `→ 请运行 koala doctor 查看，或执行 koala doctor --repair 清理终态 worktree 残留。`,
        );
      }
    }

    if (mergeLines.length > 0) {
      doneMergeReport = `\n\n${mergeLines.join('\n')}`;
    }

    // B-9bd9 CHK-003: DONE 合并成功后，尝试触发 framework audit。
    // maybeTriggerAudit 内部已 try/catch + meta-story guard + mode=off 兜底；
    // 此处再包一层防御，确保任何 audit-trigger 路径异常都不影响 DONE 成功消息。
    // projectRoot 用 mainRepoRoot（main 仓的根，不是已被清掉的 worktree）。
    try {
      const auditResult = await maybeTriggerAudit(storyId, mainRepoRoot);
      if (auditResult.hint) {
        // semi-auto 提示行：前后各空一行单独成段，avoid 和 mergeLines/docsHint 挤在一起
        doneMergeReport += `\n${auditResult.hint}`;
      }
    } catch (e: any) {
      console.warn(`[audit-trigger] DONE hook failed: ${e?.message || e}`);
    }
  }

  return { doneChecklistPrefix, doneMergeReport };
}

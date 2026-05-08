/**
 * B-9d95 CHK-003: 清理主仓中对 story 目录下未追踪的 stray 文件。
 *
 * 背景：部分 koala handler（process_event_append / process_metrics_update
 * / review_add / cluster 等）会直接写 `docs/story/actives/<storyId>/` 下的
 * 运行时文件。如果 koala 在**主仓 cwd**（而非 worktree cwd）被调用（例如
 * 手滑 / 早期脚本误用），这些文件会落到主仓 index.json 所在的副本上，
 * 却不在 worktree 分支的 git 追踪里——之后 story_advance DONE 想把
 * worktree 分支 merge 回 main，git 会报
 *   `untracked working tree files would be overwritten by merge`
 * 并 abort。B-ed3e DONE 时的真实故障就是 process-events.jsonl /
 * process-metrics.json / review.json 命中这个路径。
 *
 * 策略：合并前扫描主仓 `docs/story/actives/<storyId>/` 下未追踪文件：
 *   - 白名单（运行时自动生成、worktree 已追踪版本为权威）→ 直接 rm 并报告
 *   - 非白名单（可能是用户草稿 / 未追踪人工改动）→ 抛错，附 stash 指引，
 *     保留文件让人工决定
 *
 * 放在独立文件（不在 story-advance.ts 内）是为了让 logicTest 可以直接
 * import，而不需要把 xstate / machine 等重依赖拖进测试进程。
 */

import { execFileSync } from 'child_process';
import { basename, join } from 'path';
import { existsSync, unlinkSync } from 'fs';
import { loadConfig } from '../core/config.js';

export const STRAY_FILE_WHITELIST: ReadonlyArray<string> = [
  'background.md',
  'bug.json',
  'checklist.json',
  'decision.json',
  'delivery-check.json',
  'eval-evidence.json',
  'findings.json',
  'implementation-review.json',
  'index.json',
  'init-check.json',
  'init-self-check.json',
  'plan.md',
  'process-events.jsonl',
  'process-metrics.json',
  'review.json',
  'review-passes.json',
  'scope-check.json',
  'story-test-runs.json',
  'summary.json',
  'test-evidence.json',
  'understanding.json',
  'clusters.json',
];

/**
 * F-014 / F-020 (B-9d95 Round 1 review): 可选 worktreePath 让抛错消息包含
 * worktree / branch cleanup 指引。caller 没给 path 时给 fallback 占位符。
 * 向后兼容：原 2 参数调用保持行为不变（只是错误消息少一段 worktree 清理指引）。
 */
export function cleanStrayWorktreeFiles(
  mainRepoRoot: string,
  storyId: string,
  worktreePath?: string,
): string[] {
  const report: string[] = [];
  const config = loadConfig(mainRepoRoot);
  const storyDir = `${config.storyDir.replace(/\\/g, '/')}/${storyId}/`;

  // 若主仓没有 storyDir（极少见：INIT 阶段就删掉了再创建 worktree），跳过。
  if (!existsSync(join(mainRepoRoot, storyDir))) {
    return report;
  }

  // F-003 (B-9d95 Round 1 review): 用 execFileSync 数组参数形式调 git，避免
  // `git ls-files -- ${storyDir}` 拼接到 shell 字符串时 storyId 恶意串出现
  // shell 元字符（反引号 / $() / ;）触发注入。execFileSync 默认 shell=false
  // 直接 exec git binary，storyDir 作为独立 argv 项传入。
  let raw = '';
  try {
    raw = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--', storyDir],
      { cwd: mainRepoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString();
  } catch {
    // 不是 git 仓 / 命令失败 → 放过（merge 步骤会自己报错）
    return report;
  }

  const relPaths = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (relPaths.length === 0) return report;

  const whitelist: string[] = [];
  const offenders: string[] = [];
  for (const rel of relPaths) {
    const base = basename(rel);
    if (STRAY_FILE_WHITELIST.includes(base)) {
      whitelist.push(rel);
    } else {
      offenders.push(rel);
    }
  }

  // 非白名单：保留文件 + 抛错附 stash 指引（包括白名单——原子性：有非白名单就全不碰）
  if (offenders.length > 0) {
    const stashLines = offenders
      .map(rel => `  git stash push -- "${rel}"`)
      .join('\n');
    // F-014 / F-020: cleanStrayWorktreeFiles 在 merge 前调用。如果 throw 这里，
    // caller 应保证此时 story.phase 尚未落盘为 DONE（见 story-advance.ts），
    // 所以下次 `story_advance --phase=DONE` 仍可以重跑完整流程。但如果 caller
    // 先落盘了 phase=DONE（历史 bug），用户需要手动清理 worktree + branch，
    // 这段 hint 始终显示以便兜底。
    const wtDisplay = worktreePath ?? '<worktree 绝对路径，见 .worktrees/<storyId>>';
    throw new Error(
      `Story ${storyId} DONE merge 前发现主仓内 ${offenders.length} 个非白名单未追踪文件，` +
      `可能是人工草稿，不自动删除以防数据丢失:\n` +
      offenders.map(rel => `  - ${rel}`).join('\n') +
      `\n\n请在主仓内任选其一处理这些未追踪文件:\n` +
      `  方案 A（归档，推荐）：\n${stashLines}\n` +
      `  方案 B（确认可删）：\n` +
      offenders.map(rel => `  rm "${rel}"`).join('\n') +
      `\n\n然后重跑 koala story_advance --phase=DONE。\n` +
      `\n若 story.phase 已意外落盘为 DONE 需手动 unstick，在主仓 cwd 运行:\n` +
      `  git worktree remove --force "${wtDisplay}"\n` +
      `  git branch -d story/${storyId}\n` +
      `  # 然后手动 merge: git merge story/${storyId}（若分支尚未删除）或从 backup 恢复`,
    );
  }

  // 白名单：rm + 报告
  for (const rel of whitelist) {
    const abs = join(mainRepoRoot, rel);
    try {
      unlinkSync(abs);
      report.push(`⚠ 清理主仓未追踪副本: ${rel} (reason: worktree 已追踪版本为权威)`);
    } catch (e: any) {
      report.push(`⚠ 清理主仓未追踪副本失败: ${rel}: ${e?.message || e}`);
    }
  }

  return report;
}

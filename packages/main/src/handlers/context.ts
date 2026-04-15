
import { StoryStore } from '../core/store.js';
import type { StoryPhase, StoryEvent } from '../core/types.js';
import { execSync } from 'child_process';
import { join, isAbsolute } from 'path';
import { randomBytes } from 'crypto';

export interface HandlerContext {
  store: StoryStore;
  root: string;
  scanRoot: string;
  /** 流式日志输出（MCP 环境走 sendLoggingMessage，其他环境走 console.log） */
  log?: (msg: string) => void;
  /** 延迟获取所有已注册工具名（由 tools.ts 注入，避免循环依赖） */
  getAllToolNames?: () => Set<string>;
}

const PHASE_TO_EVENT: Record<string, string> = {
  INIT: 'INIT',
  INIT_CHECK: 'INIT_CHECK',
  PLAN: 'PLAN',
  DEV: 'START',
  TEST_CASE: 'WRITE_CASES',
  TEST_CASE_REVIEW: 'REQUEST_REVIEW',
  TEST: 'REVIEW',
  DONE: 'FINISH',
};

export { PHASE_TO_EVENT };

export function collectContext(phase: StoryPhase, action: 'create' | 'advance' | 'discard'): StoryEvent {
  const event: StoryEvent = {
    phase,
    action,
    timestamp: new Date().toISOString(),
  };
  try { event.branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); } catch { /* PROBE: branch is unavailable outside git repos */ }
  try { event.user = execSync('git config user.name', { encoding: 'utf8' }).trim(); } catch { /* PROBE: git user.name may be unset in CI/temp repos */ }
  event.sessionId = process.env.KOALA_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || undefined;
  event.agent = process.env.KOALA_AGENT || 'main';
  return event;
}

/** PLAN ~ TEST 阶段必须在 worktree 里执行 koala 命令 */
export const CWD_GATED_PHASES: Set<StoryPhase> = new Set(['PLAN', 'DEV', 'TEST_CASE', 'TEST_CASE_REVIEW', 'TEST']);

/**
 * 检查当前 cwd 是否在 story 的 worktree 中。
 * 调用者负责判断"是否应该检查"（基于目标 phase 等），本函数只做 cwd 比对。
 * 抛错时给出修复指引。
 */
export function assertCwdInWorktree(store: StoryStore, storyId: string): void {
  let story;
  try {
    story = store.readStory(storyId);
  } catch { /* PROBE: not all callers run inside a git worktree */
    return; // story 不存在，跳过
  }
  if (!story.worktree) return; // 没有 worktree，跳过（兼容旧 story）

  const cwd = process.cwd();
  let repoRoot = cwd;
  try {
    // Use git common-dir to find the MAIN repo root, not the worktree root.
    // From a linked worktree, --show-toplevel returns the worktree itself,
    // but worktree.path is stored relative to the main repo, so joining
    // ".worktrees/B-xxx" with itself produces a nested non-existent path.
    const commonDir = execSync('git rev-parse --git-common-dir', { cwd, encoding: 'utf-8' }).trim();
    const absCommonDir = isAbsolute(commonDir)
      ? commonDir
      : join(execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8' }).trim(), commonDir);
    if (absCommonDir.endsWith('/.git') || absCommonDir.endsWith('\\.git')) {
      repoRoot = absCommonDir.slice(0, -5);
    } else {
      repoRoot = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8' }).trim();
    }
  } catch { /* PROBE: cwd may not be inside a git repo */ }

  const expectedAbsPath = isAbsolute(story.worktree.path)
    ? story.worktree.path
    : join(repoRoot, story.worktree.path);

  if (cwd !== expectedAbsPath && !cwd.startsWith(expectedAbsPath + '/') && !cwd.startsWith(expectedAbsPath + '\\')) {
    throw new Error(
      `Story ${storyId} 必须在 worktree 里执行 koala 命令\n` +
      `期望 cwd: ${expectedAbsPath}\n` +
      `当前 cwd: ${cwd}\n` +
      `→ cd ${expectedAbsPath}`
    );
  }
}

export function nextStoryId(store: StoryStore, prefix = 'B'): string {
  const existing = new Set(store.listStoryIds());
  for (let attempt = 0; attempt < 100; attempt++) {
    const hex = randomBytes(2).toString('hex'); // 4 chars, e.g. "a3f7"
    const id = `${prefix}-${hex}`;
    if (!existing.has(id)) return id;
  }
  // fallback: 6 chars for extreme collision cases
  return `${prefix}-${randomBytes(3).toString('hex')}`;
}

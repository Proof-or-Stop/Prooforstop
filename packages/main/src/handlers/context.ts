
import { StoryStore } from '../core/store.js';
import type { StoryPhase, StoryEvent } from '../core/types.js';
import { execSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { join, isAbsolute } from 'path';
import { randomBytes } from 'crypto';
import { gitProbe } from '../core/git-probe.js';
import { getStoryWorktreeRuntime, resolveLinkedWorktreePath } from '../core/worktree-runtime.js';
import { CWD_GATED_LIFECYCLE_PHASES, PHASE_EVENT_BY_TARGET } from '../core/lifecycle-registry.js';

export interface HandlerContext {
  store: StoryStore;
  root: string;
  scanRoot: string;
  /** 流式日志输出（MCP 环境走 sendLoggingMessage，其他环境走 console.log） */
  log?: (msg: string) => void;
  /** 延迟获取所有已注册工具名（由 tools.ts 注入，避免循环依赖） */
  getAllToolNames?: () => Set<string>;
  /**
   * B-94a6: authority submission injection point. Production leaves these unset and
   * the verification evidence handlers resolve settings from env (off by default,
   * zero network). Tests inject `authoritySettings` + `authoritySubmitter` to drive
   * shadow / enforce / failure paths without a real network.
   */
  authoritySettings?: import('../core/authority-mode.js').AuthoritySettings;
  authoritySubmitter?: import('../core/authority-submit.js').AuthoritySubmitter;
}

const PHASE_TO_EVENT: Record<string, string> = { ...PHASE_EVENT_BY_TARGET };

export { PHASE_TO_EVENT };

export function collectContext(phase: StoryPhase, action: 'create' | 'advance' | 'discard'): StoryEvent {
  const event: StoryEvent = {
    phase,
    action,
    timestamp: new Date().toISOString(),
  };
  const branch = gitProbe('git rev-parse --abbrev-ref HEAD');
  if (branch.ok) event.branch = branch.output;
  const user = gitProbe('git config user.name');
  if (user.ok) event.user = user.output;
  event.sessionId = process.env.KOALA_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || undefined;
  event.agent = process.env.KOALA_AGENT || 'main';
  return event;
}

/** PLAN ~ TEST 阶段必须在 worktree 里执行 koala 命令 */
export const CWD_GATED_PHASES: Set<StoryPhase> = new Set(CWD_GATED_LIFECYCLE_PHASES);

/**
 * 检查当前 cwd 是否在 story 的 worktree 中。
 * 调用者负责判断"是否应该检查"（基于目标 phase 等），本函数只做 cwd 比对。
 * 抛错时给出修复指引。
 */
export function assertCwdInWorktree(store: StoryStore, storyId: string): void {
  let story;
  try {
    story = store.readStory(storyId);
  } catch {
    return; // story 不存在，跳过
  }
  if (story.phase === 'DONE' || story.phase === 'DISCARDED') return;

  // B-9d95 CHK-001 whitelist: cwd 门禁——本函数的职责就是校验调用方 cwd 是否在 story 的 worktree。
  // 这里必须读 process.cwd()（调用方视角），不能用 ctx.root（那是 handler 初始化时确定的，
  // 不等于调用方真实 cwd）。故此 process.cwd() 调用点在白名单内。
  const cwd = process.cwd();
  let expectedAbsPath: string | null = null;
  let repoRoot = cwd;
  try {
    const runtime = getStoryWorktreeRuntime(storyId, store, cwd);
    expectedAbsPath = resolveLinkedWorktreePath(runtime);
    repoRoot = runtime.repoRoot;
  } catch { /* PROBE: fall back to stored story.worktree below */ }

  if (!expectedAbsPath && !story.worktree) return; // 没有 worktree，跳过（兼容旧 story）

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
  } catch { /* not git */ }

  if (!expectedAbsPath && story.worktree) {
    expectedAbsPath = isAbsolute(story.worktree.path)
      ? story.worktree.path
      : join(repoRoot, story.worktree.path);
  }
  if (!expectedAbsPath) return;

  const normalizedCwd = canonicalPath(cwd);
  const normalizedExpected = canonicalPath(expectedAbsPath);
  if (normalizedCwd !== normalizedExpected && !normalizedCwd.startsWith(normalizedExpected + '/') && !normalizedCwd.startsWith(normalizedExpected + '\\')) {
    throw new Error(
      `Story ${storyId} 必须在 worktree 里执行 koala 命令\n` +
      `期望 cwd: ${normalizedExpected}\n` +
      `当前 cwd: ${cwd}\n` +
      `→ cd ${normalizedExpected}`
    );
  }
}

function canonicalPath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
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

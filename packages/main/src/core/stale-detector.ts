/**
 * Stale state detector — soft warning before each koala command runs.
 *
 * 灵感来自 Claude Code 的 todo_reminder：每隔一段时间没动作就注入 system-reminder。
 * koala 把 activity.jsonl + checklist.startTime + story.events + bug.foundAt 当输入，
 * 在每条 koala 命令真正执行前打 warning 到 stderr 提醒主 agent，避免 stuck phase。
 *
 * 设计原则：
 *   - 永不抛错（PROBE 类）。任意一条 rule 出错只影响该条 rule，整体 return [] 兜底
 *   - 不写 health（warning 是软提醒，不是 health issue）
 *   - 没有 active story 时直接 return []，避免 koala help / koala doctor 被打扰
 */

import { execSync } from 'child_process';
import type { HandlerContext } from '../handlers/context.js';
import type { StoryInfo, ChecklistData, BugData } from './types.js';
import { loadConfig } from './config.js';
import { readActivityLogTail } from './activity-log.js';

export interface StaleThresholds {
  /** phase 没 advance 多久算卡死（分钟） */
  phaseStale: number;
  /** checklist item 卡 in_progress 多久算遗忘（分钟） */
  itemStale: number;
  /** 距离上次任意 koala 命令多久算 idle（分钟） */
  idleKoala: number;
  /** open bug 多久没修算超期（分钟，默认 24h=1440） */
  bugStale: number;
}

export const DEFAULT_STALE_THRESHOLDS: StaleThresholds = {
  phaseStale: 30,
  itemStale: 30,
  idleKoala: 60,
  bugStale: 1440,
};


function formatMinutes(diffMs: number): string {
  const totalMin = Math.max(1, Math.round(diffMs / 60000));
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin - h * 60;
  return m > 0 ? `${h}h ${m} 分钟` : `${h}h`;
}

function resolveThresholds(root: string): StaleThresholds {
  try {
    const cfg = loadConfig(root) as any;
    const u = cfg?.staleThresholds || {};
    return {
      phaseStale: typeof u.phaseStale === 'number' && u.phaseStale > 0 ? u.phaseStale : DEFAULT_STALE_THRESHOLDS.phaseStale,
      itemStale: typeof u.itemStale === 'number' && u.itemStale > 0 ? u.itemStale : DEFAULT_STALE_THRESHOLDS.itemStale,
      idleKoala: typeof u.idleKoala === 'number' && u.idleKoala > 0 ? u.idleKoala : DEFAULT_STALE_THRESHOLDS.idleKoala,
      bugStale: typeof u.bugStale === 'number' && u.bugStale > 0 ? u.bugStale : DEFAULT_STALE_THRESHOLDS.bugStale,
    };
  } catch {
    return { ...DEFAULT_STALE_THRESHOLDS };
  }
}

/**
 * Detect active story by looking at git branch (story/B-xxxx).
 * Returns null when not on a story branch or any error.
 */
function detectActiveStoryId(root: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!branch.startsWith('story/')) return null;
    const id = branch.slice('story/'.length);
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Rule 1: phase 在某阶段长时间没 advance。
 * 读 story.events 的最后一条 timestamp 作为"上次 phase 动作时间"，
 * 超过阈值则 warn。
 */
function checkPhaseStale(story: StoryInfo, thresholds: StaleThresholds, now: number): string | null {
  try {
    const events = story.events;
    if (!Array.isArray(events) || events.length === 0) return null;
    const last = events[events.length - 1];
    if (!last || typeof last.timestamp !== 'string') return null;
    const lastTs = Date.parse(last.timestamp);
    if (!Number.isFinite(lastTs)) return null;
    const diff = now - lastTs;
    if (diff > thresholds.phaseStale * 60_000) {
      return `Story ${story.storyId} 已在 ${story.phase} 阶段 ${formatMinutes(diff)} 未 advance`;
    }
  } catch { /* PROBE */ }
  return null;
}

/**
 * Rule 2: checklist item 卡 in_progress 太久。
 */
function checkItemStale(checklist: ChecklistData, thresholds: StaleThresholds, now: number): string[] {
  const out: string[] = [];
  try {
    if (!checklist || !Array.isArray(checklist.items)) return out;
    for (const item of checklist.items) {
      if (item.status !== 'in_progress') continue;
      if (!item.startTime) continue;
      const ts = Date.parse(item.startTime);
      if (!Number.isFinite(ts)) continue;
      const diff = now - ts;
      if (diff > thresholds.itemStale * 60_000) {
        out.push(`${item.id} 已 in_progress ${formatMinutes(diff)}，是不是已经做完忘记标 done?`);
      }
    }
  } catch { /* PROBE */ }
  return out;
}

/**
 * Rule 3: 距离上次任意 koala 命令超过阈值。
 * Uses readActivityLogTail (dual-source: .koala/activity.jsonl + legacy docs/story/activity.jsonl).
 */
function checkIdleKoala(root: string, thresholds: StaleThresholds, now: number): string | null {
  try {
    const entries = readActivityLogTail(root, 1);
    if (entries.length === 0) return null;
    const entry = entries[0];
    const tsRaw = String(entry.endTime || entry.startTime || '');
    if (!tsRaw) return null;
    const ts = Date.parse(tsRaw);
    if (!Number.isFinite(ts)) return null;
    const diff = now - ts;
    if (diff > thresholds.idleKoala * 60_000) {
      return `距离上次 koala 命令已过 ${formatMinutes(diff)}，记得继续走流程`;
    }
  } catch { /* PROBE */ }
  return null;
}

/**
 * Rule 4: open bug 长时间未 fixed。
 */
function checkBugStale(bugs: BugData, thresholds: StaleThresholds, now: number): string[] {
  const out: string[] = [];
  try {
    if (!bugs || !Array.isArray(bugs.bugs)) return out;
    for (const bug of bugs.bugs) {
      if (bug.status !== 'open') continue;
      if (!bug.foundAt) continue;
      const ts = Date.parse(bug.foundAt);
      if (!Number.isFinite(ts)) continue;
      const diff = now - ts;
      if (diff > thresholds.bugStale * 60_000) {
        out.push(`Bug ${bug.id} 已 open ${formatMinutes(diff)}，建议优先修复`);
      }
    }
  } catch { /* PROBE */ }
  return out;
}

/**
 * Public API. Returns warning lines (no leading prefix). Caller prints to stderr.
 *
 * 永不抛错，任何内部异常都被吞掉返回 []。
 */
export function detectStaleState(ctx: HandlerContext): string[] {
  try {
    const storyId = detectActiveStoryId(ctx.root);
    if (!storyId) return [];

    let story: StoryInfo | null = null;
    try { story = ctx.store.readStory(storyId); } catch { /* PROBE */ }
    // 没有 story 文件就只跑 idle rule（idle 不依赖 story）
    const thresholds = resolveThresholds(ctx.root);
    const now = Date.now();
    const warnings: string[] = [];

    if (story) {
      const w1 = checkPhaseStale(story, thresholds, now);
      if (w1) warnings.push(w1);

      try {
        const checklist = ctx.store.readChecklist(storyId);
        warnings.push(...checkItemStale(checklist, thresholds, now));
      } catch { /* PROBE: no checklist */ }

      try {
        const bugs = ctx.store.readBugs(storyId);
        warnings.push(...checkBugStale(bugs, thresholds, now));
      } catch { /* PROBE */ }
    }

    const w3 = checkIdleKoala(ctx.root, thresholds, now);
    if (w3) warnings.push(w3);

    return warnings;
  } catch {
    return [];
  }
}

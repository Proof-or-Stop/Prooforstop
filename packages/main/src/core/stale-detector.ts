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

import { existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { HandlerContext } from '../handlers/context.js';
import type { StoryInfo, ChecklistData, BugData } from './types.js';
import { loadConfig } from './config.js';
import { reviewAntiStall, testAntiStall, waitingAntiStall } from './anti-stall.js';

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

interface ActivityEntry {
  source?: string;
  role?: string;
  endTime?: string;
  startTime?: string;
  tool?: string;
}

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
 * Read tail bytes from a file without loading the whole thing.
 * Used for activity.jsonl which can grow indefinitely.
 */
function readTail(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, 'r');
  try {
    const stats = statSync(filePath);
    const size = stats.size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, Math.max(0, size - len));
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
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
      const base = `Story ${story.storyId} 已在 ${story.phase} 阶段 ${formatMinutes(diff)} 未 advance`;
      if (story.phase === 'TEST_CASE_REVIEW') {
        return `${base}\n${reviewAntiStall(story.storyId)}`;
      }
      if (story.phase === 'TEST') {
        return `${base}\n${testAntiStall(story.storyId)}`;
      }
      return `${base}\n${waitingAntiStall(story.storyId)}`;
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
 * Try to parse the most-recent valid line from a tail string. Returns null if
 * no parseable line found, or if the only candidate is the *first* line of the
 * tail buffer — in that case the tail likely cuts the line in half and the
 * caller should retry with a larger window.
 */
function pickLastEntry(tail: string): { entry: ActivityEntry; firstLineCandidate: boolean } | null {
  const lines = tail.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as ActivityEntry;
      if (parsed && (parsed.endTime || parsed.startTime)) {
        return { entry: parsed, firstLineCandidate: i === 0 };
      }
    } catch { /* skip corrupt line */ }
  }
  return null;
}

/**
 * Rule 3: 距离上次任意 koala 命令超过阈值。
 * 读 docs/story/activity.jsonl 的最后一条 valid 行。
 *
 * 默认从尾部读 4KB，但如果尾部第一行就是唯一可解析的 entry，说明 tail buffer
 * 可能从中间切开了真正的最后一条记录，按 2x / 4x 重试，最多 16KB。
 */
function checkIdleKoala(root: string, thresholds: StaleThresholds, now: number): string | null {
  try {
    const path = join(root, 'docs', 'story', 'activity.jsonl');
    if (!existsSync(path)) return null;

    const sizes = [4096, 16_384, 65_536];
    let entry: ActivityEntry | null = null;
    const fileSize = statSync(path).size;
    for (const size of sizes) {
      const tail = readTail(path, size);
      if (!tail) break;
      const picked = pickLastEntry(tail);
      // Two truncation symptoms warrant retry:
      //  1. picked is the first line of the tail buffer → its head may be cut
      //  2. picked is null → no parseable line at all (last line bigger than buffer)
      // Both cases: only retry if there's still more file to read.
      const truncated = !picked || picked.firstLineCandidate;
      if (truncated && fileSize > size) {
        if (picked) entry = picked.entry; // keep best-effort fallback
        continue;
      }
      if (picked) entry = picked.entry;
      break;
    }
    if (!entry) return null;
    const tsRaw = entry.endTime || entry.startTime;
    if (!tsRaw) return null;
    const ts = Date.parse(tsRaw);
    if (!Number.isFinite(ts)) return null;
    const diff = now - ts;
    if (diff > thresholds.idleKoala * 60_000) {
      const actor = entry.role ? `（最近活跃角色: ${entry.role}）` : '';
      return `距离上次 koala 命令已过 ${formatMinutes(diff)}${actor}，记得继续走流程`;
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

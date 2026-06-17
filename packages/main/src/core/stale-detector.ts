/**
 * Stale state detector — soft warning before each lattice command runs.
 *
 * Inspired by Claude Code's todo_reminder: inject system-reminder after periods of inactivity.
 * lattice takes activity.jsonl + checklist.startTime + story.events + bug.foundAt as inputs,
 * and emits a warning to stderr before each lattice command actually runs to remind the main agent and avoid stuck phases.
 *
 * Design principles:
 *   - Never throw (PROBE class). An error in any single rule only affects that rule; the overall fallback is return [].
 *   - Do not write health (warnings are soft reminders, not health issues)
 *   - When there is no active story, return [] directly to avoid disturbing lattice help / lattice doctor
 */

import { execSync } from 'child_process';
import type { HandlerContext } from '../handlers/context.js';
import type { StoryInfo, ChecklistData, BugData } from './types.js';
import { loadConfig } from './config.js';
import { readActivityLogTail } from './activity-log.js';

export interface StaleThresholds {
  /** How long a phase can go without advance before being treated as stale, in minutes. */
  phaseStale: number;
  /** How long a checklist item can stay in_progress before it is treated as forgotten, in minutes. */
  itemStale: number;
  /** How long since the last lattice command counts as idle, in minutes. */
  idleKoala: number;
  /** How long an open bug can remain unfixed before it is overdue, in minutes. Default: 24h = 1440. */
  bugStale: number;
}

export const DEFAULT_STALE_THRESHOLDS: StaleThresholds = {
  phaseStale: 30,
  itemStale: 30,
  idleKoala: 60,
  bugStale: 1440,
};

const STALE_WARNING_COOLDOWN_MS = 30 * 60_000;

function formatMinutes(diffMs: number): string {
  const totalMin = Math.max(1, Math.round(diffMs / 60000));
  if (totalMin < 60) return `${totalMin} minutes`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin - h * 60;
  return m > 0 ? `${h}h ${m} minutes` : `${h}h`;
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
 * Rule 1: phase has not advanced for a long time at some stage.
 * Read the timestamp of the last entry in story.events as the "time of last phase action",
 * and warn if it exceeds the threshold.
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
      return `Story ${story.storyId} has been in ${story.phase} phase for ${formatMinutes(diff)} without advance`;
    }
  } catch { /* PROBE */ }
  return null;
}

/**
 * Rule 2: checklist item stuck in_progress for too long.
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
        out.push(`${item.id} has been in_progress for ${formatMinutes(diff)}; maybe it is done but was not marked done?`);
      }
    }
  } catch { /* PROBE */ }
  return out;
}

/**
 * Rule 3: more than the threshold since the last lattice command of any kind.
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
      return `It has been ${formatMinutes(diff)} since the last lattice command; remember to continue the flow`;
    }
  } catch { /* PROBE */ }
  return null;
}

/**
 * Rule 4: open bug not fixed for a long time.
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
        out.push(`Bug ${bug.id} has been open for ${formatMinutes(diff)}; consider fixing it first`);
      }
    }
  } catch { /* PROBE */ }
  return out;
}

function cooldownKeyForWarning(warning: string): string {
  const withDurationTokensNormalized = warning
    .replace(/\d+h(?: \d+ (?:min|minutes))?|\d+ (?:min|minutes)/g, '<duration>');
  return withDurationTokensNormalized
    .replace(/(has been in .+? phase for )\d+h(?: \d+ (?:min|minutes))?( without advance)/, '$1<duration>$2')
    .replace(/(has been in .+? phase for )\d+ (?:min|minutes)( without advance)/, '$1<duration>$2')
    .replace(/(has been in_progress for )\d+h(?: \d+ (?:min|minutes))?/, '$1<duration>')
    .replace(/(has been in_progress for )\d+ (?:min|minutes)/, '$1<duration>')
    .replace(/(It has been )\d+h(?: \d+ (?:min|minutes))?( since the last lattice command; remember to continue the flow)/, '$1<duration>$2')
    .replace(/(It has been )\d+ (?:min|minutes)( since the last lattice command; remember to continue the flow)/, '$1<duration>$2')
    .replace(/(has been open for )\d+h(?: \d+ (?:min|minutes))?(; consider fixing it first)/, '$1<duration>$2')
    .replace(/(has been open for )\d+ (?:min|minutes)(; consider fixing it first)/, '$1<duration>$2');
}

function suppressRecentlyEmittedWarnings(root: string, warnings: string[], now: number): string[] {
  if (warnings.length === 0) return warnings;
  try {
    const entries = readActivityLogTail(root, 25);
    const recent = new Set<string>();
    for (const entry of entries) {
      const tsRaw = String(entry.endTime || entry.startTime || entry.timestamp || '');
      const ts = Date.parse(tsRaw);
      if (!Number.isFinite(ts) || now - ts > STALE_WARNING_COOLDOWN_MS) continue;
      const staleWarnings = (entry as { staleWarnings?: unknown }).staleWarnings;
      if (!Array.isArray(staleWarnings)) continue;
      for (const warning of staleWarnings) {
        if (typeof warning === 'string') recent.add(cooldownKeyForWarning(warning));
      }
    }
    return warnings.filter(w => !recent.has(cooldownKeyForWarning(w)));
  } catch {
    return warnings;
  }
}

/**
 * Public API. Returns warning lines (no leading prefix). Caller prints to stderr.
 *
 * Never throws; any internal exception is swallowed and returns [].
 */
export function detectStaleState(ctx: HandlerContext): string[] {
  try {
    const storyId = detectActiveStoryId(ctx.root);
    if (!storyId) return [];

    let story: StoryInfo | null = null;
    try { story = ctx.store.readStory(storyId); } catch { /* PROBE */ }
    // If there is no story file, only run the idle rule (idle does not depend on story)
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

    return suppressRecentlyEmittedWarnings(ctx.root, warnings, now);
  } catch {
    return [];
  }
}

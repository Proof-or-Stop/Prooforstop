/**
 * @task B-86c0
 * @checklist CHK-001, CHK-002
 * @title move activity logging to runtime store with legacy read compatibility
 * @type feature
 * @priority high
 * @description
 *   Activity logs are runtime telemetry, not story metadata. Writing them
 *   under docs/story made status checks, DONE merges, and baseline risk noisy.
 *   New writes go to .koala/activity.jsonl while readers keep legacy
 *   docs/story/activity.jsonl compatibility.
 * @changes
 *   - [CHK-001] Define runtime and legacy activity log paths
 *   - [CHK-001] Append new activity records to .koala/activity.jsonl
 *   - [CHK-002] Read and merge runtime plus legacy activity entries
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

export interface ActivityLogEntry {
  source?: string;
  role?: string;
  startTime?: string | null;
  endTime?: string | null;
  tool?: string;
  detail?: string;
  status?: 'ok' | 'fail' | string;
  error?: string | null;
  storyId?: string | null;
  [key: string]: unknown;
}

export function getRuntimeActivityLogPath(root: string): string {
  return join(root, '.koala', 'activity.jsonl');
}

export function getLegacyActivityLogPath(root: string): string {
  return join(root, 'docs', 'story', 'activity.jsonl');
}

export function getActivityLogPaths(root: string): string[] {
  return [getRuntimeActivityLogPath(root), getLegacyActivityLogPath(root)];
}

export function appendActivityLog(root: string, record: Record<string, unknown>): void {
  const path = getRuntimeActivityLogPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + '\n');
}

function activityTimestamp(entry: ActivityLogEntry): string {
  return String(entry.endTime || entry.startTime || '');
}

export function readActivityLogEntries(root: string): ActivityLogEntry[] {
  const entries: ActivityLogEntry[] = [];
  for (const path of getActivityLogPaths(root)) {
    if (!existsSync(path)) continue;
    let raw = '';
    try { raw = readFileSync(path, 'utf-8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ActivityLogEntry;
        if (parsed && (parsed.endTime || parsed.startTime)) entries.push(parsed);
      } catch { /* skip malformed legacy/runtime log line */ }
    }
  }
  entries.sort((a, b) => activityTimestamp(a).localeCompare(activityTimestamp(b)));
  return entries;
}

export function readActivityLogTail(root: string, lines: number): ActivityLogEntry[] {
  if (lines <= 0) return [];
  return readActivityLogEntries(root).slice(-lines);
}

export function readLatestActivityLogEntry(root: string): ActivityLogEntry | null {
  const entries = readActivityLogEntries(root);
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

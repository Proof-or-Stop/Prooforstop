/**
 * Dual-source activity log module.
 *
 * Runtime logs go to <projectRoot>/.proof-or-stop/activity.jsonl.
 * The older <projectRoot>/docs/story/activity.jsonl is a read-only source.
 * readActivityLogTail merges both sources. The old legacy runtime-path read
 * fallback was removed (B-a4e3).
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import {
  PROOF_OR_STOP_ACTIVITY_LOG,
  LEGACY_DOCS_ACTIVITY_LOG,
} from './proof-or-stop-paths.js';

/** Runtime activity log path: <projectRoot>/.proof-or-stop/activity.jsonl */
export function getRuntimeActivityLogPath(projectRoot: string): string {
  return join(projectRoot, PROOF_OR_STOP_ACTIVITY_LOG);
}

/** Legacy path (read-only compat): <projectRoot>/docs/story/activity.jsonl */
export function getLegacyActivityLogPath(projectRoot: string): string {
  return join(projectRoot, LEGACY_DOCS_ACTIVITY_LOG);
}

/** Append one activity record to the runtime path. */
export function appendActivityLog(projectRoot: string, record: Record<string, unknown>): void {
  const logPath = getRuntimeActivityLogPath(projectRoot);
  const dir = dirname(logPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(logPath, JSON.stringify(record) + '\n');
}

/**
 * Read the most recent N activity entries (dual-source merge: runtime + legacy
 * docs archive, sorted by timestamp descending).
 */
export function readActivityLogTail(projectRoot: string, count: number = 50): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const logPath of [
    getRuntimeActivityLogPath(projectRoot),
    getLegacyActivityLogPath(projectRoot),
  ]) {
    if (!existsSync(logPath)) continue;
    try {
      const lines = readFileSync(logPath, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
      }
    } catch { /* skip unreadable file */ }
  }
  // Sort by timestamp descending
  entries.sort((a, b) => {
    const ta = String(a.timestamp || a.startTime || '');
    const tb = String(b.timestamp || b.startTime || '');
    return tb.localeCompare(ta);
  });
  return entries.slice(0, count);
}

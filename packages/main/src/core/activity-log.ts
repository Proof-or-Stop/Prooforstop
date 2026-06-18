/**
 * Dual-source activity log module.
 *
 * Runtime logs go to <projectRoot>/.lattice/activity.jsonl.
 * The migrated legacy archive at <projectRoot>/.lattice/activity.legacy-koala.jsonl
 * and the older <projectRoot>/docs/story/activity.jsonl are read-only sources.
 * readActivityLogTail merges all sources. The legacy `.koala/activity.jsonl`
 * read fallback was removed (B-a4e3).
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import {
  LATTICE_ACTIVITY_LOG,
  LATTICE_LEGACY_KOALA_ACTIVITY_LOG,
  LEGACY_DOCS_ACTIVITY_LOG,
} from './lattice-paths.js';

/** Runtime activity log path: <projectRoot>/.lattice/activity.jsonl */
export function getRuntimeActivityLogPath(projectRoot: string): string {
  return join(projectRoot, LATTICE_ACTIVITY_LOG);
}

/** Migrated legacy activity archive (read-only): <projectRoot>/.lattice/activity.legacy-koala.jsonl */
export function getMigratedLegacyKoalaActivityLogPath(projectRoot: string): string {
  return join(projectRoot, LATTICE_LEGACY_KOALA_ACTIVITY_LOG);
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
 * Read the most recent N activity entries (dual-source merge: runtime + legacy,
 * sorted by timestamp descending).
 */
export function readActivityLogTail(projectRoot: string, count: number = 50): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const logPath of [
    getRuntimeActivityLogPath(projectRoot),
    getMigratedLegacyKoalaActivityLogPath(projectRoot),
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

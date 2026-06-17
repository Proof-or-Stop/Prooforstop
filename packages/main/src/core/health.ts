/**
 * Health issue tracking — receiver for silent catch classification
 *
 * Design purpose:
 *   lattice previously had dozens of silent catches (try ... catch ignore). Following CC's fail-fast
 *   principle, classify into four categories:
 *     - DEBUG  (logging/progress)         → keep silent
 *     - PROBE  (probes, e.g. file not found) → keep silent
 *     - PERSIST (writeLog/save failure) → switch to reportHealthIssue (does not throw, but leaves a trace)
 *     - MUTATION (git/fs.write failure) → switch to throw
 *
 *   PERSIST-class failures were previously swallowed and could not be traced afterward. This module provides a lightweight
 *   JSONL append receiver: each issue is written to ~/.lattice/health.jsonl,
 *   and `lattice doctor` can read them out.
 *
 * Design constraints:
 *   - reportHealthIssue itself must not throw. A crash in the health module must not drag down the main flow.
 *   - JSONL line format is stable (schemaVersion=1) for easy consumption by external tooling.
 *
 * @task B-ef9c
 * @checklist CHK-001
 * @title classify silent catch handling
 * @type feature
 * @priority high
 * @description
 *   Some silent catch sites cannot all be deleted because probe/debug ignores
 *   are legitimate, but they must be classified: DEBUG stays silent, PROBE
 *   returns a default, PERSIST records health, and MUTATION must throw.
 * @changes
 *   - [CHK-001] Provide reportHealthIssue for persist failures that should degrade to health logs
 *   - [CHK-001] Document when silent is ok, when to log, and when mutation failures must throw
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { LATTICE_DIR } from './lattice-paths.js';

export interface HealthIssue {
  schemaVersion: 1;
  /** Write timestamp (ISO 8601) */
  timestamp: string;
  /** Category tag: persist:writeLog / persist:state / mutation:git / etc */
  category: string;
  /** Error message (without stack) */
  error: string;
  /** Context: command name, storyId, file path, etc. */
  context: Record<string, unknown>;
}

/** Default health.jsonl path: ~/.lattice/health.jsonl */
export function getHealthPath(): string {
  // Allow overriding the path via env for easier testing
  if (process.env.LATTICE_HEALTH_PATH) return process.env.LATTICE_HEALTH_PATH;
  return join(homedir(), LATTICE_DIR, 'health.jsonl');
}

/**
 * Record a health issue.
 *
 * **This function never throws** — even if writing the health file fails, the main flow is unaffected.
 * On write failure, it attempts to emit a warning to stderr but does not throw.
 */
export function reportHealthIssue(
  category: string,
  error: Error | { message: string },
  context: Record<string, unknown>,
): void {
  try {
    const healthPath = getHealthPath();
    const dir = join(healthPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const issue: HealthIssue = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      category,
      error: error.message,
      context,
    };
    appendFileSync(healthPath, JSON.stringify(issue) + '\n');
  } catch (e: unknown) {
    // Last line of defense: health itself crashed; write to stderr but do not throw
    try {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[lattice-health] failed to record health issue: ${msg}\n`);
    } catch { /* Truly nothing else to do */ }
  }
}

/**
 * Read all health issues (newest first).
 * An empty array means there are no issues or health.jsonl does not exist.
 */
export function readHealthIssues(maxCount = 1000): HealthIssue[] {
  const healthPath = getHealthPath();
  if (!existsSync(healthPath)) return [];
  try {
    const content = readFileSync(healthPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    const issues: HealthIssue[] = [];
    // Read from the tail backwards to ensure newest first
    for (let i = lines.length - 1; i >= 0 && issues.length < maxCount; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as HealthIssue;
        if (parsed && typeof parsed.timestamp === 'string' && typeof parsed.category === 'string') {
          issues.push(parsed);
        }
      } catch { /* Skip corrupted line */ }
    }
    return issues;
  } catch {
    return [];
  }
}

/**
 * Aggregate issues by category — used by the doctor command.
 */
export function summarizeHealthIssues(issues: HealthIssue[]): {
  total: number;
  byCategory: Record<string, number>;
  recent: HealthIssue[];
  recentWindow: '24h' | 'all';
} {
  const byCategory: Record<string, number> = {};
  for (const i of issues) {
    byCategory[i.category] = (byCategory[i.category] || 0) + 1;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = issues.filter(i => {
    const t = Date.parse(i.timestamp);
    return Number.isFinite(t) && t >= cutoff;
  });
  return {
    total: issues.length,
    byCategory,
    recent: recent.length > 0 ? recent.slice(0, 50) : issues.slice(0, 50),
    recentWindow: recent.length > 0 ? '24h' : 'all',
  };
}

/**
 * Trace snapshot storage (CHK-003)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import type { ProfileNode } from './profiler.js';
import { pickProjectConfigPath } from '../core/config.js';
export interface TraceSnapshot {
  commit: string;
  timestamp: string;
  caseName: string;
  fixturePath: string;
  trace: ProfileNode[];
}

export interface TraceFile {
  /**
   * CHK-003: key format is `caseName:commitHash`.
   * Same key → overwrite (dedup). Array sorted newest-first, capped at maxTraceSnapshots.
   */
  snapshots: Record<string, TraceSnapshot[]>;
}

const DEFAULT_MAX_SNAPSHOTS = 5;

/**
 * Read maxTraceSnapshots directly from the project config file (bypasses
 * loadConfig cache). lattice.config.json is the active project config
 * when both are present; either file is sufficient.
 */
function getMaxSnapshots(root: string): number {
  try {
    const picked = pickProjectConfigPath(root);
    if (!picked) return DEFAULT_MAX_SNAPSHOTS;
    const raw = JSON.parse(readFileSync(picked.path, 'utf-8'));
    return raw.maxTraceSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
  } catch {
    return DEFAULT_MAX_SNAPSHOTS;
  }
}

function getCurrentCommit(root: string): string {
  const gitCwd = root;
  try {
    return execSync('git rev-parse HEAD', { cwd: gitCwd, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** CHK-002: trace files go to .lattice/traces/ instead of fixturesDir, surviving git restore/clean */
function traceFilePath(root: string, fixtureName: string): string {
  return join(root, '.lattice', 'traces', fixtureName.replace(/\.json$/, '') + '.trace.json');
}

/** Build the composite key: caseName:commitHash */
function snapshotKey(caseName: string, commit: string): string {
  return `${caseName}:${commit}`;
}

/** Extract caseName from a composite key (handles legacy plain caseName keys too) */
function caseNameFromKey(key: string): string {
  const idx = key.lastIndexOf(':');
  return idx > 0 ? key.slice(0, idx) : key;
}

export function saveTraceSnapshot(
  root: string, fixtureName: string, caseName: string,
  trace: ProfileNode[],
): void {
  const filePath = traceFilePath(root, fixtureName);
  const maxN = getMaxSnapshots(root);
  let data: TraceFile = { snapshots: {} };
  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (raw.snapshots) {
        for (const [key, val] of Object.entries(raw.snapshots)) {
          data.snapshots[key] = Array.isArray(val) ? val as TraceSnapshot[] : [val as TraceSnapshot];
        }
      }
    } catch {}
  }
  const commit = getCurrentCommit(root);
  const key = snapshotKey(caseName, commit);
  const newSnap: TraceSnapshot = {
    commit,
    timestamp: new Date().toISOString(),
    caseName, fixturePath: fixtureName, trace,
  };

  // CHK-003: same key (caseName:commit) → overwrite (dedup)
  if (data.snapshots[key]) {
    data.snapshots[key] = [newSnap];
  } else {
    data.snapshots[key] = [newSnap];
  }

  // Collect all snapshots for this caseName across all commit keys, sort by timestamp desc, keep N
  const allKeysForCase = Object.keys(data.snapshots).filter(k => caseNameFromKey(k) === caseName);
  if (allKeysForCase.length > maxN) {
    // Sort keys by their snapshot timestamp (newest first)
    allKeysForCase.sort((a, b) => {
      const ta = data.snapshots[a]?.[0]?.timestamp || '';
      const tb = data.snapshots[b]?.[0]?.timestamp || '';
      return tb.localeCompare(ta);
    });
    // Remove oldest beyond N
    for (const oldKey of allKeysForCase.slice(maxN)) {
      delete data.snapshots[oldKey];
    }
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function loadTraceSnapshot(
  root: string, fixtureName: string, caseName: string,
): TraceSnapshot | null {
  const filePath = traceFilePath(root, fixtureName);
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!raw.snapshots) return null;

    // Find all keys matching this caseName (both legacy plain key and new caseName:commit keys)
    let best: TraceSnapshot | null = null;
    for (const [key, val] of Object.entries(raw.snapshots)) {
      if (caseNameFromKey(key) !== caseName && key !== caseName) continue;
      const snap = Array.isArray(val) ? (val as TraceSnapshot[])[0] : val as TraceSnapshot;
      if (!snap || typeof snap !== 'object' || !snap.timestamp) continue;
      if (!best || snap.timestamp > best.timestamp) best = snap;
    }
    return best;
  } catch { return null; }
}

export function scanAllTraces(root: string): TraceSnapshot[] {
  const tracesDir = join(root, '.lattice', 'traces');
  const results: TraceSnapshot[] = [];
  function scan(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { scan(join(dir, entry.name)); continue; }
      if (entry.name.endsWith('.trace.json')) {
        try {
          const raw = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8'));
          // Collect latest snapshot per caseName
          const byCase = new Map<string, TraceSnapshot>();
          for (const [key, val] of Object.entries(raw.snapshots || {})) {
            const cn = caseNameFromKey(key);
            const snap = Array.isArray(val) ? (val as TraceSnapshot[])[0] : val as TraceSnapshot;
            if (!snap || typeof snap !== 'object' || !snap.timestamp) continue;
            const existing = byCase.get(cn);
            if (!existing || snap.timestamp > existing.timestamp) byCase.set(cn, snap);
          }
          for (const snap of byCase.values()) results.push(snap);
        } catch {}
      }
    }
  }
  scan(tracesDir);
  return results;
}

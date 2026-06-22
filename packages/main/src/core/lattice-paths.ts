export const LATTICE_DIR = '.lattice';

/**
 * Forbidden write directory name. Kept ONLY as a write-protection sentinel for
 * the prewrite guards below (which reject any attempt to write under `.koala`).
 * The legacy `.koala` READ fallback was removed (B-a4e3); no consumer reads from
 * `.koala` anymore — Lattice reads/writes exclusively under `.lattice`.
 */
const FORBIDDEN_WRITE_DIR = '.koala';

export const LATTICE_STORY_DIR = `${LATTICE_DIR}/story/actives`;
export const LEGACY_DOCS_STORY_DIR = 'docs/story/actives';

export const LATTICE_ACTIVITY_LOG = `${LATTICE_DIR}/activity.jsonl`;
export const LATTICE_LEGACY_KOALA_ACTIVITY_LOG = `${LATTICE_DIR}/activity.legacy-koala.jsonl`;
export const LEGACY_DOCS_ACTIVITY_LOG = 'docs/story/activity.jsonl';

export const LATTICE_MAIN_WRITE_LOCK = `${LATTICE_DIR}/locks/main-write.lock`;
export const LATTICE_REPAIR_IGNORE = '.lattice-repair-ignore';

export function normalizeRelPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function uniqueRelPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = normalizeRelPath(path);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function containsLegacyKoalaDir(path: string): boolean {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => segment === FORBIDDEN_WRITE_DIR);
}

export function assertNoLegacyKoalaWritePath(path: string, label = 'path'): void {
  if (!containsLegacyKoalaDir(path)) return;
  throw new Error(`${label} must not target ${FORBIDDEN_WRITE_DIR}; use ${LATTICE_DIR} for writable Lattice assets.`);
}

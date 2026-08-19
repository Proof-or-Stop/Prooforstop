/**
 * On-disk state paths (B-cdf6 CHK-006).
 *
 * The identifiers below are brand-forward, but every VALUE is deliberately
 * FROZEN at the `.lattice` spelling. These are live state paths: `.lattice/`
 * holds the locks, activity log and per-story evidence for in-flight stories, so
 * renaming the value would orphan that state rather than migrate it. See the
 * FROZEN `.lattice/` row in `docs/requirements/decisions/brand-rename-mapping.md`.
 * Rename the identifier freely; never the string.
 */
export const PROOF_OR_STOP_DIR = '.lattice';

export const PROOF_OR_STOP_STORY_DIR = `${PROOF_OR_STOP_DIR}/story/actives`;
export const LEGACY_DOCS_STORY_DIR = 'docs/story/actives';

export const PROOF_OR_STOP_ACTIVITY_LOG = `${PROOF_OR_STOP_DIR}/activity.jsonl`;
export const LEGACY_DOCS_ACTIVITY_LOG = 'docs/story/activity.jsonl';

export const PROOF_OR_STOP_MAIN_WRITE_LOCK = `${PROOF_OR_STOP_DIR}/locks/main-write.lock`;
export const PROOF_OR_STOP_REPAIR_IGNORE = '.lattice-repair-ignore';

/*
 * Deprecated path aliases. Durable (multi-developer repo): a teammate branch
 * importing the old symbol must still compile on merge. Never remove.
 */
/** @deprecated Use `PROOF_OR_STOP_DIR`. */
export const LATTICE_DIR = PROOF_OR_STOP_DIR;
/** @deprecated Use `PROOF_OR_STOP_STORY_DIR`. */
export const LATTICE_STORY_DIR = PROOF_OR_STOP_STORY_DIR;
/** @deprecated Use `PROOF_OR_STOP_ACTIVITY_LOG`. */
export const LATTICE_ACTIVITY_LOG = PROOF_OR_STOP_ACTIVITY_LOG;
/** @deprecated Use `PROOF_OR_STOP_MAIN_WRITE_LOCK`. */
export const LATTICE_MAIN_WRITE_LOCK = PROOF_OR_STOP_MAIN_WRITE_LOCK;
/** @deprecated Use `PROOF_OR_STOP_REPAIR_IGNORE`. */
export const LATTICE_REPAIR_IGNORE = PROOF_OR_STOP_REPAIR_IGNORE;

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

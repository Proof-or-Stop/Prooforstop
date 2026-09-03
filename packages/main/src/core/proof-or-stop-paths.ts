/**
 * On-disk state paths.
 *
 * B-cc10 CHK-002: the state-directory NAME is no longer a literal here. It now
 * comes from `core/brand-paths.ts`, the single read-both resolver that owns
 * state-dir / adapter-dir / config-filename resolution.
 *
 * This indirection is load-bearing, not cosmetic. `PROOF_OR_STOP_STORY_DIR`
 * below feeds `isStoryMetadataPath` in `core/evidence-freshness.ts`, which is
 * what EXCLUDES story metadata from `storyFilesHash`. If the on-disk directory
 * were renamed while a second hardcoded copy of the old name lingered here, 344
 * archived story directories would silently flip from excluded to INCLUDED in
 * the digest — nothing would throw, the hashes would just change meaning. See
 * `docs/requirements/decisions/proof-or-stop-identity-migration.md`, section
 * "storyFilesHash: the state-dir rename is a CHK-002 correctness requirement".
 *
 * Do not reintroduce the directory-name literal here. Change it in
 * `core/brand-paths.ts` and it propagates to the hash exclusion automatically.
 */
import { PROOF_OR_STOP_STATE_DIR, STATE_DIR_NAMES } from './brand-paths.js';

export const PROOF_OR_STOP_DIR = PROOF_OR_STOP_STATE_DIR;

export const PROOF_OR_STOP_STORY_DIR = `${PROOF_OR_STOP_DIR}/story/actives`;
export const LEGACY_DOCS_STORY_DIR = 'docs/story/actives';

/**
 * EVERY accepted spelling of the story-metadata directory, canonical first.
 *
 * B-cc10 CHK-002: this list — not the single canonical `PROOF_OR_STOP_STORY_DIR`
 * — is what `isStoryMetadataPath` derives its prefixes from, and the reason is
 * the `storyFilesHash` hazard cutting BOTH ways. Deriving the exclusion from the
 * canonical name alone makes the exclusion follow the rename (good) but leaves a
 * not-yet-migrated archive under the deprecated directory OUTSIDE the exclusion
 * — so during migration those archives would silently enter the digest, which is
 * the very drift this item exists to prevent. Recognizing both spellings keeps
 * story metadata excluded on either side of the move.
 *
 * Writes still use only `PROOF_OR_STOP_STORY_DIR`; this list is READ-side only.
 */
export const PROOF_OR_STOP_STORY_DIR_NAMES: readonly string[] = STATE_DIR_NAMES.map(
  (dir) => `${dir}/story/actives`,
);

export const PROOF_OR_STOP_ACTIVITY_LOG = `${PROOF_OR_STOP_DIR}/activity.jsonl`;
export const LEGACY_DOCS_ACTIVITY_LOG = 'docs/story/activity.jsonl';

export const PROOF_OR_STOP_MAIN_WRITE_LOCK = `${PROOF_OR_STOP_DIR}/locks/main-write.lock`;

/**
 * Worktree quarantine marker. Deliberately NOT derived from
 * `PROOF_OR_STOP_STATE_DIR`: it is a sibling marker FILE, not a path inside the
 * state directory, and it is not one of the six identities B-cc10 migrates.
 * Deriving it would silently rename it along with the state dir and orphan any
 * marker already written into an existing worktree. Left as an explicit literal
 * so that rename remains a separate, deliberate decision.
 */
export const PROOF_OR_STOP_REPAIR_IGNORE = '.proof-or-stop-repair-ignore';

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

/**
 * evidence-stale-hint — single source of truth for stale verificationEvidence UX.
 *
 * Design:
 *   - Any user-visible surface (session_brief / story_advance pre-check / koala validate
 *     text output / hints.ts decorators) that detects stale verification evidence must call this module's
 *     renderEvidenceStaleHint; reconstructing marker strings or recovery commands inside the surface is not allowed.
 *   - The three surfaces produce byte-identical output (B-a2f1 decision.json preMortem #2).
 *   - storyId is required; if storyId is missing the whole block returns ''; never output literal placeholders
 *     like `<storyId>` / `<B-xxx>` to the user (B-a2f1 decision.json preMortem #3).
 *
 * Reuses: checkEvidenceFreshnessForGit + verificationEvidence on the Story checklist.
 * No new dependencies introduced; only uses existing core / store.
 */

import { checkEvidenceFreshnessForGit } from './evidence-freshness.js';
import { StoryStore } from './store.js';

/**
 * The sole cross-surface marker. All three surfaces import strings from here;
 * rewriting the constants inside a surface is not allowed.
 */
export const EVIDENCE_STALE_MARKER = '⚠ EVIDENCE STALE';

export interface StaleEvidenceEntry {
  /** intent reference, e.g. "CHK-001:happy:0" */
  intentRef: string;
  /** owning checklist item, e.g. "CHK-001" */
  itemId: string;
  /** stale reason (from checkEvidenceFreshnessForGit's reason, useful for debugging, but not emitted in the marker output) */
  reason: string;
}

/**
 * Scans the story's checklist.verificationEvidence and returns all stale entries.
 *
 * Reuses checkEvidenceFreshnessForGit: both headHash + materialHash are fed in,
 * fresh=false → treated as stale. If story / checklist cannot be read, always returns [] (probe-tolerant).
 */
export function findStaleEvidence(projectRoot: string, storyId: string): StaleEvidenceEntry[] {
  if (!storyId) return [];
  let store: StoryStore;
  try {
    store = new StoryStore(projectRoot);
  } catch {
    return [];
  }
  let checklist: { items?: Array<{ id: string; verificationEvidence?: Array<{ intentRef: string; headHash?: string; materialHash?: string }> }> } | null = null;
  try {
    checklist = store.readChecklist(storyId);
  } catch {
    return [];
  }
  if (!checklist || !Array.isArray(checklist.items)) return [];

  const out: StaleEvidenceEntry[] = [];
  for (const item of checklist.items) {
    const evidences = Array.isArray(item.verificationEvidence) ? item.verificationEvidence : [];
    for (const ev of evidences) {
      if (!ev || typeof ev.intentRef !== 'string') continue;
      const freshness = checkEvidenceFreshnessForGit(projectRoot, ev.headHash, ev.materialHash);
      if (!freshness.fresh) {
        out.push({
          intentRef: ev.intentRef,
          itemId: item.id,
          reason: freshness.reason,
        });
      }
    }
  }
  return out;
}

/**
 * Renders the cross-surface byte-identical EVIDENCE STALE block.
 *
 * Inputs:
 *   storyId   - the actual story id (e.g. "B-a2f1"); returns '' when undefined / empty string
 *   stale     - the already-computed stale list (only output when ≥1, returns '' when 0)
 *   opts      - optional; currentHead takes the first 7 chars and is filled into "materialHash drift after <sha>"
 *
 * Output format (must remain stable — all three surfaces assert this format by byte-equality):
 *
 *   ⚠ EVIDENCE STALE (materialHash drift after abc1234): 2 verification intent(s) stale for B-xxxx
 *     Run to recover:
 *       koala verification_evidence_refresh_stale --storyId=B-xxxx
 *       koala validate --story=B-xxxx --json
 *
 * Do not output literal placeholders like `<storyId>` / `<B-xxx>` (preMortem #3).
 */
export function renderEvidenceStaleHint(
  storyId: string | undefined,
  stale: ReadonlyArray<StaleEvidenceEntry>,
  opts?: { currentHead?: string },
): string {
  if (!storyId || stale.length === 0) return '';
  const headSuffix = opts?.currentHead ? ` (materialHash drift after ${opts.currentHead.slice(0, 7)})` : '';
  const count = stale.length;
  const lines = [
    `${EVIDENCE_STALE_MARKER}${headSuffix}: ${count} verification intent(s) stale for ${storyId}`,
    `  Run to recover:`,
    `    koala verification_evidence_refresh_stale --storyId=${storyId}`,
    `    koala validate --story=${storyId} --json`,
  ];
  return lines.join('\n');
}

/**
 * B-5a48 CHK-001: Single shared firing leaf for the Experience Layer A/B-gated
 * advisory experience hints.
 *
 * This is the ONE place the hint firing + per-review-round dedup + A/B arm logic
 * lives, so the PLAN site (handlers/story-review.ts) and the REVIEW site
 * (handlers/transition-effects.ts buildNextSteps) share an identical
 * implementation with NO drift in the dedup key, the event payload, or the
 * render-gate.
 *
 * Behavior (moved VERBATIM from the story-review.ts firing block, ~lines 610-649):
 *  - `hintMode = resolveHintMode(storyId)` — deterministic sha256-parity arm.
 *  - `loadExperienceHints(root)` + `formatExperienceHintsSection(...)` ALWAYS
 *    compute the section (independent of arm); the OFF arm hides it from the
 *    render-gate below, but the event still records the full would-have-surfaced
 *    set so measurement is lossless.
 *  - DEDUP: when there are hints, scan `readActivityLogTail(root, 1000)` for an
 *    existing `experience_hint_surfaced` event with the same `(storyId,
 *    reviewRound===hintRoundKey)` and skip the append if found — repeated calls
 *    in the same round => exactly one event. On a miss, `appendActivityLog(...)`
 *    fires on BOTH arms (the `hintMode` field records which arm) and `fired` is
 *    set true.
 *  - RENDER-GATE: `renderedSection = hintMode === 'on' ? section : ''`. Only the
 *    RENDER is gated; the event is not.
 *
 * CRITICAL: the CALLER supplies `hintRoundKey`. This leaf NEVER computes the
 * `story.currentReviewRound || `plan:${story.phase}`` formula — that lives at the
 * call sites so PLAN (plan:<phase>) and REVIEW (ISO currentReviewRound) keep
 * disjoint namespaces while sharing one firing implementation.
 *
 * ADVISORY-ONLY: hint content is NEVER fed to resolveReviewPromptHash and no gate
 * reads it. A load/track failure is swallowed (try/catch) and returns an empty
 * `renderedSection` with no throw and no partial event.
 *
 * ISOLATION BAR: imports ONLY the existing core leaves
 * experience-hint-loader / hint-mode / activity-log (+ the HintMode type). Zero
 * new cross-layer edges.
 */

import { loadExperienceHints, formatExperienceHintsSection, hasExperienceHints, experienceHintIds } from './experience-hint-loader.js';
import { appendActivityLog, readActivityLogTail } from './activity-log.js';
import { resolveHintMode } from './hint-mode.js';
import type { HintMode } from './hint-mode.js';

export interface SurfaceExperienceHintsOptions {
  /** The story whose arm + events this surface concerns. */
  storyId: string;
  /**
   * The stable dedup key for this round, supplied by the CALLER. PLAN uses
   * `plan:<phase>`; REVIEW uses `story.currentReviewRound` (ISO stamp). The leaf
   * never computes this formula.
   */
  hintRoundKey: string;
}

export interface SurfaceExperienceHintsResult {
  /** The deterministic A/B arm for this story. */
  hintMode: HintMode;
  /** The rendered hints section on the ON arm; '' on the OFF arm or no hints. */
  renderedSection: string;
  /** The full would-have-surfaced hint ids (same on both arms; lossless). */
  hintIds: string[];
  /** True only when this call appended a new experience_hint_surfaced event. */
  fired: boolean;
}

/**
 * Surface (and once-per-round track) the advisory experience hints for a story.
 * See the module comment for the verbatim firing semantics.
 */
export function surfaceExperienceHints(
  root: string,
  opts: SurfaceExperienceHintsOptions,
): SurfaceExperienceHintsResult {
  const { storyId, hintRoundKey } = opts;
  // B-06b3 CHK-002: deterministic A/B arm for the advisory experience-hint
  // SHADOW gate. The arm only governs whether the advisory section is RENDERED
  // (see `renderedSection` below) — hints are ALWAYS computed and the
  // experience_hint_surfaced event ALWAYS fires (with this hintMode) on BOTH
  // arms, so measurement is lossless. The arm must NEVER enter the
  // issues/blocker computation or resolveReviewPromptHash.
  const hintMode = resolveHintMode(storyId);
  let experienceHintsSection = '';
  let hintIds: string[] = [];
  let fired = false;
  try {
    const experienceHints = loadExperienceHints(root);
    // ALWAYS compute the section (independent of arm); the OFF arm hides it from
    // the prompt via the render-gate below, but the event still records the full
    // would-have-surfaced set.
    experienceHintsSection = formatExperienceHintsSection(experienceHints);
    hintIds = experienceHintIds(experienceHints);
    if (hasExperienceHints(experienceHints)) {
      // Skip the append if an experience_hint_surfaced event already exists for
      // this (storyId, hintRoundKey) — repeated calls in the same round => one event.
      const alreadySurfaced = readActivityLogTail(root, 1000).some(
        (e) => e.event === 'experience_hint_surfaced'
          && e.storyId === storyId
          && e.reviewRound === hintRoundKey,
      );
      if (!alreadySurfaced) {
        // USAGE TRACKING: exactly one event per (storyId, review round).
        // Fires on BOTH arms; the hintMode field records which arm surfaced
        // (ON) or shadow-suppressed (OFF) the section.
        appendActivityLog(root, {
          timestamp: new Date().toISOString(),
          event: 'experience_hint_surfaced',
          storyId,
          reviewRound: hintRoundKey,
          hintMode,
          hintIds,
        });
        fired = true;
      }
    }
  } catch (e) {
    // Advisory-only: never let hint loading/tracking break the caller.
    console.warn(`[experience-hints] surface failed for ${storyId}:`, (e as Error).message);
    return { hintMode, renderedSection: '', hintIds: [], fired: false };
  }
  // RENDER-GATE: ON arm renders the computed section; OFF arm uses '' so the
  // OFF-arm output is byte-identical to the no-hints case. `hintIds` (used for
  // the event above) is deliberately left untouched so measurement is unaffected
  // by the arm.
  const renderedSection = hintMode === 'on' ? experienceHintsSection : '';
  return { hintMode, renderedSection, hintIds, fired };
}

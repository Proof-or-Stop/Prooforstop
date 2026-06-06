/**
 * B-e8c8 CHK-006: Reviewer opt-in routing by riskSignals.
 *
 * Baseline reviewers (always active): concept + quality.
 * Additional reviewers opted in by story signals:
 *   - riskSignals.category ∈ { state machine / guard / gate / state-machine/gate } → +behavior
 *   - touchpoints contains `.md` files                                  → +docs
 *   - channel === 'normal'                                             → +channel
 *   - forced list (e.g. --force-reviewer=docs,channel)                 → force-mount
 *
 * Pure function — no I/O. Consumers: machine.canPassReview, reviewer_list handler,
 * the reviewer echo output by story_advance REVIEW command (after B-6974 rendered by transition-effects.ts
 * buildNextSteps, coordinated via transition-orchestrator).
 */

import type { StoryInfo } from './types.js';

export type Channel = 'quick' | 'normal';

export interface OptInReviewer {
  /** reviewer short name, e.g. concept / quality / behavior / docs / channel */
  name: string;
  /** why this reviewer is enabled (baseline / riskSignal / touchpoint / channel / forced) */
  reason: string;
  /** whether force-mounted via --force-reviewer */
  forced?: boolean;
}

/** Signal → list of trigger categories for +behavior (supports both English and the currently-used Chinese categories) */
const BEHAVIOR_TRIGGER_CATEGORIES = [
  'state machine',
  'guard',
  'gate',
  'state-machine/gate',
];

/**
 * Compute the list of reviewers that should be enabled based on the story's riskSignals / channel / touchpoints.
 * Returns the list sorted alphabetically by name (stable, convenient for assertions and rendering).
 */
export function resolveOptInReviewers(
  story: StoryInfo,
  channel: Channel,
  touchpoints?: string[],
  forced?: string[],
): OptInReviewer[] {
  const map = new Map<string, OptInReviewer>();

  // BASELINE: concept + quality are always enabled
  map.set('concept', { name: 'concept', reason: 'baseline' });
  map.set('quality', { name: 'quality', reason: 'baseline' });

  // riskSignal routing: hitting state machine/guard/gate triggers the behavior reviewer
  const categories = new Set((story.riskSignals || []).map(r => r.category));
  const triggeredBehavior = BEHAVIOR_TRIGGER_CATEGORIES.find(t => categories.has(t));
  if (triggeredBehavior) {
    map.set('behavior', { name: 'behavior', reason: `riskSignal: ${triggeredBehavior}` });
  }

  // touchpoint: changes involving .md files → +docs reviewer
  if (touchpoints && touchpoints.some(t => typeof t === 'string' && t.endsWith('.md'))) {
    map.set('docs', { name: 'docs', reason: 'touchpoint: md' });
  }

  // normal channel → +channel reviewer (checks commit author compliance)
  if (channel === 'normal') {
    map.set('channel', { name: 'channel', reason: 'channel: normal' });
  }

  // forced override: command-line --force-reviewer=docs,channel explicit force-mount
  if (forced && forced.length > 0) {
    for (const f of forced) {
      const name = String(f).trim();
      if (!name) continue;
      map.set(name, { name, reason: 'forced', forced: true });
    }
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compute the current story's channel in real time.
 * Consistent with the DEV nextSteps determination in buildNextSteps of transition-effects.ts:
 *   - checklist.items.length ≤ 2 and no riskSignals → quick
 *   - otherwise                                     → normal
 */
export function resolveChannel(
  itemsCount: number,
  riskSignals: StoryInfo['riskSignals'],
): Channel {
  if (itemsCount <= 2 && (!riskSignals || riskSignals.length === 0)) return 'quick';
  return 'normal';
}

/**
 * Match by reviewer short name against the finding agent string.
 * An agent like "koala-review-concept" matches name="concept".
 * Supports the bare "concept" name and any form of <prefix>-concept / <prefix>:concept.
 */
export function findingAgentMatchesReviewer(agent: string | undefined, reviewerName: string): boolean {
  if (!agent) return false;
  const a = agent.toLowerCase();
  const n = reviewerName.toLowerCase();
  if (a === n) return true;
  // "koala-review-concept" / "review-concept" / "some-concept" — use boundary matching
  return a.endsWith(`-${n}`) || a.endsWith(`:${n}`) || a.includes(`-${n}-`) || a.includes(`-${n}:`);
}

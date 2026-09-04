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
import { AGENT_DISPATCH_REGISTRY, resolveAgentDispatchType } from './agent-dispatch-registry.js';
import { agentRoleIdsEqual, canonicalAgentRoleId } from './agent-role-identity.js';

export type Channel = 'quick' | 'normal';

export interface OptInReviewer {
  /** reviewer short name, e.g. concept / quality / behavior / docs / channel */
  name: string;
  /** why this reviewer is enabled (baseline / riskSignal / touchpoint / channel / forced) */
  reason: string;
  /** whether force-mounted via --force-reviewer */
  forced?: boolean;
}

/**
 * Resolve reviewer identities through the dispatch registry.  The short-name
 * table is only an input compatibility surface; reviewer authority comes from
 * the explicit registry reviewerLane field, never from a prefix lookalike.
 */
const REVIEWER_SHORT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  behavior: 'proof-or-stop-review-behavior',
  channel: 'proof-or-stop-review-channel',
  concept: 'proof-or-stop-review-concept',
  delivery: 'proof-or-stop-review-delivery',
  docs: 'proof-or-stop-review-docs',
  quality: 'proof-or-stop-review-quality',
  'scope-plan': 'proof-or-stop-review-scope-plan',
  'story-init': 'proof-or-stop-review-story-init',
  'test-coverage': 'proof-or-stop-review-test-coverage',
  'topology-critic': 'proof-or-stop-review-topology-critic',
});

function reviewerEntryFor(value: string) {
  const raw = value.trim();
  if (!raw) return undefined;
  const canonical = canonicalAgentRoleId(raw).split('@', 1)[0];
  const shortName = REVIEWER_SHORT_NAMES[raw.toLowerCase()]
    ?? REVIEWER_SHORT_NAMES[canonical.toLowerCase()];
  const candidates = [raw, canonical, shortName].filter((candidate): candidate is string => !!candidate);
  return AGENT_DISPATCH_REGISTRY.find((entry) => {
    if (!entry.reviewerLane) return false;
    const accepted = [entry.canonicalName, entry.reviewerLane, ...entry.aliases];
    return candidates.some((candidate) => accepted.includes(candidate));
  });
}

/** Canonical registered lane for new output; unknown lookalikes return null. */
export function canonicalReviewerLane(value: string): string | null {
  return reviewerEntryFor(value)?.reviewerLane ?? null;
}

/** Canonical dispatch type for a registry-accepted role. */
export function canonicalAgentDispatchType(value?: string): string {
  return resolveAgentDispatchType(value).canonicalType;
}

/** Canonical and historical registered forms for read-side lookup. */
export function reviewerRoleReadIds(value: string): readonly string[] {
  const canonical = canonicalReviewerLane(value);
  if (!canonical) return [value.trim()];
  const entry = reviewerEntryFor(canonical);
  return Object.freeze([
    canonical,
    ...(entry?.aliases ?? []),
  ]);
}

/** Match only registered reviewer identities; arbitrary prefix matches fail. */
export function reviewerIdentitiesEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftLane = canonicalReviewerLane(left);
  const rightLane = canonicalReviewerLane(right);
  if (!leftLane || !rightLane) return false;
  return agentRoleIdsEqual(leftLane, rightLane);
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
 * An agent like "proof-or-stop-review-concept" matches name="concept".
 * Supports the bare "concept" name and any form of <prefix>-concept / <prefix>:concept.
 */
export function findingAgentMatchesReviewer(agent: string | undefined, reviewerName: string): boolean {
  if (!agent) return false;
  const a = agent.toLowerCase();
  const n = reviewerName.toLowerCase();
  if (a === n) return true;
  // "proof-or-stop-review-concept" / "review-concept" / "some-concept" — use boundary matching
  return a.endsWith(`-${n}`) || a.endsWith(`:${n}`) || a.includes(`-${n}-`) || a.includes(`-${n}:`);
}

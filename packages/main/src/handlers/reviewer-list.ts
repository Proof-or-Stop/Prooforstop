/**
 * B-fdcf CHK-001: lattice reviewer_list CLI
 *
 * Output the opt-in reviewer roster for the current story (computed in real time based on 5 conditions):
 *   - concept  / quality / test-coverage → baseline (always on)
 *   - behavior             → story.riskSignals hits {state machine / guard / gate}
 *   - docs                 → understanding.touchpoints contains .md files (fallback scans git diff)
 *   - channel LLM reviewer is retired; normal-channel is taken over by the validate --channel CLI gate
 *
 * Design notes (decision.json A1):
 *   - Pure function computeActiveReviewers shared by canPassReview (CHK-002) / reviewer echo output of the story_advance REVIEW command
 *   - When multiple riskSignals hit the behavior trigger set, reason is flattened into a single string
 *     ("riskSignal: gate, guard" rather than multiple entries)
 *   - forceReviewer takes a comma-separated string, restricted to lanes supported by review_run_start; writes StoryEvent.action='reviewer_forced' for audit
 *   - Computed in real time on every call, not cached (preMortem 1: state changes take effect immediately)
 *
 * Reuses workflow-policy.computeChannel (three tiers express/fast/normal), not
 * the old reviewer-opt-in.resolveChannel (two tiers quick/normal, normal once items>2,
 * inconsistent with the three-tier model; see B-fdcf background option A).
 *
 * @task B-ef9c
 * @checklist CHK-001
 * @title reviewers are triggered by workflow policy
 * @type feature
 * @priority high
 * @description
 *   Superpowers and reviewers can trigger workflow participation, but they do
 *   not define the workflow themselves: the baseline reviewers, risk-triggered
 *   behavior reviewer, and docs reviewer are computed
 *   from shared workflow policy and story artifacts.
 * @changes
 *   - [CHK-001] Keep reviewer opt-in as policy-driven trigger logic
 *   - [CHK-001] Fold old test-coverage review responsibility into REVIEW
 */

import type { HandlerContext } from './context.js';
import type { StoryInfo, ChecklistData, DecisionData, StoryEvent } from '../core/types.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';
import { REVIEW_RUN_LANES, isReviewRunLane } from '../core/review-run.js';

export interface ActiveReviewer {
  /** reviewer short name: concept / quality / test-coverage / behavior / docs / channel */
  name: string;
  /** why enabled: baseline / "riskSignal: <cats>" / "touchpoints .md" / forced */
  reason: string;
  /** whether forcibly attached via forceReviewer */
  forced?: boolean;
}

/** Keyword set that triggers the behavior reviewer when matched by riskSignal.category */
const BEHAVIOR_TRIGGERS = ['state machine', 'guard', 'gate'];

/**
 * Fixed output order (B-fdcf F-002): baseline-first concept → quality → test-coverage → behavior → docs → channel.
 * The order declared in CHK-001 userSees matches this and must not be changed to alphabetical. Forced names and any
 * Other supported reviewer names are appended at the end (in insertion order).
 */
const REVIEWER_ORDER: readonly string[] = ['concept', 'quality', 'test-coverage', 'behavior', 'docs', 'channel'];

function reviewerLaneShortName(lane: string): string {
  return lane.replace(/^lattice-review-/, '');
}

function supportedForceReviewerNames(): string {
  return REVIEW_RUN_LANES
    .map((lane) => `${reviewerLaneShortName(lane)} (${lane})`)
    .join(', ');
}

export function normalizeForceReviewerName(value: string): string {
  const raw = String(value).trim();
  if (!raw) return '';
  if (isReviewRunLane(raw)) return reviewerLaneShortName(raw);
  const lane = `lattice-review-${raw}`;
  if (isReviewRunLane(lane)) return raw;
  throw new Error(
    `reviewer_list: forceReviewer "${raw}" is not supported by review_run_start. Supported reviewers: ${supportedForceReviewerNames()}`,
  );
}

export function parseForceReviewers(forceReviewer?: string): string[] | undefined {
  if (!forceReviewer) return undefined;
  const forced = forceReviewer
    .split(',')
    .map(normalizeForceReviewerName)
    .filter(Boolean);
  return forced.length > 0 ? Array.from(new Set(forced)) : undefined;
}

/**
 * Pure function: computes the list of reviewers to enable based on story + checklist + decision.
 *
 * Return order: sorted alphabetically by name (stable, convenient for assertions / text rendering).
 * A forced reviewer with the same name overrides the auto-computed entry, marked forced=true.
 *
 * @param story       must at least contain riskSignals; reuses the StoryInfo type
 * @param checklist   must at least contain the items array ({ items: Array<unknown> } suffices)
 * @param decision    optional decision.json content (affects computeChannel decision)
 * @param touchpoints optional touchpoints list (defaults to reading story's understanding.json)
 * @param forced      optional list of reviewer names to force-mount (comma-separated string already parsed)
 */
export function computeActiveReviewers(
  story: Pick<StoryInfo, 'riskSignals'> & Partial<Pick<StoryInfo, 'riskSignalsDismissed'>>,
  checklist: Pick<ChecklistData, 'items'> | { items: Array<unknown> },
  decision?: Pick<DecisionData, 'options' | 'chosen'> | null,
  touchpoints?: string[],
  forced?: string[],
): ActiveReviewer[] {
  const map = new Map<string, ActiveReviewer>();

  // BASELINE: concept + quality + test-coverage are always enabled.
  // test-coverage is the old TEST_CASE_REVIEW responsibility folded into REVIEW:
  // it checks verificationIntent -> verificationEvidence coverage instead of owning a lifecycle phase.
  map.set('concept', { name: 'concept', reason: 'baseline' });
  map.set('quality', { name: 'quality', reason: 'baseline' });
  map.set('test-coverage', { name: 'test-coverage', reason: 'baseline' });

  // behavior: riskSignals ∩ {state machine, guard, gate} is non-empty
  // Flatten all matched categories (matching both gate+guard → "riskSignal: gate, guard")
  const dismissed = new Set((story.riskSignalsDismissed || []).map(d => d.category));
  const activeCategories = (story.riskSignals || [])
    .map(r => r.category)
    .filter(c => !dismissed.has(c));
  const hitTriggers = BEHAVIOR_TRIGGERS.filter(t => activeCategories.includes(t));
  if (hitTriggers.length > 0) {
    map.set('behavior', {
      name: 'behavior',
      reason: `riskSignal: ${hitTriggers.join(', ')}`,
    });
  }

  // docs: touchpoints contain .md files
  if (touchpoints && touchpoints.some(t => typeof t === 'string' && t.endsWith('.md'))) {
    map.set('docs', { name: 'docs', reason: 'touchpoints .md' });
  }

  // channel LLM reviewer has been retired; normal-channel mechanical constraints are handled by the
  // `lattice validate --channel --story=<id>` preflight in REVIEW→TEST.

  // forced override: command-line --forceReviewer=a,b,c explicitly mounts (input already constrained to lanes supported by review_run_start)
  // Auto reviewers with the same name will be overridden to reason='forced' + forced=true
  if (forced && forced.length > 0) {
    for (const f of forced) {
      const name = String(f).trim();
      if (!name) continue;
      map.set(name, { name, reason: 'forced', forced: true });
    }
  }

  // F-002: fixed baseline-first order rather than alphabetical. Supported forced names that are not auto-enabled are appended at the end.
  const ordered: ActiveReviewer[] = [];
  const seen = new Set<string>();
  for (const name of REVIEWER_ORDER) {
    const entry = map.get(name);
    if (entry) {
      ordered.push(entry);
      seen.add(name);
    }
  }
  for (const [name, entry] of map) {
    if (!seen.has(name)) ordered.push(entry);
  }
  return ordered;
}

/** Text output single-line format: `Active reviewers: concept, quality, behavior (riskSignal: gate)` */
export function renderActiveReviewersText(reviewers: ActiveReviewer[]): string {
  const parts = reviewers.map(r =>
    r.reason === 'baseline' ? r.name : `${r.name} (${r.reason})`,
  );
  return `Active reviewers: ${parts.join(', ')}`;
}

/** handler factory — keeps a structure consistent with other handlers */
export function createReviewerListHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    reviewer_list(args: { storyId: string; json?: boolean; forceReviewer?: string }): string {
      const story = store.readStory(args.storyId);

      // checklist — treat as empty items when missing (computeChannel handles as express)
      let checklist: { items: unknown[] } = { items: [] };
      try {
        checklist = store.readChecklist(args.storyId);
      } catch {
        /* no checklist yet — items.length = 0 → express */
      }

      // F-005: defensive fallback — store.readDecision currently returns null on file-not-exists,
      // but if validation tightens / JSON corruption throws in the future, don't bubble the exception to CLI.
      // computeChannel has a fall-through path for undefined decision.
      let decision = null;
      try {
        decision = store.readDecision(args.storyId);
      } catch {
        decision = null;
      }

      // touchpoints: understanding.touchpoints takes priority; otherwise fall back to scanning .md changes in git diff
      const understanding = store.readUnderstanding(args.storyId);
      const touchpoints = understanding?.touchpoints
        ?? detectMdTouchpointsFromGit(ctx.root);

      // forceReviewer parsing: comma-separated → strip empties → normalize to reviewer short names; reject lanes not supported by review_run_start.
      const forced = parseForceReviewers(args.forceReviewer);

      const reviewers = computeActiveReviewers(
        story,
        checklist,
        decision,
        touchpoints,
        forced,
      );

      // Audit: each forceReviewer call writes one reviewer_forced event, names[] expresses the full set added this time
      if (forced && forced.length > 0) {
        if (!story.events) story.events = [];
        const timestamp = new Date().toISOString();
        const agent = process.env.LATTICE_AGENT || 'main';
        // One event per forced name (compatible with StoryEvent.reviewer single-value field + convenient for querying by reviewer)
        for (const name of forced) {
          const event: StoryEvent = {
            phase: story.phase,
            action: 'reviewer_forced',
            timestamp,
            reviewer: name,
            reason: 'manual',
            agent,
          };
          story.events.push(event);
        }
        store.writeStory(args.storyId, story);
      }

      if (args.json) {
        return JSON.stringify({
          reviewers: reviewers.map(r => ({
            name: r.name,
            reason: r.reason,
            ...(r.forced ? { forced: true } : {}),
          })),
        });
      }

      return renderActiveReviewersText(reviewers);
    },
  };
}

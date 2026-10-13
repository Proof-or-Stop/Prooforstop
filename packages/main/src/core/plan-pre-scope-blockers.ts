/**
 * Run 19 (P1, bench-staging/oldpos/run19-cost-analysis.md §2): the
 * deterministic PLAN blockers `next` surfaces BEFORE it launches the
 * scope-plan reviewer.
 *
 * The scope-plan reviewer judges the checklist (title, userSees, excludes,
 * verificationIntent). In run 19 `next` launched it while intents were still
 * missing; the owner then added exactly those intents, the checklist digest
 * changed, the verdict went stale and the reviewer had to run again (≈3 min,
 * 0.58M tokens). Everything here is computed without a model and is what
 * story_review would report anyway, so authoring it first loses no review: the
 * reviewer still runs, once, on the final checklist.
 *
 * Per item (withdrawn items skipped):
 *   - missing verificationIntent lanes: story_review `missing_verification_intent`,
 *     the same requiresFullVerificationIntent predicate;
 *   - unpinned executable must/should intents: story_review
 *     `missing_verification_pin` (unpinnedPlanIntents);
 *   - missing userSees (shorter than 10 characters, story_review's
 *     `missing_user_sees` threshold): the reviewer traces request literals to
 *     userSees, and userSees is editable in PLAN.
 *   - examples whose expected value request.md does not quote and that carry
 *     no valid derivation (D4, old-PoS run 23; story_review
 *     `missing_intent_derivation`, core/intent-derivation.ts).
 * Story-wide: request literals (the story_create pre-check,
 * unmappedStoryRequestLiterals) that no title / userSees / verificationIntent
 * states and no PLAN excludes entry names; coverage-matrix rows the request
 * patterns demand that no intent states (core/plan-coverage-matrix.ts, story_review
 * `missing_coverage_row`), each with the item its placeholder goes to.
 */
import type { StoryStore } from './store.js';
import type { ChecklistItem, StoryInfo, VerificationLane, WorkflowPolicy } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { computeChannel } from './workflow-policy.js';
import { unpinnedPlanIntents } from './plan-verification-pins.js';
import { isHighRiskStory } from './plan-scope-check-requirement.js';
import { readStoryRequest, unmappedStoryRequestLiterals } from './story-request.js';
import { closestRequestSentence, describeDerivationProblem, intentDerivationRows } from './intent-derivation.js';
import { planCoverageGapsFor, type CoverageGap } from './plan-coverage-matrix.js';
import { loadConfig } from './config.js';

/** story_review's rule: normal channel, high risk or strict profile need happy/edge/adversarial on every item. */
export function requiresFullVerificationIntent(args: { isHighRisk: boolean; channel: string; profile: string }): boolean {
  return args.isHighRisk || args.channel === 'normal' || args.profile === 'strict';
}

/** story_review's missing_user_sees threshold. */
export function userSeesMissing(item: Pick<ChecklistItem, 'userSees'>): boolean {
  return !item.userSees || item.userSees.trim().length < 10;
}

export interface PreScopeItemBlockers {
  itemId: string;
  missingLanes: VerificationLane[];
  /** Executable must/should intents without a pin (lane/index locate the row). */
  unpinned: Array<{ ref: string; lane: VerificationLane; index: number }>;
  missingUserSees: boolean;
  /** D4: example rows without a valid derivation (lane/index locate the row). */
  missingDerivations: Array<{ ref: string; lane: VerificationLane; index: number; unquoted: string[]; problem: string; suggestedQuote?: string }>;
}

export interface PreScopeBlockers {
  items: PreScopeItemBlockers[];
  unmappedLiterals: string[];
  /** Coverage-matrix rows the request patterns demand and no intent states. */
  coverageGaps: CoverageGap[];
}

export function planPreScopeBlockers(
  store: Pick<StoryStore, 'readChecklist' | 'readDecision' | 'storyFilePath'>,
  story: StoryInfo,
  policy: Pick<WorkflowPolicy, 'profile'>,
): PreScopeBlockers {
  const checklist = store.readChecklist(story.storyId);
  const items = checklist.items.filter(item => item.status !== 'withdrawn');
  const requireFull = requiresFullVerificationIntent({
    isHighRisk: isHighRiskStory(story),
    channel: computeChannel(story, checklist, store.readDecision(story.storyId) ?? undefined),
    profile: policy.profile,
  });
  const request = readStoryRequest(store as StoryStore, story.storyId);
  const rows = items.map(item => ({
    itemId: item.id,
    missingLanes: requireFull ? VERIFICATION_LANES.filter(lane => (item.verificationIntent?.[lane] ?? []).length === 0) : [],
    unpinned: unpinnedPlanIntents(item).map(row => ({ ref: row.ref, lane: row.lane, index: row.index })),
    missingUserSees: userSeesMissing(item),
    missingDerivations: request.status === 'ok'
      ? intentDerivationRows(item.id, item.verificationIntent, request.text).filter(row => row.problem !== null)
        .map(row => ({ ref: row.ref, lane: row.lane, index: row.index, unquoted: row.unquoted, problem: describeDerivationProblem(row, request.text),
          ...(closestRequestSentence(row.desc, request.text) ? { suggestedQuote: closestRequestSentence(row.desc, request.text)! } : {}) }))
      : [],
  })).filter(row => row.missingLanes.length || row.unpinned.length || row.missingUserSees || row.missingDerivations.length);
  const unmappedLiterals = request.status === 'ok' ? unmappedStoryRequestLiterals(request.text, items, { countExcludes: true }) : [];
  // Old-PoS run 33: plan.coverageMatrix (default off: exact-text rows only).
  const coverageGaps = request.status === 'ok' ? planCoverageGapsFor(coverageConfig(store as StoryStore), items, request.text) : [];
  return { items: rows, unmappedLiterals, coverageGaps };
}

export function hasPreScopeBlockers(blockers: PreScopeBlockers): boolean {
  return blockers.items.length > 0 || blockers.unmappedLiterals.length > 0 || blockers.coverageGaps.length > 0;
}

/** The project config the coverage switch is read from (an unreadable config keeps production: exact-text rows only). */
function coverageConfig(store: StoryStore): unknown {
  try { return loadConfig(store.projectRoot); } catch { return {}; }
}

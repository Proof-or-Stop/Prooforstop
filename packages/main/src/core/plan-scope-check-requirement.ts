/**
 * When PLAN→DEV requires the signed scope-plan reviewer verdict (scope-check.json).
 *
 * The scope-plan reviewer traces every sentence and example of the stored
 * request (request.md) and of the Story artifacts to checklist intents. Before
 * run 16 the requirement fired only when an understanding snapshot existed, and
 * `understanding_set` is advisory, so an owner who skipped understanding also
 * skipped the reviewer although the balanced policy declares
 * `plan.requireUnderstanding: 'always'` (run 16 reached DEV without it).
 *
 * The reviewer does not need the understanding snapshot (its prompt reads it
 * only when present), so the requirement no longer depends on it. Required
 * when the checklist has items and any of:
 *   - an understanding snapshot exists (the original trigger, any profile);
 *   - the policy says `requireUnderstanding: 'always'` (balanced, strict);
 *   - the policy says `'high_risk'` and the Story is high risk;
 *   - a verbatim request (request.md) exists and the policy is not `'never'`.
 * light (`'never'`) and the express channel (INIT_CHECK→DEV, no PLAN) are
 * unchanged.
 *
 * One predicate for story_review (`missing_scope_check` blocker), the
 * DEV-entry gate (`[missing_scope_check]` with one `Next:` line) and `next`
 * (the managed reviewer launch step), so the three cannot drift.
 */
import { existsSync } from 'node:fs';
import type { StoryStore } from './store.js';
import type { StoryInfo, WorkflowPolicy } from './types.js';
import { STORY_REQUEST_FILE } from './story-request.js';
import { renderQualifiedManagedCodexDispatchCommand } from './reviewer-launch-guidance.js';

export const SCOPE_PLAN_REVIEWER = 'proof-or-stop-review-scope-plan';

type RequirementStore = Pick<StoryStore, 'readChecklist' | 'readUnderstanding' | 'readScopeCheck' | 'storyFilePath'>;

/** story_review's high-risk test: high/critical priority or an undismissed risk signal. */
export function isHighRiskStory(story: Pick<StoryInfo, 'priority' | 'riskSignals' | 'riskSignalsDismissed'>): boolean {
  const dismissed = new Set((story.riskSignalsDismissed ?? []).map(entry => entry.category));
  const active = (story.riskSignals ?? []).filter(signal => !dismissed.has(signal.category));
  return story.priority === 'high' || story.priority === 'critical' || active.length > 0;
}

/** Why the scope-plan verdict is required for this Story, or null when it is not. */
export function planScopeCheckRequirement(
  store: RequirementStore,
  story: Pick<StoryInfo, 'storyId' | 'priority' | 'riskSignals' | 'riskSignalsDismissed'>,
  policy: Pick<WorkflowPolicy, 'profile' | 'plan'>,
): string | null {
  const storyId = story.storyId;
  if (store.readChecklist(storyId).items.length === 0) return null;
  const mode = policy.plan.requireUnderstanding;
  if (store.readUnderstanding(storyId)) return 'an understanding snapshot exists';
  if (mode === 'always') return `the ${policy.profile} policy declares plan.requireUnderstanding 'always'`;
  if (mode === 'high_risk' && isHighRiskStory(story)) return `the ${policy.profile} policy declares plan.requireUnderstanding 'high_risk' and the Story is high risk`;
  if (mode !== 'never' && existsSync(store.storyFilePath(storyId, STORY_REQUEST_FILE))) return 'the Story has a verbatim request (request.md)';
  return null;
}

/**
 * The DEV-entry refusal when the verdict is required and absent, else null.
 * Its last line is the one next action: the managed scope-plan reviewer launch.
 */
export function missingPlanScopeCheckFailure(
  store: RequirementStore,
  story: Pick<StoryInfo, 'storyId' | 'priority' | 'riskSignals' | 'riskSignalsDismissed'>,
  policy: Pick<WorkflowPolicy, 'profile' | 'plan'>,
): string | null {
  const reason = planScopeCheckRequirement(store, story, policy);
  if (!reason || store.readScopeCheck(story.storyId)) return null;
  return `Cannot enter DEV: the PLAN scope-plan reviewer verdict (scope-check.json) is missing [missing_scope_check]; it is required because ${reason}. `
    + 'The reviewer traces every sentence and example of the request and Story artifacts to checklist intents and finishes with scope_check_save; '
    + 'the owner must not self-sign it.\n'
    + `Next: ${renderQualifiedManagedCodexDispatchCommand(story.storyId, SCOPE_PLAN_REVIEWER)}`;
}

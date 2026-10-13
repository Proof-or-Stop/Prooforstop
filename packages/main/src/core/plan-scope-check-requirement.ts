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
import { checklistChangeIsExcludesOnly, contradictedExclusions, exclusionRationaleCheckActive, excludesProofGap } from './scope-exclusion-rationale.js';
import { openScopeGaps } from './pin-audit-correction.js';
import { existsSync } from 'node:fs';
import type { StoryStore } from './store.js';
import type { ChecklistData, ScopeCheckData, StoryInfo, WorkflowPolicy } from './types.js';
import { scopeReviewChecklistDigest } from './scope-check-integrity.js';
import { STORY_REQUEST_FILE } from './story-request.js';
import { renderQualifiedManagedCodexDispatchCommand } from './reviewer-launch-guidance.js';

export const SCOPE_PLAN_REVIEWER = 'proof-or-stop-review-scope-plan';

/**
 * N8 deferral decision for a missing scope-plan verdict (computed by
 * core/scope-plan-deferral.ts `scopeVerdictDeferral`; since old-PoS run 33 N8
 * is the A/B switch plan.scopeDeferral, default off, under which a live run
 * always yields `held`):
 *   - none: no live managed scope-plan run launched in PLAN;
 *   - deferred: such a run is live and some open item is free, so DEV may start
 *     beside it (the verdict gates DEV→REVIEW); `heldItemIds` (old-PoS run 27)
 *     are the items its pin audit / same-semantics rule concerns, which are not
 *     implemented until the verdict lands (`heldReason`);
 *   - held: such a run is live and every open item is held; DEV entry waits for
 *     its verdict (`reason`).
 */
export type ScopeVerdictDeferral =
  | { kind: 'none' }
  | { kind: 'deferred'; run: { runId: string; state: string }; heldItemIds?: string[]; heldReason?: string }
  | { kind: 'held'; run: { runId: string; state: string }; reason: string };

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
  /**
   * N8 (core/scope-plan-deferral.ts `scopeVerdictDeferral`, the one predicate
   * DEV entry, story_review and `next` share): under plan.scopeDeferral=on a
   * live managed scope-plan run launched in PLAN defers the missing verdict to
   * DEV→REVIEW, unless the reviewer has a pin audit / same-semantics check to
   * do; held (the default since old-PoS run 33): DEV entry waits for that
   * run's verdict.
   */
  scopeDeferral: () => ScopeVerdictDeferral = () => ({ kind: 'none' }),
): string | null {
  const reason = planScopeCheckRequirement(store, story, policy);
  if (!reason || store.readScopeCheck(story.storyId)) return null;
  const deferral = scopeDeferral();
  if (deferral.kind === 'deferred') return null;
  if (deferral.kind === 'held') {
    return `Cannot enter DEV: the PLAN scope-plan reviewer verdict (scope-check.json) is missing [missing_scope_check]; it is required because ${reason}. `
      + `Managed scope-plan run ${deferral.run.runId} (launched in PLAN) is ${deferral.run.state}, but its verdict is not deferred to DEV→REVIEW: ${deferral.reason}. DEV entry waits for that verdict.\n`
      + `Next: proof-or-stop host_run_status --runId=${deferral.run.runId} --untilTerminal=true`;
  }
  return `Cannot enter DEV: the PLAN scope-plan reviewer verdict (scope-check.json) is missing [missing_scope_check]; it is required because ${reason}. `
    + 'The reviewer traces every sentence and example of the request and Story artifacts to checklist intents and finishes with scope_check_save; '
    + 'the owner must not self-sign it.\n'
    + `Next: ${renderQualifiedManagedCodexDispatchCommand(story.storyId, SCOPE_PLAN_REVIEWER)}`;
}

/**
 * Whether the checklist the scope-plan reviewer judged differs from the current
 * one (scope-check.json checklistDigest). A verdict without the digest (older
 * records) is never treated as changed.
 */
export function scopeVerdictChecklistChanged(scope: Pick<ScopeCheckData, 'checklistDigest'>, checklist: Pick<ChecklistData, 'items'>): boolean {
  return !!scope.checklistDigest && scope.checklistDigest !== scopeReviewChecklistDigest(checklist);
}

/**
 * Run 19 (P2): why the existing scope-plan verdict must be rerun, or null.
 * Exactly the story_review blockers whose only remedy is a reviewer rerun:
 *   - gaps open and the checklist changed since the verdict (scope_gap,
 *     "rerun the scope-plan reviewer so it judges the current checklist");
 *   - the verdict's reviewRound is not the current review round (scope_check_stale).
 * A verdict with gaps on an unchanged checklist is not stale: the owner covers
 * or excludes the gaps first, and the checklist change then makes it stale.
 */
export function scopePlanRerunReason(
  store: Pick<StoryStore, 'readChecklist' | 'readScopeCheck'>,
  story: Pick<StoryInfo, 'storyId' | 'currentReviewRound'>,
  root?: string,
): string | null {
  const scope = store.readScopeCheck(story.storyId);
  if (!scope) return null;
  // Old-PoS run 31 (D8): pin-audit gaps whose requested values are the only change are checked deterministically.
  const gaps = openScopeGaps(scope, store.readChecklist(story.storyId)).length;
  if (gaps > 0 && scopeVerdictChecklistChanged(scope, store.readChecklist(story.storyId))) {
    // Old-PoS runs 61 / 63 (core/scope-exclusion-rationale.ts): only `excludes` changed and every open gap is one an
    // excludes entry cannot close (precedent conflict, or a behaviour an item changes): the reviewer would judge the
    // same content and re-raise the same rows (3-6 identical rounds). story_review keeps the covering-row Next; the
    // checks below (contradicted exclusions, review round) still apply.
    const checklist = store.readChecklist(story.storyId);
    const excludesProof = Boolean(root) && checklistChangeIsExcludesOnly(scope, checklist)
      && openScopeGaps(scope, checklist).every(gap => excludesProofGap(root!, gap.feature ?? '', checklist.items));
    if (!excludesProof) return `the verdict of ${scope.checkedAt} lists ${gaps} gap(s) and the checklist changed since that verdict`;
  }
  // Old-PoS run 43 (core/scope-exclusion-rationale.ts): an exclusion story_review rejects is judged again once the checklist changed.
  if (root && exclusionRationaleCheckActive(root) && scopeVerdictChecklistChanged(scope, store.readChecklist(story.storyId))) {
    const contradicted = contradictedExclusions(scope, store.readChecklist(story.storyId)).length;
    if (contradicted > 0) return `the verdict of ${scope.checkedAt} closes ${contradicted} row(s) with an excludes rationale another item contradicts and the checklist changed since that verdict`;
  }
  if (story.currentReviewRound && scope.reviewRound !== story.currentReviewRound) {
    return `the verdict's reviewRound (${scope.reviewRound || 'none'}) is not the current review round (${story.currentReviewRound})`;
  }
  return null;
}

/**
 * Whether `next --run` may launch the scope-plan reviewer itself (a framework
 * step), by the rule every managed launch follows: the selection is bound
 * (this Story's own host/model/effort) and no earlier run of the target
 * exists. Run 19 (P2) adds one case: a stale verdict whose last run completed
 * and delivered that verdict (deliveryRunId, or the verdict saved after the run
 * started), so the relaunch is mechanical. A last run that failed, or that
 * completed without delivering the current verdict, stays the agent's call (no
 * relaunch loop).
 */
export function scopePlanLaunchIsFramework(args: {
  bound: boolean;
  rerun: boolean;
  last?: { runId: string; state: string; createdAt: string };
  verdict?: Pick<ScopeCheckData, 'checkedAt' | 'deliveryRunId'> | null;
}): boolean {
  if (!args.bound) return false;
  if (!args.last) return true;
  if (!args.rerun || !args.verdict || args.last.state !== 'completed') return false;
  return args.verdict.deliveryRunId
    ? args.verdict.deliveryRunId === args.last.runId
    : Date.parse(args.last.createdAt) <= Date.parse(args.verdict.checkedAt);
}

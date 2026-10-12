/**
 * EXPERIMENTAL A/B switch `plan.reviewMerge` (default off; lab plan-light,
 * structural-cost-analysis.md §7 item 4; new PoS ADR-081 "a plan complete at
 * INIT is reviewed by one session for both plan questions", ADR-043 "one plan
 * review when the plan is complete; confirmation re-reviews", ADR-040 "only
 * unanswered questions block the plan").
 *
 * Old PoS reviews the plan in up to four serial sessions: two INIT reviewers
 * (story-init, product) on the INIT draft, then the PLAN scope-plan reviewer,
 * then a scope-plan rerun after every gap fix (run 40: 1.1 + 2.5 + 1.2 min on
 * the critical path; runs 22-57: 1-6 scope-plan runs). The INIT reviewers judge
 * a plan that PLAN still rewrites, and the rerun re-reads everything.
 *
 * With the switch on:
 *   - INIT: the two INIT reviewers are not launched. The INIT_CHECK gate admits
 *     the Story without init-check.json when the PLAN scope-plan verdict will
 *     be required for it (planScopeCheckRequirement); otherwise (no review
 *     would run at all) the INIT reviewers stay required.
 *   - PLAN: the ONE scope-plan session runs once the plan is complete (after
 *     the deterministic authoring batch, as before) and also answers the INIT
 *     questions (observable outcome, verifiable checks, existing-system facts).
 *     Only real gaps and unanswered questions block (ADR-040): wording and
 *     readability notes go to its final text, never into the verdict. The
 *     request trace, the pin audit, the exclusion-rationale check and every
 *     other scope-plan rule are unchanged (request coverage is kept).
 *   - Rerun: a confirmation re-review (core/scope-plan-rerun-context.ts): the
 *     previous verdict stands for the rows of unchanged items, which the
 *     reviewer copies; it re-judges only the flagged rows and the changed
 *     items. When the judged checklist cannot be reconstructed it falls back
 *     to a full review.
 *   - Evidence: the scope-plan prompt and scope-check.json carry the A/B
 *     evidence (`planReview: 'merged'`, abVariant).
 */
import { loadConfig } from './config.js';
import { abVariantEvidenceOf, reviewMergeOn, type AbVariantEvidence } from './ab-variants.js';
import { planScopeCheckRequirement } from './plan-scope-check-requirement.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import type { StoryStore } from './store.js';

/** Whether plan.reviewMerge is on in the project config (malformed or unreadable = off). */
export function planReviewMergeActive(root: string): boolean {
  try { return reviewMergeOn(loadConfig(root)); } catch { return false; }
}

/**
 * Why INIT_CHECK needs no INIT reviewer for this Story (the merged plan review
 * in PLAN replaces them), or null: switch off, or the PLAN verdict would not be
 * required (then the INIT reviewers stay the only plan review).
 */
export function initReviewDeferredToPlan(store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'readUnderstanding' | 'readScopeCheck' | 'storyFilePath'>, root: string, storyId: string): string | null {
  try {
    const config = loadConfig(root);
    if (!reviewMergeOn(config)) return null;
    const story = store.readStory(storyId);
    const requirement = planScopeCheckRequirement(store, story, resolveWorkflowPolicy(config, story));
    return requirement
      ? `the INIT review is deferred to the ONE merged plan review in PLAN (A/B switch plan.reviewMerge=on): the scope-plan verdict is required there because ${requirement}`
      : null;
  } catch {
    return null;
  }
}

/** scope-check.json fields of a merged plan review (outside the signature domain), or null when the switch is off. */
export function mergedPlanReviewRecord(root: string): { planReview: 'merged'; abVariant: AbVariantEvidence } | null {
  try {
    const config = loadConfig(root);
    if (!reviewMergeOn(config)) return null;
    return { planReview: 'merged', abVariant: abVariantEvidenceOf(config) ?? { schema: 'proof-or-stop.ab-variants.v1', flags: { 'plan.reviewMerge': 'on' } } };
  } catch {
    return null;
  }
}

/** The merged-review block of the scope-plan prompt ([] when the switch is off). */
export function mergedPlanReviewLines(root: string): string[] {
  const record = mergedPlanReviewRecord(root);
  if (!record) return [];
  return [
    `- Merged plan review (A/B arm ${JSON.stringify(record.abVariant.flags)}): no INIT reviewer ran on this Story; this ONE session also answers the INIT questions, on the complete plan:`,
    '  - Outcome: every checklist item states a concrete, observable user result, and its userSees + verificationIntent make success and failure distinguishable. An item whose result cannot be determined, or whose planned check cannot distinguish success, is a `gap` (source "init-review").',
    '  - Facts: verify each claim the description/background makes about the EXISTING system against the code; a false claim that changes what must be built is a `gap` (source "init-review"). Proposals for new behaviour are not verified.',
    '  - Blocking rule: only a real gap (a request behaviour no row covers, a pin the request or the base contradicts, an unverifiable outcome, a false existing-system claim that changes the plan) or a question the owner must answer before DEV blocks. Record an openQuestion only when the artifacts conflict and you cannot classify a promise without the owner\'s answer. Wording, readability, term definitions, title/priority style and test-exhaustiveness refinements are never gaps or questions: mention them in your final text only.',
  ];
}

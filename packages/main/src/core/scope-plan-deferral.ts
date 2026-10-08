/**
 * N8 (v4.1 cost plan): the PLAN scope-plan reviewer runs beside the first DEV
 * implementer instead of on the critical path.
 *
 * Before, PLAN→DEV waited 1.4-2.3 min for the scope-plan verdict
 * (scope-check.json) although nothing in DEV reads it: the verdict gates
 * whether the checklist covers the request, and its remedy (cover or exclude a
 * gap with checklist_update, rerun the reviewer) is PLAN work. Now:
 *
 *   - PLAN→DEV admits a MISSING verdict while a managed scope-plan run launched
 *     in PLAN is still live (`pendingScopePlanRun`) AND the reviewer has nothing
 *     to pin-audit; story_review reports it as the advisory `scope_check_pending`
 *     instead of the `missing_scope_check` blocker. Every other DEV-entry check
 *     is unchanged, and a verdict that exists keeps today's rules (gaps / stale
 *     verdicts still block DEV entry).
 *   - No deferral with something to audit (`scopeVerdictDeferralHold`): when the
 *     scope-plan prompt lists pin-audit rows (an intent pins an expected value the
 *     request does not quote) or the request has a same-semantics sentence, a
 *     `pin-audit` / `asymmetric-example` gap changes what DEV implements; arriving
 *     mid-DEV it would come after items were built against a wrong pin (old-PoS
 *     run 23). Then DEV entry keeps the old rule: it waits for the saved verdict.
 *   - `scopeVerdictDeferral` is the one predicate the DEV-entry guard
 *     (missingPlanScopeCheckFailure), story_review and `next` share.
 *   - That live run saves its verdict in DEV (scope_check_save accepts DEV only
 *     for the managed invocation of a run launched in PLAN).
 *   - DEV→REVIEW (`scopeVerdictReviewEntryFailure`) requires what story_review
 *     would have required before DEV: the verdict exists, its signature and
 *     managed delivery verify, and it lists no gap. A gap found after
 *     implementation started therefore blocks REVIEW; `next` sends the Story
 *     back to PLAN, where it is covered/excluded and the reviewer reruns.
 *
 * On the old path (verdict saved before the Story entered DEV from PLAN, so
 * story_review already proved it signed, delivered and gap-free) the
 * REVIEW-entry check does not apply: only a verdict that is missing or was
 * saved after that DEV entry is checked here.
 */
import { existsSync, readdirSync } from 'node:fs';
import type { StoryStore } from './store.js';
import type { StoryInfo, WorkflowPolicy } from './types.js';
import { managedHostRunsRoot, readManagedHostRunProjection, verifyManagedDispatchDelivery } from './managed-host-run.js';
import { planScopeCheckRequirement, SCOPE_PLAN_REVIEWER, type ScopeVerdictDeferral } from './plan-scope-check-requirement.js';
import { verifyScopeCheckContentSignature } from './scope-check-integrity.js';
import { readStoryRequest } from './story-request.js';
import { pinAuditRows, sameSemanticsSentences } from './intent-derivation.js';

export interface PendingScopePlanRun { runId: string; createdAt: string; state: string }

/** The live (non-terminal) managed scope-plan run of this Story that was launched in PLAN, or null. */
export function pendingScopePlanRun(root: string, storyId: string): PendingScopePlanRun | null {
  const dir = managedHostRunsRoot(root);
  if (!existsSync(dir)) return null;
  let latest: PendingScopePlanRun | null = null;
  for (const runId of readdirSync(dir)) {
    try {
      const run = readManagedHostRunProjection(root, runId);
      if (run.storyId !== storyId || run.agentType !== SCOPE_PLAN_REVIEWER || run.phase !== 'PLAN' || run.terminal !== null) continue;
      if (!latest || run.createdAt > latest.createdAt) latest = { runId, createdAt: run.createdAt, state: run.state };
    } catch { /* not a readable managed run */ }
  }
  return latest;
}

/**
 * The one N8 deferral predicate (DEV-entry guard, story_review, `next`): a
 * missing verdict whose live PLAN-launched run exists is deferred only when the
 * reviewer has nothing to pin-audit.
 */
export function scopeVerdictDeferral(
  store: Pick<StoryStore, 'readChecklist' | 'storyFilePath'>,
  root: string,
  storyId: string,
): ScopeVerdictDeferral {
  const run = pendingScopePlanRun(root, storyId);
  if (!run) return { kind: 'none' };
  const hold = scopeVerdictDeferralHold(store, storyId);
  return hold ? { kind: 'held', run, reason: hold } : { kind: 'deferred', run };
}

const clipSentence = (text: string): string => (text.length > 120 ? `${text.slice(0, 119)}…` : text);

/**
 * Why the scope-plan verdict must NOT be deferred past DEV entry, or null when
 * the reviewer has nothing to audit. The scope-plan prompt (story-dispatch.ts
 * appendScopePlanRequestTraceability) carries the pin audit of every intent row
 * pinning a value the request does not quote, and the same-semantics rule; a
 * `pin-audit` / `asymmetric-example` gap from either changes the expected value
 * DEV implements (old-PoS run 23), so it must land before DEV. Computed from the
 * current checklist and request, the same inputs the prompt is rendered from.
 * No readable request (absent / tampered): the prompt carries no pin audit.
 */
export function scopeVerdictDeferralHold(store: Pick<StoryStore, 'readChecklist' | 'storyFilePath'>, storyId: string): string | null {
  const request = readStoryRequest(store, storyId);
  if (request.status !== 'ok') return null;
  let items: Parameters<typeof pinAuditRows>[0];
  try { items = store.readChecklist(storyId).items; } catch { return null; }
  const rows = pinAuditRows(items, request.text);
  if (rows.length) {
    return `its pin audit recomputes ${rows.length} intent value(s) the request does not quote (${rows.slice(0, 3).map(row => row.ref).join(', ')}${rows.length > 3 ? ` +${rows.length - 3} more` : ''}), `
      + 'and a pin-audit gap found after DEV started would come after items were implemented against the pin (old-PoS run 23)';
  }
  const sentences = sameSemanticsSentences(request.text);
  if (sentences.length) {
    return `the request has a same-semantics sentence ("${clipSentence(sentences[0]!)}") the reviewer checks for an asymmetric example, `
      + 'and an asymmetric-example gap found after DEV started would come after items were implemented against the pins (old-PoS run 23)';
  }
  return null;
}

/** When the Story last entered DEV from PLAN (the first DEV event after the last PLAN event), or null. */
export function lastPlanToDevEntryAt(story: Pick<StoryInfo, 'events'>): string | null {
  const events = story.events ?? [];
  let lastPlan = -1;
  events.forEach((event, index) => { if (event.phase === 'PLAN') lastPlan = index; });
  if (lastPlan < 0) return null;
  return events.slice(lastPlan + 1).find(event => event.phase === 'DEV')?.timestamp ?? null;
}

/**
 * DEV→REVIEW: the scope-plan verdict a deferred PLAN→DEV did not yet have.
 * Null when no verdict is required or the verdict is present, verified and
 * gap-free. The message's last line is its one next action.
 */
export function scopeVerdictReviewEntryFailure(
  store: Pick<StoryStore, 'readChecklist' | 'readUnderstanding' | 'readScopeCheck' | 'storyFilePath'>,
  root: string,
  story: Pick<StoryInfo, 'storyId' | 'priority' | 'riskSignals' | 'riskSignalsDismissed' | 'events'>,
  policy: Pick<WorkflowPolicy, 'profile' | 'plan'>,
): string | null {
  const reason = planScopeCheckRequirement(store, story, policy);
  if (!reason) return null;
  const storyId = story.storyId;
  const scope = store.readScopeCheck(storyId);
  const devEntry = lastPlanToDevEntryAt(story);
  // Never entered DEV from PLAN (express channel): the PLAN verdict does not apply.
  if (!devEntry) return null;
  // Old path: a verdict saved before DEV entry was judged by story_review then.
  if (scope && Date.parse(scope.checkedAt) < Date.parse(devEntry)) return null;
  if (!scope) {
    const pending = pendingScopePlanRun(root, storyId);
    return pending
      ? `Cannot enter REVIEW: the scope-plan reviewer verdict is still pending [scope_check_pending]; managed scope-plan run ${pending.runId} (launched in PLAN) is ${pending.state}. `
        + 'REVIEW needs its verdict (required because ' + reason + ').\n'
        + `Next: proof-or-stop host_run_status --runId=${pending.runId} --untilTerminal=true`
      : `Cannot enter REVIEW: the scope-plan reviewer verdict (scope-check.json) is missing [missing_scope_check] and no scope-plan run is live; it is required because ${reason}.\n`
        + `Next: proof-or-stop story_advance '{"storyId":"${storyId}","phase":"PLAN"}' (then relaunch the scope-plan reviewer in PLAN)`;
  }
  const signed = scope.readManifest !== undefined ? verifyScopeCheckContentSignature(storyId, scope) : Boolean(scope._hash);
  if (!signed) {
    return 'Cannot enter REVIEW: scope-check.json signature verification failed [scope_check_tampered]; it must be written by the scope-plan reviewer via scope_check_save.\n'
      + `Next: proof-or-stop story_advance '{"storyId":"${storyId}","phase":"PLAN"}' (then rerun the scope-plan reviewer)`;
  }
  if (scope.deliveryRunId) {
    const delivery = verifyManagedDispatchDelivery({ root, runId: scope.deliveryRunId, storyId, agentType: SCOPE_PLAN_REVIEWER });
    if (!delivery.valid) {
      return `Cannot enter REVIEW: scope-check.json managed delivery receipt is invalid [scope_check_delivery_invalid]: ${delivery.reason}.\n`
        + `Next: proof-or-stop story_advance '{"storyId":"${storyId}","phase":"PLAN"}' (then rerun the scope-plan reviewer)`;
    }
  }
  const gaps = (scope.features ?? []).filter(feature => feature.status === 'gap');
  if (gaps.length > 0) {
    return `Cannot enter REVIEW: the scope-plan reviewer verdict of ${scope.checkedAt} lists ${gaps.length} gap(s) [scope_gap]: `
      + `${gaps.slice(0, 4).map(gap => `"${gap.feature}"`).join(', ')}${gaps.length > 4 ? ` +${gaps.length - 4} more` : ''}. `
      + 'Cover each in a checklist item or record a PLAN exclusion (item excludes naming it and why), rerun the scope-plan reviewer and story_review, then implement any new item.\n'
      + `Next: proof-or-stop story_advance '{"storyId":"${storyId}","phase":"PLAN"}'`;
  }
  return null;
}

/**
 * Old-PoS run 52: the framework's import-time closure of a recurring
 * pre-existing finding (see closeRecurringPreexistingFindings).
 */
import type { HandlerContext } from './context.js';
import { PREEXISTING_OUT_OF_SCOPE, RECURRING_PREEXISTING_REASON_PREFIX } from '../core/finding-preexisting.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { evaluateRecurringPreexistingFinding } from './finding-preexisting.js';
import { appendFindingLifecycleTransition, withMetaFindingLock } from './finding-lifecycle.js';

/** Process event of a finding the framework closed at import as a recurrence of a pre-existing disposition (old-PoS run 52). */
export const RECURRING_PREEXISTING_CLOSED_EVENT = 'finding_preexisting_recurrence_closed' as const;

/**
 * Old-PoS run 52 (bench-staging/oldpos/run52-analysis.md §4; run 48 cycle C):
 * close each just-imported OPEN verified finding that re-files a site an
 * earlier preexisting_out_of_scope disposition of this Story covers
 * (handlers/finding-preexisting.ts evaluateRecurringPreexistingFinding: the
 * candidate itself passes the disposition check, every disposition still holds
 * on the current material, every candidate site is one of theirs). The closure
 * is the same signed resolve transition a disposition writes (resolutionType
 * preexisting_out_of_scope, strong), its reason starts with
 * RECURRING_PREEXISTING_REASON_PREFIX naming the earlier disposition(s), then
 * the sites and the base evidence; no owner turn, no repair. A site the Story edited
 * or a new site stays open. Never called for an inventory critic's own
 * findings (the critic's block dispositions them in the same import).
 */
export function closeRecurringPreexistingFindings(ctx: HandlerContext, storyId: string, findingIds: readonly string[],
  context: { command: string; agent?: string; reviewRound?: string | null }): Array<{ findingId: string; of: string[]; sites: string[] }> {
  const closed: Array<{ findingId: string; of: string[]; sites: string[] }> = [];
  for (const findingId of findingIds) {
    const all = ctx.store.readFindings(storyId).findings ?? [];
    const finding = all.find(row => row.id === findingId);
    if (!finding || finding.status !== 'open' || (finding.evidenceState !== undefined && finding.evidenceState !== 'verified')) continue;
    const match = evaluateRecurringPreexistingFinding({ store: ctx.store, root: ctx.root, storyId, finding, findings: all });
    if (!match.recurring || !match.verdict?.presence || !match.verdict.coverage) continue;
    const presence = match.verdict.presence;
    const reason = `${RECURRING_PREEXISTING_REASON_PREFIX}${match.of.join(', ')}): every defect site (${match.sites.join(', ')}) `
      + `was already dispositioned ${PREEXISTING_OUT_OF_SCOPE} by ${match.of.join(', ')} and is still unchanged since the Story base ${presence.base.slice(0, 12)} `
      + `(reviewed head ${presence.head.slice(0, 12)}): ${presence.reason}. Outside this Story: ${match.verdict.coverage.reason}. `
      + `No owner turn, no repair. Severity unchanged. Follow-up: the one recorded for ${match.of.join(', ')}.`;
    const wrote = withMetaFindingLock(ctx, storyId, (fence) => {
      const data = ctx.store.readFindings(storyId);
      const row = data.findings.find(candidate => candidate.id === findingId);
      if (!row || row.status !== 'open') return false;
      const transition = appendFindingLifecycleTransition(ctx, storyId, row, fence, {
        toStatus: 'resolved', reason, resolutionType: 'preexisting_out_of_scope', resolveEvidenceStrength: 'strong',
      });
      row.status = transition.toStatus;
      row.resolvedAt = transition.at;
      if (transition.reason) row.resolvedReason = transition.reason;
      if (transition.resolutionType) row.resolutionType = transition.resolutionType;
      if (transition.resolveEvidenceStrength) row.resolveEvidenceStrength = transition.resolveEvidenceStrength;
      ctx.store.writeFindings(storyId, data);
      return true;
    });
    if (!wrote) continue;
    ctx.store.appendProcessEvent(storyId, { type: RECURRING_PREEXISTING_CLOSED_EVENT, storyId, command: context.command, role: 'framework',
      ...(context.agent ? { agent: context.agent } : {}), result: 'resolved', findingId, recurringPreexistingOf: match.of, sites: match.sites,
      reviewRound: context.reviewRound ?? null, base: presence.base, head: presence.head });
    closed.push({ findingId, of: match.of, sites: match.sites });
  }
  if (closed.length) {
    try {
      ctx.store.writeProcessMetrics(storyId, computeProcessMetrics(storyId, ctx.store, ctx.root));
    } catch (e) {
      console.warn(`[process-metrics] recompute failed for ${storyId}:`, (e as Error).message);
    }
  }
  return closed;
}


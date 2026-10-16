/**
 * Lab run110: the store-aware half of core/file-state-conflict.ts. Reads the Story's scope contract, scope boundary and
 * verbatim request, and returns the file-state verdict for one open finding (shared by next's framework step
 * `finding_file_state_settled`, finding_resolve disposition=file_state_conflict and the import-time closure, so the
 * three always agree). With remediation.fileStateSettle=off nothing is settled.
 */
import type { HandlerContext } from './context.js';
import type { StoryStore } from '../core/store.js';
import type { Finding } from '../core/types.js';
import { readStoryRequest } from '../core/story-request.js';
import { fileStateSettleOn } from '../core/ab-variants.js';
import { loadConfig } from '../core/config.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { FILE_STATE_CONFLICT, fileStateConflictOf, recordFileStateSettlement, type FileStateVerdict } from '../core/file-state-conflict.js';
import { appendFindingLifecycleTransition, withMetaFindingLock } from './finding-lifecycle.js';

/** Process event of a finding the framework closed at import as the losing side of a file-state conflict (lab run110). */
export const FILE_STATE_CLOSED_EVENT = 'finding_file_state_settled' as const;

/** The verdict for one finding, or null (switch off, no file-state demand the contract or the request decides). */
export function evaluateFileStateConflict(args: { store: StoryStore; root: string; storyId: string; finding: Finding; findings?: readonly Finding[] }): FileStateVerdict | null {
  const { store, root, storyId, finding } = args;
  try { if (!fileStateSettleOn(loadConfig(root))) return null; } catch { /* unreadable config: the production default (on) */ }
  let contract;
  try { contract = store.readScopeContract(storyId); } catch { return null; }
  if (!contract) return null;
  let boundaryExcluded: string[] = [];
  try { boundaryExcluded = store.readScopeBoundary(storyId)?.excluded ?? []; } catch { boundaryExcluded = []; }
  const request = readStoryRequest(store, storyId);
  let findings = args.findings;
  if (!findings) { try { findings = store.readFindings(storyId).findings ?? []; } catch { findings = []; } }
  return fileStateConflictOf({ finding, findings, contract, requestText: request.status === 'ok' ? request.text : null, boundaryExcluded });
}

/** The audited resolve reason (the verdict's reason plus the follow-up). */
export function fileStateSettlementReason(verdict: FileStateVerdict, followUp: string): string {
  return `${verdict.reason} Follow-up: ${followUp.trim() || (verdict.dir === 'unchanged' ? 'change these files in a separate Story whose scope admits them.' : 'none: the request asks for the change.')}`;
}

/**
 * Lab run110: close each just-imported OPEN verified finding that is the losing side of a file-state conflict
 * (evaluateFileStateConflict settle=true): the same signed resolve transition finding_resolve
 * disposition=file_state_conflict writes (resolutionType superseded, strong), no owner turn, no repair, no extra
 * round. Never called for an inventory critic's own findings.
 */
export function closeFileStateSettledFindings(ctx: HandlerContext, storyId: string, findingIds: readonly string[],
  context: { command: string; agent?: string; reviewRound?: string | null }): Array<{ findingId: string; files: string[] }> {
  const closed: Array<{ findingId: string; files: string[] }> = [];
  for (const findingId of findingIds) {
    const all = ctx.store.readFindings(storyId).findings ?? [];
    const finding = all.find(row => row.id === findingId);
    if (!finding || finding.status !== 'open' || (finding.evidenceState !== undefined && finding.evidenceState !== 'verified')) continue;
    const verdict = evaluateFileStateConflict({ store: ctx.store, root: ctx.root, storyId, finding, findings: all });
    if (!verdict?.settle) continue;
    const reason = fileStateSettlementReason(verdict, '');
    const wrote = withMetaFindingLock(ctx, storyId, (fence) => {
      const data = ctx.store.readFindings(storyId);
      const row = data.findings.find(candidate => candidate.id === findingId);
      if (!row || row.status !== 'open') return false;
      const transition = appendFindingLifecycleTransition(ctx, storyId, row, fence, {
        toStatus: 'resolved', reason, resolutionType: 'superseded', resolveEvidenceStrength: 'strong',
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
    recordFileStateSettlement(ctx.root, storyId, { files: verdict.files, dir: verdict.dir, winner: verdict.winner ?? 'scope_boundary', findingId, why: verdict.reason });
    ctx.store.appendProcessEvent(storyId, { type: FILE_STATE_CLOSED_EVENT, storyId, command: context.command, role: 'framework',
      ...(context.agent ? { agent: context.agent } : {}), result: 'resolved', findingId, files: verdict.files, dir: verdict.dir,
      winner: verdict.winner, disposition: FILE_STATE_CONFLICT, reviewRound: context.reviewRound ?? null });
    closed.push({ findingId, files: verdict.files });
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

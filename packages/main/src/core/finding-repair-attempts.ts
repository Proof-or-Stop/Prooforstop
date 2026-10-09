/**
 * Old-PoS run 30 (B-c201:F-005): two managed finding-repair runs ended without a
 * commit and next relaunched the same repair with the same prompt. The
 * relaunched repair prompt now quotes what the earlier completed runs bound to
 * the same finding reported, so the worker starts from that report (and next
 * replans after a second run without a commit, handlers/next-driver.ts).
 */
import { existsSync, readdirSync } from 'node:fs';
import { managedHostRunsRoot, readManagedHostRunBinding, readManagedHostRunProjection } from './managed-host-run.js';
import { managedRunFinalMessage } from './managed-run-final-message.js';

/** Characters kept from the end of each earlier report. */
export const EARLIER_REPAIR_REPORT_MAX_CHARS = 1200;
const FINDING_REPAIR_AGENT = 'proof-or-stop-finding-repair';

export interface EarlierRepairReport { runId: string; createdAt: string; report: string }

/** Completed managed finding-repair runs bound to `findingId` (single or grouped), oldest first, with their final report. */
export function earlierFindingRepairReports(root: string, storyId: string, findingId: string, limit = 2): EarlierRepairReport[] {
  const runsRoot = managedHostRunsRoot(root);
  if (!existsSync(runsRoot)) return [];
  const rows: EarlierRepairReport[] = [];
  for (const runId of readdirSync(runsRoot)) {
    try {
      const run = readManagedHostRunProjection(root, runId);
      if (run.storyId !== storyId || run.agentType !== FINDING_REPAIR_AGENT || run.state !== 'completed' || !run.terminal) continue;
      const target = readManagedHostRunBinding(root, runId).managedDispatchTarget as { findingId?: string; groupFindingIds?: string[] } | null | undefined;
      if (target?.findingId !== findingId && !(Array.isArray(target?.groupFindingIds) && target!.groupFindingIds.includes(findingId))) continue;
      const message = (managedRunFinalMessage(root, runId) ?? '(no final report retained)').trim();
      rows.push({ runId, createdAt: run.createdAt, report: message.length > EARLIER_REPAIR_REPORT_MAX_CHARS ? `...${message.slice(-EARLIER_REPAIR_REPORT_MAX_CHARS)}` : message });
    } catch { /* not a readable managed run */ }
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-limit);
}

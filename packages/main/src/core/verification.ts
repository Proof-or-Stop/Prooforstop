import type {
  ChecklistData,
  ChecklistItem,
  VerificationCoverageEntry,
  VerificationCoverageReport,
  VerificationEvidence,
  VerificationIntentItem,
  VerificationLane,
  VerificationPriority,
} from './types.js';

export const VERIFICATION_LANES: readonly VerificationLane[] = ['happy', 'edge', 'adversarial'];

export function intentRef(itemId: string, lane: VerificationLane, index: number, intent?: VerificationIntentItem): string {
  return intent?.id || `${itemId}:${lane}:${index}`;
}

export function collectVerificationIntents(item: ChecklistItem): Array<{
  ref: string;
  itemId: string;
  lane: VerificationLane;
  index: number;
  intent: VerificationIntentItem;
}> {
  const result: Array<{ ref: string; itemId: string; lane: VerificationLane; index: number; intent: VerificationIntentItem }> = [];
  const vi = item.verificationIntent;
  if (!vi) return result;
  for (const lane of VERIFICATION_LANES) {
    const entries = vi[lane] || [];
    entries.forEach((intent, index) => {
      result.push({ ref: intentRef(item.id, lane, index, intent), itemId: item.id, lane, index, intent });
    });
  }
  return result;
}

export function evidenceMatches(evidence: VerificationEvidence, ref: string): boolean {
  return evidence.intentRef === ref;
}

function pickEvidence(item: ChecklistItem, ref: string): VerificationEvidence | undefined {
  return (item.verificationEvidence || []).find(e => evidenceMatches(e, ref));
}

function headMatches(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function isRequired(priority: VerificationPriority): boolean {
  return priority === 'must';
}

export function buildVerificationCoverage(cl: ChecklistData, currentHead?: string): VerificationCoverageReport {
  const entries: VerificationCoverageEntry[] = [];
  for (const item of cl.items) {
    for (const collected of collectVerificationIntents(item)) {
      const priority = collected.intent.priority || 'must';
      const evidence = pickEvidence(item, collected.ref);
      let status: VerificationCoverageEntry['status'] = 'missing';
      if (evidence) {
        if (evidence.kind === 'waiver') status = 'waived';
        else if (evidence.result === 'fail') status = 'failed';
        else if (currentHead && evidence.headHash && !headMatches(evidence.headHash, currentHead)) status = 'stale';
        else status = 'covered';
      }
      entries.push({
        intentRef: collected.ref,
        itemId: item.id,
        lane: collected.lane,
        desc: collected.intent.desc,
        type: collected.intent.type,
        priority,
        status,
        ...(evidence ? { evidence } : {}),
      });
    }
  }
  const requiredEntries = entries.filter(e => isRequired(e.priority));
  const coveredStatuses = new Set(['covered', 'waived']);
  return {
    total: entries.length,
    required: requiredEntries.length,
    covered: entries.filter(e => coveredStatuses.has(e.status)).length,
    missingRequired: requiredEntries.filter(e => !coveredStatuses.has(e.status)).length,
    entries,
  };
}

export function getBlockingVerificationEvidenceIssues(cl: ChecklistData, currentHead?: string): string[] {
  const coverage = buildVerificationCoverage(cl, currentHead);
  return coverage.entries
    .filter(e => e.priority === 'must' && !['covered', 'waived'].includes(e.status))
    .map(e => `${e.intentRef} [${e.status}] ${e.desc}`);
}

export function renderVerificationCoverage(report: VerificationCoverageReport): string {
  if (report.total === 0) return 'Verification intent coverage: no explicit verificationIntent entries';
  const lines = [
    `Verification intent coverage: ${report.covered}/${report.total} covered (${report.missingRequired} required missing)`,
  ];
  for (const e of report.entries) {
    const marker = e.status === 'covered' || e.status === 'waived' ? '✓' : '✗';
    const ev = e.evidence
      ? ` via ${e.evidence.kind}${e.evidence.file ? ` (${e.evidence.file})` : ''}`
      : '';
    lines.push(`  ${marker} ${e.intentRef} [${e.lane}/${e.priority}/${e.type}] ${e.status}${ev} — ${e.desc}`);
  }
  return lines.join('\n');
}

export function makeEvidence(args: Omit<VerificationEvidence, 'timestamp' | 'headHash'> & { headHash?: string }): VerificationEvidence {
  return {
    ...args,
    timestamp: new Date().toISOString(),
    ...(args.headHash ? { headHash: args.headHash } : {}),
  };
}

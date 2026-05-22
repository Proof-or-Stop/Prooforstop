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
import { formatVerificationEvidenceVerdict } from './types.js';
import type { VerificationIntentPolicyResolution } from './workflow-policy.js';
import { type EvidenceQualityProfile, getEvidenceQualityIssues, type EvidenceQualityIssue } from './evidence-quality.js';
import { evaluateAttestationEvidence, type AttestationIssue } from './attestation.js';

export const VERIFICATION_LANES: readonly VerificationLane[] = ['happy', 'edge', 'adversarial'];
export type DeferredGateEvidenceMode = 'covered' | 'missing';

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

function isDeferredGateEvidence(evidence: VerificationEvidence): boolean {
  return evidence.kind === 'waiver' && evidence.waiverType === 'deferred_gate_evidence';
}

export function buildVerificationCoverage(
  cl: ChecklistData,
  currentHead?: string,
  isEvidenceFresh?: (headHash: string, evidence?: VerificationEvidence) => boolean,
  options: { deferredGateEvidence?: DeferredGateEvidenceMode; evidenceQualityProfile?: EvidenceQualityProfile } = {},
): VerificationCoverageReport {
  const qualityProfile = options.evidenceQualityProfile ?? 'light';
  const entries: VerificationCoverageEntry[] = [];
  const qualityIssues: EvidenceQualityIssue[] = [];
  const attestationIssues: AttestationIssue[] = [];
  for (const item of cl.items) {
    for (const collected of collectVerificationIntents(item)) {
      const priority = collected.intent.priority || 'must';
      const evidence = pickEvidence(item, collected.ref);
      let status: VerificationCoverageEntry['status'] = 'missing';
      if (evidence) {
        if (isDeferredGateEvidence(evidence)) status = 'deferred';
        else if (evidence.kind === 'waiver') status = 'waived';
        else if (evidence.result === 'fail') status = 'failed';
        else if (
          currentHead &&
          evidence.headHash &&
          !headMatches(evidence.headHash, currentHead) &&
          !(isEvidenceFresh?.(evidence.headHash, evidence) ?? false)
        ) status = 'stale';
        else status = 'covered';

        // Evidence quality classification (balanced: warning, strict: blocking)
        if (status === 'covered' && qualityProfile !== 'light') {
          const issue = getEvidenceQualityIssues(collected.ref, item.id, evidence, qualityProfile);
          if (issue) {
            qualityIssues.push(issue);
            status = 'weak'; // both balanced (warning) and strict (blocking) mark as weak
          }
        }

        // Attestation evaluation — runs on initially-covered evidence regardless of quality demotion
        // so attestation issues are always captured when present
        if ((status === 'covered' || status === 'weak') && qualityProfile !== 'light' && evidence.attestation) {
          const attIssues = evaluateAttestationEvidence(evidence, qualityProfile, {
            currentHead,
            isMaterialFresh: isEvidenceFresh ? (h, e) => isEvidenceFresh(h, e) : undefined,
          });
          if (attIssues.length > 0) {
            attestationIssues.push(...attIssues);
            if (qualityProfile === 'strict') status = 'weak';
          }
        }
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
  if (options.deferredGateEvidence !== 'missing') coveredStatuses.add('deferred');
  // 'weak' entries: covered in balanced (warning), not covered in strict
  if (qualityProfile !== 'strict') coveredStatuses.add('weak');
  return {
    total: entries.length,
    required: requiredEntries.length,
    covered: entries.filter(e => coveredStatuses.has(e.status)).length,
    missingRequired: requiredEntries.filter(e => !coveredStatuses.has(e.status)).length,
    entries,
    ...(qualityIssues.length > 0 ? { qualityIssues } : {}),
    ...(attestationIssues.length > 0 ? { attestationIssues } : {}),
  };
}

export function getBlockingVerificationEvidenceIssues(cl: ChecklistData, currentHead?: string, evidenceQualityProfile?: EvidenceQualityProfile): string[] {
  const coverage = buildVerificationCoverage(cl, currentHead, undefined, { evidenceQualityProfile });
  const nonCoveredStatuses = evidenceQualityProfile === 'strict'
    ? (s: string) => !['covered', 'waived', 'deferred'].includes(s)  // 'weak' is blocking in strict
    : (s: string) => !['covered', 'waived', 'deferred', 'weak'].includes(s);
  // When qualityIssues or attestationIssues provides detail for a weak entry, skip the generic entry
  const qualityIssueRefs = new Set(coverage.qualityIssues?.filter(qi => qi.blocking).map(qi => qi.intentRef) ?? []);
  const attestationIssueRefs = new Set(coverage.attestationIssues?.filter(ai => ai.severity === 'blocking').map(ai => ai.intentRef) ?? []);
  const issues = coverage.entries
    .filter(e => e.priority === 'must' && nonCoveredStatuses(e.status))
    .filter(e => e.status !== 'weak' || (!qualityIssueRefs.has(e.intentRef) && !attestationIssueRefs.has(e.intentRef)))
    .map(e => `${e.intentRef} [${e.status}] ${e.desc}`);
  // Include quality issue details for weak entries in strict mode
  if (coverage.qualityIssues) {
    for (const qi of coverage.qualityIssues) {
      if (qi.blocking) issues.push(`${qi.intentRef} [weak] ${qi.detail}`);
    }
  }
  // Include attestation issue details for weak entries in strict mode
  if (coverage.attestationIssues) {
    for (const ai of coverage.attestationIssues) {
      if (ai.severity === 'blocking') issues.push(`${ai.intentRef} [weak] ${ai.code} — ${ai.message}`);
    }
  }
  return issues;
}

export function renderVerificationCoverage(report: VerificationCoverageReport, policy?: VerificationIntentPolicyResolution): string {
  if (report.total === 0) {
    if (policy?.policy === 'express-exempt' && policy.message) return policy.message;
    return 'Verification intent coverage: no explicit verificationIntent entries';
  }
  const lines = [
    `Verification intent coverage: ${report.covered}/${report.total} covered (${report.missingRequired} required missing)`,
  ];
  for (const e of report.entries) {
    const marker = e.status === 'covered' || e.status === 'waived'
      ? '✓'
      : e.status === 'deferred'
        ? '~'
        : e.status === 'weak'
          ? '⚠'
          : '✗';
    const ev = e.evidence
      ? ` via ${e.evidence.kind}${e.evidence.verdict ? ` verdict=${formatVerificationEvidenceVerdict(e.evidence.verdict)}` : ''}${e.evidence.file ? ` (${e.evidence.file})` : ''}`
      : '';
    lines.push(`  ${marker} ${e.intentRef} [${e.lane}/${e.priority}/${e.type}] ${e.status}${ev} — ${e.desc}`);
  }
  if (report.qualityIssues && report.qualityIssues.length > 0) {
    lines.push('');
    lines.push('Evidence quality warnings:');
    for (const issue of report.qualityIssues) {
      const prefix = issue.blocking ? '  [BLOCKING]' : '  [WARNING]';
      lines.push(`${prefix} ${issue.intentRef}: ${issue.detail} (${issue.weaknessReason})`);
    }
  }
  if (report.attestationIssues && report.attestationIssues.length > 0) {
    lines.push('');
    lines.push('Attestation warnings:');
    for (const issue of report.attestationIssues) {
      const prefix = issue.severity === 'blocking' ? '  [BLOCKING]' : '  [WARNING]';
      lines.push(`${prefix} ${issue.intentRef}: ${issue.code} — ${issue.message}`);
    }
  }
  return lines.join('\n');
}

export function makeEvidence(args: Omit<VerificationEvidence, 'timestamp' | 'headHash' | 'materialHash'> & {
  headHash?: string;
  materialHash?: string;
}): VerificationEvidence {
  return {
    ...args,
    timestamp: new Date().toISOString(),
    ...(args.headHash ? { headHash: args.headHash } : {}),
    ...(args.materialHash ? { materialHash: args.materialHash } : {}),
  };
}

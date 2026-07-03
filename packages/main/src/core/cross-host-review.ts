/**
 * cross-host-review — PURE (no I/O) diff + joint-decision logic for the M1
 * crypto-deferred automatic cross-host adversarial review (story B-f57a).
 *
 * `diffFindings` surfaces WHICH finding one host raised that the other missed —
 * the finding-level divergence the existing verdicts.ts `summarizeVerdicts` does
 * NOT fill (it only counts pass/fail hosts). `jointDecision` combines two host
 * decisions into a fail-closed joint verdict: pass IFF both hosts pass AND there
 * is no finding-level disagreement; otherwise blocked.
 *
 * No cryptography: this is the adversarial joint-decision layer, not a signature
 * layer. Independence here is cross-vendor (Claude host A / Codex host B),
 * same-operator orchestrated — the honest ceiling stated in the threat model.
 */

import type { Finding } from './adversarial-review.js';

export const CROSS_HOST_DISAGREEMENT_SCHEMA = 'lattice.cross_host_disagreement.v1' as const;

export type CrossHostDecision = 'pass' | 'fail' | 'blocked';

export interface DisagreementReport {
  schemaVersion: typeof CROSS_HOST_DISAGREEMENT_SCHEMA;
  /** Findings both hosts raised (matched by key). */
  agreed: Finding[];
  /** Findings only host A raised. */
  onlyHostA: Finding[];
  /** Findings only host B raised. */
  onlyHostB: Finding[];
  hasDisagreement: boolean;
  /** onlyHostA.length + onlyHostB.length. */
  divergentCount: number;
}

export interface JointDecisionResult {
  hostADecision: CrossHostDecision;
  hostBDecision: CrossHostDecision;
  jointDecision: 'pass' | 'blocked';
  blockedReason?: string;
  disagreement: DisagreementReport;
}

/**
 * Match key for a finding: `${lower(file)}:${line}:${normalizedTitle}` where the
 * title is lowercased and whitespace-collapsed. Two findings that point at the
 * same file/line with the same (normalized) title are "the same finding" even if
 * their issue/fix prose differs.
 */
export function findingKey(finding: Finding): string {
  const file = (finding.file ?? '').toLowerCase();
  const title = (finding.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${file}:${finding.line}:${title}`;
}

/** Dedup a finding list by match key, keeping the first occurrence of each key. */
function dedupByKey(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const finding of findings) {
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

/**
 * Diff two hosts' findings by match key. Each host list is de-duplicated within
 * itself BEFORE diffing (so a host repeating the same finding does not inflate
 * the divergence). `agreed` uses host A's representative for a shared key.
 */
export function diffFindings(hostA: Finding[], hostB: Finding[]): DisagreementReport {
  const a = dedupByKey(hostA ?? []);
  const b = dedupByKey(hostB ?? []);
  const bKeys = new Map<string, Finding>(b.map(f => [findingKey(f), f]));
  const aKeys = new Set<string>(a.map(f => findingKey(f)));

  const agreed: Finding[] = [];
  const onlyHostA: Finding[] = [];
  for (const finding of a) {
    if (bKeys.has(findingKey(finding))) agreed.push(finding);
    else onlyHostA.push(finding);
  }
  const onlyHostB: Finding[] = [];
  for (const finding of b) {
    if (!aKeys.has(findingKey(finding))) onlyHostB.push(finding);
  }
  const divergentCount = onlyHostA.length + onlyHostB.length;
  return {
    schemaVersion: CROSS_HOST_DISAGREEMENT_SCHEMA,
    agreed,
    onlyHostA,
    onlyHostB,
    hasDisagreement: divergentCount > 0,
    divergentCount,
  };
}

/**
 * Combine host-A and host-B decisions into a fail-closed joint decision.
 * `jointDecision` is 'pass' IFF BOTH decisions === 'pass' AND
 * `!disagreement.hasDisagreement`; otherwise 'blocked' with a descriptive
 * `blockedReason` naming exactly why.
 */
export function jointDecision(
  hostAVerdict: CrossHostDecision,
  hostBVerdict: CrossHostDecision,
  disagreement: DisagreementReport,
): JointDecisionResult {
  const bothPass = hostAVerdict === 'pass' && hostBVerdict === 'pass';
  if (bothPass && !disagreement.hasDisagreement) {
    return {
      hostADecision: hostAVerdict,
      hostBDecision: hostBVerdict,
      jointDecision: 'pass',
      disagreement,
    };
  }
  const reasons: string[] = [];
  if (hostAVerdict !== 'pass') reasons.push(`host A decision is ${hostAVerdict}`);
  if (hostBVerdict !== 'pass') reasons.push(`host B decision is ${hostBVerdict}`);
  if (disagreement.hasDisagreement) {
    reasons.push(
      `hosts disagree on ${disagreement.divergentCount} finding(s) `
      + `(only host A: ${disagreement.onlyHostA.length}, only host B: ${disagreement.onlyHostB.length})`,
    );
  }
  return {
    hostADecision: hostAVerdict,
    hostBDecision: hostBVerdict,
    jointDecision: 'blocked',
    blockedReason: `cross-host review blocked: ${reasons.join('; ')}`,
    disagreement,
  };
}

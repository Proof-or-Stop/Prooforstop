import type { AttestationMetadata, VerificationEvidence } from './types.js';
import type { EvidenceQualityProfile } from './evidence-quality.js';

export interface AttestationIssue {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
  intentRef: string;
}

export interface AttestationEvaluationOptions {
  /** Current git HEAD for staleness detection. */
  currentHead?: string;
  /** Returns true when a given headHash is still considered fresh (e.g. via materialHash). */
  isMaterialFresh?: (headHash: string, evidence: VerificationEvidence) => boolean;
}

function hasBinding(a: AttestationMetadata): boolean {
  return !!(
    (a.command && a.command.trim()) ||
    (a.artifactRef && a.artifactRef.trim()) ||
    (a.artifactDigest && a.artifactDigest.trim())
  );
}

function hasClaims(a: AttestationMetadata): boolean {
  return !!(a.checkedClaims && a.checkedClaims.some(c => c.trim().length > 0));
}

function isStale(evidence: VerificationEvidence, currentHead: string, isMaterialFresh?: AttestationEvaluationOptions['isMaterialFresh']): boolean {
  if (!evidence.headHash) return false;
  if (evidence.headHash === currentHead || currentHead.startsWith(evidence.headHash) || evidence.headHash.startsWith(currentHead)) return false;
  if (isMaterialFresh?.(evidence.headHash, evidence)) return false;
  return true;
}

export function evaluateAttestationEvidence(
  evidence: VerificationEvidence,
  profile: EvidenceQualityProfile,
  options: AttestationEvaluationOptions = {},
): AttestationIssue[] {
  // Legacy evidence without attestation metadata — always compatible
  if (!evidence.attestation) return [];

  // Light profile — no issues raised
  if (profile === 'light') return [];

  const a = evidence.attestation;
  const ref = evidence.intentRef;
  const issues: AttestationIssue[] = [];
  const blocking = profile === 'strict';

  if (a.kind === 'human') {
    if (!hasClaims(a) && !hasBinding(a)) {
      issues.push({
        code: 'human_attestation_empty',
        severity: blocking ? 'blocking' : 'warning',
        message: 'Human attestation has no checkedClaims and no command/artifact binding — looks-good claim without substance',
        intentRef: ref,
      });
    }
  } else if (a.kind === 'ci') {
    if (!hasClaims(a)) {
      issues.push({
        code: 'ci_attestation_no_claims',
        severity: blocking ? 'blocking' : 'warning',
        message: 'CI attestation has no checkedClaims — cannot determine what was verified',
        intentRef: ref,
      });
    }
    if (!hasBinding(a)) {
      issues.push({
        code: 'ci_attestation_no_binding',
        severity: blocking ? 'blocking' : 'warning',
        message: 'CI attestation has no command/artifact binding — cannot trace evidence to a specific run',
        intentRef: ref,
      });
    }
  }

  // Staleness check (applies to both kinds when currentHead supplied)
  if (options.currentHead && isStale(evidence, options.currentHead, options.isMaterialFresh)) {
    issues.push({
      code: 'attestation_stale',
      severity: blocking ? 'blocking' : 'warning',
      message: `Attestation headHash ${evidence.headHash} does not match current HEAD ${options.currentHead}`,
      intentRef: ref,
    });
  }

  return issues;
}

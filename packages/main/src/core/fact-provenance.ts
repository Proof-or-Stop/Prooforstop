import type { VerificationEvidence } from './types.js';
import type { EvidenceQualityProfile } from './evidence-quality.js';

export interface FactProvenanceIssue {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
  intentRef: string;
}

export interface FactProvenanceOptions {
  /** Force provenance checks even when evidence.factProvenance.kind is not 'external_fact'. */
  requireExternalProvenance?: boolean;
  /** In strict: block when only secondary/tertiary sources are present (no primary). */
  requirePrimarySource?: boolean;
  /** Max age in days for fetchedAt before considering stale. Default: 90. */
  maxAgeDays?: number;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export function evaluateFactProvenanceEvidence(
  evidence: VerificationEvidence,
  profile: EvidenceQualityProfile,
  options: FactProvenanceOptions = {},
): FactProvenanceIssue[] {
  if (profile === 'light') return [];

  const fp = evidence.factProvenance;
  const isExternalClaim = fp?.kind === 'external_fact' || options.requireExternalProvenance;

  // Non-external evidence without factProvenance is always compatible
  if (!isExternalClaim) return [];

  const blocking = profile === 'strict';
  const ref = evidence.intentRef;
  const issues: FactProvenanceIssue[] = [];
  const now = options.now ?? new Date();
  const maxAgeDays = options.maxAgeDays ?? 90;

  // Missing source URL/ref
  if (!fp?.sourceUrl && !fp?.sourceRef) {
    issues.push({
      code: 'missing_source',
      severity: blocking ? 'blocking' : 'warning',
      message: 'External fact evidence has no sourceUrl or sourceRef — source cannot be traced',
      intentRef: ref,
    });
  }

  // Missing digest
  if (!fp?.digest) {
    issues.push({
      code: 'missing_digest',
      severity: blocking ? 'blocking' : 'warning',
      message: 'External fact evidence has no digest — content integrity cannot be verified',
      intentRef: ref,
    });
  }

  // Missing checkedClaims
  if (!fp?.checkedClaims || fp.checkedClaims.length === 0) {
    issues.push({
      code: 'missing_checked_claims',
      severity: blocking ? 'blocking' : 'warning',
      message: 'External fact evidence has no checkedClaims — verified assertions are unspecified',
      intentRef: ref,
    });
  }

  // Stale fetchedAt
  if (fp?.fetchedAt) {
    const fetchedDate = new Date(fp.fetchedAt);
    const ageMs = now.getTime() - fetchedDate.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > maxAgeDays) {
      issues.push({
        code: 'stale_fetched_at',
        severity: blocking ? 'blocking' : 'warning',
        message: `External fact was fetched ${Math.floor(ageDays)} days ago (max ${maxAgeDays}) — re-verification required`,
        intentRef: ref,
      });
    }
  }

  // Expired
  if (fp?.expiresAt) {
    const expiresDate = new Date(fp.expiresAt);
    if (expiresDate <= now) {
      issues.push({
        code: 'expired',
        severity: blocking ? 'blocking' : 'warning',
        message: `External fact expired at ${fp.expiresAt} — re-verification required`,
        intentRef: ref,
      });
    }
  }

  // Secondary/tertiary-only when primary required
  if (options.requirePrimarySource && fp?.sourceClass && fp.sourceClass !== 'primary' && fp.sourceClass !== 'internal') {
    issues.push({
      code: 'secondary_only_source',
      severity: blocking ? 'blocking' : 'warning',
      message: `External fact uses only a ${fp.sourceClass} source — a primary source is required`,
      intentRef: ref,
    });
  }

  // Conflicting sources
  if (fp?.conflictingSources && fp.conflictingSources.length > 0) {
    issues.push({
      code: 'conflicting_sources',
      severity: blocking ? 'blocking' : 'warning',
      message: `External fact has ${fp.conflictingSources.length} conflicting source(s) — resolve conflicts before accepting evidence`,
      intentRef: ref,
    });
  }

  return issues;
}

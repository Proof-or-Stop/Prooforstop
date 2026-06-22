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
  /** Days before expiry to emit soon_expiring warning. Default: 7. */
  soonExpiryDays?: number;
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
  const soonExpiryDays = options.soonExpiryDays ?? 7;

  // Missing source URL/ref (treat whitespace-only as missing)
  const hasSourceUrl = fp?.sourceUrl && fp.sourceUrl.trim().length > 0;
  const hasSourceRef = fp?.sourceRef && fp.sourceRef.trim().length > 0;
  if (!hasSourceUrl && !hasSourceRef) {
    issues.push({
      code: 'missing_source',
      severity: blocking ? 'blocking' : 'warning',
      message: 'External fact evidence has no sourceUrl or sourceRef — source cannot be traced',
      intentRef: ref,
    });
  }

  // Missing digest (treat whitespace-only as missing)
  if (!fp?.digest || fp.digest.trim().length === 0) {
    issues.push({
      code: 'missing_digest',
      severity: blocking ? 'blocking' : 'warning',
      message: 'External fact evidence has no digest — content integrity cannot be verified',
      intentRef: ref,
    });
  }

  // Missing checkedClaims (must have at least one non-empty trimmed claim)
  const validClaims = fp?.checkedClaims?.filter(c => c.trim().length > 0) ?? [];
  if (validClaims.length === 0) {
    issues.push({
      code: 'missing_checked_claims',
      severity: blocking ? 'blocking' : 'warning',
      message: 'External fact evidence has no checkedClaims — verified assertions are unspecified',
      intentRef: ref,
    });
  }

  // Stale or invalid fetchedAt
  if (fp?.fetchedAt) {
    const fetchedDate = new Date(fp.fetchedAt);
    if (isNaN(fetchedDate.getTime())) {
      issues.push({
        code: 'invalid_fetched_at',
        severity: blocking ? 'blocking' : 'warning',
        message: `External fact has invalid fetchedAt value: "${fp.fetchedAt}"`,
        intentRef: ref,
      });
    } else {
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
  }

  // Expired or invalid expiresAt; soon-expiring
  if (fp?.expiresAt) {
    const expiresDate = new Date(fp.expiresAt);
    if (isNaN(expiresDate.getTime())) {
      issues.push({
        code: 'invalid_expires_at',
        severity: blocking ? 'blocking' : 'warning',
        message: `External fact has invalid expiresAt value: "${fp.expiresAt}"`,
        intentRef: ref,
      });
    } else if (expiresDate <= now) {
      issues.push({
        code: 'expired',
        severity: blocking ? 'blocking' : 'warning',
        message: `External fact expired at ${fp.expiresAt} — re-verification required`,
        intentRef: ref,
      });
    } else {
      const msUntilExpiry = expiresDate.getTime() - now.getTime();
      const daysUntilExpiry = msUntilExpiry / (1000 * 60 * 60 * 24);
      if (daysUntilExpiry <= soonExpiryDays) {
        issues.push({
          code: 'soon_expiring',
          severity: 'warning',
          message: `External fact expires in ${Math.ceil(daysUntilExpiry)} day(s) at ${fp.expiresAt} — consider re-verification`,
          intentRef: ref,
        });
      }
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

  // Conflicting sources (count only non-empty trimmed entries)
  const validConflicting = fp?.conflictingSources?.filter(s => s.trim().length > 0) ?? [];
  if (validConflicting.length > 0) {
    issues.push({
      code: 'conflicting_sources',
      severity: blocking ? 'blocking' : 'warning',
      message: `External fact has ${validConflicting.length} conflicting source(s) — resolve conflicts before accepting evidence`,
      intentRef: ref,
    });
  }

  return issues;
}

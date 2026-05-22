import type { VerificationEvidence } from './types.js';
import type { EvidenceQualityProfile } from './evidence-quality.js';

export interface ActorTrustIssue {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
  intentRef: string;
}

export interface ActorTrustRegistry {
  trustedActorIds?: string[];
  revokedActorIds?: string[];
}

export interface ActorStats {
  /** intentRefs for which this actorId produced passing evidence */
  passingRefs?: string[];
  /** Total pass count across all intent refs for this actorId */
  totalPasses?: number;
  /** Total evidence count for this actorId */
  totalEvidence?: number;
}

export interface ActorTrustOptions {
  registry?: ActorTrustRegistry;
  /** If true, balanced warns and strict blocks when actorTrust metadata is absent. */
  requireActorMetadata?: boolean;
  /** Per-actor stats used to detect suspicious always-pass patterns. */
  actorStats?: Record<string, ActorStats>;
}

export function evaluateActorTrustEvidence(
  evidence: VerificationEvidence,
  profile: EvidenceQualityProfile,
  options: ActorTrustOptions = {},
): ActorTrustIssue[] {
  // Light profile: legacy evidence is always compatible, no issues
  if (profile === 'light') return [];

  const ref = evidence.intentRef;
  const at = evidence.actorTrust;
  const blocking = profile === 'strict';
  const issues: ActorTrustIssue[] = [];

  // Missing actor metadata
  if (!at) {
    if (options.requireActorMetadata) {
      issues.push({
        code: 'actor_metadata_missing',
        severity: blocking ? 'blocking' : 'warning',
        message: 'No actorTrust metadata on evidence — actor identity cannot be verified',
        intentRef: ref,
      });
    }
    return issues;
  }

  const registry = options.registry ?? {};
  const actorId = at.actorId ?? at.producerActorId;

  // Check explicit trustStatus=revoked
  if (at.trustStatus === 'revoked') {
    issues.push({
      code: 'actor_revoked',
      severity: blocking ? 'blocking' : 'warning',
      message: `Actor trustStatus is explicitly 'revoked'`,
      intentRef: ref,
    });
  }

  // Check against revoked registry
  if (actorId && registry.revokedActorIds?.includes(actorId)) {
    if (!issues.some(i => i.code === 'actor_revoked')) {
      issues.push({
        code: 'actor_revoked',
        severity: blocking ? 'blocking' : 'warning',
        message: `Actor '${actorId}' is in the revoked actor list`,
        intentRef: ref,
      });
    }
  }
  if (at.verifierActorId && registry.revokedActorIds?.includes(at.verifierActorId)) {
    issues.push({
      code: 'verifier_actor_revoked',
      severity: blocking ? 'blocking' : 'warning',
      message: `Verifier actor '${at.verifierActorId}' is in the revoked actor list`,
      intentRef: ref,
    });
  }

  // Same producer/verifier actor (self-verification)
  if (
    at.producerActorId &&
    at.verifierActorId &&
    at.producerActorId === at.verifierActorId
  ) {
    issues.push({
      code: 'same_producer_verifier',
      severity: blocking ? 'blocking' : 'warning',
      message: `Producer and verifier are the same actor '${at.producerActorId}' — evidence lacks independent review`,
      intentRef: ref,
    });
  }

  // Same producer/verifier provider
  if (at.producerProvider && at.verifierProvider && at.producerProvider === at.verifierProvider) {
    const detail =
      at.producerVendor && at.verifierVendor && at.producerVendor === at.verifierVendor &&
      at.producerModel && at.verifierModel && at.producerModel === at.verifierModel
        ? ` (vendor=${at.producerVendor}, model=${at.producerModel})`
        : at.producerVendor && at.verifierVendor && at.producerVendor === at.verifierVendor
          ? ` (vendor=${at.producerVendor})`
          : '';
    issues.push({
      code: 'same_provider',
      severity: blocking ? 'blocking' : 'warning',
      message: `Producer and verifier use the same provider '${at.producerProvider}'${detail} — evidence lacks cross-provider independence`,
      intentRef: ref,
    });
  }

  // Same producerRunId/verifierRunId (same run self-verifying)
  if (
    at.producerRunId &&
    at.verifierRunId &&
    at.producerRunId === at.verifierRunId
  ) {
    issues.push({
      code: 'same_run_id',
      severity: blocking ? 'blocking' : 'warning',
      message: `Producer and verifier share the same runId '${at.producerRunId}' — same run cannot independently verify itself`,
      intentRef: ref,
    });
  }

  // Suspicious always-pass pattern
  if (actorId && options.actorStats) {
    const stats = options.actorStats[actorId];
    if (stats) {
      const total = stats.totalEvidence ?? 0;
      const passes = stats.totalPasses ?? 0;
      // Flag when actor has ≥3 evidence records and 100% pass rate
      if (total >= 3 && passes === total) {
        issues.push({
          code: 'suspicious_always_pass',
          severity: blocking ? 'blocking' : 'warning',
          message: `Actor '${actorId}' has a suspicious always-pass pattern (${passes}/${total} pass rate across all evidence)`,
          intentRef: ref,
        });
      }
    }
  }

  return issues;
}

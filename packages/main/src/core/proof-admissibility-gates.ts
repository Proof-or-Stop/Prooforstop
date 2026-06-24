import { loadConfig } from './config.js';
import {
  PROOF_ADMISSIBILITY_CONTRACT_VERSION,
  evaluateProofAdmissibility,
  type AdmissibilityResult,
  type ArtifactConsumerKind,
  type ClaimKind,
  type EvaluateProofAdmissibilityInput,
} from './proof-admissibility.js';

export type ProofAdmissibilityMode = 'warn' | 'enforce';

export interface ProofAdmissibilityDiagnostic {
  artifactId?: string;
  artifactKind: string;
  consumer: ArtifactConsumerKind;
  claim: ClaimKind;
  scope: AdmissibilityResult['scope'];
  allowed: boolean;
  mode: ProofAdmissibilityMode;
  blocking: boolean;
  reasons: string[];
  remediation: string[];
}

export function resolveProofAdmissibilityMode(projectRoot?: string): ProofAdmissibilityMode {
  if (!projectRoot) return 'warn';
  const config = loadConfig(projectRoot) as unknown as Record<string, unknown>;
  const proof = config.proofAdmissibility;
  if (!proof || typeof proof !== 'object') return 'warn';
  const mode = (proof as { mode?: unknown }).mode;
  return mode === 'enforce' ? 'enforce' : 'warn';
}

export function buildProofAdmissibilityDiagnostic(
  input: EvaluateProofAdmissibilityInput & { artifactId?: string; mode?: ProofAdmissibilityMode },
): ProofAdmissibilityDiagnostic {
  const checks = {
    contractVersion: PROOF_ADMISSIBILITY_CONTRACT_VERSION,
    ...(input.checks ?? {}),
  };
  const result = evaluateProofAdmissibility({ ...input, checks });
  const mode = input.mode ?? 'warn';
  return {
    artifactId: input.artifactId,
    artifactKind: result.artifactKind,
    consumer: input.consumer,
    claim: input.claim,
    scope: result.scope,
    allowed: result.allowed,
    mode,
    blocking: mode === 'enforce' && !result.allowed,
    reasons: result.reasons,
    remediation: result.remediation,
  };
}

export function formatProofAdmissibilityDiagnostic(diagnostic: ProofAdmissibilityDiagnostic): string {
  const id = diagnostic.artifactId ? `${diagnostic.artifactId} ` : '';
  const status = diagnostic.allowed ? 'allowed' : diagnostic.blocking ? 'blocked' : 'warning';
  const reasons = diagnostic.reasons.length ? diagnostic.reasons.join(', ') : 'none';
  return `${status}: ${id}${diagnostic.artifactKind} scope=${diagnostic.scope} consumer=${diagnostic.consumer} claim=${diagnostic.claim} reasons=${reasons}; remediation=${diagnostic.remediation.join(' | ')}`;
}

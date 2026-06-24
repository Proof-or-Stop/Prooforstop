import { loadConfig } from './config.js';
import {
  PROOF_ADMISSIBILITY_CONTRACT_VERSION,
  PROOF_ADMISSIBILITY_VERIFIER_VERSION,
  evaluateProofAdmissibility,
  type AdmissibilityResult,
  type AdmissibilityOverall,
  type ArtifactConsumerKind,
  type ClaimKind,
  type EvaluateProofAdmissibilityInput,
} from './proof-admissibility.js';

export type ProofAdmissibilityMode = 'warn' | 'enforce';

export const PROOF_ADMISSIBILITY_ENFORCE_BLOCK_REASON = 'proof_admissibility_blocked' as const;

type ProofAdmissibilityEvaluator = (input: EvaluateProofAdmissibilityInput) => AdmissibilityResult;

export interface ProofAdmissibilityDiagnostic {
  artifactId?: string;
  artifactKind: string;
  consumer: ArtifactConsumerKind;
  claim: ClaimKind;
  scope: AdmissibilityResult['scope'];
  overall: AdmissibilityOverall;
  allowed: boolean;
  mode: ProofAdmissibilityMode;
  blocking: boolean;
  reasons: string[];
  remediation: string[];
  error?: string;
}

export function resolveProofAdmissibilityMode(projectRoot?: string): ProofAdmissibilityMode {
  if (!projectRoot) return 'warn';
  const config = loadConfig(projectRoot);
  const proof = config.proofAdmissibility;
  if (!proof || typeof proof !== 'object') return 'warn';
  const mode = proof.mode;
  return mode === 'enforce' ? 'enforce' : 'warn';
}

export function buildProofAdmissibilityDiagnostic(
  input: EvaluateProofAdmissibilityInput & {
    artifactId?: string;
    mode?: ProofAdmissibilityMode;
    evaluator?: ProofAdmissibilityEvaluator;
  },
): ProofAdmissibilityDiagnostic {
  const checks = {
    contractVersion: PROOF_ADMISSIBILITY_CONTRACT_VERSION,
    verifierVersion: PROOF_ADMISSIBILITY_VERIFIER_VERSION,
    ...(input.checks ?? {}),
  };
  const mode = input.mode ?? 'warn';
  const evaluator = input.evaluator ?? evaluateProofAdmissibility;
  let result: AdmissibilityResult;
  try {
    result = evaluator({ ...input, checks });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      artifactId: input.artifactId,
      artifactKind: input.artifactKind,
      consumer: input.consumer,
      claim: input.claim,
      scope: 'unknown',
      overall: 'error',
      allowed: false,
      mode,
      blocking: false,
      reasons: ['checker_error'],
      remediation: [
        'Proof checker failed before it could classify the artifact. Treat this as warning-only workflow recovery, not admissible proof.',
      ],
      error: message,
    };
  }
  return {
    artifactId: input.artifactId,
    artifactKind: result.artifactKind,
    consumer: input.consumer,
    claim: input.claim,
    scope: result.scope,
    overall: result.overall,
    allowed: result.allowed,
    mode,
    blocking: mode === 'enforce' && result.overall === 'fail' && !result.allowed,
    reasons: result.reasons,
    remediation: result.remediation,
  };
}

export function formatProofAdmissibilityDiagnostic(diagnostic: ProofAdmissibilityDiagnostic): string {
  const id = diagnostic.artifactId ? `${diagnostic.artifactId} ` : '';
  const status = diagnostic.allowed ? 'allowed' : diagnostic.overall === 'error' ? 'checker-error' : diagnostic.blocking ? 'blocked' : 'warning';
  const reasons = diagnostic.reasons.length ? diagnostic.reasons.join(', ') : 'none';
  return `${status}: ${id}${diagnostic.artifactKind} scope=${diagnostic.scope} consumer=${diagnostic.consumer} claim=${diagnostic.claim} overall=${diagnostic.overall} reasons=${reasons}; remediation=${diagnostic.remediation.join(' | ')}`;
}

export function proofAdmissibilityBlockingReason(diagnostic: ProofAdmissibilityDiagnostic): string | null {
  if (!diagnostic.blocking) return null;
  const reasons = diagnostic.reasons.length > 0 ? diagnostic.reasons.join(',') : 'inadmissible';
  const remediation = diagnostic.remediation[0] ?? 'Regenerate admissible proof for this consumer.';
  return `${PROOF_ADMISSIBILITY_ENFORCE_BLOCK_REASON}: ${diagnostic.artifactKind} cannot satisfy ${diagnostic.consumer}/${diagnostic.claim} in enforce mode (${reasons}); ${remediation}`;
}

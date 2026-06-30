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
export type ProofAdmissibilityEnforcedConsumer = Extract<
  ArtifactConsumerKind,
  'DONE_REQUIRED' | 'REVIEW' | 'HANDOFF' | 'AUTHORITY_GATE_DECISION'
>;

export interface ProofAdmissibilityPolicy {
  mode: ProofAdmissibilityMode;
  enforcedConsumers: readonly ProofAdmissibilityEnforcedConsumer[];
}

export const DEFAULT_PROOF_ADMISSIBILITY_ENFORCED_CONSUMERS = [
  'DONE_REQUIRED',
  'REVIEW',
  'HANDOFF',
  'AUTHORITY_GATE_DECISION',
] as const satisfies readonly ProofAdmissibilityEnforcedConsumer[];

const PROOF_ADMISSIBILITY_ENFORCED_CONSUMER_SET = new Set<string>(DEFAULT_PROOF_ADMISSIBILITY_ENFORCED_CONSUMERS);

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
  enforcedConsumer: boolean;
  blocking: boolean;
  reasons: string[];
  remediation: string[];
  error?: string;
}

function normalizeEnforcedConsumers(value: unknown): ProofAdmissibilityEnforcedConsumer[] {
  if (!Array.isArray(value)) return [];
  const out: ProofAdmissibilityEnforcedConsumer[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (!PROOF_ADMISSIBILITY_ENFORCED_CONSUMER_SET.has(item)) continue;
    if (!out.includes(item as ProofAdmissibilityEnforcedConsumer)) out.push(item as ProofAdmissibilityEnforcedConsumer);
  }
  return out;
}

export function resolveProofAdmissibilityPolicy(projectRoot?: string): ProofAdmissibilityPolicy {
  if (!projectRoot) {
    return { mode: 'warn', enforcedConsumers: DEFAULT_PROOF_ADMISSIBILITY_ENFORCED_CONSUMERS };
  }
  const config = loadConfig(projectRoot);
  const proof = config.proofAdmissibility;
  if (!proof || typeof proof !== 'object') {
    return { mode: 'warn', enforcedConsumers: DEFAULT_PROOF_ADMISSIBILITY_ENFORCED_CONSUMERS };
  }
  const mode: ProofAdmissibilityMode = proof.mode === 'enforce' ? 'enforce' : 'warn';
  const configuredConsumers = normalizeEnforcedConsumers(proof.enforcedConsumers ?? proof.highRiskConsumers);
  return {
    mode,
    enforcedConsumers: configuredConsumers.length > 0
      ? configuredConsumers
      : DEFAULT_PROOF_ADMISSIBILITY_ENFORCED_CONSUMERS,
  };
}

export function resolveProofAdmissibilityMode(projectRoot?: string): ProofAdmissibilityMode {
  return resolveProofAdmissibilityPolicy(projectRoot).mode;
}

export function buildProofAdmissibilityDiagnostic(
  input: EvaluateProofAdmissibilityInput & {
    artifactId?: string;
    mode?: ProofAdmissibilityMode;
    enforcedConsumers?: readonly ProofAdmissibilityEnforcedConsumer[];
    policy?: ProofAdmissibilityPolicy;
    evaluator?: ProofAdmissibilityEvaluator;
  },
): ProofAdmissibilityDiagnostic {
  const checks = {
    contractVersion: PROOF_ADMISSIBILITY_CONTRACT_VERSION,
    verifierVersion: PROOF_ADMISSIBILITY_VERIFIER_VERSION,
    ...(input.checks ?? {}),
  };
  const policy = input.policy ?? {
    mode: input.mode ?? 'warn',
    enforcedConsumers: input.enforcedConsumers ?? DEFAULT_PROOF_ADMISSIBILITY_ENFORCED_CONSUMERS,
  };
  const mode = policy.mode;
  const evaluator = input.evaluator ?? evaluateProofAdmissibility;
  const enforcedConsumer = policy.enforcedConsumers.includes(input.consumer as ProofAdmissibilityEnforcedConsumer);
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
      enforcedConsumer,
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
    enforcedConsumer,
    blocking: mode === 'enforce' && enforcedConsumer && result.overall === 'fail' && !result.allowed,
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

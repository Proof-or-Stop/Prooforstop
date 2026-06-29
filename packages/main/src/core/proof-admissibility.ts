/**
 * Proof admissibility registry — classification-only MVP.
 *
 * This module is intentionally inert with respect to lifecycle gates. It gives
 * callers a shared vocabulary for proof-looking surfaces and a fail-closed
 * evaluator they can use before future gate integration.
 */

export const EVIDENCE_SCOPES = [
  'audit-note',
  'legacy-observed',
  'legacy-local-only',
  'legacy-unknown-producer',
  'evidence-candidate',
  'local-diagnostic',
  'local-key-single-host',
  'local-gate-evidence',
  'local-review-quorum',
  'legacy-authority-receipt',
] as const;
export type EvidenceScope = typeof EVIDENCE_SCOPES[number];

export const TEMPORAL_ROLES = [
  'historical-baseline',
  'current-state',
  'transition-relation',
  'not-applicable',
] as const;
export type TemporalRole = typeof TEMPORAL_ROLES[number];

export const ARTIFACT_ROLES = [
  'problem-observation',
  'repro-validity-review',
  'planning-input',
  'planning-review',
  'current-verification',
  'regression-matrix-review',
  'red-green-relation',
  'handoff-context',
  'local-diagnostic',
  'legacy-authority-decision',
] as const;
export type ArtifactRole = typeof ARTIFACT_ROLES[number];

export const CLAIM_KINDS = [
  'historical-failure',
  'current-pass',
  'current-fail',
  'red-green-equivalence',
  'review-pass',
  'done-readiness',
  'production-completion',
  'handoff-context',
  'diagnostic-status',
] as const;
export type ClaimKind = typeof CLAIM_KINDS[number];

export const ARTIFACT_CONSUMER_KINDS = [
  'STORY_INTAKE',
  'PLAN',
  'REVIEW',
  'TEST',
  'DONE',
  'HANDOFF',
  'LEGACY_AUTHORITY_RECEIPT',
  'DONE_REQUIRED',
] as const;
export type ArtifactConsumerKind = typeof ARTIFACT_CONSUMER_KINDS[number];

export const PROOF_PRODUCER_BOUNDARIES = [
  'caller-writable',
  'local-runtime-owned',
  'legacy-authority-owned',
  'trusted-reviewer-owned',
  'legacy-unknown',
] as const;
export type ProofProducerBoundary = typeof PROOF_PRODUCER_BOUNDARIES[number];

export const ADMISSIBILITY_REASON_CODES = [
  'unsupported_schema_version',
  'unsupported_contract_version',
  'unsupported_verifier_version',
  'checker_error',
  'bad_shape',
  'missing_required_field',
  'unexpected_field',
  'signature_missing',
  'signature_invalid',
  'digest_mismatch',
  'stale_head',
  'stale_material',
  'stale_story_files',
  'stale_hash_tuple',
  'story_mismatch',
  'artifact_subject_mismatch',
  'producer_mismatch',
  'unknown_producer',
  'producer_owned_required',
  'artifact_consumer_mismatch',
  'gate_phase_mismatch',
  'temporal_role_mismatch',
  'historical_baseline_missing',
  'current_state_missing',
  'red_green_relation_missing',
  'red_green_command_mismatch',
  'equivalence_review_missing',
  'matrix_gap_unwaived',
  'bootstrap_noise',
  'environment_noise',
  'command_spec_missing',
  'command_spec_digest_mismatch',
  'bootstrap_spec_digest_mismatch',
  'clause_not_applicable',
  'clause_not_bound',
  'local_diagnostic_non_gate',
  'reserved_key_detected',
  'legacy_downgrade',
] as const;
export type AdmissibilityReasonCode = typeof ADMISSIBILITY_REASON_CODES[number];

export const PROOF_ADMISSIBILITY_CONTRACT_VERSION = 'lattice.proof_admissibility.v1' as const;
export const PROOF_ADMISSIBILITY_VERIFIER_VERSION = 'lattice.proof_admissibility_verifier.v1' as const;

export type AdmissibilityOverall = 'pass' | 'warn' | 'fail' | 'error';

export interface ProofClaimPolicy {
  claim: ClaimKind;
  consumers: readonly ArtifactConsumerKind[];
  productionDoneEligible: boolean;
}

export interface ProofSurfaceDefinition {
  artifactKind: string;
  aliases?: readonly string[];
  scope: EvidenceScope;
  artifactRole: ArtifactRole;
  temporalRole: TemporalRole;
  producerBoundary: ProofProducerBoundary;
  schemaVersions: readonly string[];
  strictShapeRequired: boolean;
  semanticDigestRequired: boolean;
  signatureOrReceiptBindingRequired: boolean;
  temporalAndMaterialBindingRequired: boolean;
  allowedConsumers: readonly ArtifactConsumerKind[];
  allowedClaims: readonly ProofClaimPolicy[];
  producerBoundaryNote: string;
  remediation: string;
}

export type ProofSurfaceKind = typeof PROOF_SURFACE_REGISTRY[number]['artifactKind'];

export interface AdmissibilityChecks {
  schemaVersion?: string;
  contractVersion?: string;
  verifierVersion?: string;
  strictShapeValid?: boolean;
  semanticDigestValid?: boolean;
  signatureOrReceiptBindingValid?: boolean;
  temporalAndMaterialBindingValid?: boolean;
  subjectMatches?: boolean;
  storyMatches?: boolean;
  gatePhaseMatches?: boolean;
  commandSpecDigestValid?: boolean;
  redGreenCommandsMatch?: boolean;
  matrixGapWaived?: boolean;
  bootstrapNoiseRejected?: boolean;
  hashTupleFresh?: boolean;
  producerBoundaryTrusted?: boolean;
  hasReservedProofKey?: boolean;
}

export interface EvaluateProofAdmissibilityInput {
  artifactKind: string;
  consumer: ArtifactConsumerKind;
  claim: ClaimKind;
  checks?: AdmissibilityChecks;
}

export interface AdmissibilityResult {
  artifactKind: string;
  scope: EvidenceScope | 'unknown';
  artifactRole: ArtifactRole | 'unknown';
  temporalRole: TemporalRole | 'unknown';
  producerBoundary: ProofProducerBoundary | 'unknown';
  consumer: ArtifactConsumerKind;
  claim: ClaimKind;
  overall: AdmissibilityOverall;
  allowed: boolean;
  productionDoneEligible: boolean;
  reasons: AdmissibilityReasonCode[];
  remediation: string[];
  definition?: ProofSurfaceDefinition;
}

const CANDIDATE_REMEDIATION =
  'Promote through story-bound verification evidence and a matching gate policy; candidate artifacts stay intake/planning evidence.';
const DIAGNOSTIC_REMEDIATION =
  'Use this only as diagnostic context; obtain a trusted current-state proof from the matching producer before claiming completion.';
const LEGACY_RECEIPT_REMEDIATION =
  'Treat legacy receipt evidence as out-of-core compatibility input; use local proof-admissibility, receipt-bundle, and quorum evidence for current assurance.';
const PRODUCTION_GATE_REMEDIATION =
  'Re-run the matching local gate verifier for the current story/head/material tuple and target consumer.';

export const PROOF_SURFACE_REGISTRY = [
  {
    artifactKind: 'done-required-evidence',
    aliases: ['done-required-evidence.json'],
    scope: 'local-gate-evidence',
    artifactRole: 'current-verification',
    temporalRole: 'current-state',
    producerBoundary: 'local-runtime-owned',
    schemaVersions: ['lattice.done_required_evidence.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: true,
    allowedConsumers: ['DONE_REQUIRED', 'DONE'],
    allowedClaims: [
      { claim: 'done-readiness', consumers: ['DONE_REQUIRED', 'DONE'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Local runtime-owned DONE-required command evidence; strong local readiness evidence, not an Authority production claim by itself.',
    remediation: 'Refresh done_required_validate for the current HEAD/material/story files before DONE consumption.',
  },
  {
    artifactKind: 'delivery-check',
    aliases: ['delivery-check.json', 'final-report'],
    scope: 'local-diagnostic',
    artifactRole: 'current-verification',
    temporalRole: 'current-state',
    producerBoundary: 'local-runtime-owned',
    schemaVersions: ['lattice.delivery_check.v1'],
    strictShapeRequired: false,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: true,
    allowedConsumers: ['REVIEW', 'TEST', 'DONE'],
    allowedClaims: [
      { claim: 'done-readiness', consumers: ['REVIEW', 'TEST', 'DONE'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Local delivery/final report evidence can support review discussion but is not release readiness.',
    remediation: DIAGNOSTIC_REMEDIATION,
  },
  {
    artifactKind: 'review-run',
    aliases: ['review-pass', 'finding'],
    scope: 'local-review-quorum',
    artifactRole: 'planning-review',
    temporalRole: 'current-state',
    producerBoundary: 'trusted-reviewer-owned',
    schemaVersions: ['lattice.review_run.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: true,
    temporalAndMaterialBindingRequired: true,
    allowedConsumers: ['REVIEW'],
    allowedClaims: [
      { claim: 'review-pass', consumers: ['REVIEW'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Reviewer-owned lane evidence may satisfy local review escalation only.',
    remediation: 'Start a fresh signed review run for the current round/material and consume it only in REVIEW.',
  },
  {
    artifactKind: 'legacy-authority-receipt-ref',
    aliases: ['legacy-authority-receipt-refs.json'],
    scope: 'legacy-authority-receipt',
    artifactRole: 'legacy-authority-decision',
    temporalRole: 'current-state',
    producerBoundary: 'legacy-authority-owned',
    schemaVersions: ['lattice.legacy_authority_receipt_refs.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: true,
    temporalAndMaterialBindingRequired: true,
    allowedConsumers: ['LEGACY_AUTHORITY_RECEIPT', 'TEST', 'DONE'],
    allowedClaims: [
      /**
       * @task B-91f3
       * @checklist CHK-001, CHK-002
       * @title Legacy authority receipt refs remain readable evidence, not local production completion
       * @type feature
       * @priority high
       * @description
       *   Legacy authority receipt refs may be classified as out-of-core compatibility input.
       *   The local proof-admissibility core must not convert that legacy evidence into a local release readiness claim.
       * @changes
       *   - [CHK-002] Set legacy-authority-receipt-ref production-completion productionDoneEligible=false for local CLI proof.
       */
      { claim: 'production-completion', consumers: ['LEGACY_AUTHORITY_RECEIPT', 'TEST', 'DONE'], productionDoneEligible: false },
      { claim: 'done-readiness', consumers: ['TEST', 'DONE'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Legacy out-of-core receipt refs are compatibility input only; local core does not claim production completion from them.',
    remediation: PRODUCTION_GATE_REMEDIATION,
  },
  {
    artifactKind: 'legacy-authority-receipt',
    scope: 'legacy-authority-receipt',
    artifactRole: 'legacy-authority-decision',
    temporalRole: 'current-state',
    producerBoundary: 'legacy-authority-owned',
    schemaVersions: ['lattice.legacy_authority_receipt.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: true,
    temporalAndMaterialBindingRequired: true,
    allowedConsumers: ['LEGACY_AUTHORITY_RECEIPT'],
    allowedClaims: [
      { claim: 'diagnostic-status', consumers: ['LEGACY_AUTHORITY_RECEIPT'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'A legacy out-of-core receipt is diagnostic compatibility input only; active local gates ignore it.',
    remediation: LEGACY_RECEIPT_REMEDIATION,
  },
  {
    artifactKind: 'offline-receipt-bundle',
    scope: 'local-key-single-host',
    artifactRole: 'local-diagnostic',
    temporalRole: 'current-state',
    producerBoundary: 'local-runtime-owned',
    schemaVersions: ['lattice.receipt_bundle.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: true,
    temporalAndMaterialBindingRequired: true,
    allowedConsumers: ['REVIEW', 'TEST', 'DONE'],
    allowedClaims: [
      { claim: 'diagnostic-status', consumers: ['REVIEW', 'TEST', 'DONE'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Offline local-key bundles are single-host evidence and must not be over-read as Authority proof.',
    remediation: DIAGNOSTIC_REMEDIATION,
  },
  {
    artifactKind: 'handoff-pack',
    aliases: ['handoff-receipt', 'dispatch-report', 'host-verdict'],
    scope: 'local-diagnostic',
    artifactRole: 'handoff-context',
    temporalRole: 'not-applicable',
    producerBoundary: 'local-runtime-owned',
    schemaVersions: ['lattice.handoff.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: false,
    allowedConsumers: ['HANDOFF', 'PLAN', 'REVIEW'],
    allowedClaims: [
      { claim: 'handoff-context', consumers: ['HANDOFF', 'PLAN', 'REVIEW'], productionDoneEligible: false },
      { claim: 'diagnostic-status', consumers: ['HANDOFF', 'PLAN', 'REVIEW'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Handoff output transfers context and candidate evidence; it never sets release readiness.',
    remediation: DIAGNOSTIC_REMEDIATION,
  },
  {
    artifactKind: 'usage-ledger-authority-evidence',
    scope: 'local-diagnostic',
    artifactRole: 'local-diagnostic',
    temporalRole: 'current-state',
    producerBoundary: 'local-runtime-owned',
    schemaVersions: ['lattice.usage_ledger_authority_evidence.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: true,
    allowedConsumers: ['REVIEW', 'TEST'],
    allowedClaims: [
      { claim: 'diagnostic-status', consumers: ['REVIEW', 'TEST'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Privacy-preserving usage evidence is local diagnostic evidence unless separately gate-consumed by Authority.',
    remediation: DIAGNOSTIC_REMEDIATION,
  },
  {
    artifactKind: 'repro-probe',
    scope: 'evidence-candidate',
    artifactRole: 'problem-observation',
    temporalRole: 'historical-baseline',
    producerBoundary: 'caller-writable',
    schemaVersions: ['lattice.evidence.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: false,
    allowedConsumers: ['STORY_INTAKE', 'PLAN'],
    allowedClaims: [
      { claim: 'historical-failure', consumers: ['STORY_INTAKE', 'PLAN'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'B-0aa1 Repro probe records candidate historical failure context only.',
    remediation: CANDIDATE_REMEDIATION,
  },
  {
    artifactKind: 'repro-review',
    scope: 'evidence-candidate',
    artifactRole: 'repro-validity-review',
    temporalRole: 'historical-baseline',
    producerBoundary: 'trusted-reviewer-owned',
    schemaVersions: ['lattice.evidence.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: false,
    allowedConsumers: ['STORY_INTAKE', 'PLAN'],
    allowedClaims: [
      { claim: 'historical-failure', consumers: ['STORY_INTAKE', 'PLAN'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Candidate repro review can validate intake framing but is not current verification evidence.',
    remediation: CANDIDATE_REMEDIATION,
  },
  {
    artifactKind: 'spike-record',
    scope: 'evidence-candidate',
    artifactRole: 'problem-observation',
    temporalRole: 'historical-baseline',
    producerBoundary: 'caller-writable',
    schemaVersions: ['lattice.evidence.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: false,
    allowedConsumers: ['STORY_INTAKE', 'PLAN'],
    allowedClaims: [
      { claim: 'historical-failure', consumers: ['STORY_INTAKE', 'PLAN'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Disposable spike record is candidate exploration evidence.',
    remediation: CANDIDATE_REMEDIATION,
  },
  {
    artifactKind: 'spike-review',
    scope: 'evidence-candidate',
    artifactRole: 'planning-review',
    temporalRole: 'historical-baseline',
    producerBoundary: 'trusted-reviewer-owned',
    schemaVersions: ['lattice.evidence.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: false,
    allowedConsumers: ['STORY_INTAKE', 'PLAN'],
    allowedClaims: [
      { claim: 'historical-failure', consumers: ['STORY_INTAKE', 'PLAN'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Spike review supports planning confidence only.',
    remediation: CANDIDATE_REMEDIATION,
  },
  {
    artifactKind: 'red-green-relation',
    scope: 'evidence-candidate',
    artifactRole: 'red-green-relation',
    temporalRole: 'transition-relation',
    producerBoundary: 'local-runtime-owned',
    schemaVersions: ['lattice.evidence.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: true,
    allowedConsumers: ['STORY_INTAKE', 'PLAN'],
    allowedClaims: [
      { claim: 'red-green-equivalence', consumers: ['STORY_INTAKE', 'PLAN'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Candidate relation evidence links baseline/current command intent for intake; it is not a current gate proof.',
    remediation: CANDIDATE_REMEDIATION,
  },
  {
    artifactKind: 'red-green-relation-evaluation',
    aliases: ['red-green-evaluation'],
    scope: 'evidence-candidate',
    artifactRole: 'red-green-relation',
    temporalRole: 'transition-relation',
    producerBoundary: 'local-runtime-owned',
    schemaVersions: ['lattice.evidence.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: true,
    allowedConsumers: ['STORY_INTAKE', 'PLAN'],
    allowedClaims: [
      { claim: 'red-green-equivalence', consumers: ['STORY_INTAKE', 'PLAN'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Derived evaluator result that records command/pattern relation outcome for intake planning.',
    remediation: CANDIDATE_REMEDIATION,
  },
  {
    artifactKind: 'regression-matrix-review',
    scope: 'evidence-candidate',
    artifactRole: 'regression-matrix-review',
    temporalRole: 'transition-relation',
    producerBoundary: 'trusted-reviewer-owned',
    schemaVersions: ['lattice.evidence.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: false,
    allowedConsumers: ['STORY_INTAKE', 'PLAN'],
    allowedClaims: [
      { claim: 'red-green-equivalence', consumers: ['STORY_INTAKE', 'PLAN'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Candidate regression matrix review supports intake only.',
    remediation: CANDIDATE_REMEDIATION,
  },
  {
    artifactKind: 'story-evidence-binding',
    scope: 'evidence-candidate',
    artifactRole: 'planning-input',
    temporalRole: 'not-applicable',
    producerBoundary: 'local-runtime-owned',
    schemaVersions: ['lattice.evidence.v1'],
    strictShapeRequired: true,
    semanticDigestRequired: true,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: false,
    allowedConsumers: ['STORY_INTAKE', 'PLAN'],
    allowedClaims: [
      { claim: 'handoff-context', consumers: ['STORY_INTAKE', 'PLAN'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Immutable link from candidate evidence to story id; it does not create verificationEvidence.',
    remediation: CANDIDATE_REMEDIATION,
  },
  {
    artifactKind: 'legacy-evidence',
    aliases: ['legacy-observed-evidence'],
    scope: 'legacy-observed',
    artifactRole: 'local-diagnostic',
    temporalRole: 'not-applicable',
    producerBoundary: 'legacy-unknown',
    schemaVersions: ['legacy'],
    strictShapeRequired: false,
    semanticDigestRequired: false,
    signatureOrReceiptBindingRequired: false,
    temporalAndMaterialBindingRequired: false,
    allowedConsumers: ['PLAN', 'REVIEW'],
    allowedClaims: [
      { claim: 'diagnostic-status', consumers: ['PLAN', 'REVIEW'], productionDoneEligible: false },
    ],
    producerBoundaryNote: 'Historical readable evidence missing the current contract.',
    remediation: 'Keep for audit or regenerate under a current proof policy before any gate claim.',
  },
] as const satisfies readonly ProofSurfaceDefinition[];

const registryByKind = new Map<string, ProofSurfaceDefinition>();
for (const definition of PROOF_SURFACE_REGISTRY) {
  registryByKind.set(definition.artifactKind, definition);
  const aliases = 'aliases' in definition ? definition.aliases : [];
  for (const alias of aliases) registryByKind.set(alias, definition);
}

export function listProofSurfaceDefinitions(): readonly ProofSurfaceDefinition[] {
  return PROOF_SURFACE_REGISTRY;
}

export function getProofSurfaceDefinition(artifactKind: string): ProofSurfaceDefinition | undefined {
  return registryByKind.get(artifactKind);
}

function addReason(
  reasons: AdmissibilityReasonCode[],
  remediation: string[],
  reason: AdmissibilityReasonCode,
  hint: string,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
  if (!remediation.includes(hint)) remediation.push(hint);
}

function requireCheck(
  checks: AdmissibilityChecks,
  field: keyof AdmissibilityChecks,
  reasons: AdmissibilityReasonCode[],
  remediation: string[],
  missingReason: AdmissibilityReasonCode,
  missingHint: string,
  invalidReason: AdmissibilityReasonCode,
  invalidHint: string,
): void {
  const value = checks[field];
  if (value === undefined) {
    addReason(reasons, remediation, missingReason, missingHint);
    return;
  }
  if (value !== true) {
    addReason(reasons, remediation, invalidReason, invalidHint);
  }
}

function defaultResult(input: EvaluateProofAdmissibilityInput): AdmissibilityResult {
  return {
    artifactKind: input.artifactKind,
    scope: 'unknown',
    artifactRole: 'unknown',
    temporalRole: 'unknown',
    producerBoundary: 'unknown',
    consumer: input.consumer,
    claim: input.claim,
    overall: 'fail',
    allowed: false,
    productionDoneEligible: false,
    reasons: ['missing_required_field'],
    remediation: ['Register the artifact kind in the proof admissibility registry before any consumer treats it as proof.'],
  };
}

export function evaluateProofAdmissibility(input: EvaluateProofAdmissibilityInput): AdmissibilityResult {
  const definition = getProofSurfaceDefinition(input.artifactKind);
  if (!definition) return defaultResult(input);

  const checks = input.checks ?? {};
  const reasons: AdmissibilityReasonCode[] = [];
  const remediation: string[] = [];
  const policy = definition.allowedClaims.find(
    claimPolicy => claimPolicy.claim === input.claim && claimPolicy.consumers.includes(input.consumer),
  );

  if (!definition.allowedConsumers.includes(input.consumer) || !policy) {
    addReason(
      reasons,
      remediation,
      'artifact_consumer_mismatch',
      `Use ${definition.artifactKind} only for consumers: ${definition.allowedConsumers.join(', ')}.`,
    );
  }

  if (checks.contractVersion == null) {
    addReason(reasons, remediation, 'missing_required_field', 'Evaluate the artifact with the current proof admissibility contract version.');
  } else if (checks.contractVersion !== PROOF_ADMISSIBILITY_CONTRACT_VERSION) {
    addReason(reasons, remediation, 'unsupported_contract_version', 'Evaluate the artifact with the current proof admissibility contract version.');
  }

  /**
   * @task B-fbfb
   * @checklist CHK-002, CHK-003
   * @title proof admissibility version convergence anchors
   * @type feature
   * @priority high
   * @description
   *   AND supportedSchemaVersion maps checks.schemaVersion to each registry schemaVersions list.
   *   AND supportedVerifierVersion maps checks.verifierVersion to PROOF_ADMISSIBILITY_VERIFIER_VERSION.
   *   AND supportedContractVersion maps checks.contractVersion to PROOF_ADMISSIBILITY_CONTRACT_VERSION.
   *   AND verifierVersionSupported is the ledger-consumption alias for AND supportedVerifierVersion.
   *   AND contractVersionSupported is the ledger-consumption alias for AND supportedContractVersion.
   *   unsupported_schema_version, unsupported_contract_version, and unsupported_verifier_version are deterministic proof-admissibility reason codes.
   * @changes
   *   - [CHK-002] Add AND supportedSchemaVersion, AND supportedVerifierVersion, AND supportedContractVersion, AND verifierVersionSupported, and AND contractVersionSupported implementation anchors.
   *   - [CHK-003] Bind unsupported_schema_version, unsupported_contract_version, and unsupported_verifier_version reason-code coverage to smoke tests.
   */
  if (checks.verifierVersion == null) {
    addReason(reasons, remediation, 'missing_required_field', 'Evaluate the artifact with the current proof admissibility verifier version.');
  } else if (checks.verifierVersion !== PROOF_ADMISSIBILITY_VERIFIER_VERSION) {
    addReason(reasons, remediation, 'unsupported_verifier_version', 'Evaluate the artifact with the current proof admissibility verifier version.');
  }

  if (checks.schemaVersion !== undefined && !definition.schemaVersions.includes(checks.schemaVersion)) {
    addReason(reasons, remediation, 'unsupported_schema_version', `Use one of the supported schema versions: ${definition.schemaVersions.join(', ')}.`);
  }

  if (checks.hasReservedProofKey === true) {
    addReason(reasons, remediation, 'reserved_key_detected', 'Strip caller-writable reserved proof keys and regenerate producer-owned proof fields.');
  }
  if (checks.storyMatches === false) {
    addReason(reasons, remediation, 'story_mismatch', 'Evaluate only proof bound to the requested story id.');
  }
  if (checks.gatePhaseMatches === false) {
    addReason(reasons, remediation, 'gate_phase_mismatch', 'Evaluate only proof bound to the requested lifecycle gate phase.');
  }
  if (checks.commandSpecDigestValid === false) {
    addReason(reasons, remediation, 'command_spec_digest_mismatch', 'Regenerate proof from the exact command specification consumed by this policy.');
  }
  if (checks.redGreenCommandsMatch === false) {
    addReason(reasons, remediation, 'red_green_command_mismatch', 'Bind red and green runs to the same command intent before claiming equivalence.');
  }
  if (checks.matrixGapWaived === false) {
    addReason(reasons, remediation, 'matrix_gap_unwaived', 'Resolve or explicitly waive the regression-matrix gap before consuming this proof.');
  }
  if (checks.bootstrapNoiseRejected === false) {
    addReason(reasons, remediation, 'bootstrap_noise', 'Classify bootstrap noise separately; it cannot satisfy target-bug proof claims.');
  }
  if (checks.hashTupleFresh === false) {
    addReason(reasons, remediation, 'stale_hash_tuple', 'Refresh proof against the current story/head/material hash tuple.');
  }

  if (checks.schemaVersion === undefined) {
    addReason(reasons, remediation, 'missing_required_field', `Provide a schemaVersion supported by ${definition.artifactKind}: ${definition.schemaVersions.join(', ')}.`);
  }

  if (definition.strictShapeRequired) {
    requireCheck(
      checks,
      'strictShapeValid',
      reasons,
      remediation,
      'missing_required_field',
      'Confirm the artifact strict shape before treating it as admissible proof.',
      'bad_shape',
      'Regenerate the artifact with the required strict shape and no unexpected proof fields.',
    );
  }
  if (definition.semanticDigestRequired) {
    requireCheck(
      checks,
      'semanticDigestValid',
      reasons,
      remediation,
      'missing_required_field',
      'Confirm the semantic digest before treating claim-consumed fields as proof.',
      'digest_mismatch',
      'Regenerate the artifact so all claim-consumed semantic fields are digest-bound.',
    );
  }
  if (definition.signatureOrReceiptBindingRequired) {
    requireCheck(
      checks,
      'signatureOrReceiptBindingValid',
      reasons,
      remediation,
      'signature_missing',
      'Verify the required signature or receipt binding before treating this artifact as proof.',
      'signature_invalid',
      'Verify or recreate the signature/receipt binding for this exact subject.',
    );
  }
  if (definition.temporalAndMaterialBindingRequired) {
    requireCheck(
      checks,
      'temporalAndMaterialBindingValid',
      reasons,
      remediation,
      'missing_required_field',
      'Confirm the current head/material/story-files tuple before treating this artifact as proof.',
      'stale_material',
      'Refresh the artifact for the current temporal role and head/material/story-files tuple.',
    );
  }

  if (!definition.scope.startsWith('legacy-')) {
    requireCheck(
      checks,
      'subjectMatches',
      reasons,
      remediation,
      'missing_required_field',
      'Confirm the artifact subject matches the requested story, gate, command, or candidate before treating it as proof.',
      'artifact_subject_mismatch',
      'Evaluate only artifacts bound to the requested story, gate, command, or candidate subject.',
    );
    requireCheck(
      checks,
      'producerBoundaryTrusted',
      reasons,
      remediation,
      'unknown_producer',
      'Confirm the artifact producer boundary before treating it as proof.',
      'producer_owned_required',
      definition.producerBoundaryNote,
    );
  }

  if (input.claim === 'production-completion' && definition.scope !== 'local-gate-evidence') {
    addReason(
      reasons,
      remediation,
      definition.scope === 'local-diagnostic' ? 'local_diagnostic_non_gate' : 'producer_owned_required',
      definition.remediation,
    );
  }
  if (definition.scope.startsWith('legacy-') && input.claim !== 'diagnostic-status') {
    addReason(reasons, remediation, 'legacy_downgrade', definition.remediation);
  }

  const allowed = Boolean(policy) && reasons.length === 0;
  const overall: AdmissibilityOverall = allowed ? 'pass' : 'fail';
  const productionDoneEligible = allowed && Boolean(policy?.productionDoneEligible) && definition.scope === 'local-gate-evidence';

  return {
    artifactKind: definition.artifactKind,
    scope: definition.scope,
    artifactRole: definition.artifactRole,
    temporalRole: definition.temporalRole,
    producerBoundary: definition.producerBoundary,
    consumer: input.consumer,
    claim: input.claim,
    overall,
    allowed,
    productionDoneEligible,
    reasons,
    remediation: remediation.length > 0 ? remediation : [definition.remediation],
    definition,
  };
}

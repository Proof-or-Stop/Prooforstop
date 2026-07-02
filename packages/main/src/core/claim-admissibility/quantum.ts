import { createHash } from 'node:crypto';

export const QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION = 'lattice.quantum_claim_admissibility.v1' as const;
export const QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION = 'lattice.quantum_claim_admissibility_verifier.v1' as const;

export const QUANTUM_RUNTIME_STATUS =
  'Quantum claim-admissibility runtime status: M0-M1 implemented; M2-M5 pending.' as const;

export const QUANTUM_BOUNDARY_PARAGRAPH =
  'Proof-or-Stop for computational quantum mechanics is a local claim-admissibility control layer. It checks whether a stated quantum-simulation claim has current, bound evidence before advancing; it does not prove quantum mechanics, validate physical systems or hardware, improve solvers, make production deployment claims, or act as Authority.';

export const QUANTUM_CLAIM_IDS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q11', 'Q12'] as const;
export type QuantumClaimId = typeof QUANTUM_CLAIM_IDS[number];

export const QUANTUM_EVIDENCE_KINDS = [
  'hamiltonian-freeze',
  'basis-grid-freeze',
  'initial-state-freeze',
  'solver-run',
  'energy-eigenvalue',
  'normalization',
  'unitarity',
  'invariant',
  'convergence',
  'reference-comparison',
  'reproducibility',
  'figure-table-provenance',
] as const;
export type QuantumEvidenceKind = typeof QUANTUM_EVIDENCE_KINDS[number];

export const QUANTUM_CORE_IDENTITY_FIELDS = [
  'codeHash',
  'solverConfigHash',
  'verifierScriptHash',
  'environmentHash',
  'outputDigest',
] as const;
export type QuantumCoreIdentityField = typeof QUANTUM_CORE_IDENTITY_FIELDS[number];

export const QUANTUM_CONDITIONAL_IDENTITY_FIELDS = [
  'hamiltonianHash',
  'potentialHash',
  'domainHash',
  'boundaryConditionHash',
  'initialStateHash',
  'basisSetHash',
  'gridHash',
  'discretizationHash',
  'timeStepHash',
  'tolerancePolicyHash',
  'randomSeed',
  'checkpointHash',
  'referenceDataHash',
  'plotScriptHash',
] as const;
export type QuantumConditionalIdentityField = typeof QUANTUM_CONDITIONAL_IDENTITY_FIELDS[number];

export const QUANTUM_CLAIM_SPECIFIC_FIELDS = ['sourceRunId', 'plotConfigHash', 'metricDefinitionHash'] as const;
export type QuantumClaimSpecificField = typeof QUANTUM_CLAIM_SPECIFIC_FIELDS[number];

export type QuantumIdentityField = QuantumCoreIdentityField | QuantumConditionalIdentityField | QuantumClaimSpecificField;

export interface QuantumEvidenceIdentity {
  codeHash: string;
  solverConfigHash: string;
  verifierScriptHash: string;
  environmentHash: string;
  outputDigest: string;
  hamiltonianHash?: string;
  potentialHash?: string;
  domainHash?: string;
  boundaryConditionHash?: string;
  initialStateHash?: string;
  basisSetHash?: string;
  gridHash?: string;
  discretizationHash?: string;
  timeStepHash?: string;
  tolerancePolicyHash?: string;
  randomSeed?: string;
  checkpointHash?: string;
  referenceDataHash?: string;
  plotScriptHash?: string;
  sourceRunId?: string;
  plotConfigHash?: string;
  metricDefinitionHash?: string;
}

export interface QuantumVerifierReceipt {
  evidenceKind: QuantumEvidenceKind | string;
  status: 'pass' | 'fail';
  exitCode: number;
  identity: Partial<QuantumEvidenceIdentity>;
  verifierScriptHash?: string;
  outputDigest?: string;
  observedAt?: string;
  stale?: boolean;
  note?: string;
}

export type QuantumRequestedStrength =
  | 'scoped'
  | 'ground-state'
  | 'convergence'
  | 'quantum-advantage'
  | 'theory'
  | 'hardware'
  | 'physical-validation'
  | 'solver-improvement'
  | 'production'
  | 'authority';

export interface QuantumClaimCheckInput {
  schemaVersion?: string;
  claimId: QuantumClaimId | string;
  activeIdentity?: Partial<QuantumEvidenceIdentity>;
  receipts?: QuantumVerifierReceipt[];
  narrativeClaim?: string;
  requestedStrength?: QuantumRequestedStrength;
  stochastic?: boolean;
  seedSensitive?: boolean;
  checkpointed?: boolean;
}

export interface QuantumArtifactIndexEntry {
  id: string;
  kind: string;
  digest: string;
}

export interface QuantumBoundaryBooleans {
  localOnly: true;
  scopedComputationalClaim: boolean;
  quantumTheoryClaim: false;
  physicalValidationClaim: false;
  hardwareValidationClaim: false;
  solverImprovementClaim: false;
  productionClaim: false;
  authorityClaim: false;
}

export interface QuantumClaimCheckResult {
  schemaVersion: typeof QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION;
  verifierVersion: typeof QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION;
  claimId: string;
  allowed: boolean;
  nextAction: 'advance' | 'repair' | 'degrade' | 'escalate' | 'stop';
  scopedClaim: boolean;
  reasons: string[];
  checkedReceipts: QuantumEvidenceKind[];
  missingReceipts: QuantumEvidenceKind[];
  requiredIdentityFields: QuantumIdentityField[];
  boundary: QuantumBoundaryBooleans;
  boundaryText: string;
  runtimeStatus: typeof QUANTUM_RUNTIME_STATUS;
  artifactIndex: QuantumArtifactIndexEntry[];
}

interface ClaimRequirements {
  receiptKinds: readonly QuantumEvidenceKind[];
  conditionalFields: readonly QuantumConditionalIdentityField[];
  claimSpecificFields?: readonly QuantumClaimSpecificField[];
  basisOrGrid?: boolean;
}

const CLAIM_REQUIREMENTS: Record<QuantumClaimId, ClaimRequirements> = {
  Q1: {
    receiptKinds: ['hamiltonian-freeze'],
    conditionalFields: ['hamiltonianHash', 'potentialHash', 'domainHash', 'boundaryConditionHash'],
  },
  Q2: {
    receiptKinds: ['basis-grid-freeze'],
    conditionalFields: ['discretizationHash', 'tolerancePolicyHash'],
    basisOrGrid: true,
  },
  Q3: {
    receiptKinds: ['initial-state-freeze'],
    conditionalFields: ['initialStateHash', 'tolerancePolicyHash'],
  },
  Q4: {
    receiptKinds: ['solver-run'],
    conditionalFields: ['hamiltonianHash'],
  },
  Q5: {
    receiptKinds: ['energy-eigenvalue'],
    conditionalFields: ['hamiltonianHash', 'potentialHash', 'domainHash', 'boundaryConditionHash', 'discretizationHash', 'tolerancePolicyHash'],
    basisOrGrid: true,
  },
  Q6: {
    receiptKinds: ['normalization'],
    conditionalFields: ['initialStateHash', 'tolerancePolicyHash'],
  },
  Q7: {
    receiptKinds: ['unitarity'],
    conditionalFields: ['initialStateHash', 'timeStepHash', 'tolerancePolicyHash'],
  },
  Q8: {
    receiptKinds: ['invariant'],
    conditionalFields: ['hamiltonianHash', 'tolerancePolicyHash'],
  },
  Q9: {
    receiptKinds: ['convergence'],
    conditionalFields: ['hamiltonianHash', 'discretizationHash', 'tolerancePolicyHash'],
    basisOrGrid: true,
  },
  Q10: {
    receiptKinds: ['reference-comparison'],
    conditionalFields: ['hamiltonianHash', 'referenceDataHash', 'tolerancePolicyHash'],
    claimSpecificFields: ['metricDefinitionHash'],
    basisOrGrid: true,
  },
  Q11: {
    receiptKinds: ['reproducibility'],
    conditionalFields: ['hamiltonianHash', 'tolerancePolicyHash'],
  },
  Q12: {
    receiptKinds: ['figure-table-provenance'],
    conditionalFields: ['plotScriptHash'],
    claimSpecificFields: ['sourceRunId', 'plotConfigHash'],
  },
};

const ALL_REASON_PREFIXES = [
  'unsupported_schema_version',
  'unknown_claim',
  'claim_boundary_violation',
  'missing_core_identity_field',
  'missing_conditional_identity_field',
  'missing_claim_field',
  'missing_basis_or_grid_identity',
  'missing_required_receipt',
  'duplicate_receipt',
  'receipt_exit_nonzero',
  'receipt_status_not_pass',
  'stale_evidence',
  'output_digest_missing',
  'unbound_solver_output',
  'unbound_plot_table',
  'verifier_script_mismatch',
  'identity_mismatch',
  'weak_evidence_overclaim',
] as const;
export type QuantumReasonPrefix = typeof ALL_REASON_PREFIXES[number];

const HARD_STOP_REASON_PREFIXES: readonly QuantumReasonPrefix[] = [
  'unknown_claim',
  'claim_boundary_violation',
  'missing_core_identity_field',
  'missing_conditional_identity_field',
  'missing_claim_field',
  'missing_basis_or_grid_identity',
  'missing_required_receipt',
  'duplicate_receipt',
  'receipt_exit_nonzero',
  'receipt_status_not_pass',
  'stale_evidence',
  'output_digest_missing',
  'unbound_solver_output',
  'unbound_plot_table',
  'verifier_script_mismatch',
  'identity_mismatch',
];

function isKnownClaim(claimId: string): claimId is QuantumClaimId {
  return (QUANTUM_CLAIM_IDS as readonly string[]).includes(claimId);
}

function isKnownEvidenceKind(evidenceKind: string): evidenceKind is QuantumEvidenceKind {
  return (QUANTUM_EVIDENCE_KINDS as readonly string[]).includes(evidenceKind);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function reason(code: QuantumReasonPrefix, subject?: string): string {
  return subject ? `${code}:${subject}` : code;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function quantumDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function demoHash(label: string): string {
  return quantumDigest({ demo: 'quantum-claim-admissibility', label });
}

function buildRequiredIdentityFields(input: QuantumClaimCheckInput, claimId: QuantumClaimId): QuantumIdentityField[] {
  const requirements = CLAIM_REQUIREMENTS[claimId];
  const fields: QuantumIdentityField[] = [...QUANTUM_CORE_IDENTITY_FIELDS, ...requirements.conditionalFields];
  if (requirements.basisOrGrid) {
    const identity = input.activeIdentity ?? {};
    if (hasField(identity, 'basisSetHash')) fields.push('basisSetHash');
    if (hasField(identity, 'gridHash')) fields.push('gridHash');
    if (!hasField(identity, 'basisSetHash') && !hasField(identity, 'gridHash')) fields.push('basisSetHash', 'gridHash');
  }
  if (input.stochastic === true || input.seedSensitive === true) fields.push('randomSeed');
  if (input.checkpointed === true) fields.push('checkpointHash');
  for (const field of requirements.claimSpecificFields ?? []) fields.push(field);
  return [...new Set(fields)];
}

function expectedReceiptKinds(claimId: QuantumClaimId): readonly QuantumEvidenceKind[] {
  return CLAIM_REQUIREMENTS[claimId].receiptKinds;
}

function boundaryViolation(input: QuantumClaimCheckInput): boolean {
  if (
    input.requestedStrength === 'theory'
    || input.requestedStrength === 'hardware'
    || input.requestedStrength === 'physical-validation'
    || input.requestedStrength === 'solver-improvement'
    || input.requestedStrength === 'production'
    || input.requestedStrength === 'authority'
  ) {
    return true;
  }
  const text = input.narrativeClaim ?? '';
  return /\b(proves?\s+quantum\s+mechanics|physical\s+validation|validated\s+physical\s+system|hardware\s+validated|solver\s+improvement|production\s+complete|authority\s+done)\b/i.test(text);
}

function requestedStrengthOverclaims(input: QuantumClaimCheckInput): string | undefined {
  if (input.claimId !== 'Q5') return undefined;
  if (
    input.requestedStrength === 'ground-state'
    || input.requestedStrength === 'convergence'
    || input.requestedStrength === 'quantum-advantage'
  ) {
    return input.requestedStrength;
  }
  return undefined;
}

function classifyNextAction(reasons: readonly string[]): QuantumClaimCheckResult['nextAction'] {
  if (reasons.length === 0) return 'advance';
  if (reasons.some((item) => item.startsWith('unsupported_schema_version'))) return 'escalate';
  if (reasons.some((item) => HARD_STOP_REASON_PREFIXES.some((prefix) => item === prefix || item.startsWith(`${prefix}:`)))) {
    return 'stop';
  }
  if (reasons.some((item) => item.startsWith('weak_evidence_overclaim'))) return 'degrade';
  return 'repair';
}

function artifactIndexFor(input: QuantumClaimCheckInput, checkedReceipts: readonly QuantumEvidenceKind[]): QuantumArtifactIndexEntry[] {
  return [
    { id: 'active-identity', kind: 'quantum-evidence-identity', digest: quantumDigest(input.activeIdentity ?? {}) },
    { id: 'checked-receipts', kind: 'quantum-evidence-kind-set', digest: quantumDigest(checkedReceipts) },
    { id: 'receipt-set', kind: 'quantum-verifier-receipts', digest: quantumDigest(input.receipts ?? []) },
  ];
}

function hasField(identity: Partial<QuantumEvidenceIdentity>, field: QuantumIdentityField): boolean {
  return isNonEmptyString(identity[field]);
}

function fieldValue(identity: Partial<QuantumEvidenceIdentity>, field: QuantumIdentityField): string | undefined {
  const value = identity[field];
  return isNonEmptyString(value) ? value : undefined;
}

function completeIdentity(): QuantumEvidenceIdentity {
  return {
    codeHash: demoHash('code:v1'),
    solverConfigHash: demoHash('solver-config:v1'),
    verifierScriptHash: demoHash('verifier-script:v1'),
    environmentHash: demoHash('environment:v1'),
    outputDigest: demoHash('output:v1'),
    hamiltonianHash: demoHash('hamiltonian:v1'),
    potentialHash: demoHash('potential:v1'),
    domainHash: demoHash('domain:v1'),
    boundaryConditionHash: demoHash('boundary-condition:v1'),
    initialStateHash: demoHash('initial-state:v1'),
    basisSetHash: demoHash('basis-set:v1'),
    gridHash: demoHash('grid:v1'),
    discretizationHash: demoHash('discretization:v1'),
    timeStepHash: demoHash('timestep:v1'),
    tolerancePolicyHash: demoHash('tolerance-policy:v1'),
    randomSeed: 'seed:20260702',
    checkpointHash: demoHash('checkpoint:v1'),
    referenceDataHash: demoHash('reference-data:v1'),
    plotScriptHash: demoHash('plot-script:v1'),
    sourceRunId: 'run:quantum-demo:v1',
    plotConfigHash: demoHash('plot-config:v1'),
    metricDefinitionHash: demoHash('metric-definition:v1'),
  };
}

function completeReceipt(evidenceKind: QuantumEvidenceKind, identity: QuantumEvidenceIdentity): QuantumVerifierReceipt {
  return {
    evidenceKind,
    status: 'pass',
    exitCode: 0,
    identity: { ...identity },
    verifierScriptHash: identity.verifierScriptHash,
    outputDigest: identity.outputDigest,
    observedAt: '2026-07-02T00:00:00.000Z',
  };
}

export function buildCompleteQuantumEvidence(claimId: QuantumClaimId = 'Q5'): QuantumClaimCheckInput {
  const activeIdentity = completeIdentity();
  return {
    schemaVersion: QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION,
    claimId,
    activeIdentity,
    receipts: expectedReceiptKinds(claimId).map((evidenceKind) => completeReceipt(evidenceKind, activeIdentity)),
    requestedStrength: 'scoped',
    narrativeClaim: 'Local scoped computational quantum claim with current bound evidence.',
  };
}

export function evaluateQuantumClaim(input: QuantumClaimCheckInput): QuantumClaimCheckResult {
  const reasons: string[] = [];
  const schemaVersion = input.schemaVersion ?? QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION;
  if (schemaVersion !== QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION) {
    reasons.push(reason('unsupported_schema_version', schemaVersion));
  }

  const claimId = String(input.claimId);
  if (!isKnownClaim(claimId)) {
    reasons.push(reason('unknown_claim', claimId));
  }
  if (boundaryViolation(input)) {
    reasons.push('claim_boundary_violation');
  }

  const identity = input.activeIdentity ?? {};
  for (const field of QUANTUM_CORE_IDENTITY_FIELDS) {
    if (!hasField(identity, field)) {
      reasons.push(reason('missing_core_identity_field', field));
    }
  }

  const requiredIdentityFields = isKnownClaim(claimId) ? buildRequiredIdentityFields(input, claimId) : [...QUANTUM_CORE_IDENTITY_FIELDS];
  if (isKnownClaim(claimId)) {
    const requirements = CLAIM_REQUIREMENTS[claimId];
    for (const field of requirements.conditionalFields) {
      if (!hasField(identity, field)) {
        reasons.push(reason('missing_conditional_identity_field', field));
      }
    }
    if (requirements.basisOrGrid && !hasField(identity, 'basisSetHash') && !hasField(identity, 'gridHash')) {
      reasons.push('missing_basis_or_grid_identity');
    }
    if ((input.stochastic === true || input.seedSensitive === true) && !hasField(identity, 'randomSeed')) {
      reasons.push(reason('missing_conditional_identity_field', 'randomSeed'));
    }
    if (input.checkpointed === true && !hasField(identity, 'checkpointHash')) {
      reasons.push(reason('missing_conditional_identity_field', 'checkpointHash'));
    }
    for (const field of requirements.claimSpecificFields ?? []) {
      if (!hasField(identity, field)) {
        reasons.push(reason('missing_claim_field', field));
      }
    }
  }

  const receiptByKind = new Map<QuantumEvidenceKind, QuantumVerifierReceipt>();
  for (const receipt of input.receipts ?? []) {
    const evidenceKind = String(receipt.evidenceKind);
    if (!isKnownEvidenceKind(evidenceKind)) continue;
    if (receiptByKind.has(evidenceKind)) {
      reasons.push(reason('duplicate_receipt', evidenceKind));
      continue;
    }
    receiptByKind.set(evidenceKind, receipt);
  }

  const checkedReceipts: QuantumEvidenceKind[] = [];
  const missingReceipts: QuantumEvidenceKind[] = [];
  const requiredReceipts = isKnownClaim(claimId) ? expectedReceiptKinds(claimId) : [];
  for (const evidenceKind of requiredReceipts) {
    const receipt = receiptByKind.get(evidenceKind);
    if (!receipt) {
      missingReceipts.push(evidenceKind);
      reasons.push(reason('missing_required_receipt', evidenceKind));
      continue;
    }
    checkedReceipts.push(evidenceKind);
    if (receipt.exitCode !== 0) reasons.push(reason('receipt_exit_nonzero', evidenceKind));
    if (receipt.status !== 'pass') reasons.push(reason('receipt_status_not_pass', evidenceKind));
    if (receipt.stale === true) reasons.push(reason('stale_evidence', evidenceKind));
    if (!isNonEmptyString(receipt.outputDigest)) reasons.push(reason('output_digest_missing', evidenceKind));
    if (evidenceKind === 'solver-run' && (!hasField(receipt.identity, 'outputDigest') || !isNonEmptyString(receipt.outputDigest))) {
      reasons.push('unbound_solver_output');
    }
    if (
      evidenceKind === 'figure-table-provenance'
      && (!hasField(receipt.identity, 'sourceRunId') || !hasField(receipt.identity, 'plotScriptHash') || !hasField(receipt.identity, 'plotConfigHash'))
    ) {
      reasons.push('unbound_plot_table');
    }
    if (!isNonEmptyString(receipt.verifierScriptHash) || receipt.verifierScriptHash !== fieldValue(identity, 'verifierScriptHash')) {
      reasons.push(reason('verifier_script_mismatch', evidenceKind));
    }
    for (const field of requiredIdentityFields) {
      const expected = fieldValue(identity, field);
      if (!expected) continue;
      if (fieldValue(receipt.identity, field) !== expected) {
        reasons.push(reason('identity_mismatch', `${evidenceKind}.${field}`));
      }
    }
  }

  const overclaim = requestedStrengthOverclaims(input);
  if (overclaim) {
    reasons.push(reason('weak_evidence_overclaim', overclaim));
  }

  const uniqueReasons = [...new Set(reasons)];
  const nextAction = classifyNextAction(uniqueReasons);
  const scopedClaim = uniqueReasons.length === 0 || nextAction === 'degrade';
  return {
    schemaVersion: QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION,
    verifierVersion: QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
    claimId,
    allowed: uniqueReasons.length === 0,
    nextAction,
    scopedClaim,
    reasons: uniqueReasons,
    checkedReceipts,
    missingReceipts,
    requiredIdentityFields,
    boundary: {
      localOnly: true,
      scopedComputationalClaim: scopedClaim,
      quantumTheoryClaim: false,
      physicalValidationClaim: false,
      hardwareValidationClaim: false,
      solverImprovementClaim: false,
      productionClaim: false,
      authorityClaim: false,
    },
    boundaryText: QUANTUM_BOUNDARY_PARAGRAPH,
    runtimeStatus: QUANTUM_RUNTIME_STATUS,
    artifactIndex: artifactIndexFor(input, checkedReceipts),
  };
}

export function renderQuantumClaimCheckText(result: QuantumClaimCheckResult): string {
  return [
    `Quantum claim check (${result.schemaVersion})`,
    result.runtimeStatus,
    `claimId: ${result.claimId}`,
    `allowed: ${result.allowed}`,
    `nextAction: ${result.nextAction}`,
    `scopedClaim: ${result.scopedClaim}`,
    `reasons: ${result.reasons.join(', ') || 'none'}`,
    `checkedReceipts: ${result.checkedReceipts.join(', ') || 'none'}`,
    `missingReceipts: ${result.missingReceipts.join(', ') || 'none'}`,
    `quantumTheoryClaim: ${result.boundary.quantumTheoryClaim}`,
    `physicalValidationClaim: ${result.boundary.physicalValidationClaim}`,
    `hardwareValidationClaim: ${result.boundary.hardwareValidationClaim}`,
    `solverImprovementClaim: ${result.boundary.solverImprovementClaim}`,
    `productionClaim: ${result.boundary.productionClaim}`,
    `authorityClaim: ${result.boundary.authorityClaim}`,
    result.boundaryText,
  ].join('\n');
}

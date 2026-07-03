import { createHash } from 'node:crypto';

export const QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION = 'lattice.quantum_claim_admissibility.v1' as const;
export const QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION = 'lattice.quantum_claim_admissibility_verifier.v1' as const;
export const QUANTUM_VERIFIER_ADAPTER_OUTPUT_VERSION = 'lattice.quantum_verifier_adapter_output.v1' as const;
export const QUANTUM_CLAIM_GATE_POLICY_SCHEMA_VERSION = 'lattice.quantum_claim_gate_policy.v1' as const;

export const QUANTUM_RUNTIME_STATUS =
  'Quantum claim-admissibility runtime status: M0-M3 implemented; M4-M5 pending.' as const;

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

export type QuantumVerifierAdapterId =
  | 'quantum.hamiltonian-spec'
  | 'quantum.basis-grid'
  | 'quantum.solver-output'
  | 'quantum.normalization'
  | 'quantum.unitarity-probability-conservation'
  | 'quantum.convergence'
  | 'quantum.reference-comparison'
  | 'quantum.reproducibility'
  | 'quantum.figure-table-provenance';

export interface QuantumVerifierAdapterClaimBoundary {
  readonly localOnly: true;
  readonly scopedComputationalClaim: true;
  readonly quantumTheoryClaim: false;
  readonly physicalValidationClaim: false;
  readonly hardwareValidationClaim: false;
  readonly solverImprovementClaim: false;
  readonly productionClaim: false;
  readonly authorityClaim: false;
}

export interface QuantumVerifierAdapterEvidenceProfile {
  readonly evidenceKind: QuantumEvidenceKind;
  readonly claimIds: readonly QuantumClaimId[];
  readonly requiredIdentityFields: readonly QuantumIdentityField[];
  readonly requiresBasisOrGrid?: boolean;
}

export interface QuantumVerifierAdapterDescriptor {
  readonly id: QuantumVerifierAdapterId;
  readonly version: typeof QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION;
  readonly displayName: string;
  readonly description: string;
  readonly executionBoundary: 'read-receipt-only';
  readonly supportedOutputVersions: readonly [typeof QUANTUM_VERIFIER_ADAPTER_OUTPUT_VERSION];
  readonly evidenceProfiles: readonly QuantumVerifierAdapterEvidenceProfile[];
  readonly claimBoundary: QuantumVerifierAdapterClaimBoundary;
}

export interface QuantumVerifierAdapterOutput {
  readonly adapterId: QuantumVerifierAdapterId | string;
  readonly outputVersion: typeof QUANTUM_VERIFIER_ADAPTER_OUTPUT_VERSION | string;
  readonly evidenceKind: QuantumEvidenceKind | string;
  readonly status: 'pass' | 'fail';
  readonly exitCode: number;
  readonly identity?: Partial<QuantumEvidenceIdentity>;
  readonly verifierScriptHash?: string;
  readonly outputDigest?: string;
  readonly observedAt?: string;
  readonly stale?: boolean;
  readonly note?: string;
}

export type QuantumVerifierNormalizationFailureCode =
  | 'unknown_adapter_id'
  | 'unsupported_output_version'
  | 'unsupported_evidence_kind'
  | 'missing_output_identity'
  | 'missing_active_identity'
  | 'missing_basis_or_grid_identity'
  | 'identity_mismatch'
  | 'stale_output'
  | 'output_status_not_pass'
  | 'output_exit_nonzero'
  | 'verifier_script_mismatch'
  | 'output_digest_missing'
  | 'output_digest_mismatch';

export type QuantumVerifierNormalizationResult =
  | {
      readonly ok: true;
      readonly status: 'normalized';
      readonly adapterId: QuantumVerifierAdapterId;
      readonly evidenceKind: QuantumEvidenceKind;
      readonly receipt: QuantumVerifierReceipt;
    }
  | {
      readonly ok: false;
      readonly status: 'blocked';
      readonly adapterId?: string;
      readonly evidenceKind?: string;
      readonly reason: QuantumVerifierNormalizationFailureCode;
      readonly reasons: readonly string[];
    };

export const QUANTUM_REQUESTED_STRENGTHS = [
  'scoped',
  'ground-state',
  'convergence',
  'quantum-advantage',
  'theory',
  'hardware',
  'physical-validation',
  'solver-improvement',
  'production',
  'authority',
] as const;
export type QuantumRequestedStrength = typeof QUANTUM_REQUESTED_STRENGTHS[number];

export const QUANTUM_CLAIM_CHECK_CASES = [
  'complete',
  'weak',
  'degraded',
  'stale',
  'missing',
  'mismatched',
  'unbound',
  'overclaim',
] as const;
export type QuantumClaimCheckCase = typeof QUANTUM_CLAIM_CHECK_CASES[number];

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

export type QuantumGatePolicyDecision = 'advance' | 'repair' | 'degrade' | 'escalate' | 'stop';

export interface QuantumClaimGatePolicyResult {
  schemaVersion: typeof QUANTUM_CLAIM_GATE_POLICY_SCHEMA_VERSION;
  claimCheckSchemaVersion: typeof QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION;
  verifierVersion: typeof QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION;
  claimId: string;
  decision: QuantumGatePolicyDecision;
  allowed: boolean;
  transition: 'claim-admissibility';
  localOnly: true;
  localClaimAdmissibilityOnly: true;
  writesLifecycleEvidence: false;
  mutatesLifecycle: false;
  sourceNextAction: QuantumClaimCheckResult['nextAction'];
  scopedClaim: boolean;
  degradedClaimAvailable: boolean;
  reasons: string[];
  checkedReceipts: QuantumEvidenceKind[];
  missingReceipts: QuantumEvidenceKind[];
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
  'missing_receipt_identity',
  'output_digest_missing',
  'output_digest_mismatch',
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
  'missing_receipt_identity',
  'output_digest_missing',
  'output_digest_mismatch',
  'unbound_solver_output',
  'unbound_plot_table',
  'verifier_script_mismatch',
  'identity_mismatch',
];

function isKnownClaim(claimId: string): claimId is QuantumClaimId {
  return (QUANTUM_CLAIM_IDS as readonly string[]).includes(claimId);
}

function assertKnownClaim(claimId: string): asserts claimId is QuantumClaimId {
  if (!isKnownClaim(claimId)) {
    throw new Error(`Unknown quantum claimId: ${claimId}. Expected one of ${QUANTUM_CLAIM_IDS.join(', ')}.`);
  }
}

function isKnownEvidenceKind(evidenceKind: string): evidenceKind is QuantumEvidenceKind {
  return (QUANTUM_EVIDENCE_KINDS as readonly string[]).includes(evidenceKind);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const TRUEISH_OVERCLAIM_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);

const QUANTUM_DIRECT_BOUNDARY_CLAIM_FIELDS = [
  'quantumTheoryClaim',
  'physicalValidationClaim',
  'hardwareValidationClaim',
  'solverImprovementClaim',
  'productionClaim',
  'authorityClaim',
  'productionReadyClaim',
] as const;

const QUANTUM_BOUNDARY_FIELD_OVERCLAIM_PATTERN = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9_])["']?(?:${QUANTUM_DIRECT_BOUNDARY_CLAIM_FIELDS.join('|')})["']?\s*[:=]\s*(?:true|1|yes|y|on)\b`,
  'i',
);

const QUANTUM_CLAIM_BOUNDARY_NARRATIVE_OVERCLAIM_PATTERN =
  /\b(?:(?:proves?|proved|proven|verifies?|verified|validates?|validated|guarantees?|guaranteed)\s+(?:quantum\s+(?:mechanics|theory)|physical\s+(?:system|reality)|hardware|laboratory|lab)|(?:quantum\s+(?:mechanics|theory)|physical\s+(?:system|validation|reality)|hardware|laboratory|lab)\s+(?:is\s+)?(?:proved|proven|verified|validated|guaranteed|complete)|(?:hardware|physical|laboratory|lab)\s+validation\s+(?:proved|proven|verified|validated|guaranteed|complete)|solver\s+(?:improvement|quality|improved|optimized|optimal)|(?:production|authority|external|terminal)\s+(?:done|complete|completion|ready|readiness)|ready\s+for\s+production|production-ready)\b/i;

function isUnsafeBoundaryOverclaimValue(value: unknown): boolean {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value !== 'string') return false;
  return TRUEISH_OVERCLAIM_VALUES.has(value.trim().toLowerCase());
}

function boundaryViolationReasons(input: QuantumClaimCheckInput): string[] {
  const violations: string[] = [];
  if (
    input.requestedStrength === 'theory'
    || input.requestedStrength === 'hardware'
    || input.requestedStrength === 'physical-validation'
    || input.requestedStrength === 'solver-improvement'
    || input.requestedStrength === 'production'
    || input.requestedStrength === 'authority'
  ) {
    violations.push(`requestedStrength.${input.requestedStrength}`);
  }

  const record = input as unknown as Record<string, unknown>;
  for (const field of QUANTUM_DIRECT_BOUNDARY_CLAIM_FIELDS) {
    if (isUnsafeBoundaryOverclaimValue(record[field])) violations.push(field);
  }

  const text = input.narrativeClaim ?? '';
  if (
    text !== ''
    && (
      QUANTUM_BOUNDARY_FIELD_OVERCLAIM_PATTERN.test(text)
      || QUANTUM_CLAIM_BOUNDARY_NARRATIVE_OVERCLAIM_PATTERN.test(text)
    )
  ) {
    violations.push('narrativeClaim');
  }

  return [...new Set(violations)];
}

function reason(code: QuantumReasonPrefix, subject?: string): string {
  return subject ? `${code}:${subject}` : code;
}

function normalizationReason(code: QuantumVerifierNormalizationFailureCode, subject?: string): string {
  return subject ? `${code}:${subject}` : code;
}

const QUANTUM_VERIFIER_ADAPTER_CLAIM_BOUNDARY: QuantumVerifierAdapterClaimBoundary = Object.freeze({
  localOnly: true,
  scopedComputationalClaim: true,
  quantumTheoryClaim: false,
  physicalValidationClaim: false,
  hardwareValidationClaim: false,
  solverImprovementClaim: false,
  productionClaim: false,
  authorityClaim: false,
});

function freezeQuantumEvidenceProfile(profile: QuantumVerifierAdapterEvidenceProfile): QuantumVerifierAdapterEvidenceProfile {
  return Object.freeze({
    ...profile,
    claimIds: Object.freeze([...profile.claimIds]),
    requiredIdentityFields: Object.freeze([...profile.requiredIdentityFields]),
  });
}

function defineQuantumVerifierAdapter(
  descriptor: Omit<QuantumVerifierAdapterDescriptor, 'claimBoundary' | 'supportedOutputVersions' | 'evidenceProfiles'>
    & { readonly evidenceProfiles: readonly QuantumVerifierAdapterEvidenceProfile[] },
): QuantumVerifierAdapterDescriptor {
  return Object.freeze({
    ...descriptor,
    supportedOutputVersions: Object.freeze([QUANTUM_VERIFIER_ADAPTER_OUTPUT_VERSION]) as readonly [typeof QUANTUM_VERIFIER_ADAPTER_OUTPUT_VERSION],
    evidenceProfiles: Object.freeze(descriptor.evidenceProfiles.map((profile) => freezeQuantumEvidenceProfile(profile))),
    claimBoundary: QUANTUM_VERIFIER_ADAPTER_CLAIM_BOUNDARY,
  });
}

export const QUANTUM_VERIFIER_ADAPTER_DESCRIPTORS: readonly QuantumVerifierAdapterDescriptor[] = Object.freeze([
  defineQuantumVerifierAdapter({
    id: 'quantum.hamiltonian-spec',
    version: QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
    displayName: 'Hamiltonian/spec verifier adapter',
    description: 'Descriptor for hash-bound Hamiltonian, potential, domain, and boundary-condition freeze receipts.',
    executionBoundary: 'read-receipt-only',
    evidenceProfiles: [
      {
        evidenceKind: 'hamiltonian-freeze',
        claimIds: ['Q1'],
        requiredIdentityFields: ['hamiltonianHash', 'potentialHash', 'domainHash', 'boundaryConditionHash'],
      },
    ],
  }),
  defineQuantumVerifierAdapter({
    id: 'quantum.basis-grid',
    version: QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
    displayName: 'Basis/grid verifier adapter',
    description: 'Descriptor for basis, grid, discretization, and tolerance-policy freeze receipts.',
    executionBoundary: 'read-receipt-only',
    evidenceProfiles: [
      {
        evidenceKind: 'basis-grid-freeze',
        claimIds: ['Q2'],
        requiredIdentityFields: ['discretizationHash', 'tolerancePolicyHash'],
        requiresBasisOrGrid: true,
      },
    ],
  }),
  defineQuantumVerifierAdapter({
    id: 'quantum.solver-output',
    version: QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
    displayName: 'Solver output verifier adapter',
    description: 'Descriptor for solver-run and energy/eigenvalue output receipts bound to the active computational identity.',
    executionBoundary: 'read-receipt-only',
    evidenceProfiles: [
      {
        evidenceKind: 'solver-run',
        claimIds: ['Q4'],
        requiredIdentityFields: ['hamiltonianHash'],
      },
      {
        evidenceKind: 'energy-eigenvalue',
        claimIds: ['Q5'],
        requiredIdentityFields: [
          'hamiltonianHash',
          'potentialHash',
          'domainHash',
          'boundaryConditionHash',
          'discretizationHash',
          'tolerancePolicyHash',
        ],
        requiresBasisOrGrid: true,
      },
    ],
  }),
  defineQuantumVerifierAdapter({
    id: 'quantum.normalization',
    version: QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
    displayName: 'Normalization verifier adapter',
    description: 'Descriptor for wavefunction or state-vector normalization receipts.',
    executionBoundary: 'read-receipt-only',
    evidenceProfiles: [
      {
        evidenceKind: 'normalization',
        claimIds: ['Q6'],
        requiredIdentityFields: ['initialStateHash', 'tolerancePolicyHash'],
      },
    ],
  }),
  defineQuantumVerifierAdapter({
    id: 'quantum.unitarity-probability-conservation',
    version: QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
    displayName: 'Unitarity/probability-conservation verifier adapter',
    description: 'Descriptor for timestep-bound norm-drift and probability-conservation receipts.',
    executionBoundary: 'read-receipt-only',
    evidenceProfiles: [
      {
        evidenceKind: 'unitarity',
        claimIds: ['Q7'],
        requiredIdentityFields: ['initialStateHash', 'timeStepHash', 'tolerancePolicyHash'],
      },
    ],
  }),
  defineQuantumVerifierAdapter({
    id: 'quantum.convergence',
    version: QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
    displayName: 'Convergence verifier adapter',
    description: 'Descriptor for grid or basis refinement receipts scoped to declared tolerances.',
    executionBoundary: 'read-receipt-only',
    evidenceProfiles: [
      {
        evidenceKind: 'convergence',
        claimIds: ['Q9'],
        requiredIdentityFields: ['hamiltonianHash', 'discretizationHash', 'tolerancePolicyHash'],
        requiresBasisOrGrid: true,
      },
    ],
  }),
  defineQuantumVerifierAdapter({
    id: 'quantum.reference-comparison',
    version: QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
    displayName: 'Reference comparison verifier adapter',
    description: 'Descriptor for baseline/reference comparison receipts bound to shared metrics and identities.',
    executionBoundary: 'read-receipt-only',
    evidenceProfiles: [
      {
        evidenceKind: 'reference-comparison',
        claimIds: ['Q10'],
        requiredIdentityFields: ['hamiltonianHash', 'referenceDataHash', 'tolerancePolicyHash', 'metricDefinitionHash'],
        requiresBasisOrGrid: true,
      },
    ],
  }),
  defineQuantumVerifierAdapter({
    id: 'quantum.reproducibility',
    version: QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
    displayName: 'Reproducibility verifier adapter',
    description: 'Descriptor for rerun/stability receipts under the same solver identity and tolerance policy.',
    executionBoundary: 'read-receipt-only',
    evidenceProfiles: [
      {
        evidenceKind: 'reproducibility',
        claimIds: ['Q11'],
        requiredIdentityFields: ['hamiltonianHash', 'tolerancePolicyHash'],
      },
    ],
  }),
  defineQuantumVerifierAdapter({
    id: 'quantum.figure-table-provenance',
    version: QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
    displayName: 'Figure/table provenance verifier adapter',
    description: 'Descriptor for plot/table receipts bound to source run, plot script, and plot configuration identity.',
    executionBoundary: 'read-receipt-only',
    evidenceProfiles: [
      {
        evidenceKind: 'figure-table-provenance',
        claimIds: ['Q12'],
        requiredIdentityFields: ['plotScriptHash', 'sourceRunId', 'plotConfigHash'],
      },
    ],
  }),
]);

export function listQuantumVerifierAdapterDescriptors(): readonly QuantumVerifierAdapterDescriptor[] {
  return QUANTUM_VERIFIER_ADAPTER_DESCRIPTORS;
}

export function getQuantumVerifierAdapterDescriptor(id: string): QuantumVerifierAdapterDescriptor | undefined {
  return QUANTUM_VERIFIER_ADAPTER_DESCRIPTORS.find((adapter) => adapter.id === id);
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

function hasField(identity: unknown, field: QuantumIdentityField): boolean {
  return fieldValue(identity, field) !== undefined;
}

function fieldValue(identity: unknown, field: QuantumIdentityField): string | undefined {
  if (!isRecord(identity)) return undefined;
  const value = identity[field];
  return isNonEmptyString(value) ? value : undefined;
}

function normalizationBlocked(
  code: QuantumVerifierNormalizationFailureCode,
  options: {
    readonly adapterId?: string;
    readonly evidenceKind?: string;
    readonly subject?: string;
  } = {},
): QuantumVerifierNormalizationResult {
  return Object.freeze({
    ok: false,
    status: 'blocked',
    adapterId: options.adapterId,
    evidenceKind: options.evidenceKind,
    reason: code,
    reasons: Object.freeze([normalizationReason(code, options.subject ?? options.evidenceKind ?? options.adapterId)]),
  });
}

function evidenceProfileFor(
  adapter: QuantumVerifierAdapterDescriptor,
  evidenceKind: string,
): QuantumVerifierAdapterEvidenceProfile | undefined {
  if (!isKnownEvidenceKind(evidenceKind)) return undefined;
  return adapter.evidenceProfiles.find((profile) => profile.evidenceKind === evidenceKind);
}

function hasBasisOrGridIdentity(identity: unknown): boolean {
  return Boolean(fieldValue(identity, 'basisSetHash') || fieldValue(identity, 'gridHash'));
}

function identityFieldsForProfile(
  profile: QuantumVerifierAdapterEvidenceProfile,
  activeIdentity: Partial<QuantumEvidenceIdentity> | undefined,
): readonly QuantumIdentityField[] {
  const fields: QuantumIdentityField[] = [...QUANTUM_CORE_IDENTITY_FIELDS, ...profile.requiredIdentityFields];
  if (profile.requiresBasisOrGrid === true) {
    if (fieldValue(activeIdentity, 'basisSetHash')) fields.push('basisSetHash');
    if (fieldValue(activeIdentity, 'gridHash')) fields.push('gridHash');
  }
  return [...new Set(fields)];
}

function normalizationFieldSubject(evidenceKind: string, field: QuantumIdentityField): string {
  return `${evidenceKind}.${field}`;
}

export function normalizeQuantumVerifierAdapterOutput(
  output: QuantumVerifierAdapterOutput,
  activeIdentity: Partial<QuantumEvidenceIdentity> | undefined,
): QuantumVerifierNormalizationResult {
  const adapterId = String(output.adapterId);
  const evidenceKind = String(output.evidenceKind);
  const adapter = getQuantumVerifierAdapterDescriptor(adapterId);
  if (!adapter) {
    return normalizationBlocked('unknown_adapter_id', { adapterId });
  }

  if (!adapter.supportedOutputVersions.includes(output.outputVersion as typeof QUANTUM_VERIFIER_ADAPTER_OUTPUT_VERSION)) {
    return normalizationBlocked('unsupported_output_version', {
      adapterId,
      evidenceKind,
      subject: String(output.outputVersion),
    });
  }

  const profile = evidenceProfileFor(adapter, evidenceKind);
  if (!profile) {
    return normalizationBlocked('unsupported_evidence_kind', { adapterId, evidenceKind });
  }

  if (output.status !== 'pass') {
    return normalizationBlocked('output_status_not_pass', { adapterId, evidenceKind });
  }
  if (output.exitCode !== 0) {
    return normalizationBlocked('output_exit_nonzero', { adapterId, evidenceKind });
  }
  if (output.stale === true) {
    return normalizationBlocked('stale_output', { adapterId, evidenceKind });
  }

  const outputIdentity = output.identity;
  if (!isRecord(outputIdentity)) {
    return normalizationBlocked('missing_output_identity', { adapterId, evidenceKind });
  }

  if (profile.requiresBasisOrGrid === true) {
    if (!hasBasisOrGridIdentity(activeIdentity)) {
      return normalizationBlocked('missing_basis_or_grid_identity', {
        adapterId,
        evidenceKind,
        subject: `${evidenceKind}.active`,
      });
    }
    if (!hasBasisOrGridIdentity(outputIdentity)) {
      return normalizationBlocked('missing_basis_or_grid_identity', {
        adapterId,
        evidenceKind,
        subject: `${evidenceKind}.output`,
      });
    }
  }

  for (const field of identityFieldsForProfile(profile, activeIdentity)) {
    if (field === 'verifierScriptHash' || field === 'outputDigest') continue;
    const activeValue = fieldValue(activeIdentity, field);
    const outputValue = fieldValue(outputIdentity, field);
    if (!activeValue) {
      return normalizationBlocked('missing_active_identity', {
        adapterId,
        evidenceKind,
        subject: normalizationFieldSubject(evidenceKind, field),
      });
    }
    if (!outputValue) {
      return normalizationBlocked('missing_output_identity', {
        adapterId,
        evidenceKind,
        subject: normalizationFieldSubject(evidenceKind, field),
      });
    }
    if (activeValue !== outputValue) {
      return normalizationBlocked('identity_mismatch', {
        adapterId,
        evidenceKind,
        subject: normalizationFieldSubject(evidenceKind, field),
      });
    }
  }

  const activeVerifierScriptHash = fieldValue(activeIdentity, 'verifierScriptHash');
  const identityVerifierScriptHash = fieldValue(outputIdentity, 'verifierScriptHash');
  const outputVerifierScriptHash = isNonEmptyString(output.verifierScriptHash) ? output.verifierScriptHash : undefined;
  if (
    !activeVerifierScriptHash
    || !identityVerifierScriptHash
    || !outputVerifierScriptHash
    || activeVerifierScriptHash !== identityVerifierScriptHash
    || activeVerifierScriptHash !== outputVerifierScriptHash
  ) {
    return normalizationBlocked('verifier_script_mismatch', { adapterId, evidenceKind });
  }

  const activeOutputDigest = fieldValue(activeIdentity, 'outputDigest');
  const identityOutputDigest = fieldValue(outputIdentity, 'outputDigest');
  const outputDigest = isNonEmptyString(output.outputDigest) ? output.outputDigest : undefined;
  if (!activeOutputDigest || !identityOutputDigest || !outputDigest) {
    return normalizationBlocked('output_digest_missing', { adapterId, evidenceKind });
  }
  if (activeOutputDigest !== identityOutputDigest || activeOutputDigest !== outputDigest) {
    return normalizationBlocked('output_digest_mismatch', { adapterId, evidenceKind });
  }

  return Object.freeze({
    ok: true,
    status: 'normalized',
    adapterId: adapter.id,
    evidenceKind: profile.evidenceKind,
    receipt: Object.freeze({
      evidenceKind: profile.evidenceKind,
      status: 'pass',
      exitCode: 0,
      identity: Object.freeze({ ...output.identity }),
      verifierScriptHash: outputVerifierScriptHash,
      outputDigest,
      observedAt: output.observedAt,
      note: output.note,
    }),
  });
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
  const knownClaimId = String(claimId);
  assertKnownClaim(knownClaimId);
  const activeIdentity = completeIdentity();
  return {
    schemaVersion: QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION,
    claimId: knownClaimId,
    activeIdentity,
    receipts: expectedReceiptKinds(knownClaimId).map((evidenceKind) => completeReceipt(evidenceKind, activeIdentity)),
    requestedStrength: 'scoped',
    narrativeClaim: 'Local scoped computational quantum claim with current bound evidence.',
  };
}

export function buildQuantumClaimCheckCase(
  caseName: QuantumClaimCheckCase = 'complete',
  claimId: QuantumClaimId = 'Q5',
): QuantumClaimCheckInput {
  const knownClaimId = String(claimId);
  assertKnownClaim(knownClaimId);
  if (caseName === 'complete') return buildCompleteQuantumEvidence(knownClaimId);

  if (caseName === 'weak' || caseName === 'degraded') {
    const input = buildCompleteQuantumEvidence('Q5');
    input.requestedStrength = 'ground-state';
    input.narrativeClaim = 'A single bound Q5 energy receipt is being asked to prove a stronger ground-state result.';
    return input;
  }

  if (caseName === 'stale') {
    const input = buildCompleteQuantumEvidence('Q5');
    if (input.receipts?.[0]) input.receipts[0].stale = true;
    return input;
  }

  if (caseName === 'missing') {
    const input = buildCompleteQuantumEvidence('Q5');
    input.receipts = [];
    return input;
  }

  if (caseName === 'mismatched') {
    const input = buildCompleteQuantumEvidence('Q5');
    if (input.receipts?.[0]) {
      input.receipts[0].identity.hamiltonianHash = 'sha256:mismatched-hamiltonian';
    }
    return input;
  }

  if (caseName === 'unbound') {
    const input = buildCompleteQuantumEvidence('Q4');
    if (input.receipts?.[0]) {
      delete input.receipts[0].identity.outputDigest;
      delete input.receipts[0].outputDigest;
    }
    return input;
  }

  const input = buildCompleteQuantumEvidence('Q5');
  input.requestedStrength = 'production';
  input.narrativeClaim = 'productionClaim: true; authorityClaim: true; hardware validation complete; quantum theory proven.';
  const unsafeRecord = input as unknown as Record<string, unknown>;
  unsafeRecord.productionClaim = true;
  unsafeRecord.authorityClaim = true;
  return input;
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
  for (const violation of boundaryViolationReasons(input)) {
    reasons.push(reason('claim_boundary_violation', violation));
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
    const receiptIdentity = isRecord(receipt.identity) ? receipt.identity : undefined;
    if (!receiptIdentity) {
      reasons.push(reason('missing_receipt_identity', evidenceKind));
    }
    if (receipt.exitCode !== 0) reasons.push(reason('receipt_exit_nonzero', evidenceKind));
    if (receipt.status !== 'pass') reasons.push(reason('receipt_status_not_pass', evidenceKind));
    if (receipt.stale === true) reasons.push(reason('stale_evidence', evidenceKind));
    const receiptIdentityOutputDigest = fieldValue(receiptIdentity, 'outputDigest');
    const receiptOutputDigest = isNonEmptyString(receipt.outputDigest) ? receipt.outputDigest : undefined;
    if (!receiptOutputDigest || !receiptIdentityOutputDigest) reasons.push(reason('output_digest_missing', evidenceKind));
    if (receiptOutputDigest && receiptIdentityOutputDigest && receiptOutputDigest !== receiptIdentityOutputDigest) {
      reasons.push(reason('output_digest_mismatch', evidenceKind));
    }
    if (evidenceKind === 'solver-run') {
      const activeOutputDigest = fieldValue(identity, 'outputDigest');
      if (!receiptIdentityOutputDigest || !receiptOutputDigest) {
        reasons.push('unbound_solver_output');
      }
      if (
        (receiptOutputDigest && activeOutputDigest && receiptOutputDigest !== activeOutputDigest)
        || (receiptOutputDigest && receiptIdentityOutputDigest && receiptOutputDigest !== receiptIdentityOutputDigest)
      ) {
        reasons.push(reason('output_digest_mismatch', evidenceKind));
      }
    }
    if (
      evidenceKind === 'figure-table-provenance'
      && (!hasField(receiptIdentity, 'sourceRunId') || !hasField(receiptIdentity, 'plotScriptHash') || !hasField(receiptIdentity, 'plotConfigHash'))
    ) {
      reasons.push('unbound_plot_table');
    }
    if (!isNonEmptyString(receipt.verifierScriptHash) || receipt.verifierScriptHash !== fieldValue(identity, 'verifierScriptHash')) {
      reasons.push(reason('verifier_script_mismatch', evidenceKind));
    }
    for (const field of requiredIdentityFields) {
      const expected = fieldValue(identity, field);
      if (!expected) continue;
      if (receiptIdentity && fieldValue(receiptIdentity, field) !== expected) {
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

const QUANTUM_GATE_POLICY_REPAIR_REASON_PREFIXES = [
  'missing_core_identity_field',
  'missing_conditional_identity_field',
  'missing_claim_field',
  'missing_basis_or_grid_identity',
  'missing_required_receipt',
  'missing_receipt_identity',
  'output_digest_missing',
] as const satisfies readonly QuantumReasonPrefix[];

const QUANTUM_GATE_POLICY_STOP_REASON_PREFIXES = [
  'unknown_claim',
  'claim_boundary_violation',
  'duplicate_receipt',
  'receipt_exit_nonzero',
  'receipt_status_not_pass',
  'stale_evidence',
  'output_digest_mismatch',
  'unbound_solver_output',
  'unbound_plot_table',
  'verifier_script_mismatch',
  'identity_mismatch',
] as const satisfies readonly QuantumReasonPrefix[];

function hasReasonPrefix(reasons: readonly string[], prefix: string): boolean {
  return reasons.some((item) => item === prefix || item.startsWith(`${prefix}:`));
}

function hasAnyReasonPrefix(reasons: readonly string[], prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => hasReasonPrefix(reasons, prefix));
}

export function decideQuantumClaimGatePolicy(result: QuantumClaimCheckResult): QuantumGatePolicyDecision {
  if (result.allowed && result.reasons.length === 0) return 'advance';
  if (hasReasonPrefix(result.reasons, 'unsupported_schema_version')) return 'escalate';
  if (hasAnyReasonPrefix(result.reasons, QUANTUM_GATE_POLICY_STOP_REASON_PREFIXES)) return 'stop';
  if (hasAnyReasonPrefix(result.reasons, QUANTUM_GATE_POLICY_REPAIR_REASON_PREFIXES)) return 'repair';
  if (hasReasonPrefix(result.reasons, 'weak_evidence_overclaim')) return 'degrade';
  return result.nextAction;
}

export function evaluateQuantumClaimGatePolicy(input: QuantumClaimCheckInput): QuantumClaimGatePolicyResult {
  const check = evaluateQuantumClaim(input);
  const decision = decideQuantumClaimGatePolicy(check);
  const allowed = decision === 'advance' && check.allowed;
  return {
    schemaVersion: QUANTUM_CLAIM_GATE_POLICY_SCHEMA_VERSION,
    claimCheckSchemaVersion: check.schemaVersion,
    verifierVersion: check.verifierVersion,
    claimId: check.claimId,
    decision,
    allowed,
    transition: 'claim-admissibility',
    localOnly: true,
    localClaimAdmissibilityOnly: true,
    writesLifecycleEvidence: false,
    mutatesLifecycle: false,
    sourceNextAction: check.nextAction,
    scopedClaim: check.scopedClaim,
    degradedClaimAvailable: decision === 'degrade' && check.scopedClaim,
    reasons: check.reasons,
    checkedReceipts: check.checkedReceipts,
    missingReceipts: check.missingReceipts,
    boundary: check.boundary,
    boundaryText: check.boundaryText,
    runtimeStatus: check.runtimeStatus,
    artifactIndex: check.artifactIndex,
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

export function renderQuantumClaimGatePolicyText(result: QuantumClaimGatePolicyResult): string {
  return [
    `Quantum claim gate policy (${result.schemaVersion})`,
    result.runtimeStatus,
    `claimId: ${result.claimId}`,
    `decision: ${result.decision}`,
    `allowed: ${result.allowed}`,
    `transition: ${result.transition}`,
    `localClaimAdmissibilityOnly: ${result.localClaimAdmissibilityOnly}`,
    `writesLifecycleEvidence: ${result.writesLifecycleEvidence}`,
    `mutatesLifecycle: ${result.mutatesLifecycle}`,
    `sourceNextAction: ${result.sourceNextAction}`,
    `scopedClaim: ${result.scopedClaim}`,
    `degradedClaimAvailable: ${result.degradedClaimAvailable}`,
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

import {
  digestCanonicalJson,
  type Digestable,
} from '../digest.js';
import {
  PROOF_ADMISSIBILITY_CONTRACT_VERSION,
  PROOF_ADMISSIBILITY_VERIFIER_VERSION,
  evaluateProofAdmissibility,
  type AdmissibilityChecks,
  type AdmissibilityReasonCode,
  type ArtifactConsumerKind,
  type ClaimKind,
} from '../proof-admissibility.js';
import type {
  DoneRequiredCommandReceipt,
  RoutineValidationIdentity,
} from '../validation-types.js';
import {
  QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
  getQuantumVerifierAdapterDescriptor,
  normalizeQuantumVerifierAdapterOutput,
  type QuantumClaimId,
  type QuantumEvidenceIdentity,
  type QuantumVerifierAdapterOutput,
} from '../claim-admissibility/quantum.js';

export const EVIDENCE_ENVIRONMENT_CONTRACT_VERSION = 'lattice.evidence_environment.v1' as const;
export const EVIDENCE_ENVIRONMENT_RECEIPT_VERSION = 'lattice.evidence_environment_receipt.v1' as const;
export const EVIDENCE_ENVIRONMENT_ENVELOPE_VERSION = 'lattice.evidence_environment_envelope.v1' as const;

export const CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR_ID = 'code-runtime.policy-authorized-local-validation' as const;
export const QUANTUM_ENVIRONMENT_DESCRIPTOR_ID = 'quantum.read-receipt-only' as const;

export type EvidenceEnvironmentKind =
  | 'code-runtime'
  | 'scientific-receipt';
export type EvidenceEnvironmentMode =
  | 'execute-local'
  | 'read-receipt-only'
  | 'observe-state'
  | 'execute-remote';
export type EvidenceEnvironmentRole =
  | 'executor'
  | 'observer'
  | 'receipt-reader'
  | 'orchestrator';
export type EvidenceEnvironmentTrustClass =
  | 'local-runtime-owned'
  | 'trusted-reviewer-owned'
  | 'authority-owned'
  | 'external-attested'
  | 'diagnostic-only';
export type EvidenceEnvironmentReproducibilityClass =
  | 'deterministic'
  | 'bounded-nondeterministic'
  | 'stateful'
  | 'temporal';
export type EvidenceEnvironmentReceiptStatus = 'pass' | 'fail' | 'error' | 'timeout' | 'cancelled' | 'unavailable';

export type EvidenceEnvironmentReasonCode =
  | 'unsupported_contract_version'
  | 'unsupported_receipt_version'
  | 'unsupported_environment_kind'
  | 'unknown_environment_descriptor'
  | 'duplicate_environment_descriptor'
  | 'bad_shape'
  | 'unexpected_field'
  | 'missing_required_field'
  | 'subject_mismatch'
  | 'environment_mismatch'
  | 'adapter_mismatch'
  | 'invocation_mismatch'
  | 'command_spec_mismatch'
  | 'policy_mismatch'
  | 'producer_mismatch'
  | 'producer_attestation_missing'
  | 'producer_attestation_invalid'
  | 'same_producer_not_independent'
  | 'stale_receipt'
  | 'unsafe_isolation'
  | 'forbidden_execution'
  | 'checker_error'
  | 'direct_completion_authority'
  | 'diagnostic_only_non_gate';

export interface EvidenceEnvironmentDescriptor {
  readonly id: string;
  readonly contractVersion: typeof EVIDENCE_ENVIRONMENT_CONTRACT_VERSION;
  readonly version: string;
  readonly kind: EvidenceEnvironmentKind;
  readonly mode: EvidenceEnvironmentMode;
  readonly roles: readonly EvidenceEnvironmentRole[];
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly trustClass: EvidenceEnvironmentTrustClass;
  readonly reproducibilityClass: EvidenceEnvironmentReproducibilityClass;
  readonly supportedReceiptVersions: readonly string[];
  readonly supportedClaimIds: readonly string[];
  readonly supportedConsumers: readonly ArtifactConsumerKind[];
  readonly policyAuthorizedOnly: boolean;
  readonly network: 'denied' | 'policy-bound' | 'external';
  readonly isolation: 'process' | 'container' | 'external-attested' | 'receipt-only';
  readonly createsStorage: false;
  readonly createsLifecycleGate: false;
  readonly completionEligible: false;
}

export interface EvidenceEnvironmentCommandSpec {
  readonly commandId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly processEnvironmentDigest: string;
  readonly executableDigest: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  readonly network: 'denied' | 'policy-bound';
  readonly secrets: 'none' | 'redacted-policy-bound';
  readonly policyAuthorized: true;
}

export interface EvidenceEnvironmentInvocationRequest {
  readonly contractVersion: typeof EVIDENCE_ENVIRONMENT_CONTRACT_VERSION;
  readonly invocationId: string;
  readonly invocationDigest: string;
  readonly claimId: string;
  readonly subject: {
    readonly type: string;
    readonly id: string;
    readonly digest: string;
  };
  readonly environmentDescriptorId: string;
  readonly adapterId: string;
  readonly policyId: string;
  readonly policyDigest: string;
  readonly requestedAt: string;
  readonly freshnessDeadline: string;
  readonly inputDigest: string;
  readonly commandSpec?: EvidenceEnvironmentCommandSpec;
}

export interface EvidenceEnvironmentProducerAttestation {
  readonly producerId: string;
  readonly lineageId: string;
  readonly keyId: string;
  readonly sessionId: string;
  readonly verificationSource: 'verifier-owned-attestation-registry';
  readonly signatureVerified: boolean;
  readonly trustClass: EvidenceEnvironmentTrustClass;
}

export interface EvidenceEnvironmentReceipt {
  readonly receiptVersion: typeof EVIDENCE_ENVIRONMENT_RECEIPT_VERSION;
  readonly invocationId: string;
  readonly invocationDigest: string;
  readonly subjectDigest: string;
  readonly environmentDescriptorId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly policyDigest: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly status: EvidenceEnvironmentReceiptStatus;
  readonly observedAt: string;
  readonly completedAt: string;
  readonly commandSpecDigest?: string;
  readonly producerAttestation?: EvidenceEnvironmentProducerAttestation;
  readonly isolation: {
    readonly kind: EvidenceEnvironmentDescriptor['isolation'];
    readonly identityVerified: boolean;
    readonly network: EvidenceEnvironmentDescriptor['network'];
  };
  readonly diagnostics?: readonly string[];
}

export interface NormalizedEvidenceEnvironmentEnvelope {
  readonly envelopeVersion: typeof EVIDENCE_ENVIRONMENT_ENVELOPE_VERSION;
  readonly contractVersion: typeof EVIDENCE_ENVIRONMENT_CONTRACT_VERSION;
  readonly descriptorId: string;
  readonly descriptorVersion: string;
  readonly environmentKind: EvidenceEnvironmentKind;
  readonly mode: EvidenceEnvironmentMode;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly invocationId: string;
  readonly claimId: string;
  readonly subject: EvidenceEnvironmentInvocationRequest['subject'];
  readonly policyId: string;
  readonly policyDigest: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly status: EvidenceEnvironmentReceiptStatus;
  readonly observedAt: string;
  readonly completedAt: string;
  readonly freshnessDeadline: string;
  readonly trustClass: EvidenceEnvironmentTrustClass;
  readonly reproducibilityClass: EvidenceEnvironmentReproducibilityClass;
  readonly producerAttestation?: EvidenceEnvironmentProducerAttestation;
  readonly commandSpecDigest?: string;
  readonly semanticDigest: string;
  readonly policyInputDigest: string;
  readonly boundary: {
    readonly observationOnly: true;
    readonly createsStorage: false;
    readonly createsLifecycleGate: false;
    readonly completionEligible: false;
  };
}

export interface EvidenceEnvironmentFailure {
  readonly ok: false;
  readonly reason: EvidenceEnvironmentReasonCode;
  readonly reasons: readonly EvidenceEnvironmentReasonCode[];
}

export interface EvidenceEnvironmentSuccess {
  readonly ok: true;
  readonly envelope: NormalizedEvidenceEnvironmentEnvelope;
}

export type EvidenceEnvironmentNormalizationResult =
  | EvidenceEnvironmentSuccess
  | EvidenceEnvironmentFailure;

export interface EvidenceEnvironmentRegistry {
  readonly list: () => readonly EvidenceEnvironmentDescriptor[];
  readonly resolve: (id: string) => EvidenceEnvironmentDescriptor | undefined;
  readonly validate: () => {
    readonly ok: boolean;
    readonly reasons: readonly EvidenceEnvironmentReasonCode[];
  };
}

const DESCRIPTOR_KEYS = new Set([
  'id',
  'contractVersion',
  'version',
  'kind',
  'mode',
  'roles',
  'adapterId',
  'adapterVersion',
  'trustClass',
  'reproducibilityClass',
  'supportedReceiptVersions',
  'supportedClaimIds',
  'supportedConsumers',
  'policyAuthorizedOnly',
  'network',
  'isolation',
  'createsStorage',
  'createsLifecycleGate',
  'completionEligible',
]);

const INVOCATION_KEYS = new Set([
  'contractVersion',
  'invocationId',
  'invocationDigest',
  'claimId',
  'subject',
  'environmentDescriptorId',
  'adapterId',
  'policyId',
  'policyDigest',
  'requestedAt',
  'freshnessDeadline',
  'inputDigest',
  'commandSpec',
]);

const RECEIPT_KEYS = new Set([
  'receiptVersion',
  'invocationId',
  'invocationDigest',
  'subjectDigest',
  'environmentDescriptorId',
  'adapterId',
  'adapterVersion',
  'policyDigest',
  'inputDigest',
  'outputDigest',
  'status',
  'observedAt',
  'completedAt',
  'commandSpecDigest',
  'producerAttestation',
  'isolation',
  'diagnostics',
]);

function failure(...reasons: EvidenceEnvironmentReasonCode[]): EvidenceEnvironmentFailure {
  const unique = Object.freeze([...new Set(reasons)]);
  return Object.freeze({
    ok: false,
    reason: unique[0] ?? 'bad_shape',
    reasons: unique,
  });
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return isNonEmpty(value) && Number.isFinite(Date.parse(value));
}

function frozenDescriptor(descriptor: EvidenceEnvironmentDescriptor): EvidenceEnvironmentDescriptor {
  return Object.freeze({
    ...descriptor,
    roles: Array.isArray(descriptor.roles) ? Object.freeze([...descriptor.roles]) : descriptor.roles,
    supportedReceiptVersions: Array.isArray(descriptor.supportedReceiptVersions)
      ? Object.freeze([...descriptor.supportedReceiptVersions])
      : descriptor.supportedReceiptVersions,
    supportedClaimIds: Array.isArray(descriptor.supportedClaimIds)
      ? Object.freeze([...descriptor.supportedClaimIds])
      : descriptor.supportedClaimIds,
    supportedConsumers: Array.isArray(descriptor.supportedConsumers)
      ? Object.freeze([...descriptor.supportedConsumers])
      : descriptor.supportedConsumers,
  });
}

function claimSupported(descriptor: EvidenceEnvironmentDescriptor, claimId: string): boolean {
  return Array.isArray(descriptor.supportedClaimIds) && descriptor.supportedClaimIds.some((supported) => (
    supported === claimId || (supported.endsWith('*') && claimId.startsWith(supported.slice(0, -1)))
  ));
}

export function digestEvidenceEnvironmentInvocation(
  invocation: Omit<EvidenceEnvironmentInvocationRequest, 'invocationDigest'>,
): string {
  return digestCanonicalJson(invocation);
}

export const CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR = frozenDescriptor({
  id: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR_ID,
  contractVersion: EVIDENCE_ENVIRONMENT_CONTRACT_VERSION,
  version: '1.0.0',
  kind: 'code-runtime',
  mode: 'execute-local',
  roles: ['executor'],
  adapterId: 'code-runtime.policy-authorized-local-validation-receipt',
  adapterVersion: PROOF_ADMISSIBILITY_VERIFIER_VERSION,
  trustClass: 'local-runtime-owned',
  reproducibilityClass: 'deterministic',
  supportedReceiptVersions: [EVIDENCE_ENVIRONMENT_RECEIPT_VERSION],
  supportedClaimIds: ['done-readiness'],
  supportedConsumers: ['DONE_REQUIRED', 'DONE'],
  policyAuthorizedOnly: true,
  network: 'policy-bound',
  isolation: 'process',
  createsStorage: false,
  createsLifecycleGate: false,
  completionEligible: false,
});

export const QUANTUM_ENVIRONMENT_DESCRIPTOR = frozenDescriptor({
  id: QUANTUM_ENVIRONMENT_DESCRIPTOR_ID,
  contractVersion: EVIDENCE_ENVIRONMENT_CONTRACT_VERSION,
  version: '1.0.0',
  kind: 'scientific-receipt',
  mode: 'read-receipt-only',
  roles: ['receipt-reader'],
  adapterId: 'quantum.receipt-normalizer',
  adapterVersion: 'lattice.quantum_claim_admissibility_verifier.v1',
  trustClass: 'diagnostic-only',
  reproducibilityClass: 'bounded-nondeterministic',
  supportedReceiptVersions: [EVIDENCE_ENVIRONMENT_RECEIPT_VERSION],
  supportedClaimIds: ['Q*'],
  supportedConsumers: [],
  policyAuthorizedOnly: true,
  network: 'denied',
  isolation: 'receipt-only',
  createsStorage: false,
  createsLifecycleGate: false,
  completionEligible: false,
});

const DEFAULT_ENVIRONMENT_DESCRIPTORS = Object.freeze([
  CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR,
  QUANTUM_ENVIRONMENT_DESCRIPTOR,
]);

export function validateEnvironmentDescriptor(
  descriptor: EvidenceEnvironmentDescriptor,
): readonly EvidenceEnvironmentReasonCode[] {
  const reasons: EvidenceEnvironmentReasonCode[] = [];
  if (!descriptor || typeof descriptor !== 'object') return Object.freeze(['bad_shape']);
  if (!hasOnlyKeys(descriptor, DESCRIPTOR_KEYS)) reasons.push('unexpected_field');
  if (descriptor.contractVersion !== EVIDENCE_ENVIRONMENT_CONTRACT_VERSION) reasons.push('unsupported_contract_version');
  if (!isNonEmpty(descriptor.id) || !isNonEmpty(descriptor.version) || !isNonEmpty(descriptor.adapterId) || !isNonEmpty(descriptor.adapterVersion)) {
    reasons.push('missing_required_field');
  }
  if (!['code-runtime', 'scientific-receipt'].includes(descriptor.kind)) reasons.push('unsupported_environment_kind');
  if (!['execute-local', 'read-receipt-only', 'observe-state', 'execute-remote'].includes(descriptor.mode)) reasons.push('bad_shape');
  if (!Array.isArray(descriptor.roles) || descriptor.roles.length === 0
    || descriptor.roles.some((role) => !['executor', 'observer', 'receipt-reader', 'orchestrator'].includes(role))) {
    reasons.push('missing_required_field');
  }
  if (!Array.isArray(descriptor.supportedReceiptVersions)
    || !descriptor.supportedReceiptVersions.includes(EVIDENCE_ENVIRONMENT_RECEIPT_VERSION)) reasons.push('unsupported_receipt_version');
  if (!Array.isArray(descriptor.supportedClaimIds) || !Array.isArray(descriptor.supportedConsumers)) reasons.push('bad_shape');
  if (!['local-runtime-owned', 'trusted-reviewer-owned', 'authority-owned', 'external-attested', 'diagnostic-only'].includes(descriptor.trustClass)) reasons.push('bad_shape');
  if (!['deterministic', 'bounded-nondeterministic', 'stateful', 'temporal'].includes(descriptor.reproducibilityClass)) reasons.push('bad_shape');
  if (!['denied', 'policy-bound', 'external'].includes(descriptor.network)) reasons.push('bad_shape');
  if (!['process', 'container', 'external-attested', 'receipt-only'].includes(descriptor.isolation)) reasons.push('bad_shape');
  if (descriptor.createsStorage !== false || descriptor.createsLifecycleGate !== false || descriptor.completionEligible !== false) {
    reasons.push('direct_completion_authority');
  }
  if (descriptor.mode === 'execute-local' && descriptor.policyAuthorizedOnly !== true) reasons.push('forbidden_execution');
  if (descriptor.mode === 'read-receipt-only' && Array.isArray(descriptor.roles) && descriptor.roles.includes('executor')) reasons.push('forbidden_execution');
  return Object.freeze([...new Set(reasons)]);
}

export function createEvidenceEnvironmentRegistry(
  descriptors: readonly EvidenceEnvironmentDescriptor[] = DEFAULT_ENVIRONMENT_DESCRIPTORS,
): EvidenceEnvironmentRegistry {
  const frozen = Object.freeze(descriptors.map(frozenDescriptor));
  return Object.freeze({
    list: () => frozen,
    resolve: (id: string) => frozen.find((descriptor) => descriptor.id === id),
    validate: () => {
      const reasons: EvidenceEnvironmentReasonCode[] = [];
      const ids = new Set<string>();
      for (const descriptor of frozen) {
        reasons.push(...validateEnvironmentDescriptor(descriptor));
        if (ids.has(descriptor.id)) reasons.push('duplicate_environment_descriptor');
        ids.add(descriptor.id);
      }
      const unique = Object.freeze([...new Set(reasons)]);
      return Object.freeze({ ok: unique.length === 0, reasons: unique });
    },
  });
}

const DEFAULT_ENVIRONMENT_REGISTRY = createEvidenceEnvironmentRegistry();

export function listEvidenceEnvironmentDescriptors(): readonly EvidenceEnvironmentDescriptor[] {
  return DEFAULT_ENVIRONMENT_REGISTRY.list();
}

export function getEvidenceEnvironmentDescriptor(id: string): EvidenceEnvironmentDescriptor | undefined {
  return DEFAULT_ENVIRONMENT_REGISTRY.resolve(id);
}

export function digestEvidenceEnvironmentCommandSpec(spec: EvidenceEnvironmentCommandSpec): string {
  return digestCanonicalJson(spec);
}

function policyInput(
  descriptor: EvidenceEnvironmentDescriptor,
  invocation: EvidenceEnvironmentInvocationRequest,
  receipt: EvidenceEnvironmentReceipt,
): Digestable {
  return {
    claimId: invocation.claimId,
    subject: invocation.subject as unknown as Digestable,
    environment: {
      id: descriptor.id,
      version: descriptor.version,
      kind: descriptor.kind,
      mode: descriptor.mode,
      adapterId: descriptor.adapterId,
      adapterVersion: descriptor.adapterVersion,
      trustClass: descriptor.trustClass,
      reproducibilityClass: descriptor.reproducibilityClass,
    },
    invocationId: invocation.invocationId,
    inputDigest: invocation.inputDigest,
    outputDigest: receipt.outputDigest,
    policyId: invocation.policyId,
    policyDigest: invocation.policyDigest,
    commandSpecDigest: receipt.commandSpecDigest ?? null,
    status: receipt.status,
    observedAt: receipt.observedAt,
    completedAt: receipt.completedAt,
    freshnessDeadline: invocation.freshnessDeadline,
  };
}

export function normalizeEvidenceEnvironmentReceipt(
  descriptor: EvidenceEnvironmentDescriptor,
  invocation: EvidenceEnvironmentInvocationRequest,
  receipt: EvidenceEnvironmentReceipt,
  now = new Date(),
): EvidenceEnvironmentNormalizationResult {
  const reasons: EvidenceEnvironmentReasonCode[] = [...validateEnvironmentDescriptor(descriptor)];
  if (!invocation || typeof invocation !== 'object' || !receipt || typeof receipt !== 'object') return failure('bad_shape');
  if (!hasOnlyKeys(invocation, INVOCATION_KEYS) || !hasOnlyKeys(receipt, RECEIPT_KEYS)) reasons.push('unexpected_field');
  if (invocation.contractVersion !== EVIDENCE_ENVIRONMENT_CONTRACT_VERSION) reasons.push('unsupported_contract_version');
  if (receipt.receiptVersion !== EVIDENCE_ENVIRONMENT_RECEIPT_VERSION) reasons.push('unsupported_receipt_version');
  if (!isNonEmpty(invocation.invocationId) || !isNonEmpty(invocation.invocationDigest)
    || !isNonEmpty(invocation.claimId) || !isNonEmpty(invocation.subject?.digest)
    || !isNonEmpty(invocation.policyId) || !isNonEmpty(invocation.policyDigest) || !isNonEmpty(invocation.inputDigest)
    || !isNonEmpty(receipt.outputDigest)) {
    reasons.push('missing_required_field');
  }
  const unsignedInvocation = { ...invocation } as Record<string, unknown>;
  delete unsignedInvocation.invocationDigest;
  if (invocation.invocationDigest !== digestEvidenceEnvironmentInvocation(
    unsignedInvocation as unknown as Omit<EvidenceEnvironmentInvocationRequest, 'invocationDigest'>,
  )) reasons.push('invocation_mismatch');
  if (receipt.invocationDigest !== invocation.invocationDigest) reasons.push('invocation_mismatch');
  if (!claimSupported(descriptor, invocation.claimId)) reasons.push('policy_mismatch');
  if (invocation.environmentDescriptorId !== descriptor.id || receipt.environmentDescriptorId !== descriptor.id) reasons.push('environment_mismatch');
  if (invocation.adapterId !== descriptor.adapterId || receipt.adapterId !== descriptor.adapterId || receipt.adapterVersion !== descriptor.adapterVersion) {
    reasons.push('adapter_mismatch');
  }
  if (receipt.invocationId !== invocation.invocationId) reasons.push('invocation_mismatch');
  if (receipt.subjectDigest !== invocation.subject.digest) reasons.push('subject_mismatch');
  if (receipt.policyDigest !== invocation.policyDigest) reasons.push('policy_mismatch');
  if (receipt.inputDigest !== invocation.inputDigest) reasons.push('invocation_mismatch');
  if (!isIsoDate(invocation.requestedAt) || !isIsoDate(invocation.freshnessDeadline)
    || !isIsoDate(receipt.observedAt) || !isIsoDate(receipt.completedAt)) {
    reasons.push('bad_shape');
  } else {
    if (Date.parse(receipt.observedAt) < Date.parse(invocation.requestedAt)
      || Date.parse(receipt.completedAt) < Date.parse(receipt.observedAt)
      || now.getTime() > Date.parse(invocation.freshnessDeadline)) {
      reasons.push('stale_receipt');
    }
  }
  if (receipt.isolation?.kind !== descriptor.isolation
    || receipt.isolation?.network !== descriptor.network
    || receipt.isolation?.identityVerified !== true) {
    reasons.push('unsafe_isolation');
  }
  if (invocation.commandSpec) {
    if (descriptor.mode !== 'execute-local'
      || invocation.commandSpec.policyAuthorized !== true
      || invocation.commandSpec.shell !== false
      || !isNonEmpty(invocation.commandSpec.executableDigest)
      || !isNonEmpty(invocation.commandSpec.processEnvironmentDigest)
      || receipt.commandSpecDigest !== digestEvidenceEnvironmentCommandSpec(invocation.commandSpec)) {
      reasons.push('command_spec_mismatch');
    }
  } else if (descriptor.mode === 'execute-local') {
    reasons.push('command_spec_mismatch');
  }
  if (descriptor.mode === 'read-receipt-only' && invocation.commandSpec) reasons.push('forbidden_execution');
  if (receipt.status === 'error') reasons.push('checker_error');
  if (descriptor.trustClass === 'external-attested') {
    if (!receipt.producerAttestation) reasons.push('producer_attestation_missing');
    else if (receipt.producerAttestation.signatureVerified !== true) reasons.push('producer_attestation_invalid');
  }
  if (receipt.producerAttestation && receipt.producerAttestation.trustClass !== descriptor.trustClass) {
    reasons.push('producer_mismatch');
  }
  if (receipt.producerAttestation && (
    receipt.producerAttestation.verificationSource !== 'verifier-owned-attestation-registry'
    || !isNonEmpty(receipt.producerAttestation.keyId)
    || !isNonEmpty(receipt.producerAttestation.sessionId)
    || !isNonEmpty(receipt.producerAttestation.lineageId)
  )) reasons.push('producer_attestation_invalid');
  if (receipt.producerAttestation && receipt.producerAttestation.signatureVerified !== true) {
    reasons.push('producer_attestation_invalid');
  }
  if (reasons.length > 0) return failure(...reasons);

  const semantic = policyInput(descriptor, invocation, receipt);
  const withoutDigest = {
    envelopeVersion: EVIDENCE_ENVIRONMENT_ENVELOPE_VERSION,
    contractVersion: EVIDENCE_ENVIRONMENT_CONTRACT_VERSION,
    descriptorId: descriptor.id,
    descriptorVersion: descriptor.version,
    environmentKind: descriptor.kind,
    mode: descriptor.mode,
    adapterId: descriptor.adapterId,
    adapterVersion: descriptor.adapterVersion,
    invocationId: invocation.invocationId,
    claimId: invocation.claimId,
    subject: Object.freeze({ ...invocation.subject }),
    policyId: invocation.policyId,
    policyDigest: invocation.policyDigest,
    inputDigest: invocation.inputDigest,
    outputDigest: receipt.outputDigest,
    status: receipt.status,
    observedAt: receipt.observedAt,
    completedAt: receipt.completedAt,
    freshnessDeadline: invocation.freshnessDeadline,
    trustClass: descriptor.trustClass,
    reproducibilityClass: descriptor.reproducibilityClass,
    ...(receipt.producerAttestation ? { producerAttestation: Object.freeze({ ...receipt.producerAttestation }) } : {}),
    ...(receipt.commandSpecDigest ? { commandSpecDigest: receipt.commandSpecDigest } : {}),
    policyInputDigest: digestCanonicalJson(semantic),
    boundary: Object.freeze({
      observationOnly: true as const,
      createsStorage: false as const,
      createsLifecycleGate: false as const,
      completionEligible: false as const,
    }),
  };
  const envelope: NormalizedEvidenceEnvironmentEnvelope = Object.freeze({
    ...withoutDigest,
    semanticDigest: digestCanonicalJson(withoutDigest),
  });
  return Object.freeze({ ok: true, envelope });
}

export function projectDoneRequiredReceiptToEnvironment(
  receipt: DoneRequiredCommandReceipt,
  input: {
    readonly invocationId: string;
    readonly subjectId: string;
    readonly subjectDigest: string;
    readonly policyId: string;
    readonly policyDigest: string;
    readonly requestedAt: string;
    readonly freshnessDeadline: string;
    readonly routineIdentity: RoutineValidationIdentity;
  },
): {
  readonly descriptor: EvidenceEnvironmentDescriptor;
  readonly invocation: EvidenceEnvironmentInvocationRequest;
  readonly receipt: EvidenceEnvironmentReceipt;
} {
  if (!receipt.commandSpec) throw new Error('command_spec_mismatch: DONE-required receipt must carry lattice.command-spec.v1');
  if (receipt.commandSpec.shell) throw new Error('command_spec_mismatch: EEA reference path requires shell=false');
  const identityCommand = input.routineIdentity.commands.find((command) => (
    command.command === receipt.command
    && JSON.stringify(command.args) === JSON.stringify(receipt.args)
    && command.cwd === receipt.cwd
    && command.shell === false
  ));
  if (!identityCommand || !identityCommand.executableDigest) {
    throw new Error('command_spec_mismatch: matching routine-validation execution identity is required');
  }
  const commandSpec: EvidenceEnvironmentCommandSpec = Object.freeze({
    commandId: receipt.commandSpec.digest,
    executable: receipt.command,
    args: Object.freeze([...receipt.args]),
    cwd: receipt.cwd,
    shell: false,
    processEnvironmentDigest: identityCommand.effectiveEnvironmentDigest,
    executableDigest: identityCommand.executableDigest,
    timeoutMs: receipt.commandSpec.timeoutMs,
    outputLimitBytes: 12_000,
    network: 'policy-bound',
    secrets: 'redacted-policy-bound',
    policyAuthorized: true,
  });
  const unsignedInvocation: Omit<EvidenceEnvironmentInvocationRequest, 'invocationDigest'> = {
    contractVersion: EVIDENCE_ENVIRONMENT_CONTRACT_VERSION,
    invocationId: input.invocationId,
    claimId: 'done-readiness',
    subject: Object.freeze({ type: 'story', id: input.subjectId, digest: input.subjectDigest }),
    environmentDescriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR_ID,
    adapterId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.adapterId,
    policyId: input.policyId,
    policyDigest: input.policyDigest,
    requestedAt: input.requestedAt,
    freshnessDeadline: input.freshnessDeadline,
    inputDigest: receipt.commandSpec.digest,
    commandSpec,
  };
  const invocation: EvidenceEnvironmentInvocationRequest = Object.freeze({
    ...unsignedInvocation,
    invocationDigest: digestEvidenceEnvironmentInvocation(unsignedInvocation),
  });
  const environmentReceipt: EvidenceEnvironmentReceipt = Object.freeze({
    receiptVersion: EVIDENCE_ENVIRONMENT_RECEIPT_VERSION,
    invocationId: input.invocationId,
    invocationDigest: invocation.invocationDigest,
    subjectDigest: input.subjectDigest,
    environmentDescriptorId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR_ID,
    adapterId: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.adapterId,
    adapterVersion: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR.adapterVersion,
    policyDigest: input.policyDigest,
    inputDigest: receipt.commandSpec.digest,
    outputDigest: receipt.outputDigest,
    status: receipt.timedOut ? 'timeout' : receipt.status === 'PASS' ? 'pass' : 'fail',
    observedAt: receipt.startedAt,
    completedAt: receipt.endedAt,
    commandSpecDigest: digestEvidenceEnvironmentCommandSpec(commandSpec),
    isolation: Object.freeze({ kind: 'process', identityVerified: true, network: 'policy-bound' }),
    diagnostics: Object.freeze([`exitCode=${receipt.exitCode}`, `durationMs=${receipt.durationMs}`]),
  });
  return Object.freeze({ descriptor: CODE_RUNTIME_ENVIRONMENT_DESCRIPTOR, invocation, receipt: environmentReceipt });
}

export function projectQuantumReceiptToEnvironment(input: {
  readonly output: QuantumVerifierAdapterOutput;
  readonly activeIdentity: Partial<QuantumEvidenceIdentity>;
  readonly claimId: QuantumClaimId;
  readonly invocationId: string;
  readonly subjectId: string;
  readonly subjectDigest: string;
  readonly policyId: string;
  readonly policyDigest: string;
  readonly requestedAt: string;
  readonly freshnessDeadline: string;
  readonly observedAt?: string;
  readonly completedAt: string;
}): {
  readonly descriptor: EvidenceEnvironmentDescriptor;
  readonly invocation: EvidenceEnvironmentInvocationRequest;
  readonly receipt: EvidenceEnvironmentReceipt;
} {
  const normalizedQuantum = normalizeQuantumVerifierAdapterOutput(input.output, input.activeIdentity);
  if (!normalizedQuantum.ok) {
    throw new Error(`quantum_receipt_invalid: ${normalizedQuantum.reasons.join(', ')}`);
  }
  const quantumAdapter = getQuantumVerifierAdapterDescriptor(normalizedQuantum.adapterId);
  const profile = quantumAdapter?.evidenceProfiles.find((candidate) => candidate.evidenceKind === normalizedQuantum.evidenceKind);
  if (!profile?.claimIds.includes(input.claimId)) {
    throw new Error(`quantum_receipt_invalid: claim ${input.claimId} is not supported by ${normalizedQuantum.adapterId}/${normalizedQuantum.evidenceKind}`);
  }
  const descriptor = frozenDescriptor({
    ...QUANTUM_ENVIRONMENT_DESCRIPTOR,
    adapterVersion: QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
  });
  const inputDigest = digestCanonicalJson(input.activeIdentity);
  const outputDigest = normalizedQuantum.receipt.outputDigest;
  if (!outputDigest) throw new Error('quantum_receipt_invalid: output digest is required after normalization');
  const observedAt = input.observedAt ?? normalizedQuantum.receipt.observedAt;
  if (!observedAt) throw new Error('quantum_receipt_invalid: observedAt is required for the EEA temporal envelope');
  return Object.freeze({
    descriptor,
    invocation: (() => {
      const unsigned: Omit<EvidenceEnvironmentInvocationRequest, 'invocationDigest'> = {
      contractVersion: EVIDENCE_ENVIRONMENT_CONTRACT_VERSION,
      invocationId: input.invocationId,
      claimId: input.claimId,
      subject: Object.freeze({ type: 'quantum-computation', id: input.subjectId, digest: input.subjectDigest }),
      environmentDescriptorId: descriptor.id,
      adapterId: descriptor.adapterId,
      policyId: input.policyId,
      policyDigest: input.policyDigest,
      requestedAt: input.requestedAt,
      freshnessDeadline: input.freshnessDeadline,
      inputDigest,
      };
      return Object.freeze({ ...unsigned, invocationDigest: digestEvidenceEnvironmentInvocation(unsigned) });
    })(),
    receipt: Object.freeze({
      receiptVersion: EVIDENCE_ENVIRONMENT_RECEIPT_VERSION,
      invocationId: input.invocationId,
      invocationDigest: (() => {
        const unsigned: Omit<EvidenceEnvironmentInvocationRequest, 'invocationDigest'> = {
          contractVersion: EVIDENCE_ENVIRONMENT_CONTRACT_VERSION,
          invocationId: input.invocationId,
          claimId: input.claimId,
          subject: { type: 'quantum-computation', id: input.subjectId, digest: input.subjectDigest },
          environmentDescriptorId: descriptor.id,
          adapterId: descriptor.adapterId,
          policyId: input.policyId,
          policyDigest: input.policyDigest,
          requestedAt: input.requestedAt,
          freshnessDeadline: input.freshnessDeadline,
          inputDigest,
        };
        return digestEvidenceEnvironmentInvocation(unsigned);
      })(),
      subjectDigest: input.subjectDigest,
      environmentDescriptorId: descriptor.id,
      adapterId: descriptor.adapterId,
      adapterVersion: descriptor.adapterVersion,
      policyDigest: input.policyDigest,
      inputDigest,
      outputDigest,
      status: normalizedQuantum.receipt.status,
      observedAt,
      completedAt: input.completedAt,
      isolation: Object.freeze({ kind: 'receipt-only', identityVerified: true, network: 'denied' }),
    }),
  });
}

export interface EvidenceEnvironmentGateProjectionInput {
  readonly envelope: NormalizedEvidenceEnvironmentEnvelope;
  readonly artifactKind: string;
  readonly consumer: ArtifactConsumerKind;
  readonly claim: ClaimKind;
  readonly checks: AdmissibilityChecks;
  readonly additionalPolicyRequirements?: readonly boolean[];
}

export interface EvidenceEnvironmentGateProjection {
  readonly decision: 'advance' | 'stop';
  readonly allowed: boolean;
  readonly reasons: readonly (AdmissibilityReasonCode | EvidenceEnvironmentReasonCode)[];
  readonly policyInputDigest: string;
  readonly boundary: NormalizedEvidenceEnvironmentEnvelope['boundary'];
}

export function evaluateEvidenceEnvironmentGateProjection(
  input: EvidenceEnvironmentGateProjectionInput,
): EvidenceEnvironmentGateProjection {
  const reasons: (AdmissibilityReasonCode | EvidenceEnvironmentReasonCode)[] = [];
  if (input.envelope.boundary.completionEligible !== false
    || input.envelope.boundary.createsLifecycleGate !== false
    || input.envelope.boundary.createsStorage !== false) {
    reasons.push('direct_completion_authority');
  }
  if (input.envelope.status !== 'pass') reasons.push(input.envelope.status === 'error' ? 'checker_error' : 'bad_shape');
  if (input.envelope.trustClass === 'diagnostic-only') reasons.push('diagnostic_only_non_gate');
  if (input.additionalPolicyRequirements?.some((satisfied) => !satisfied)) reasons.push('clause_not_bound');

  const admissibility = evaluateProofAdmissibility({
    artifactKind: input.artifactKind,
    consumer: input.consumer,
    claim: input.claim,
    checks: {
      ...input.checks,
      contractVersion: PROOF_ADMISSIBILITY_CONTRACT_VERSION,
      verifierVersion: PROOF_ADMISSIBILITY_VERIFIER_VERSION,
      semanticDigestValid: Boolean(input.envelope.semanticDigest),
      subjectMatches: input.checks.subjectMatches,
      environmentDescriptorValid: true,
      environmentReceiptValid: true,
      environmentPolicyValid: true,
    },
  });
  reasons.push(...admissibility.reasons);
  const unique = Object.freeze([...new Set(reasons)]);
  const allowed = admissibility.allowed && unique.length === 0;
  return Object.freeze({
    decision: allowed ? 'advance' : 'stop',
    allowed,
    reasons: unique,
    policyInputDigest: input.envelope.policyInputDigest,
    boundary: input.envelope.boundary,
  });
}

export function evaluateEvidenceEnvironmentQuorum(
  envelopes: readonly NormalizedEvidenceEnvironmentEnvelope[],
): {
  readonly independent: boolean;
  readonly reasons: readonly EvidenceEnvironmentReasonCode[];
} {
  const reasons: EvidenceEnvironmentReasonCode[] = [];
  const lineages = new Set<string>();
  const keys = new Set<string>();
  const sessions = new Set<string>();
  for (const envelope of envelopes) {
    const attestation = envelope.producerAttestation;
    if (!attestation) {
      reasons.push('producer_attestation_missing');
      continue;
    }
    if (!attestation.signatureVerified) reasons.push('producer_attestation_invalid');
    if (lineages.has(attestation.lineageId)
      || keys.has(attestation.keyId)
      || sessions.has(attestation.sessionId)) reasons.push('same_producer_not_independent');
    lineages.add(attestation.lineageId);
    keys.add(attestation.keyId);
    sessions.add(attestation.sessionId);
  }
  const unique = Object.freeze([...new Set(reasons)]);
  return Object.freeze({ independent: unique.length === 0, reasons: unique });
}

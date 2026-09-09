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
} from '../validation-types.js';
import {
  QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
  getQuantumVerifierAdapterDescriptor,
  normalizeQuantumVerifierAdapterOutput,
  type QuantumClaimId,
  type QuantumEvidenceIdentity,
  type QuantumVerifierAdapterOutput,
} from '../claim-admissibility/quantum.js';

export const EVIDENCE_ENVIRONMENT_CONTRACT_VERSION = 'proof-or-stop.evidence_environment.v1' as const;
export const EVIDENCE_ENVIRONMENT_RECEIPT_VERSION = 'proof-or-stop.evidence_environment_receipt.v1' as const;
export const EVIDENCE_ENVIRONMENT_ENVELOPE_VERSION = 'proof-or-stop.evidence_environment_envelope.v1' as const;

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
  | 'digest_mismatch'
  | 'command_spec_mismatch'
  | 'policy_mismatch'
  | 'producer_mismatch'
  | 'producer_attestation_missing'
  | 'producer_attestation_invalid'
  | 'distinct_host_quorum_unsupported'
  | 'same_producer_not_independent'
  | 'stale_receipt'
  | 'unsafe_isolation'
  | 'forbidden_execution'
  | 'checker_error'
  | 'receipt_failed'
  | 'receipt_timeout'
  | 'receipt_cancelled'
  | 'receipt_unavailable'
  | 'quorum_cardinality_missing'
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
  readonly shell: boolean;
  readonly processEnvironmentDigest: string;
  readonly executableDigest: string | null;
  readonly shellExecutableDigest?: string;
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

export interface EvidenceEnvironmentReceipt {
  readonly receiptVersion: typeof EVIDENCE_ENVIRONMENT_RECEIPT_VERSION;
  readonly receiptDigest: string;
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
  /**
   * Reserved opaque reference. The current implementation has no project-owned,
   * pinned producer trust registry, so this field never upgrades evidence to an
   * independent-host quorum.
   */
  readonly producerAttestationRef?: string;
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
  'receiptDigest',
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
  'producerAttestationRef',
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
  adapterVersion: 'proof-or-stop.quantum_claim_admissibility_verifier.v1',
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

export function digestEvidenceEnvironmentReceipt(
  receipt: Omit<EvidenceEnvironmentReceipt, 'receiptDigest'>,
): string {
  return digestCanonicalJson(receipt);
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
  options: {
    readonly registry?: EvidenceEnvironmentRegistry;
  } = {},
): EvidenceEnvironmentNormalizationResult {
  const reasons: EvidenceEnvironmentReasonCode[] = [...validateEnvironmentDescriptor(descriptor)];
  const registry = options.registry ?? DEFAULT_ENVIRONMENT_REGISTRY;
  const registeredDescriptor = registry.resolve(descriptor.id);
  if (!registeredDescriptor) {
    reasons.push('unknown_environment_descriptor');
  } else if (digestCanonicalJson(registeredDescriptor) !== digestCanonicalJson(descriptor)) {
    reasons.push('environment_mismatch');
  }
  if (!invocation || typeof invocation !== 'object' || !receipt || typeof receipt !== 'object') return failure('bad_shape');
  if (!hasOnlyKeys(invocation, INVOCATION_KEYS) || !hasOnlyKeys(receipt, RECEIPT_KEYS)) reasons.push('unexpected_field');
  if (invocation.contractVersion !== EVIDENCE_ENVIRONMENT_CONTRACT_VERSION) reasons.push('unsupported_contract_version');
  if (receipt.receiptVersion !== EVIDENCE_ENVIRONMENT_RECEIPT_VERSION) reasons.push('unsupported_receipt_version');
  const unsignedReceipt = { ...receipt } as Record<string, unknown>;
  delete unsignedReceipt.receiptDigest;
  if (!isNonEmpty(receipt.receiptDigest)
    || receipt.receiptDigest !== digestEvidenceEnvironmentReceipt(
      unsignedReceipt as unknown as Omit<EvidenceEnvironmentReceipt, 'receiptDigest'>,
    )) reasons.push('digest_mismatch');
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
      || !isNonEmpty(invocation.commandSpec.processEnvironmentDigest)
      || (invocation.commandSpec.shell
        ? (!isNonEmpty(invocation.commandSpec.shellExecutableDigest)
          || (invocation.commandSpec.executableDigest !== null
            && !isNonEmpty(invocation.commandSpec.executableDigest)))
        : (!isNonEmpty(invocation.commandSpec.executableDigest)
          || invocation.commandSpec.shellExecutableDigest !== undefined))
      || receipt.commandSpecDigest !== digestEvidenceEnvironmentCommandSpec(invocation.commandSpec)) {
      reasons.push('command_spec_mismatch');
    }
  } else if (descriptor.mode === 'execute-local') {
    reasons.push('command_spec_mismatch');
  }
  if (descriptor.mode === 'read-receipt-only' && invocation.commandSpec) reasons.push('forbidden_execution');
  if (receipt.status === 'error') reasons.push('checker_error');
  if (receipt.producerAttestationRef) {
    // Fail closed until a project-owned registry can verify a pinned public key,
    // signed session binding, invocation/subject binding, and revocation state.
    // A caller callback is deliberately not accepted as a trust root.
    reasons.push('producer_attestation_invalid');
  } else if (descriptor.trustClass === 'external-attested') {
    reasons.push('producer_attestation_missing');
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
  },
): {
  readonly descriptor: EvidenceEnvironmentDescriptor;
  readonly invocation: EvidenceEnvironmentInvocationRequest;
  readonly receipt: EvidenceEnvironmentReceipt;
} {
  if (!receipt.commandSpec) {
    throw new Error(
      'command_spec_mismatch: DONE-required receipt must carry an accepted versioned CommandSpec envelope (current proof-or-stop.command-spec.v2; legacy proof-or-stop.command-spec.v1 accepted for pre-existing receipts)',
    );
  }
  if (!isNonEmpty(receipt.effectiveEnvironmentDigest)) {
    throw new Error('command_spec_mismatch: executor-owned effective environment identity is required');
  }
  if (!receipt.commandSpec.shell && !isNonEmpty(receipt.executableDigest)) {
    throw new Error('command_spec_mismatch: direct execution requires executor-owned target executable identity');
  }
  if (receipt.commandSpec.shell && !isNonEmpty(receipt.shellExecutableDigest)) {
    throw new Error('command_spec_mismatch: shell execution requires executor-owned shell executable identity');
  }
  const commandSpecCwd = (() => {
    if (!isNonEmpty(receipt.commandSpec.cwd)) {
      throw new Error('command_spec_mismatch: DONE-required CommandSpec cwd is required');
    }
    switch (receipt.commandSpec.schema) {
      case 'proof-or-stop.command-spec.v2':
        // v2 owns a repo-relative logical cwd. The top-level receipt.cwd and
        // commandSpec.resolvedCwd are physical execution provenance and must
        // not enter the portable EEA invocation/command identity.
        return receipt.commandSpec.cwd;
      case 'proof-or-stop.command-spec.v1':
        // Legacy v1 digested its absolute cwd. Preserve that identity exactly
        // for pre-existing receipts; v1 was never cross-root portable.
        return receipt.commandSpec.cwd;
      default:
        throw new Error(`command_spec_mismatch: unsupported DONE-required CommandSpec schema ${String((receipt.commandSpec as { schema?: unknown }).schema)}`);
    }
  })();
  const commandSpec: EvidenceEnvironmentCommandSpec = Object.freeze({
    commandId: receipt.commandSpec.digest,
    executable: receipt.command,
    args: Object.freeze([...receipt.args]),
    cwd: commandSpecCwd,
    shell: receipt.commandSpec.shell,
    processEnvironmentDigest: receipt.effectiveEnvironmentDigest,
    executableDigest: receipt.executableDigest ?? null,
    ...(receipt.commandSpec.shell ? { shellExecutableDigest: receipt.shellExecutableDigest! } : {}),
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
  const unsignedReceipt: Omit<EvidenceEnvironmentReceipt, 'receiptDigest'> = {
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
  };
  const environmentReceipt: EvidenceEnvironmentReceipt = Object.freeze({
    ...unsignedReceipt,
    receiptDigest: digestEvidenceEnvironmentReceipt(unsignedReceipt),
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
  const unsignedInvocation: Omit<EvidenceEnvironmentInvocationRequest, 'invocationDigest'> = {
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
  const invocation: EvidenceEnvironmentInvocationRequest = Object.freeze({
    ...unsignedInvocation,
    invocationDigest: digestEvidenceEnvironmentInvocation(unsignedInvocation),
  });
  const unsignedReceipt: Omit<EvidenceEnvironmentReceipt, 'receiptDigest'> = {
      receiptVersion: EVIDENCE_ENVIRONMENT_RECEIPT_VERSION,
      invocationId: input.invocationId,
      invocationDigest: invocation.invocationDigest,
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
  };
  const receipt: EvidenceEnvironmentReceipt = Object.freeze({
    ...unsignedReceipt,
    receiptDigest: digestEvidenceEnvironmentReceipt(unsignedReceipt),
  });
  return Object.freeze({
    descriptor,
    invocation,
    receipt,
  });
}

export interface EvidenceEnvironmentGateProjectionInput {
  readonly descriptorId: string;
  readonly invocation: EvidenceEnvironmentInvocationRequest;
  readonly receipt: EvidenceEnvironmentReceipt;
  readonly artifactKind: string;
  readonly consumer: ArtifactConsumerKind;
  readonly claim: ClaimKind;
  readonly checks: AdmissibilityChecks;
  readonly additionalPolicyRequirements?: readonly boolean[];
  readonly now?: Date;
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
  const descriptor = DEFAULT_ENVIRONMENT_REGISTRY.resolve(input.descriptorId);
  const boundary = Object.freeze({
    observationOnly: true as const,
    createsStorage: false as const,
    createsLifecycleGate: false as const,
    completionEligible: false as const,
  });
  if (!descriptor) {
    return Object.freeze({
      decision: 'stop',
      allowed: false,
      reasons: Object.freeze(['unknown_environment_descriptor'] as const),
      policyInputDigest: '',
      boundary,
    });
  }
  const normalized = normalizeEvidenceEnvironmentReceipt(
    descriptor,
    input.invocation,
    input.receipt,
    input.now ?? new Date(),
    { registry: DEFAULT_ENVIRONMENT_REGISTRY },
  );
  if (!normalized.ok) {
    return Object.freeze({
      decision: 'stop',
      allowed: false,
      reasons: normalized.reasons,
      policyInputDigest: '',
      boundary,
    });
  }
  const envelope = normalized.envelope;
  if (envelope.status !== 'pass') {
    const statusReason: Record<Exclude<EvidenceEnvironmentReceiptStatus, 'pass'>, EvidenceEnvironmentReasonCode> = {
      fail: 'receipt_failed',
      error: 'checker_error',
      timeout: 'receipt_timeout',
      cancelled: 'receipt_cancelled',
      unavailable: 'receipt_unavailable',
    };
    reasons.push(statusReason[envelope.status]);
  }
  if (envelope.trustClass === 'diagnostic-only') reasons.push('diagnostic_only_non_gate');
  if (input.additionalPolicyRequirements?.some((satisfied) => !satisfied)) reasons.push('clause_not_bound');

  const admissibility = evaluateProofAdmissibility({
    artifactKind: input.artifactKind,
    consumer: input.consumer,
    claim: input.claim,
    checks: {
      ...input.checks,
      contractVersion: PROOF_ADMISSIBILITY_CONTRACT_VERSION,
      verifierVersion: PROOF_ADMISSIBILITY_VERIFIER_VERSION,
      semanticDigestValid: Boolean(envelope.semanticDigest),
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
    policyInputDigest: envelope.policyInputDigest,
    boundary: envelope.boundary,
  });
}

export function evaluateEvidenceEnvironmentQuorum(
  input: {
    readonly items: readonly {
      readonly descriptorId: string;
      readonly invocation: EvidenceEnvironmentInvocationRequest;
      readonly receipt: EvidenceEnvironmentReceipt;
    }[];
    readonly requiredCount?: number;
    readonly now?: Date;
  },
): {
  readonly independent: boolean;
  readonly reasons: readonly EvidenceEnvironmentReasonCode[];
} {
  const reasons: EvidenceEnvironmentReasonCode[] = [];
  const requiredCount = input.requiredCount ?? 2;
  const attestationRefs = new Set<string>();
  if (!Number.isInteger(requiredCount) || requiredCount < 2 || input.items.length < requiredCount) {
    reasons.push('quorum_cardinality_missing');
  }
  for (const item of input.items) {
    const attestationRef = item.receipt.producerAttestationRef;
    if (attestationRef) {
      if (attestationRefs.has(attestationRef)) reasons.push('same_producer_not_independent');
      attestationRefs.add(attestationRef);
    }
    const descriptor = DEFAULT_ENVIRONMENT_REGISTRY.resolve(item.descriptorId);
    if (!descriptor) {
      reasons.push('unknown_environment_descriptor');
      continue;
    }
    const normalized = normalizeEvidenceEnvironmentReceipt(
      descriptor,
      item.invocation,
      item.receipt,
      input.now ?? new Date(),
      { registry: DEFAULT_ENVIRONMENT_REGISTRY },
    );
    if (!normalized.ok) {
      reasons.push(...normalized.reasons);
      continue;
    }
    if (!attestationRef) {
      reasons.push('producer_attestation_missing');
      continue;
    }
  }
  // No project-owned, key-pinned, revocation-aware producer registry exists yet.
  // Therefore producerId/lineageId/keyId/sessionId independence cannot be
  // established and distinct-host quorum is intentionally unsupported.
  reasons.push('distinct_host_quorum_unsupported');
  const unique = Object.freeze([...new Set(reasons)]);
  return Object.freeze({ independent: false, reasons: unique });
}

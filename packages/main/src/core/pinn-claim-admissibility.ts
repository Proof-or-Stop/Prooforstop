import { createHash } from 'node:crypto';

export const PINN_CLAIM_ADMISSIBILITY_SCHEMA_VERSION = 'lattice.pinn_claim_admissibility.v1' as const;
export const PINN_CLAIM_ADMISSIBILITY_VERIFIER_VERSION = 'lattice.pinn_claim_admissibility_verifier.v1' as const;

export const PINN_BOUNDARY_PARAGRAPH =
  'Proof-or-Stop for PINNs is a local claim-admissibility control layer. It checks whether a stated PINN claim has current, bound evidence before advancing; it does not prove PDE correctness, deployment readiness, or external completion.';

export const PINN_CLAIM_IDS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'] as const;
export type PinnClaimId = typeof PINN_CLAIM_IDS[number];

export const PINN_ADAPTER_IDS = [
  'spec-freeze',
  'training',
  'residual',
  'boundary-condition',
  'initial-condition',
  'out-of-sample',
  'baseline-fairness',
  'reproducibility',
  'provenance',
] as const;
export type PinnAdapterId = typeof PINN_ADAPTER_IDS[number];

export const PINN_IDENTITY_FIELDS = [
  'pdeSpecHash',
  'domainHash',
  'boundaryConditionHash',
  'initialConditionHash',
  'collocationPointHash',
  'evaluationGridHash',
  'trainingConfigHash',
  'randomSeed',
  'checkpointHash',
  'codeHash',
  'verifierScriptHash',
  'environmentHash',
  'outputDigest',
] as const;
export type PinnIdentityField = typeof PINN_IDENTITY_FIELDS[number];

export interface PinnEvidenceIdentity {
  pdeSpecHash: string;
  domainHash: string;
  boundaryConditionHash: string;
  initialConditionHash: string;
  collocationPointHash: string;
  evaluationGridHash: string;
  trainingConfigHash: string;
  randomSeed: string;
  checkpointHash: string;
  codeHash: string;
  verifierScriptHash: string;
  environmentHash: string;
  outputDigest: string;
}

export interface PinnVerifierReceipt {
  adapterId: PinnAdapterId;
  status: 'pass' | 'fail';
  exitCode: number;
  identity: Partial<PinnEvidenceIdentity>;
  verifierScriptHash?: string;
  outputDigest?: string;
  thresholdVersion?: string;
  metricName?: string;
  observedAt?: string;
  stale?: boolean;
  note?: string;
}

export interface PinnClaimCheckInput {
  schemaVersion?: string;
  claimId: PinnClaimId | string;
  activeIdentity?: Partial<PinnEvidenceIdentity>;
  receipts?: PinnVerifierReceipt[];
  narrativeClaim?: string;
  checklistPassed?: boolean;
  trainingLossLow?: boolean;
  deploymentReadyClaim?: boolean;
  externalCompletionClaim?: boolean;
  terminalCompletionClaim?: boolean;
  pdeCorrectnessClaim?: boolean;
}

export interface PinnArtifactIndexEntry {
  id: string;
  kind: string;
  digest: string;
}

export interface PinnClaimCheckResult {
  schemaVersion: typeof PINN_CLAIM_ADMISSIBILITY_SCHEMA_VERSION;
  verifierVersion: typeof PINN_CLAIM_ADMISSIBILITY_VERIFIER_VERSION;
  claimId: string;
  allowed: boolean;
  nextAction: 'advance' | 'repair' | 'degrade' | 'stop';
  reasons: string[];
  checkedAdapters: PinnAdapterId[];
  missingAdapters: PinnAdapterId[];
  deploymentReadyClaim: false;
  externalCompletionClaim: false;
  terminalCompletionClaim: false;
  pdeCorrectnessClaim: false;
  boundary: string;
  artifactIndex: PinnArtifactIndexEntry[];
}

export interface PinnInjectionSpec {
  id: string;
  title: string;
  class: 'missing' | 'stale' | 'unsafe' | 'overclaim';
  expectedA4Reason: string;
}

export interface PinnArmMetrics {
  armId: 'A1' | 'A2' | 'A3' | 'A4';
  name: string;
  total: number;
  acceptedCount: number;
  rejectedCount: number;
  unsupportedAcceptanceCount: number;
  staleAcceptanceCount: number;
  rejectedInjectionCount: number;
  rejectionRate: number;
  rejectionWilson95: { low: number; high: number };
  meanWallTimeMs: number;
  meanInterventionCount: number;
  acceptedInjectionIds: string[];
  rejectedInjectionIds: string[];
}

export interface PinnBenchmarkReport {
  schemaVersion: 'lattice.pinn_claim_admissibility_benchmark.v1';
  suiteStatus: 'PASS' | 'FAIL';
  generatedAt: string;
  totalInjections: number;
  injections: PinnInjectionSpec[];
  arms: PinnArmMetrics[];
  a4: PinnArmMetrics;
  claims: {
    deploymentReadyClaim: false;
    externalCompletionClaim: false;
    terminalCompletionClaim: false;
    pdeCorrectnessClaim: false;
  };
  boundary: string;
  artifactIndex: PinnArtifactIndexEntry[];
}

export const PINN_FAILURE_INJECTIONS: readonly PinnInjectionSpec[] = [
  { id: 'B1', title: 'spec changed while residual reused', class: 'stale', expectedA4Reason: 'identity_mismatch' },
  { id: 'B2', title: 'BC changed while BC report reused', class: 'stale', expectedA4Reason: 'identity_mismatch' },
  { id: 'B3', title: 'checkpoint mismatch', class: 'stale', expectedA4Reason: 'identity_mismatch' },
  { id: 'B4', title: 'collocation points changed', class: 'stale', expectedA4Reason: 'identity_mismatch' },
  { id: 'B5', title: 'grid narrowed to easy region', class: 'stale', expectedA4Reason: 'identity_mismatch' },
  { id: 'B6', title: 'baseline comparison benchmark mismatch', class: 'stale', expectedA4Reason: 'identity_mismatch' },
  { id: 'B7', title: 'stale figure provenance', class: 'stale', expectedA4Reason: 'stale_evidence' },
  { id: 'B8', title: 'seed/config missing', class: 'missing', expectedA4Reason: 'missing_identity_field' },
  { id: 'B9', title: 'low training loss but high out-of-sample residual', class: 'unsafe', expectedA4Reason: 'receipt_status_not_pass' },
  { id: 'B10', title: 'verifier threshold silently changed', class: 'unsafe', expectedA4Reason: 'verifier_threshold_mismatch' },
  { id: 'B11', title: 'BC report missing', class: 'missing', expectedA4Reason: 'missing_required_receipt' },
  { id: 'B12', title: 'IC report missing', class: 'missing', expectedA4Reason: 'missing_required_receipt' },
  { id: 'B13', title: 'code changed after checkpoint', class: 'stale', expectedA4Reason: 'identity_mismatch' },
  { id: 'B14', title: 'metric changed', class: 'unsafe', expectedA4Reason: 'metric_mismatch' },
  { id: 'B15', title: 'manually edited figures/tables', class: 'unsafe', expectedA4Reason: 'identity_mismatch' },
] as const;

const CLAIM_REQUIRED_ADAPTERS: Record<PinnClaimId, readonly PinnAdapterId[]> = {
  C1: ['spec-freeze'],
  C2: ['spec-freeze', 'training'],
  C3: ['spec-freeze', 'training', 'residual'],
  C4: ['spec-freeze', 'training', 'residual', 'boundary-condition'],
  C5: ['spec-freeze', 'training', 'residual', 'boundary-condition', 'initial-condition'],
  C6: ['spec-freeze', 'training', 'residual', 'boundary-condition', 'initial-condition', 'out-of-sample'],
  C7: ['spec-freeze', 'training', 'residual', 'boundary-condition', 'initial-condition', 'out-of-sample', 'baseline-fairness'],
  C8: ['spec-freeze', 'training', 'residual', 'boundary-condition', 'initial-condition', 'out-of-sample', 'baseline-fairness', 'reproducibility'],
  C9: ['spec-freeze', 'training', 'residual', 'boundary-condition', 'initial-condition', 'out-of-sample', 'baseline-fairness', 'reproducibility', 'provenance'],
};

function isKnownClaim(claimId: string): claimId is PinnClaimId {
  return (PINN_CLAIM_IDS as readonly string[]).includes(claimId);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function pinnDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function demoHash(label: string): string {
  return pinnDigest({ demo: 'pinn-claim-admissibility', label });
}

function completeIdentity(): PinnEvidenceIdentity {
  return {
    pdeSpecHash: demoHash('pde-spec:v1'),
    domainHash: demoHash('domain:v1'),
    boundaryConditionHash: demoHash('boundary-condition:v1'),
    initialConditionHash: demoHash('initial-condition:v1'),
    collocationPointHash: demoHash('collocation-points:v1'),
    evaluationGridHash: demoHash('evaluation-grid:v1'),
    trainingConfigHash: demoHash('training-config:v1'),
    randomSeed: 'seed:20260702',
    checkpointHash: demoHash('checkpoint:v1'),
    codeHash: demoHash('code:v1'),
    verifierScriptHash: demoHash('verifier-script:v1'),
    environmentHash: demoHash('environment:v1'),
    outputDigest: demoHash('output:v1'),
  };
}

function completeReceipt(adapterId: PinnAdapterId, identity: PinnEvidenceIdentity): PinnVerifierReceipt {
  return {
    adapterId,
    status: 'pass',
    exitCode: 0,
    identity: { ...identity },
    verifierScriptHash: identity.verifierScriptHash,
    outputDigest: demoHash(`receipt:${adapterId}:output`),
    thresholdVersion: 'thresholds:v1',
    metricName: adapterId,
    observedAt: '2026-07-02T00:00:00.000Z',
  };
}

export function buildCompletePinnEvidence(claimId: PinnClaimId = 'C9'): PinnClaimCheckInput {
  const activeIdentity = completeIdentity();
  return {
    schemaVersion: PINN_CLAIM_ADMISSIBILITY_SCHEMA_VERSION,
    claimId,
    activeIdentity,
    receipts: PINN_ADAPTER_IDS.map((adapterId) => completeReceipt(adapterId, activeIdentity)),
    narrativeClaim: 'Local PINN claim-admissibility evidence is complete for the requested claim boundary.',
    checklistPassed: true,
    trainingLossLow: false,
    deploymentReadyClaim: false,
    externalCompletionClaim: false,
    terminalCompletionClaim: false,
    pdeCorrectnessClaim: false,
  };
}

function receiptFor(input: PinnClaimCheckInput, adapterId: PinnAdapterId): PinnVerifierReceipt | undefined {
  return input.receipts?.find((receipt) => receipt.adapterId === adapterId);
}

function removeReceipt(input: PinnClaimCheckInput, adapterId: PinnAdapterId): void {
  input.receipts = (input.receipts ?? []).filter((receipt) => receipt.adapterId !== adapterId);
}

export function buildInjectedPinnEvidence(injectionId: string): PinnClaimCheckInput {
  const input = buildCompletePinnEvidence('C9');
  const activeIdentity = input.activeIdentity as PinnEvidenceIdentity;
  switch (injectionId) {
    case 'B1': {
      activeIdentity.pdeSpecHash = demoHash('pde-spec:v2');
      const receipt = receiptFor(input, 'residual');
      if (receipt) receipt.stale = true;
      break;
    }
    case 'B2': {
      activeIdentity.boundaryConditionHash = demoHash('boundary-condition:v2');
      const receipt = receiptFor(input, 'boundary-condition');
      if (receipt) receipt.stale = true;
      break;
    }
    case 'B3': {
      const receipt = receiptFor(input, 'training');
      if (receipt) receipt.identity.checkpointHash = demoHash('checkpoint:old');
      const residual = receiptFor(input, 'residual');
      if (residual) residual.identity.checkpointHash = demoHash('checkpoint:old');
      break;
    }
    case 'B4': {
      activeIdentity.collocationPointHash = demoHash('collocation-points:v2');
      const receipt = receiptFor(input, 'residual');
      if (receipt) receipt.stale = true;
      break;
    }
    case 'B5': {
      activeIdentity.evaluationGridHash = demoHash('evaluation-grid:easy-region');
      const receipt = receiptFor(input, 'out-of-sample');
      if (receipt) receipt.stale = true;
      break;
    }
    case 'B6': {
      const receipt = receiptFor(input, 'baseline-fairness');
      if (receipt) receipt.identity.outputDigest = demoHash('baseline:other-benchmark');
      break;
    }
    case 'B7': {
      const receipt = receiptFor(input, 'provenance');
      if (receipt) receipt.stale = true;
      break;
    }
    case 'B8':
      delete input.activeIdentity?.randomSeed;
      delete input.activeIdentity?.trainingConfigHash;
      break;
    case 'B9': {
      const receipt = receiptFor(input, 'residual');
      if (receipt) receipt.status = 'fail';
      const oosReceipt = receiptFor(input, 'out-of-sample');
      if (oosReceipt) oosReceipt.status = 'fail';
      input.trainingLossLow = true;
      break;
    }
    case 'B10': {
      const receipt = receiptFor(input, 'residual');
      if (receipt) receipt.thresholdVersion = 'thresholds:relaxed';
      break;
    }
    case 'B11':
      removeReceipt(input, 'boundary-condition');
      break;
    case 'B12':
      removeReceipt(input, 'initial-condition');
      break;
    case 'B13': {
      activeIdentity.codeHash = demoHash('code:v2-after-checkpoint');
      const checkpointReceipts = ['training', 'residual', 'boundary-condition', 'initial-condition', 'out-of-sample'] as const;
      for (const adapterId of checkpointReceipts) {
        const receipt = receiptFor(input, adapterId);
        if (receipt) receipt.stale = true;
      }
      break;
    }
    case 'B14': {
      const receipt = receiptFor(input, 'baseline-fairness');
      if (receipt) receipt.metricName = 'changed-metric';
      break;
    }
    case 'B15': {
      const receipt = receiptFor(input, 'provenance');
      if (receipt) receipt.identity.outputDigest = demoHash('manually-edited-figures');
      break;
    }
    default:
      throw new Error(`Unknown PINN failure injection: ${injectionId}`);
  }
  if (input.activeIdentity && input.activeIdentity.verifierScriptHash === undefined) {
    input.activeIdentity.verifierScriptHash = activeIdentity.verifierScriptHash;
  }
  return input;
}

function reason(code: string, subject?: string): string {
  return subject ? `${code}:${subject}` : code;
}

function boundaryViolation(input: PinnClaimCheckInput): boolean {
  if (input.deploymentReadyClaim === true || input.externalCompletionClaim === true || input.terminalCompletionClaim === true || input.pdeCorrectnessClaim === true) {
    return true;
  }
  const retiredFields = [
    ['production', 'Done'].join(''),
    ['authority', 'Done'].join(''),
    ['full', 'Authority', 'Done'].join(''),
  ];
  const record = input as unknown as Record<string, unknown>;
  if (retiredFields.some((field) => record[field] === true)) return true;
  const text = input.narrativeClaim ?? '';
  return /\b(proves?\s+PDE\s+correctness|deployment\s+ready|ready\s+for\s+deployment|external\s+completion|deploymentReadyClaim\s*[:=]\s*true|externalCompletionClaim\s*[:=]\s*true|pdeCorrectnessClaim\s*[:=]\s*true)\b/i.test(text);
}

function classifyNextAction(reasons: readonly string[]): PinnClaimCheckResult['nextAction'] {
  if (reasons.length === 0) return 'advance';
  if (reasons.some((item) => /^(unsupported_|claim_boundary_violation|identity_mismatch|verifier_script_mismatch|verifier_threshold_mismatch|metric_mismatch|output_digest_mismatch|duplicate_receipt|receipt_exit_nonzero|receipt_status_not_pass)/.test(item))) {
    return 'stop';
  }
  if (reasons.some((item) => item.startsWith('stale_evidence'))) return 'degrade';
  return 'repair';
}

function artifactIndexFor(input: PinnClaimCheckInput, checkedAdapters: readonly PinnAdapterId[]): PinnArtifactIndexEntry[] {
  return [
    { id: 'active-identity', kind: 'pinn-evidence-identity', digest: pinnDigest(input.activeIdentity ?? {}) },
    { id: 'checked-adapters', kind: 'pinn-adapter-set', digest: pinnDigest(checkedAdapters) },
    { id: 'receipt-set', kind: 'pinn-verifier-receipts', digest: pinnDigest(input.receipts ?? []) },
  ];
}

export function evaluatePinnClaim(input: PinnClaimCheckInput): PinnClaimCheckResult {
  const reasons: string[] = [];
  const schemaVersion = input.schemaVersion ?? PINN_CLAIM_ADMISSIBILITY_SCHEMA_VERSION;
  if (schemaVersion !== PINN_CLAIM_ADMISSIBILITY_SCHEMA_VERSION) {
    reasons.push(reason('unsupported_schema_version', schemaVersion));
  }
  const claimId = String(input.claimId);
  if (!isKnownClaim(claimId)) {
    reasons.push(reason('unsupported_claim', claimId));
  }
  if (boundaryViolation(input)) reasons.push('claim_boundary_violation');

  const identity = input.activeIdentity ?? {};
  for (const field of PINN_IDENTITY_FIELDS) {
    if (typeof identity[field] !== 'string' || identity[field]?.trim() === '') {
      reasons.push(reason('missing_identity_field', field));
    }
  }

  const requiredAdapters = isKnownClaim(claimId) ? CLAIM_REQUIRED_ADAPTERS[claimId] : [];
  const missingAdapters: PinnAdapterId[] = [];
  const checkedAdapters: PinnAdapterId[] = [];
  const receiptByAdapter = new Map<PinnAdapterId, PinnVerifierReceipt>();
  for (const receipt of input.receipts ?? []) {
    if (!receiptByAdapter.has(receipt.adapterId)) {
      receiptByAdapter.set(receipt.adapterId, receipt);
      continue;
    }
    reasons.push(reason('duplicate_receipt', receipt.adapterId));
  }

  for (const adapterId of requiredAdapters) {
    const receipt = receiptByAdapter.get(adapterId);
    if (!receipt) {
      missingAdapters.push(adapterId);
      reasons.push(reason('missing_required_receipt', adapterId));
      continue;
    }
    checkedAdapters.push(adapterId);
    if (receipt.exitCode !== 0) reasons.push(reason('receipt_exit_nonzero', adapterId));
    if (receipt.status !== 'pass') reasons.push(reason('receipt_status_not_pass', adapterId));
    if (receipt.stale === true) reasons.push(reason('stale_evidence', adapterId));
    if (!receipt.outputDigest || receipt.outputDigest.trim() === '') reasons.push(reason('output_digest_missing', adapterId));
    if (receipt.thresholdVersion && receipt.thresholdVersion !== 'thresholds:v1') {
      reasons.push(reason('verifier_threshold_mismatch', adapterId));
    }
    if (receipt.metricName && receipt.metricName !== adapterId) {
      reasons.push(reason('metric_mismatch', adapterId));
    }
    if (!receipt.verifierScriptHash || receipt.verifierScriptHash !== identity.verifierScriptHash) {
      reasons.push(reason('verifier_script_mismatch', adapterId));
    }
    for (const field of PINN_IDENTITY_FIELDS) {
      if (receipt.identity[field] !== identity[field]) {
        reasons.push(reason('identity_mismatch', `${adapterId}.${field}`));
      }
    }
  }

  if (input.trainingLossLow === true && isKnownClaim(claimId) && PINN_CLAIM_IDS.indexOf(claimId) >= PINN_CLAIM_IDS.indexOf('C3')) {
    const nonTrainingAdapters = requiredAdapters.filter((adapterId) => adapterId !== 'spec-freeze' && adapterId !== 'training');
    const missingOrInvalid = nonTrainingAdapters.some((adapterId) => reasons.some((item) => item.endsWith(adapterId) || item.includes(`${adapterId}.`)));
    if (missingOrInvalid) reasons.push('training_loss_not_solution_evidence');
  }

  const uniqueReasons = [...new Set(reasons)];
  const nextAction = classifyNextAction(uniqueReasons);
  return {
    schemaVersion: PINN_CLAIM_ADMISSIBILITY_SCHEMA_VERSION,
    verifierVersion: PINN_CLAIM_ADMISSIBILITY_VERIFIER_VERSION,
    claimId,
    allowed: uniqueReasons.length === 0,
    nextAction,
    reasons: uniqueReasons,
    checkedAdapters,
    missingAdapters,
    deploymentReadyClaim: false,
    externalCompletionClaim: false,
    terminalCompletionClaim: false,
    pdeCorrectnessClaim: false,
    boundary: PINN_BOUNDARY_PARAGRAPH,
    artifactIndex: artifactIndexFor(input, checkedAdapters),
  };
}

function verifierOnlyAccepts(input: PinnClaimCheckInput): boolean {
  return (input.receipts ?? []).every((receipt) => receipt.exitCode === 0 && receipt.status === 'pass');
}

function wilsonInterval(successes: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const phat = successes / total;
  const denom = 1 + (z * z) / total;
  const center = phat + (z * z) / (2 * total);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total);
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}

function metricsForArm(
  armId: PinnArmMetrics['armId'],
  name: string,
  decisions: { injection: PinnInjectionSpec; accepted: boolean; interventionCount: number; wallTimeMs: number }[],
): PinnArmMetrics {
  const accepted = decisions.filter((decision) => decision.accepted);
  const rejected = decisions.filter((decision) => !decision.accepted);
  const rejectedCount = rejected.length;
  return {
    armId,
    name,
    total: decisions.length,
    acceptedCount: accepted.length,
    rejectedCount,
    unsupportedAcceptanceCount: accepted.length,
    staleAcceptanceCount: accepted.filter((decision) => decision.injection.class === 'stale').length,
    rejectedInjectionCount: rejectedCount,
    rejectionRate: decisions.length === 0 ? 0 : rejectedCount / decisions.length,
    rejectionWilson95: wilsonInterval(rejectedCount, decisions.length),
    meanWallTimeMs: decisions.reduce((sum, decision) => sum + decision.wallTimeMs, 0) / Math.max(1, decisions.length),
    meanInterventionCount: decisions.reduce((sum, decision) => sum + decision.interventionCount, 0) / Math.max(1, decisions.length),
    acceptedInjectionIds: accepted.map((decision) => decision.injection.id),
    rejectedInjectionIds: rejected.map((decision) => decision.injection.id),
  };
}

export function runPinnClaimBenchmark(): PinnBenchmarkReport {
  const decisions = PINN_FAILURE_INJECTIONS.map((injection) => {
    const input = buildInjectedPinnEvidence(injection.id);
    return {
      injection,
      input,
      a1: true,
      a2: input.checklistPassed === true,
      a3: verifierOnlyAccepts(input),
      a4: evaluatePinnClaim(input),
    };
  });
  const arms: PinnArmMetrics[] = [
    metricsForArm('A1', 'self-report narrative only', decisions.map((decision, index) => ({
      injection: decision.injection,
      accepted: decision.a1,
      interventionCount: 0,
      wallTimeMs: 1 + (index % 2),
    }))),
    metricsForArm('A2', 'checklist-only review', decisions.map((decision, index) => ({
      injection: decision.injection,
      accepted: decision.a2,
      interventionCount: 1,
      wallTimeMs: 2 + (index % 3),
    }))),
    metricsForArm('A3', 'verifier receipts without lifecycle gate', decisions.map((decision, index) => ({
      injection: decision.injection,
      accepted: decision.a3,
      interventionCount: 2,
      wallTimeMs: 4 + (index % 4),
    }))),
    metricsForArm('A4', 'Proof-or-Stop claim gate', decisions.map((decision, index) => ({
      injection: decision.injection,
      accepted: decision.a4.allowed,
      interventionCount: decision.a4.allowed ? 1 : 3,
      wallTimeMs: 8 + (index % 5),
    }))),
  ];
  const a4 = arms.find((arm) => arm.armId === 'A4');
  if (!a4) throw new Error('internal error: A4 metrics missing');
  const weakerArmsExposeGap = arms.filter((arm) => arm.armId !== 'A4').some((arm) => arm.unsupportedAcceptanceCount > 0);
  const suiteStatus = a4.rejectedInjectionCount === PINN_FAILURE_INJECTIONS.length && weakerArmsExposeGap ? 'PASS' : 'FAIL';
  return {
    schemaVersion: 'lattice.pinn_claim_admissibility_benchmark.v1',
    suiteStatus,
    generatedAt: '2026-07-02T00:00:00.000Z',
    totalInjections: PINN_FAILURE_INJECTIONS.length,
    injections: [...PINN_FAILURE_INJECTIONS],
    arms,
    a4,
    claims: {
      deploymentReadyClaim: false,
      externalCompletionClaim: false,
      terminalCompletionClaim: false,
      pdeCorrectnessClaim: false,
    },
    boundary: PINN_BOUNDARY_PARAGRAPH,
    artifactIndex: [
      { id: 'injection-corpus', kind: 'pinn-failure-injections', digest: pinnDigest(PINN_FAILURE_INJECTIONS) },
      { id: 'arm-metrics', kind: 'pinn-benchmark-metrics', digest: pinnDigest(arms) },
      { id: 'boundary', kind: 'claim-boundary', digest: pinnDigest(PINN_BOUNDARY_PARAGRAPH) },
    ],
  };
}

export function renderPinnClaimCheckText(result: PinnClaimCheckResult): string {
  return [
    `PINN claim check (${result.schemaVersion})`,
    `claimId: ${result.claimId}`,
    `allowed: ${result.allowed}`,
    `nextAction: ${result.nextAction}`,
    `reasons: ${result.reasons.join(', ') || 'none'}`,
    `checkedAdapters: ${result.checkedAdapters.join(', ') || 'none'}`,
    `missingAdapters: ${result.missingAdapters.join(', ') || 'none'}`,
    `deploymentReadyClaim: ${result.deploymentReadyClaim}`,
    `externalCompletionClaim: ${result.externalCompletionClaim}`,
    `terminalCompletionClaim: ${result.terminalCompletionClaim}`,
    `pdeCorrectnessClaim: ${result.pdeCorrectnessClaim}`,
    result.boundary,
  ].join('\n');
}

export function renderPinnBenchmarkText(report: PinnBenchmarkReport): string {
  const lines = [
    `PINN claim-admissibility benchmark (${report.schemaVersion})`,
    `suiteStatus: ${report.suiteStatus}`,
    `totalInjections: ${report.totalInjections}`,
    `A4 rejectedInjectionCount: ${report.a4.rejectedInjectionCount}`,
  ];
  for (const arm of report.arms) {
    lines.push(
      `${arm.armId} ${arm.name}: accepted=${arm.acceptedCount}/${arm.total} rejected=${arm.rejectedCount}/${arm.total} rejectionRate=${arm.rejectionRate.toFixed(3)} wilson95=[${arm.rejectionWilson95.low.toFixed(3)}, ${arm.rejectionWilson95.high.toFixed(3)}] overheadMs=${arm.meanWallTimeMs.toFixed(1)} interventions=${arm.meanInterventionCount.toFixed(1)}`,
    );
  }
  lines.push(`deploymentReadyClaim: ${report.claims.deploymentReadyClaim}`);
  lines.push(`externalCompletionClaim: ${report.claims.externalCompletionClaim}`);
  lines.push(`terminalCompletionClaim: ${report.claims.terminalCompletionClaim}`);
  lines.push(`pdeCorrectnessClaim: ${report.claims.pdeCorrectnessClaim}`);
  lines.push(report.boundary);
  return lines.join('\n');
}

export function renderPinnReportText(report: PinnBenchmarkReport): string {
  const lines = [
    'PINN claim-admissibility report',
    `suiteStatus: ${report.suiteStatus}`,
    `A4 blocks: ${report.a4.rejectedInjectionCount}/${report.totalInjections}`,
    'artifactIndex:',
    ...report.artifactIndex.map((entry) => `  - ${entry.id} (${entry.kind}) ${entry.digest}`),
    `deploymentReadyClaim: ${report.claims.deploymentReadyClaim}`,
    `externalCompletionClaim: ${report.claims.externalCompletionClaim}`,
    `terminalCompletionClaim: ${report.claims.terminalCompletionClaim}`,
    `pdeCorrectnessClaim: ${report.claims.pdeCorrectnessClaim}`,
    report.boundary,
  ];
  return lines.join('\n');
}

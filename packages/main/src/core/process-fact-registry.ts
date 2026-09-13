import { posix as pathPosix } from 'node:path';
import {
  COMMAND_POLICIES,
  type CommandPolicy,
  type CommandDestructiveRisk,
  type CommandLifecycleStatus,
  type CommandPhase,
  type KnownCommandName,
} from './command-policy.js';
import { FLOW_FACT_POLICIES } from './flow-fact-policy.js';
import { PROCESS_FACT_LEVELS, type ProcessFactLevel, type ProcessFactLevelEntry } from './process-fact-levels.js';

export const CANDIDATE_SPEC_PROCESS_FACT_SCHEMA_VERSION = 'proof-or-stop.candidate-spec-set.v1' as const;

export type ProcessFactKind =
  | 'command'
  | 'runtime-behavior'
  | 'gate-evidence'
  | 'execution-status'
  | 'validation-status'
  | 'review-run'
  | 'review-pass'
  | 'prompt-envelope'
  | 'finding'
  | 'flow-policy'
  | 'host-availability-probe'
  | 'host-verdict'
  | 'reviewer-lane'
  | 'signed-artifact'
  | 'artifact';

export type ProcessFactSemantic =
  | 'artifact'
  | 'atomic-persistence'
  | 'blocker-state'
  | 'command'
  | 'execution-evidence'
  | 'finding-state'
  | 'flow-policy'
  | 'freshness-policy'
  | 'gate-evidence'
  | 'host-availability'
  | 'host-readiness'
  | 'host-verdict'
  | 'no-blocker-evidence'
  | 'normalization-policy'
  | 'review-run'
  | 'review-pass'
  | 'prompt-envelope'
  | 'reviewer-lane'
  | 'runtime-behavior'
  | 'schema-contract'
  | 'signed-artifact'
  | 'supersession-policy'
  | 'test-evidence'
  | 'validation-result'
  | 'validation-status'
  | 'verification-evidence'
  | 'verification-policy'
  | 'workspace-binding';

export const REPRO_BOOTSTRAP_COMPONENT_IDS = ['P0m', 'P0p', 'P1', 'P1f', 'P2a', 'P2b'] as const;
export type ReproBootstrapComponentId = typeof REPRO_BOOTSTRAP_COMPONENT_IDS[number];
/** The only process-fact floor the current selector implements. */
export const VALIDATION_TIER_FLOOR = 'repository-full' as const;
export type ValidationTierFloor = typeof VALIDATION_TIER_FLOOR;
export const DYNAMIC_FINDING_VALIDATION_FLOOR_FACT_NAME = 'runtime:dynamic_finding_applicability_gate' as const;

export interface ProcessFactArtifactRef {
  name: string;
  path: string;
  signed: boolean;
  signature?: string;
  producerCommand?: string;
  consumerGate?: string;
  reviewerLane?: string;
}

export interface ProcessFactRegistryEntry {
  /** Stable identity used by registry digests. Final registry entries always carry it. */
  factId: string;
  /** Authoritative declaration paths; component-owned entries author their exact governed paths. */
  paths: readonly string[];
  componentId?: ReproBootstrapComponentId;
  serializationBoundaryId?: string;
  /** Source path for a generated path in `paths`; omitted for source paths. */
  generatedFrom?: string;
  name: string;
  kind: ProcessFactKind;
  semantics: readonly ProcessFactSemantic[];
  level: ProcessFactLevel;
  /** Validation tier floor for changes to this fact's explicitly governed paths. */
  validationTierFloor?: ValidationTierFloor;
  lifecycle?: CommandLifecycleStatus;
  allowedPhases?: readonly CommandPhase[] | 'all';
  rootOnly?: boolean;
  legacy?: boolean;
  gateEvidence?: boolean;
  destructiveRisk?: CommandDestructiveRisk;
  producer: string;
  /** Canonical repository sources that implement/register the producer. */
  producerSourceRefs?: readonly string[];
  consumerGate?: string;
  /** Canonical repository sources that declare or implement the consumer. */
  consumerSourceRefs?: readonly string[];
  artifact?: ProcessFactArtifactRef;
  reviewerLane?: string;
  rationale: string;
}

type ProcessFactRegistryDeclaration = Omit<ProcessFactRegistryEntry, 'factId' | 'paths'>
  & Partial<Pick<ProcessFactRegistryEntry, 'factId' | 'paths'>>;

export interface ProcessFactRegistryProjectionEntry {
  factId: string;
  kind: ProcessFactKind;
  paths: string[];
  componentId?: ReproBootstrapComponentId;
  serializationBoundaryId?: string;
}

export interface ComponentProcessFactMappingEntry {
  factId: string;
  componentId: ReproBootstrapComponentId;
  path: string;
  generatedFrom?: string;
}

export type ProcessFactRegistryMappingFailure =
  | 'process-missing'
  | 'process-ambiguous'
  | 'process-non-total'
  | 'process-generated-without-lineage';

export class ProcessFactRegistryMappingError extends Error {
  readonly code = 'registry-component-mapping-unavailable' as const;
  readonly reason: ProcessFactRegistryMappingFailure;

  constructor(reason: ProcessFactRegistryMappingFailure, detail: string) {
    super(`registry-component-mapping-unavailable: ${reason}: ${detail}`);
    this.name = 'ProcessFactRegistryMappingError';
    this.reason = reason;
  }
}

const PROCESS_FACT_DECLARATION_PATHS_BY_KIND: Record<ProcessFactKind, readonly string[]> = {
  artifact: ['packages/main/src/core/process-fact-registry.ts', 'packages/main/src/core/store.ts'],
  command: ['packages/main/src/core/command-policy.ts', 'packages/main/src/core/process-fact-levels.ts'],
  'execution-status': ['packages/main/src/core/process-fact-levels.ts', 'packages/main/src/core/process-fact-registry.ts'],
  finding: ['packages/main/src/core/process-fact-levels.ts', 'packages/main/src/handlers/finding.ts'],
  'flow-policy': ['packages/main/src/core/flow-fact-policy.ts'],
  'gate-evidence': ['packages/main/src/core/machine.ts', 'packages/main/src/core/process-fact-levels.ts'],
  'host-availability-probe': ['packages/main/src/core/process-fact-levels.ts', 'packages/main/src/handlers/review-escalation.ts'],
  'host-verdict': ['packages/main/src/core/process-fact-levels.ts', 'packages/main/src/handlers/quorum-submit.ts'],
  'prompt-envelope': ['packages/main/src/core/process-fact-levels.ts', 'packages/main/src/core/prompt-envelope.ts'],
  'review-pass': ['packages/main/src/core/process-fact-levels.ts', 'packages/main/src/core/review-run.ts'],
  'review-run': ['packages/main/src/core/process-fact-levels.ts', 'packages/main/src/core/review-run.ts'],
  'reviewer-lane': ['packages/main/src/core/process-fact-registry.ts', 'packages/main/src/core/prompt-role-contract-registry.ts'],
  'runtime-behavior': ['packages/main/src/core/process-fact-levels.ts', 'packages/main/src/core/process-fact-registry.ts'],
  'signed-artifact': ['packages/main/src/core/process-fact-registry.ts', 'packages/main/src/core/validation-artifact-signing.ts'],
  'validation-status': ['packages/main/src/core/process-fact-levels.ts', 'packages/main/src/handlers/verifier.ts'],
};
const GENERATED_PROCESS_FACT_PATH_PREFIXES = [
  '.claude/',
  '.codex/',
  '.proof-or-stop-codex/',
  'dist/',
  'packages/graph/assets/',
  'tests/output/',
] as const;
const GENERATED_PROCESS_FACT_EXACT_PATHS = new Set(['AGENTS.md', 'CLAUDE.md']);

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeProcessFactPath(value: unknown, reason: ProcessFactRegistryMappingFailure): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\0')) {
    throw new ProcessFactRegistryMappingError(reason, 'path must be a non-empty exact string');
  }
  if (value.includes('\\') || /^[A-Za-z]:/u.test(value) || pathPosix.isAbsolute(value)) {
    throw new ProcessFactRegistryMappingError(reason, `absolute path is forbidden: ${value}`);
  }
  const normalized = pathPosix.normalize(value).replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new ProcessFactRegistryMappingError(reason, `path escapes the repository: ${value}`);
  }
  return normalized;
}

function isGeneratedProcessFactPath(path: string): boolean {
  return GENERATED_PROCESS_FACT_EXACT_PATHS.has(path)
    || GENERATED_PROCESS_FACT_PATH_PREFIXES.some(prefix => path.startsWith(prefix))
    || path.includes('/dist/')
    || path.includes('/generated/');
}

function validateOptionalProcessFactIdentity(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ProcessFactRegistryMappingError('process-non-total', `${label} must be a non-empty exact string`);
  }
  return value;
}

function validateProcessFactComponentId(value: unknown): ReproBootstrapComponentId | undefined {
  const componentId = validateOptionalProcessFactIdentity(value, 'componentId');
  if (componentId === undefined) return undefined;
  if (!(REPRO_BOOTSTRAP_COMPONENT_IDS as readonly string[]).includes(componentId)) {
    throw new ProcessFactRegistryMappingError('process-non-total', `unknown componentId: ${componentId}`);
  }
  return componentId as ReproBootstrapComponentId;
}

function normalizeProcessFactMappingEntry(entry: Partial<ProcessFactRegistryEntry>): {
  factId: string;
  kind: ProcessFactKind;
  paths: string[];
  componentId?: ReproBootstrapComponentId;
  serializationBoundaryId?: string;
  generatedFrom?: string;
} {
  if (typeof entry?.factId !== 'string' || entry.factId.length === 0 || entry.factId.trim() !== entry.factId
    || typeof entry.kind !== 'string' || !Array.isArray(entry.paths)) {
    throw new ProcessFactRegistryMappingError('process-missing', 'factId, kind, and paths are required');
  }
  if (entry.paths.length === 0) {
    throw new ProcessFactRegistryMappingError('process-non-total', `${entry.factId} has no mapped path`);
  }
  const paths = entry.paths.map(path => normalizeProcessFactPath(path, 'process-non-total')).sort(compareUtf8);
  if (new Set(paths).size !== paths.length) {
    throw new ProcessFactRegistryMappingError('process-ambiguous', `${entry.factId} maps the same normalized path more than once`);
  }
  const componentId = validateProcessFactComponentId(entry.componentId);
  const serializationBoundaryId = validateOptionalProcessFactIdentity(entry.serializationBoundaryId, 'serializationBoundaryId');
  const generatedFrom = entry.generatedFrom === undefined
    ? undefined
    : normalizeProcessFactPath(entry.generatedFrom, 'process-non-total');
  if (componentId && paths.some(isGeneratedProcessFactPath) && generatedFrom === undefined) {
    throw new ProcessFactRegistryMappingError(
      'process-generated-without-lineage',
      `${entry.factId} maps a generated component path without generatedFrom`,
    );
  }
  if (generatedFrom !== undefined
    && (componentId === undefined || paths.length !== 1 || !isGeneratedProcessFactPath(paths[0])
      || isGeneratedProcessFactPath(generatedFrom) || paths[0] === generatedFrom)) {
    throw new ProcessFactRegistryMappingError(
      'process-non-total',
      `${entry.factId} generatedFrom must bind exactly one generated component path to a different source path`,
    );
  }
  return { factId: entry.factId, kind: entry.kind, paths, componentId, serializationBoundaryId, generatedFrom };
}

/** Complete §4 projection. It deliberately omits generatedFrom. */
export function projectProcessFactRegistry(
  entries: readonly Partial<ProcessFactRegistryEntry>[] = PROCESS_FACT_REGISTRY,
): ProcessFactRegistryProjectionEntry[] {
  const normalized = entries.map(normalizeProcessFactMappingEntry);
  const ids = normalized.map(entry => entry.factId);
  if (new Set(ids).size !== ids.length) {
    throw new ProcessFactRegistryMappingError('process-ambiguous', 'factId values must be unique');
  }
  return normalized
    .map(({ factId, kind, paths, componentId, serializationBoundaryId }) => ({
      factId,
      kind,
      paths,
      ...(componentId === undefined ? {} : { componentId }),
      ...(serializationBoundaryId === undefined ? {} : { serializationBoundaryId }),
    }))
    .sort((left, right) => compareUtf8(left.factId, right.factId));
}

/** Complete §12 component projection. It never consults producer/source/artifact hints. */
export function projectComponentProcessFactMapping(
  componentId: string,
  entries: readonly Partial<ProcessFactRegistryEntry>[] = PROCESS_FACT_REGISTRY,
): ComponentProcessFactMappingEntry[] {
  const requested = validateProcessFactComponentId(componentId);
  if (!requested) {
    throw new ProcessFactRegistryMappingError('process-non-total', 'componentId is required');
  }
  const normalized = entries.map(normalizeProcessFactMappingEntry);
  const tuples = normalized
    .filter(entry => entry.componentId === requested)
    .flatMap(entry => entry.paths.map(path => ({
      factId: entry.factId,
      componentId: requested,
      path,
      ...(entry.generatedFrom === undefined ? {} : { generatedFrom: entry.generatedFrom }),
    })))
    .sort((left, right) => compareUtf8(left.factId, right.factId)
      || compareUtf8(left.path, right.path)
      || compareUtf8(left.generatedFrom ?? '', right.generatedFrom ?? ''));
  const tupleKeys = tuples.map(tuple => `${tuple.factId}\0${tuple.componentId}\0${tuple.path}\0${tuple.generatedFrom ?? ''}`);
  if (new Set(tupleKeys).size !== tupleKeys.length) {
    throw new ProcessFactRegistryMappingError('process-ambiguous', `duplicate component tuple for ${requested}`);
  }
  const ids = normalized.map(entry => entry.factId);
  if (new Set(ids).size !== ids.length) {
    throw new ProcessFactRegistryMappingError('process-ambiguous', 'factId values must be unique');
  }
  return tuples;
}

export function declareProcessFactMapping(entry: ProcessFactRegistryDeclaration): ProcessFactRegistryEntry {
  if (entry.name === DYNAMIC_FINDING_VALIDATION_FLOOR_FACT_NAME
    && (entry.validationTierFloor !== 'repository-full'
      || !Array.isArray(entry.paths)
      || entry.paths.length === 0)) {
    throw new ProcessFactRegistryMappingError(
      'process-non-total',
      `${DYNAMIC_FINDING_VALIDATION_FLOOR_FACT_NAME} requires explicit validation floor paths`,
    );
  }
  if (entry.validationTierFloor !== undefined) {
    if (entry.validationTierFloor !== VALIDATION_TIER_FLOOR) {
      throw new ProcessFactRegistryMappingError(
        'process-non-total',
        `${entry.name} has unknown validationTierFloor: ${String(entry.validationTierFloor)}`,
      );
    }
    if (entry.level !== 'L4') {
      throw new ProcessFactRegistryMappingError(
        'process-non-total',
        `${entry.name} validationTierFloor requires level L4`,
      );
    }
    if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
      throw new ProcessFactRegistryMappingError(
        'process-non-total',
        `${entry.name} validationTierFloor requires explicitly authored paths`,
      );
    }
  }
  const declaredPaths = entry.paths ?? PROCESS_FACT_DECLARATION_PATHS_BY_KIND[entry.kind];
  if (!declaredPaths) {
    throw new ProcessFactRegistryMappingError('process-missing', `${entry.name} has no authored mapping for kind ${entry.kind}`);
  }
  return {
    ...entry,
    factId: entry.factId ?? entry.name,
    paths: declaredPaths.map(path => normalizeProcessFactPath(path, 'process-non-total')).sort(compareUtf8),
  };
}

export interface Story3PersistenceOnlyRecordPolicy {
  // Story 2 semantic validation is a separate contract below, not an expansion
  // of this persistence-only consumer allowlist.
  recordClass: 'persistence' | 'candidate' | 'route' | 'baseline' | 'history' | 'standalone-receipt' | 'ledger-receipt';
  recordTypes: readonly string[];
  level: 'L2';
  producer: string;
  allowedConsumers: readonly ['finding_ledger_query'];
  gateEvidence: false;
  lifecycleAuthority: 'none';
  rationale: string;
}

export const PROCESS_FACT_STORY2_CANDIDATE_POLICY = {
  recordTypes: ['detector_signal', 'candidate', 'candidate_reproduction_attestation'],
  producer: 'handlers/finding-identity',
  semanticVerifier: 'core/finding-identity.verifyIdentityEnvelope',
  carrierVerifier: 'handlers/finding-identity-store.verifiedIdentityCarrier',
  allowedConsumers: ['finding_candidate_get', 'finding_candidate_merge', 'finding_candidate_disprove', 'finding_candidate_promote'],
  gateEvidence: false,
  lifecycleAuthority: 'none',
  promotion: 'current eligible review run signs a semantic reproduction attestation bound to the exact candidate hash, preregistered command/selector, causal receipt hash, and verified FindingRef; marker-only receipt evidence cannot authorize promotion',
} as const;

/** Semantic target consent is independent of durable-byte receipts and gates. */
export const PROCESS_FACT_STORY2_ROUTE_POLICY = {
  recordTypes: ['canonical_defect', 'route_receipt', 'candidate_route', 'progress_baseline', 'progress_baseline_set', 'progress_evidence', 'progress_predecessor'],
  producer: 'handlers/finding-route',
  semanticVerifiers: ['core/finding-route', 'core/finding-progress', 'core/finding-identity'],
  carrierVerifier: 'handlers/finding-identity-store.verifiedIdentityCarrier',
  allowedConsumers: ['finding_identity_query', 'finding_route_verify', 'finding_candidate_route', 'finding_progress_capture', 'finding_progress_predecessor'],
  gateEvidence: false,
  lifecycleAuthority: 'none',
  targetAuthority: 'current target owner or canonical B-META main authority; never source self-authorization',
  predecessorBoundary: 'neutral source checkpoint is not proof of canonical deferral or renewal eligibility',
  sourceRestorationBoundary: 'Story2 imports no Story1 material reader; registry and Story1 callers compose the signed exact-source/root restoration reader internally, while standalone drift and strict current-reviewer acceptance fail closed',
  initialPublication: 'one atomic receipt plus four signed same-kind baselines and complete signed set',
} as const;

/** History is an exact signed lineage projection, never current gate evidence. */
export const PROCESS_FACT_STORY2_HISTORY_POLICY = {
  recordTypes: ['finding_supersession', 'canonical_revision', 'canonical_defect_supersession', 'history_recall'],
  producer: 'handlers/finding-history',
  semanticVerifiers: ['core/finding-history.validateHistoryGraph', 'core/finding-identity.verifyIdentityEnvelope'],
  carrierVerifier: 'handlers/finding-identity-store.verifiedIdentityCarrier',
  allowedConsumers: ['finding_history_query', 'finding_history_recall', 'finding_identity_query', 'finding_route_verify'],
  gateEvidence: false,
  lifecycleAuthority: 'none',
  legacyPolicy: 'strict opt-in Store mirror read; no rewrite or identity creation on reads',
  revisionPublication: 'staged non-current revision activated only by exact signed link; two recoverable transactions',
  recallPolicy: 'once per canonical subject and observed trigger state; invalid historical receipt is never current consent',
  invalidationComposition: 'registry injects handlers/finding-deferral-recall.observeDeferralInvalidation through an internal typed provider; standalone Story2 refuses without it; command JSON and public history queries cannot supply it; locked revalidation and non-gate candidate authority remain unchanged',
} as const;

/** Read-only transport of verified signed records, never a minted credential. */
export const PROCESS_FACT_STORY2_SCORECARD_POLICY = {
  producer: 'handlers/finding-history.finding_identity_scorecard',
  semanticVerifier: 'core/finding-history.verifyIdentityScorecard',
  carrierVerifier: 'handlers/finding-identity-store.verifiedIdentityCarrier',
  allowedConsumers: ['finding_identity_scorecard'],
  gateEvidence: false,
  lifecycleAuthority: 'none',
  currentness: 'exact declared source set, complete record inventory and double-read current snapshot digest; stale expected input refuses',
  measurements: 'per-detector/version/category descriptive adjudication counts, not precision/recall; zero denominator is null insufficient_evidence',
  qualification: 'observe/warn only; no enforce, qualifying window, latency or joint batching certification',
} as const;

/**
 * Persistence authority is deliberately narrower than semantic authority.
 * These rows can prove exact durable bytes only; no row in this table may be
 * promoted to L4 or consumed directly by a lifecycle predicate.
 */
export const PROCESS_FACT_STORY3_PERSISTENCE_ONLY_RECORD_POLICIES = [
  { recordClass: 'persistence', recordTypes: ['finding', 'assessment_proposal', 'assessment', 'mandatory_repair', 'deferral_expiry_policy', 'deferral', 'manifest', 'supersession', 'material_drift_reattestation'], level: 'L2', producer: 'core/finding-ledger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'Atomic persistence proves durable exact bytes, not blocker/pass/unblock truth.' },
  { recordClass: 'candidate', recordTypes: ['candidate', 'candidate_route'], level: 'L2', producer: 'Story 2 schema-neutral caller through core/finding-ledger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'Candidate bytes remain advisory until a separately registered semantic authority acts.' },
  { recordClass: 'route', recordTypes: ['route'], level: 'L2', producer: 'Story 2 schema-neutral caller through core/finding-ledger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'Persisted route bytes never establish applicability or lifecycle disposition.' },
  { recordClass: 'baseline', recordTypes: ['progress_baseline', 'progress_baseline_set', 'baseline_set'], level: 'L2', producer: 'Story 2 schema-neutral caller through core/finding-ledger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'Baseline bytes preserve a non-gate before-state and cannot block, pass, or unblock alone.' },
  { recordClass: 'history', recordTypes: ['historical', 'canonical_defect', 'canonical_defect_supersession'], level: 'L2', producer: 'Story 2 schema-neutral caller through core/finding-ledger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'Historical identity and recall bytes remain advisory rather than current lifecycle evidence.' },
  { recordClass: 'standalone-receipt', recordTypes: ['standalone_receipt', 'route_receipt'], level: 'L2', producer: 'Story 2 schema-neutral caller through core/finding-ledger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'A standalone target receipt remains non-authoritative until an exact-CAS semantic consumer is registered.' },
  { recordClass: 'ledger-receipt', recordTypes: ['finding_ledger_receipt'], level: 'L2', producer: 'handlers/finding-ledger.appendFindingLedger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'The signed commit receipt proves persistence integrity only and never the truth of committed content.' },
] as const satisfies readonly Story3PersistenceOnlyRecordPolicy[];

export const DYNAMIC_FINDING_ALLOWED_CONSUMERS = [
  'finding_triage',
  'storyMachine.canPassReview',
  'getGuardFailureReason',
  'reviewer_batch',
  'reviewer_status',
  'review_convergence',
  'lifecycle_readiness',
  'certification_window',
  'storyMachine.canFinish',
  'story-aware-validation additive constraints',
] as const;

export const DYNAMIC_FINDING_SEMANTIC_VERIFIER_SOURCE_REFS = [
  'packages/main/src/handlers/finding-applicability-proof.ts',
  'packages/main/src/handlers/finding-deferral-proof.ts',
] as const;

export const DYNAMIC_FINDING_PRODUCER_COMMANDS = [
  'finding_applicability_assess',
  'finding_applicability_batch',
  'finding_deferral_record',
  'finding_mandatory_repair_close',
] as const;

export const DYNAMIC_FINDING_PRODUCER_SOURCE_REFS_BY_COMMAND = {
  finding_applicability_assess: ['packages/main/src/handlers/finding-applicability.ts'],
  finding_applicability_batch: ['packages/main/src/handlers/finding-applicability.ts'],
  finding_deferral_record: ['packages/main/src/handlers/finding-applicability.ts'],
  finding_mandatory_repair_close: ['packages/main/src/handlers/finding-applicability.ts'],
} as const satisfies Record<typeof DYNAMIC_FINDING_PRODUCER_COMMANDS[number], readonly string[]>;

export const DYNAMIC_FINDING_CONSUMER_SOURCE_REFS = {
  finding_triage: ['packages/main/src/handlers/finding-applicability.ts'],
  'storyMachine.canPassReview': ['packages/main/src/core/machine.ts'],
  getGuardFailureReason: [
    'packages/main/src/core/machine.ts',
    'packages/main/src/core/guard-utils.ts',
  ],
  reviewer_batch: ['packages/main/src/handlers/reviewer-batch.ts'],
  reviewer_status: ['packages/main/src/core/reviewer-status.ts'],
  review_convergence: ['packages/main/src/core/review-convergence.ts'],
  lifecycle_readiness: ['packages/main/src/core/lifecycle-readiness.ts'],
  certification_window: ['packages/main/src/core/certification-window.ts'],
  'storyMachine.canFinish': ['packages/main/src/core/machine.ts'],
  'story-aware-validation additive constraints': ['packages/main/src/core/story-aware-validation.ts'],
} as const satisfies Record<typeof DYNAMIC_FINDING_ALLOWED_CONSUMERS[number], readonly string[]>;

// These tokens prove only that each mapped consumer implementation remains present.
// Independent literal consumer/path pins in validation-tier-planner-smoke protect the
// Dynamic Finding validation-floor authority boundary against coordinated shrinkage.
export const DYNAMIC_FINDING_CONSUMER_IMPLEMENTATION_TOKENS = {
  finding_triage: ['finding_triage'],
  'storyMachine.canPassReview': ['canPassReviewGuard'],
  getGuardFailureReason: ['getGuardFailureReason'],
  reviewer_batch: ['reviewer_batch'],
  reviewer_status: ['summarizeReviewerStatus'],
  review_convergence: ['assessReviewConvergence'],
  lifecycle_readiness: ['buildStoryReadinessReport'],
  certification_window: ['projectCertificationWindowStatus'],
  'storyMachine.canFinish': ['canFinishGuard'],
  'story-aware-validation additive constraints': ['classifyFullValidationReasons'],
} as const satisfies Record<typeof DYNAMIC_FINDING_ALLOWED_CONSUMERS[number], readonly string[]>;

export const PROCESS_FACT_DYNAMIC_FINDING_POLICY = {
  recordTypes: ['finding_applicability_assessment', 'finding_deferral_disposition', 'dynamic_finding_manifest', 'material_drift_reattestation', 'mandatory_repair'],
  producer: 'handlers/finding-applicability (finding_applicability_assess, finding_applicability_batch, finding_deferral_record, finding_mandatory_repair_close)',
  producerCommands: DYNAMIC_FINDING_PRODUCER_COMMANDS,
  producerSourceRefsByCommand: DYNAMIC_FINDING_PRODUCER_SOURCE_REFS_BY_COMMAND,
  semanticVerifier: 'handlers/finding-applicability-proof current reviewer proposal and executed pinned witness; finding-deferral-proof signed policy/exact progress lineage; exact ledger/CAS, route and current-source checks; repair closure rechecks runtime artifacts, environment and key trust across material-identical descendant commits',
  semanticVerifierSourceRefs: DYNAMIC_FINDING_SEMANTIC_VERIFIER_SOURCE_REFS,
  allowedConsumers: DYNAMIC_FINDING_ALLOWED_CONSUMERS,
  consumerSourceRefsByConsumer: DYNAMIC_FINDING_CONSUMER_SOURCE_REFS,
  consumerImplementationTokensByConsumer: DYNAMIC_FINDING_CONSUMER_IMPLEMENTATION_TOKENS,
  gateEvidence: true,
  lifecycleAuthority: 'dynamic-blocker-projection-only',
  rollout: ['observe', 'warn', 'enforce'],
  killSwitch: 'legacy predicate fallback',
  qualification: '22 metric rows; public queries and independently reviewed preregistered mutation executions supply counts; reported statistics remain diagnostic; exact per-subject independent gold, not an existence list, adjudicates the full census with a grader distinct from both source observer and bound decision proposer; high/critical misses veto aggregate averages and synthetic successes never dilute operational denominators; monotonic frozen-population start/end records measure proposal latency with per-observation population proof, unmatched starts refuse via timeout rate; full proposal/route/deferral/repair subject census from workspace-trusted signed public query rows with exact record counts, hashes and unique identities; no protected-store parsing by the scorecard reducer; merged prerequisites required before the real 20 Stories / 200 cases / 30 observed days',
  historicalRuntime: 'finding_runtime_evidence_run sourceRef executes an exact ancestor in a detached temporary worktree; both ordered receipts, selectors, witness schemas and pair digest bind non-regression proof',
  qualificationProvenance: 'merged prerequisites require exact-current successful execution receipts with independently reviewed FINDING_PREREQUISITE command/selector bindings; historical readers recheck receipt trust; performance source IDs deduplicate completed candidate cohorts and latency attempts, conflicting references refuse, elapsed time counts once and performance rows never inflate independent Finding cases or observed days',
  collectionReadiness: 'finding_rollout_scorecard collection is diagnostic_only with gateEvidence=false and no automatic enrollment or scope expansion; missing and untrusted evidence are distinct, exact independent subject census is shared with admission; stale current prerequisites refuse enforce while still-verified historical denominators remain diagnostic',
  materialReattestation: 'finding_material_reattest signs unchanged source, process-policy, canonical and target-route dependencies plus exact fresh same-command runtime re-executions after current independent PASS; readers rederive all inputs; head_only recovery additionally requires unchanged material/base and descendant head ancestry, never unconditional hash reuse',
  recallProducer: 'story_advance owner boundary reconciles non-authoritative history recalls in warn/enforce only; explicit and automatic triggers share observed-state keys; failures report without bypassing gates or blocking DEV rework',
  validation: 'signed findingConstraintDigest; additive required commands and affected paths; reassessment escalates to full; recheck before launch and before persistence; never scope authority',
} as const;

export const PROCESS_FACT_STORY3_RUNTIME_RECEIPT_POLICY = {
  recordType: 'runtime_evidence_receipt',
  level: 'L3',
  producer: 'core/runtime-evidence-receipt + handlers/finding-ledger.verify',
  allowedConsumers: ['finding_ledger_query'],
  gateEvidence: false,
  lifecycleAuthority: 'gate-eligible-input-only',
  rationale: 'A current signed runtime receipt can be an input to a separately registered future gate consumer; persistence or query output alone never changes lifecycle state.',
} as const;

export const PROCESS_FACT_STORY3_FINDING_LIFECYCLE_POLICY = {
  recordType: 'finding_lifecycle_transition',
  level: 'L4',
  producer: 'handlers/finding.appendFindingLifecycleTransition + handlers/finding-ledger.bindLegacyFindingLedgerReceipts',
  allowedConsumers: ['StoryStore.readFindings', 'storyMachine.canPassReview'],
  gateEvidence: true,
  lifecycleAuthority: 'terminal-finding-state',
  rationale: 'ReviewRemediation validates the complete inventory-bound repair set and actual signed execution receipts, then stages individual current exact-CAS transitions in one fenced ledger publication; exact replay authenticates the batch marker and recovers projections and one metadata commit. A current exact-signed append-only terminal transition is the canonical resolve/dismiss fact folded by readFindings before the REVIEW blocker gate. A pre-upgrade current-key transition missing only the nested exact digest remains fail-closed unless a separate current exact-signed legacy_lifecycle_receipt_binding re-attests its immutable carrier, record, source identity, and chain. Original Finding rows and historical transition bytes remain immutable.',
} as const;

export const PROCESS_FACT_STORY3_FINDING_PROJECTION_POLICY = {
  recordType: 'finding_projection',
  level: 'L4',
  producer: 'handlers/finding-ledger.createAuthoritativeFindingMutation',
  allowedConsumers: ['StoryStore.readFindings', 'storyMachine.canPassReview'],
  gateEvidence: true,
  lifecycleAuthority: 'current-finding-projection',
  rationale: 'A current-key exact-signed, source-record CAS-bound append preserves live legacy Finding mutations without rewriting the immutable source row; StoryStore folds only verified projections in ledger order.',
} as const;

export const PROCESS_FACT_KIND_BY_COMMAND: Record<string, ProcessFactKind> = {
  validate: 'validation-status',
  done_required_validate: 'validation-status',
  test_add: 'execution-status',
  test_story: 'execution-status',
  verification_evidence_add: 'execution-status',
  verification_evidence_batch_add: 'execution-status',
  verification_evidence_refresh_stale: 'execution-status',
  verification_run: 'execution-status',
  // B-1482: the narrowing-only re-pin rewrites the selector every past and future
  // receipt of the pinned command is judged against, so it states the same kind of
  // fact as the sibling writers rather than the generic L4 gate-evidence fallback.
  verification_pin_narrow: 'execution-status',
  host_run: 'execution-status',
  host_run_status: 'execution-status',
  host_run_cancel: 'execution-status',
  host_run_worker: 'execution-status',
  review_run_start: 'review-run',
  certification_window_begin: 'gate-evidence',
  certification_window_status: 'gate-evidence',
  certification_window_cancel: 'gate-evidence',
  review_inventory_begin: 'gate-evidence',
  review_inventory_status: 'gate-evidence',
  review_inventory_critic_set: 'gate-evidence',
  review_inventory_wave_advance: 'gate-evidence',
  review_inventory_finalize: 'gate-evidence',
  review_inventory_cancel: 'gate-evidence',

  review_pass_set: 'review-pass',
  managed_review_proposal_set: 'artifact',
  managed_review_evidence_import: 'gate-evidence',
  finding_add: 'finding',
  finding_resolve: 'finding',
  finding_dismiss: 'finding',
  autopilot_review_submit: 'host-verdict',
  quorum_submit: 'host-verdict',
  decision_doc_proposal: 'gate-evidence',
  decision_doc_save: 'gate-evidence',
  review_escalation_policy_set: 'gate-evidence',
  review_host_availability_probe: 'host-availability-probe',
  review_escalation_fallback_set: 'gate-evidence',
  story_create_from_repro: 'gate-evidence',
  acceptance_basis_generate: 'signed-artifact',
  pre_review_check: 'signed-artifact',
  acceptance_rollout_report: 'signed-artifact',
};

export const PROCESS_FACT_REQUIRED_SEMANTICS = {
  reviewer_batch: ['schema-contract', 'freshness-policy', 'reviewer-lane'],
  agent_prompt: ['artifact', 'prompt-envelope', 'schema-contract'],
  validate: ['validation-status', 'validation-result', 'gate-evidence'],
  done_required_validate: ['schema-contract', 'execution-evidence', 'validation-result', 'gate-evidence'],
  test_add: ['test-evidence', 'validation-result'],
  test_story: ['test-evidence', 'validation-result'],
  verification_evidence_add: ['schema-contract', 'execution-evidence', 'verification-evidence', 'freshness-policy', 'gate-evidence'],
  verification_evidence_batch_add: ['schema-contract', 'execution-evidence', 'verification-evidence', 'freshness-policy', 'atomic-persistence', 'gate-evidence'],
  verification_evidence_refresh_stale: ['schema-contract', 'execution-evidence', 'verification-evidence', 'freshness-policy', 'atomic-persistence', 'gate-evidence'],
  verification_run: ['schema-contract', 'execution-evidence', 'verification-evidence', 'freshness-policy', 'gate-evidence'],
  verification_pin_narrow: ['schema-contract', 'execution-evidence', 'verification-evidence', 'freshness-policy', 'gate-evidence'],
  finding_progress_predecessor: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_identity_confirm: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_identity_query: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_supersession_add: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_identity_supersede: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_history_query: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_identity_scorecard: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_history_recall: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_route_accept: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_route_reject: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_route_revoke: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_route_verify: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_candidate_route: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_progress_capture: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_candidate_add: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_candidate_get: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_candidate_merge: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_candidate_disprove: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_candidate_promote: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  verification_intent_recover: ['signed-artifact', 'verification-policy', 'gate-evidence'],
  verification_intent_append: ['signed-artifact', 'verification-policy', 'gate-evidence'],
  finding_ledger_query: ['schema-contract', 'signed-artifact', 'atomic-persistence'],
  finding_runtime_evidence_run: ['atomic-persistence', 'signed-artifact', 'schema-contract'],
  finding_runtime_evidence_verify: ['execution-evidence', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding'],
  finding_applicability_assess: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'freshness-policy', 'gate-evidence'],
  finding_applicability_batch: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'freshness-policy', 'gate-evidence'],
  finding_deferral_record: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'freshness-policy', 'gate-evidence'],
  finding_mandatory_repair_close: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'freshness-policy', 'gate-evidence'],
  finding_triage: ['schema-contract', 'signed-artifact', 'freshness-policy', 'blocker-state', 'gate-evidence'],
  finding_rollout_scorecard: ['schema-contract', 'freshness-policy'],
  finding_qualification_record: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'execution-evidence'],
  finding_qualification_query: ['schema-contract', 'signed-artifact'],
  finding_material_reattest: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'execution-evidence'],
  finding_assessment_propose: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'execution-evidence'],
  host_run: ['execution-evidence', 'schema-contract'],
  // Aggregate cursors affect observation only; terminal signatures and the
  // immutable Story ownership subject retain their existing consumer rules.
  host_run_status: ['execution-evidence', 'schema-contract', 'freshness-policy'],
  host_run_cancel: ['execution-evidence', 'schema-contract'],
  host_run_worker: ['execution-evidence', 'atomic-persistence', 'schema-contract'],
  review_run_start: ['review-run', 'prompt-envelope', 'schema-contract', 'workspace-binding', 'gate-evidence'],
  certification_window_begin: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'blocker-state', 'gate-evidence'],
  certification_window_status: ['artifact', 'signed-artifact', 'blocker-state', 'freshness-policy', 'gate-evidence'],
  certification_window_cancel: ['artifact', 'signed-artifact', 'blocker-state', 'gate-evidence'],
  review_inventory_begin: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'gate-evidence'],
  review_inventory_status: ['artifact', 'signed-artifact', 'blocker-state', 'freshness-policy', 'gate-evidence'],
  review_inventory_critic_set: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'review-pass', 'gate-evidence', 'normalization-policy'],
  review_inventory_wave_advance: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'blocker-state', 'gate-evidence'],
  review_inventory_finalize: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'no-blocker-evidence', 'gate-evidence'],
  review_inventory_cancel: ['artifact', 'signed-artifact', 'blocker-state', 'gate-evidence'],

  review_pass_set: ['review-pass', 'prompt-envelope', 'no-blocker-evidence', 'gate-evidence'],
  managed_review_proposal_set: ['artifact', 'prompt-envelope', 'reviewer-lane', 'schema-contract'],
  managed_review_evidence_import: ['prompt-envelope', 'reviewer-lane', 'freshness-policy', 'blocker-state', 'execution-evidence', 'gate-evidence'],
  review_loop_start: ['blocker-state', 'schema-contract', 'gate-evidence'],
  review_loop_iteration_add: ['blocker-state', 'schema-contract', 'gate-evidence'],
  review_loop_close: ['blocker-state', 'schema-contract', 'gate-evidence'],
  scope_boundary_set: ['schema-contract', 'gate-evidence'],
  scope_contract_set: ['schema-contract', 'atomic-persistence', 'gate-evidence'],
  scope_contract_init_from_plan: ['schema-contract', 'atomic-persistence', 'gate-evidence'],
  execution_boundary_set: ['schema-contract', 'workspace-binding', 'gate-evidence'],
  scope_freeze_check: ['validation-result', 'schema-contract', 'gate-evidence'],
  scope_extension_proposal: ['blocker-state', 'schema-contract', 'gate-evidence'],
  scope_extension_decide: ['blocker-state', 'schema-contract', 'gate-evidence'],
  finding_add: ['finding-state', 'blocker-state', 'gate-evidence'],
  finding_resolve: ['finding-state', 'blocker-state', 'gate-evidence'],
  finding_dismiss: ['finding-state', 'blocker-state', 'gate-evidence'],
  autopilot_review_submit: ['host-verdict', 'execution-evidence', 'freshness-policy', 'schema-contract', 'gate-evidence'],
  quorum_submit: ['host-verdict', 'execution-evidence', 'atomic-persistence', 'gate-evidence'],
  decision_doc_proposal: ['schema-contract', 'gate-evidence'],
  decision_doc_save: ['artifact', 'schema-contract', 'execution-evidence', 'gate-evidence'],
  review_escalation_policy_set: ['schema-contract', 'gate-evidence'],
  review_host_availability_probe: ['host-availability', 'host-readiness', 'execution-evidence', 'freshness-policy', 'schema-contract', 'gate-evidence'],
  review_escalation_fallback_set: ['schema-contract', 'freshness-policy', 'host-availability', 'host-readiness', 'gate-evidence'],
  story_create_from_repro: ['artifact', 'schema-contract', 'workspace-binding', 'gate-evidence'],
  original_intent_snapshot_set: ['schema-contract', 'gate-evidence'],
  milestone_ledger_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  milestone_ledger_add: ['schema-contract', 'verification-policy', 'gate-evidence'],
  slice_plan_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  parent_ledger_rollup_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  proofstory_contract_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  acceptance_topology_check: ['schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'gate-evidence'],
  acceptance_basis_generate: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding'],
  acceptance_basis: ['schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding'],
  pre_review_check: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'gate-evidence'],
  pre_review_check_read: ['schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'gate-evidence'],
  acceptance_rollout_report: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'host-verdict', 'gate-evidence'],
  acceptance_rollout_report_read: ['schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'host-verdict', 'gate-evidence'],
  acceptance_rollout_check: ['schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'host-verdict', 'gate-evidence'],
  topology_exclusion_approval_set: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'reviewer-lane'],
  topology_critic_receipt_set: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'reviewer-lane'],
  topology_critic_receipt_check: ['schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'reviewer-lane'],
  intent_collision_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  scope_shrinkage_decision_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  red_evidence_create: ['schema-contract', 'verification-policy', 'gate-evidence'],
  // W2b (B-e10d): the target-binding writer records structured metadata under a
  // schema and enforces the §3.3 expectedRedTargets membership policy, but is a
  // run PREREQUISITE — deliberately NOT 'gate-evidence' (nothing consumes the
  // binding as a gate in this leaf; chain freeze / green-confirm match are W2c).
  red_evidence_binding_set: ['schema-contract', 'verification-policy'],
  // W2c (B-506e): the two chain-control commands write schema-bound records and
  // enforce the §3.3 expectedRedTargets membership policy, but are NOT
  // 'gate-evidence' — the v1 gate predicate ignores their v2 records and no gate
  // consumes the chain in this leaf (gate rewiring is W3).
  red_evidence_quarantine: ['schema-contract', 'verification-policy'],
  red_evidence_recover: ['schema-contract', 'verification-policy'],
  // W2d (B-9ff1): the read-only envelope pre-flight validates a candidate
  // assertion against the §1.1 schema and the §1.2 policy registries, so it
  // carries schema-contract + verification-policy semantics — but NOT
  // 'gate-evidence': no gate consumes its answer (the gate-consumption query is
  // §5 / W3). Canonical scope sentence, used verbatim at every site that states
  // this guarantee: Scoped to the command handler itself and the CLI
  // story-evidence writers, it writes no RED-evidence record, chain record or
  // story/evidence artifact, emits no process event, changes no gate verdict,
  // and runs no preCommand or postCommand hook. Nothing outside that scope is
  // covered: see the red_evidence_envelope_check note in cli/activity-policy.ts,
  // which lists the surfaces known when it was written and is not a proof of
  // exhaustiveness.
  red_evidence_envelope_check: ['schema-contract', 'verification-policy'],
  spike_start: ['schema-contract', 'verification-policy', 'gate-evidence'],
  spike_result_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  spike_result: ['schema-contract', 'verification-policy', 'gate-evidence'],
  spike_discard: ['schema-contract', 'verification-policy', 'gate-evidence'],
  spike_promote: ['schema-contract', 'verification-policy', 'gate-evidence'],
  intent_coverage_check: ['schema-contract', 'verification-policy'],
  proofstory_gate_check: ['schema-contract', 'verification-policy'],
  done_intent_equivalence_check: ['schema-contract', 'verification-policy'],
  proofstory_review_completeness_check: ['schema-contract', 'verification-policy'],
  parent_roadmap_status: ['schema-contract', 'verification-policy'],
  parent_roadmap_evaluate: ['schema-contract', 'verification-policy'],
} as const satisfies Record<string, readonly ProcessFactSemantic[]>;

export const PROCESS_FACT_RUNTIME_SEMANTICS = {
  // Status recommendations share the gate admissibility predicate; window
  // RUNNING alone never proves that a routine process is still executing.
  'runtime:precert_routine_single_execution': ['runtime-behavior', 'signed-artifact', 'atomic-persistence', 'validation-result', 'gate-evidence'],
  'runtime:agent_dispatch_role_authority_gate': ['runtime-behavior', 'schema-contract', 'reviewer-lane', 'gate-evidence'],
  'runtime:legacy_role_alias_sunset_contract': ['runtime-behavior', 'schema-contract', 'normalization-policy'],
  'runtime:review_escalation_done_gate': ['runtime-behavior', 'host-verdict', 'host-availability', 'gate-evidence'],
  'runtime:review_assurance_floor_done_gate': ['runtime-behavior', 'host-verdict', 'host-availability', 'gate-evidence'],
  'runtime:review_run_story_files_hash_gate': ['runtime-behavior', 'freshness-policy', 'workspace-binding', 'review-run', 'gate-evidence'],
  'runtime:review_run_atomic_persistence_gate': ['runtime-behavior', 'atomic-persistence', 'prompt-envelope', 'review-run', 'gate-evidence'],
  'runtime:review_inventory_temporal_integrity_gate': ['runtime-behavior', 'atomic-persistence', 'signed-artifact', 'schema-contract', 'freshness-policy', 'reviewer-lane', 'finding-state', 'gate-evidence'],
  // Native read-side authority preserves the signed reviewPurpose and inventoryBinding;
  // inventory-completeness evidence cannot be rebound to a topology dispatch.
  'runtime:review_execution_authority_gate': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'reviewer-lane', 'execution-evidence', 'gate-evidence'],
  // B-7abb: bounded plan-reference classification precedes decimal sentence
  // splitting; it grants neither dependency approval nor source-wide authority.
  'runtime:prompt_envelope_review_gate': ['runtime-behavior', 'prompt-envelope', 'schema-contract', 'normalization-policy', 'freshness-policy', 'review-run', 'review-pass', 'gate-evidence'],
  'runtime:incremental_review_eligibility_gate': ['runtime-behavior', 'prompt-envelope', 'schema-contract', 'normalization-policy', 'freshness-policy', 'review-run', 'review-pass', 'verification-policy', 'gate-evidence'],
  // Shared by final gate, readiness/batch, inventory and quorum. Open findings and
  // incomplete source rosters fail closed; narrowed inventory rechecks its semantic basis.
  // v2 closure policy rejects unresolved bare aliases; old signed selections expire.
  'runtime:post_remediation_review_selection_gate': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'normalization-policy', 'freshness-policy', 'reviewer-lane', 'gate-evidence'],
  'runtime:prompt_role_body_rollout_gate': ['runtime-behavior', 'prompt-envelope', 'schema-contract', 'reviewer-lane', 'gate-evidence'],
  'runtime:prompt_role_evidence_eligibility_gate': ['runtime-behavior', 'schema-contract', 'reviewer-lane', 'gate-evidence'],
  'runtime:story_files_hash_freshness_gate': ['runtime-behavior', 'freshness-policy', 'workspace-binding', 'verification-evidence', 'review-run', 'host-verdict', 'gate-evidence'],
  'runtime:causal_execution_key_gate': ['runtime-behavior', 'execution-evidence', 'schema-contract', 'workspace-binding', 'freshness-policy', 'verification-policy', 'gate-evidence'],
  'runtime:causal_receipt_import_gate': ['runtime-behavior', 'execution-evidence', 'schema-contract', 'atomic-persistence', 'freshness-policy', 'workspace-binding', 'gate-evidence'],
  'runtime:causal_dependency_preflight_metrics_gate': ['runtime-behavior', 'execution-evidence', 'schema-contract', 'freshness-policy', 'verification-policy', 'gate-evidence'],
  'runtime:evidence_hash_snapshot_fail_closed_gate': ['runtime-behavior', 'freshness-policy', 'workspace-binding', 'verification-evidence', 'gate-evidence'],
  'runtime:repro_first_story_intake_preflight': ['runtime-behavior', 'schema-contract', 'workspace-binding', 'gate-evidence'],
  'runtime:story_create_phase_admission_gate': ['runtime-behavior', 'schema-contract', 'blocker-state', 'gate-evidence'],
  'runtime:evidence_environment_gate_projection': ['runtime-behavior', 'execution-evidence', 'schema-contract', 'normalization-policy', 'freshness-policy', 'verification-policy', 'gate-evidence'],
  'runtime:proof_admissibility_gate_diagnostic': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'gate-evidence'],
  'runtime:verification_execution_assertion_reuse_gate': ['runtime-behavior', 'schema-contract', 'execution-evidence', 'verification-evidence', 'freshness-policy', 'atomic-persistence', 'gate-evidence'],
  'runtime:verification_execution_key_producer_lock': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'execution-evidence', 'atomic-persistence', 'gate-evidence'],
  'runtime:parent_roadmap_totality_claim_consumer': ['runtime-behavior', 'schema-contract', 'verification-policy', 'gate-evidence'],
  'runtime:closeout_artifact_trust_boundary': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'gate-evidence'],
  'runtime:composite_scope_digest_review_gate': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'review-run', 'gate-evidence'],
  'runtime:trusted_closeout_artifact_validation': ['runtime-behavior', 'schema-contract', 'verification-policy', 'gate-evidence'],
  'runtime:routine_validation_fresh_pass_reuse_gate': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'execution-evidence', 'validation-result', 'verification-policy', 'gate-evidence'],
  'runtime:story_aware_dynamic_selection_manifest': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'verification-policy', 'gate-evidence'],
  // Closure evidence binds call-time physical reads. v2 command receipts additionally bind executor-observed clean start/end, receipt-relative trees and effective declared environment; legacy/unknown evidence cannot certify reuse.
  'runtime:story_aware_dynamic_closure_receipt': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'normalization-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'verification-policy', 'gate-evidence'],
  'runtime:story_aware_dynamic_shard_aggregate': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'workspace-binding', 'execution-evidence', 'verification-policy', 'gate-evidence'],
  // Iteration selection cannot replace explicit full or TEST/DONE canonical execution.
  'runtime:story_aware_dynamic_authority_gate': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'freshness-policy', 'validation-result', 'verification-policy', 'gate-evidence'],
  'runtime:acceptance_topology_plan_dev_gate': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'workspace-binding', 'verification-policy', 'gate-evidence'],
  'runtime:acceptance_rollout_dev_review_gate': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'verification-policy', 'execution-evidence', 'host-verdict', 'gate-evidence'],
  'runtime:topology_critic_authority_verification': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'verification-policy'],
  'runtime:canonical_scope_path_gate': ['runtime-behavior', 'schema-contract', 'normalization-policy', 'freshness-policy', 'gate-evidence'],
  // Invocation-local history pin failures use typescript_baseline_pin_unresolved_fail_closed; the existing semantic gate refuses this diagnostic even with current anchors or acknowledgements.
  'runtime:ast_semantic_anchor_gate': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'gate-evidence'],
  'runtime:shared_gap_log_metadata_gate': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'gate-evidence'],
  'runtime:delivery_promise_outcome_done_gate': ['runtime-behavior', 'schema-contract', 'normalization-policy', 'gate-evidence'],
} as const satisfies Record<string, readonly ProcessFactSemantic[]>;

export const PROCESS_FACT_ARTIFACT_BY_COMMAND: Record<string, ProcessFactArtifactRef> = {
  scope_budget_approve: {
    name: 'scope-budget-decisions.json', path: 'scope-budget-decisions.json', signed: true,
    signature: 'signValidationArtifact/verifyValidationArtifact for journal and every scope-bound expiring decision',
    producerCommand: 'scope_budget_approve', consumerGate: 'machine DEV guards and acceptance amendment application',
  },
  certification_window_begin: {
    name: 'certification-window.json',
    path: 'certification-window.json',
    signed: true,
    signature: 'signCertificationWindow/verifyCertificationWindow and signPrecertReceipt/verifyPrecertReceipt and signPrecertCheapCheckReceipt/verifyPrecertCheapCheckReceipt; inventory-completeness-only receipts never authorize PRE_CERT',
    producerCommand: 'certification_window_begin/certification_window_status/certification_window_cancel/validate',
    consumerGate: 'Durable ADMITTING is not heavy authority; recovery checks frozen identity and signed consumption owner. done_required_validate / validate --full PRE_CERT certification-window gate / unscoped validate --story / runValidateGate / certification_window_begin',
  },
  certification_window_status: {
    name: 'certification-window.json',
    path: 'certification-window.json',
    signed: true,
    signature: 'signCertificationWindow/verifyCertificationWindow',
    producerCommand: 'certification_window_status --refresh=true (default status is read-only)',
    consumerGate: 'done_required_validate / validate --full PRE_CERT certification-window gate / unscoped validate --story / runValidateGate / certification_window_begin; DONE-required checks admission inside validation ownership after queued policy drift checks, without consuming routine allocation; done_prepare accepts only signed authorized ADMITTED to RUNNING deltas through isCertificationRunningOnlyAdvance',
  },
  certification_window_cancel: {
    name: 'certification-window.json',
    path: 'certification-window.json',
    signed: true,
    signature: 'signCertificationWindow/verifyCertificationWindow with CANCELLED state',
    producerCommand: 'certification_window_cancel',
    consumerGate: 'done_required_validate / validate --full PRE_CERT certification-window gate / unscoped validate --story / runValidateGate / certification_window_begin; DONE-required checks admission inside validation ownership after queued policy drift checks, without consuming routine allocation; done_prepare accepts only signed authorized ADMITTED to RUNNING deltas through isCertificationRunningOnlyAdvance',
  },
  review_inventory_begin: {
    name: 'review-inventory-epochs.json',
    path: 'review-inventory-epochs.json',
    signed: true,
    signature: 'signReviewInventoryEpoch/verifyReviewInventoryEpoch including initialRunSequenceBoundary, complete acceptance scopeDigest, candidateSpecSetDigest, corpusDigest, requiredLanes, and baselineFindingIds; signReviewInventoryReceipt/verifyReviewInventoryReceipt',
    producerCommand: 'review_inventory_begin/review_inventory_status/review_inventory_wave_advance/review_inventory_finalize/review_inventory_cancel',
    consumerGate: 'storyMachine.canReenterDev REVIEW to DEV inventory remediation/completeness gate',
  },
  review_inventory_status: {
    name: 'review-inventory-epochs.json', path: 'review-inventory-epochs.json', signed: true,
    signature: 'signReviewInventoryEpoch/verifyReviewInventoryEpoch', producerCommand: 'review_inventory_status --refresh (default is unsigned observation only)',
    consumerGate: 'storyMachine.canReenterDev REVIEW to DEV inventory freshness gate',
  },
  review_inventory_critic_set: {
    name: 'review-inventory-epochs.json', path: 'review-inventory-epochs.json', signed: true,
    signature: 'signReviewInventoryCriticReceipt/verifyReviewInventoryCriticReceipt with explicit inventory-completeness purpose and exact signed epoch/wave/cutoff binding in dispatch and ReviewRun, terminal read evidence, and complete per-finding dispositions including current purpose-bound critic discoveries; never topology business-author provenance. OPEN inventory pass producers and lane consumers require both signed readManifest and mechanical readLog, including pass-only finding normalization.', producerCommand: 'review_inventory_critic_set',
    consumerGate: 'review_inventory_finalize current-wave independent completeness critic gate',
    reviewerLane: 'proof-or-stop-review-topology-critic',
  },
  review_inventory_wave_advance: {
    name: 'review-inventory-epochs.json', path: 'review-inventory-epochs.json', signed: true,
    signature: 'signReviewInventoryEpoch/verifyReviewInventoryEpoch after validated current-wave critic receipt and nonzero new families; nextRunSequenceBoundary seals every lower/equal ReviewRun independent of timestamp equality', producerCommand: 'review_inventory_wave_advance',
    consumerGate: 'review_inventory_finalize authority-specific completeness gate and reviewer terminal admission boundary',
    reviewerLane: 'proof-or-stop-review-topology-critic',
  },
  review_inventory_finalize: {
    name: 'review-inventory-epochs.json',
    path: 'review-inventory-epochs.json',
    signed: true,
    signature: 'signReviewInventoryEpoch/verifyReviewInventoryEpoch and signReviewInventoryReceipt/verifyReviewInventoryReceipt and signReviewInventoryCriticReceipt/verifyReviewInventoryCriticReceipt under withReviewInventoryMutationLock; authorizesTest=false inventory-completeness-only never authorizes PRE_CERT',
    producerCommand: 'review_inventory_finalize',
    consumerGate: 'storyMachine.canReenterDev REVIEW to DEV inventory remediation/completeness gate with live terminal/finding aggregate replay before consume; certification_window_begin',
  },
  review_inventory_cancel: {
    name: 'review-inventory-epochs.json', path: 'review-inventory-epochs.json', signed: true,
    signature: 'signReviewInventoryEpoch/verifyReviewInventoryEpoch and, for FINALIZED recovery, signReviewInventoryReceipt/verifyReviewInventoryReceipt with invalidatedAt/invalidationReason', producerCommand: 'review_inventory_cancel',
    consumerGate: 'storyMachine.canReenterDev REVIEW to DEV inventory state gate',
  },
  agent_prompt: {
    name: 'prompt-envelopes.json',
    path: 'prompt-envelopes.json',
    signed: false,
    producerCommand: 'agent_prompt without --readOnly/review_run_start; readOnly inspection never publishes and its v1 JSON preserves roleBodyDigest and knownExecutionEnvironment with envelope:null/canMintReviewEvidence:false',
    consumerGate: 'audit-only for story-dispatch; review-run envelopeId is consumed through the signed ReviewRun by REVIEW, assurance-floor, and quorum gates. Fresh rows carry exact proof-or-stop.* Prompt identities; retired-family rows are inert and rejected by active readers without a compatibility fallback.',
  },
  closeout_write_receipt: {
    name: 'closeout-write-receipts.jsonl',
    path: 'closeout-write-receipts.jsonl',
    signed: false,
    producerCommand: 'core/auto-commit-metadata',
    consumerGate: 'review-run metadata-only retention classifier (artifact gate validation remains independent)',
  },
  story_advance: {
    name: 'index.json',
    path: 'index.json',
    signed: false,
    producerCommand: 'story_advance',
    consumerGate: 'storyMachine phase guards and story_advance preflight gates',
  },
  story_discard: {
    name: 'scope-discard-digest.json',
    path: 'scope-discard-digest.json',
    signed: false,
    producerCommand: 'story_discard',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  story_review: {
    name: 'review.json',
    path: 'review.json',
    signed: true,
    signature: 'sha256(storyId:timestamp:issueCount:blockerCount:proof-or-stop-review-integrity-v1)',
    producerCommand: 'story_review',
    consumerGate: 'storyMachine.canStartDev PLAN to DEV gate',
  },
  candidate_spec_route: {
    name: 'candidate-spec-set.json',
    path: 'candidate-spec-set.json',
    signed: true,
    signature: `artifactDigest over ${CANDIDATE_SPEC_PROCESS_FACT_SCHEMA_VERSION} canonical fields, signed rollout mode, pre-budget document-frequency and zero-hit query filtering, typed protected direct sources and missing diagnostics, ordinary-only cutoff/truncation classification, non-story-metadata changed paths, and freshness bindings`,
    producerCommand: 'candidate_spec_route',
    consumerGate: 'scope_check_save, reviewer read-evidence candidate routing gate, and review inventory candidate-universe freshness gate',
  },
  checklist_update: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'checklist_update',
    consumerGate: 'storyMachine.checklistAllDone DEV to REVIEW gate',
  },
  verification_intent_recover: {name:'checklist.json',path:'checklist.json',signed:false,signature:'exact repository-signed Git-metadata checkpoint is verified before projection recovery',producerCommand:'verification_intent_recover',consumerGate:'StoryStore canonical readers reject missing, stripped or mismatched checkpoint projections'},
  verification_intent_append: {name:'checklist.json',path:'checklist.json',signed:false,signature:'repository-local Ed25519 amendment chain binding owner, scope, before and after intent semantics',producerCommand:'verification_intent_append',consumerGate:'StoryStore.readChecklist and writeChecklist validate signatures before coverage and review consumers'},
  verification_evidence_add: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'verification_evidence_add',
    consumerGate: 'validate verification coverage and freshness gates after heartbeat-protected execution with forwarded abort/deadline controls and a write-side abort check; causal toolVersion binds the executing CLI build independently of target-project and cwd manifests; validate verification coverage and freshness gates; signed V5 currentness binds the actual invocation environment and child-cwd executable bytes separately from the absolute host runtime, and unprovable executable resolution fails closed; causal toolVersion binds the executing CLI build independently of target-project and cwd manifests',
  },
  verification_evidence_batch_add: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'verification_evidence_batch_add',
    consumerGate: 'validate verification coverage and freshness gates after heartbeat-protected abort-atomic execution: batch command/cwd/effective-timeout/environment plus HEAD/material/story-files identity shares one process while each intent retains independent selector evaluation; causal toolVersion binds the executing CLI build independently of target-project and cwd manifests',
  },
  verification_evidence_refresh_stale: {
    // Explicit dry-run is an unsigned observation; only execution produces this artifact.
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'verification_evidence_refresh_stale',
    consumerGate: 'validate verification freshness gate after abort-atomic pinned re-execution with shared executor progress, unique raw-command ordinals and forwarded abort/deadline controls: every immutable pinned intent, including docs/manual, re-executes through the same command/selector/timeout stamping boundary; raw refresh execution binds command/cwd/effective-timeout/provenance and current material/environment/runtime context, while selector/type/kind bind distinct signed causal identities and receipt-keyed import checks; causal toolVersion binds the executing CLI build independently of target-project and cwd manifests; execution time is projected from the signed causal receipt; failed or pinless rows never regain mechanical authority; validate verification freshness gate: every immutable pinned intent, including docs/manual, re-executes through the same command/selector/timeout stamping boundary; selector-free physical execution keys bind signed causal identity and receipt-keyed import checks, while assertion keys independently bind selector/type/kind/timeout provenance; actual child launch occurs inside the causal runner after its last-moment preflight, never before a post-run readiness check; an observation-only identifier prevents a real ordinary rerun from borrowing an older CAS observation and never enters physical grouping; V3 execution time projects the actual signed causal source, and V5 fan-out preserves its immutable bytes/time; failed or pinless rows never regain mechanical authority; causal toolVersion binds the executing CLI build independently of target-project and cwd manifests',
  },
  verification_run: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'verification_run',
    consumerGate: 'validate verification coverage and freshness gates after heartbeat-protected execution with forwarded abort/deadline controls and a write-side abort check; causal toolVersion binds the executing CLI build independently of target-project and cwd manifests',
  },
  recover_evidence: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'recover_evidence',
    consumerGate: 'validate verification freshness gate',
  },
  artifact_declare: {
    name: 'declared-artifacts.json',
    path: 'declared-artifacts.json',
    signed: false,
    producerCommand: 'artifact_declare',
    consumerGate: 'dirty-worktree classifier and DONE declared artifact gate',
  },
  original_intent_snapshot_set: {
    name: 'original-intent-snapshot.json',
    path: 'original-intent-snapshot.json',
    signed: false,
    producerCommand: 'original_intent_snapshot_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
  },
  milestone_ledger_set: {
    name: 'milestone-ledger.json',
    path: 'milestone-ledger.json',
    signed: false,
    producerCommand: 'milestone_ledger_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
  },
  milestone_ledger_add: {
    name: 'milestone-ledger.json',
    path: 'milestone-ledger.json',
    signed: false,
    producerCommand: 'milestone_ledger_add',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
  },
  // Deliberate key/producerCommand deviation: milestone_closeout_capture is NOT an
  // invocable CLI command. The snapshot is written by the story_advance DONE-time
  // capture in handlers/milestone-status, but story_advance already claims index.json
  // in this map and the read-only milestone_closeout command is a consumer, not the
  // producer. A synthetic unquoted key keeps this ref reachable from the
  // artifact:milestone-closeout.json fact entry without attaching a false producer
  // claim to any command fact (a 'runtime:'-style quoted key would not parse in
  // verify-process-fact-contract.mjs key extraction).
  milestone_closeout_capture: {
    name: 'milestone-closeout.json',
    path: 'milestone-closeout.json',
    signed: false,
    producerCommand: 'story_advance',
    consumerGate: 'DONE-phase milestone_status and milestone_closeout snapshot-first read path (snapshot-only; never re-blocks DONE)',
  },
  slice_plan_set: {
    name: 'slice-plan.json',
    path: 'slice-plan.json',
    signed: false,
    producerCommand: 'slice_plan_set',
    consumerGate: 'ProofStory DEV admission and DONE intent-equivalence gates',
  },
  parent_ledger_rollup_set: {
    name: 'parent-ledger-rollup.json',
    path: 'parent-ledger-rollup.json',
    signed: false,
    producerCommand: 'parent_ledger_rollup_set',
    consumerGate: 'ProofStory DONE intent-equivalence gate',
  },
  delivery_context_pack: {
    name: 'delivery-context-pack.json',
    path: 'evidence/delivery-context-pack.json',
    signed: false,
    producerCommand: 'delivery_context_pack',
  },
  proofstory_contract_set: {
    name: 'proofstory.json',
    path: 'proofstory.json',
    signed: false,
    producerCommand: 'proofstory_contract_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
  },
  acceptance_basis_generate: {
    name: 'acceptance-basis.json',
    path: 'acceptance-basis.json',
    signed: true,
    signature: 'Ed25519(canonical receipt binding basis/topology/scope/workspace/storyFilesHash/closureFilesHash)',
    producerCommand: 'acceptance_basis_generate',
    consumerGate: 'acceptance_topology_check and transition-orchestrator PLAN to DEV structural gate',
  },
  pre_review_check: {
    name: 'pre-review-check.json',
    path: 'pre-review-check.json',
    signed: true,
    signature: 'Ed25519(canonical current basis/topology/scope/storyFilesHash/closureFilesHash/evidence/cutoff/critic binding)',
    producerCommand: 'pre_review_check',
    consumerGate: 'pre_review_check_read and transition-orchestrator DEV to REVIEW executable gate',
  },
  acceptance_rollout_report: {
    name: 'acceptance-rollout-report.json',
    path: 'acceptance-rollout-report.json',
    signed: true,
    signature: 'Ed25519(canonical verifier-derived report binding frozen membership/source inventory/window/thresholds/verdict/workspace/full-3x2)',
    producerCommand: 'acceptance_rollout_report',
    consumerGate: 'acceptance_rollout_report_read, acceptance_rollout_check, and transition-orchestrator DEV to REVIEW rollout gate',
  },
  topology_exclusion_approval_set: {
    name: 'topology-exclusion-approvals.json', path: 'topology-exclusion-approvals.json', signed: true,
    signature: 'Ed25519(canonical scope-plan approval binding exclusion/basis/topology/scope/story/closure/provenance)',
    producerCommand: 'topology_exclusion_approval_set', consumerGate: 'topology_critic_receipt_set and topology_critic_receipt_check',
  },
  topology_critic_receipt_set: {
    name: 'topology-critic-receipt.json', path: 'topology-critic-receipt.json', signed: true,
    signature: 'Ed25519(canonical critic receipt binding role/provenance/basis/topology/scope/story/closure/findings/exclusions/verdict/time)',
    producerCommand: 'topology_critic_receipt_set', consumerGate: 'topology_critic_receipt_check CLI verification',
  },
  intent_collision_set: {
    name: 'intent-collision.json',
    path: 'intent-collision.json',
    signed: false,
    producerCommand: 'intent_collision_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
  },
  scope_shrinkage_decision_set: {
    name: 'scope-shrinkage-decision.json',
    path: 'scope-shrinkage-decision.json',
    signed: false,
    producerCommand: 'scope_shrinkage_decision_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
  },
  red_evidence_create: {
    name: 'red-evidence.json',
    path: 'red-evidence.json',
    signed: false,
    producerCommand: 'red_evidence_create',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
  },
  spike_start: {
    name: 'spike.json',
    path: 'spike.json',
    signed: false,
    producerCommand: 'spike_start',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
  },
  spike_result_set: {
    name: 'spike.json',
    path: 'spike.json',
    signed: false,
    producerCommand: 'spike_result_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
  },
  spike_result: {
    name: 'spike.json',
    path: 'spike.json',
    signed: false,
    producerCommand: 'spike_result',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
  },
  spike_discard: {
    name: 'spike.json',
    path: 'spike.json',
    signed: false,
    producerCommand: 'spike_discard',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
  },
  spike_promote: {
    name: 'spike.json',
    path: 'spike.json',
    signed: false,
    producerCommand: 'spike_promote',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
  },
  review_run_start: {
    name: 'review-runs.json',
    path: 'review-runs.json',
    signed: true,
    signature: 'signReviewRun/verifyReviewRun; Explicit critic reviewPurpose and inventoryBinding use a versioned signature suffix; absent fields never authorize a new inventory receipt. Inventory precheck, monotonic RR allocation, Prompt Envelope and ReviewRun durable publication share one outer inventory critical section. ReviewRun.storyFilesHash, workspaceBinding.bindingHash, and Prompt Envelope envelopeId are folded into new review-run signatures. Active ReviewRun, scopeBinding, and workspaceBinding objects use exact-field allowlists before signature verification, so an unknown or mixed nested identity cannot hide outside the signed domain. promptHash equals the exact assembledPrompt domain digest, so the delivered bytes are mechanically bound and compared to canonical proof-or-stop.* runtime/role/task assembly by REVIEW consumers. Rows from the retired identity family are inert historical bytes and current REVIEW admission rejects them without a compatibility fallback.',
    producerCommand: 'review_run_start',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  review_pass_set: {
    name: 'review-passes.json',
    path: 'review-passes.json',
    signed: true,
    signature: 'signReviewPass/verifyReviewPass; direct native records seal a registered-broker Ed25519 invocation attestation bound to exact story/lane/ReviewRun/writer/dispatch/adapter/host/nonce; historical consumers select that sealed dispatch digest, preserving purpose, inventory subject, current host identity, signature and nonce-consumption checks when later waves dispatch the same lane; envelope-bound records use the versioned envelopeId-inclusive domain, reviewRunId-inclusive records do not fall back to legacy signatures, writerSessionId-inclusive records bind writer session provenance, and exact terminal semantic retries return the existing RP id only after current writer provenance and a fresh registered-broker invocation are authenticated; missing or forged authority and consumed nonces fail closed even for identical payloads, while semantic conflicts fail closed',
    producerCommand: 'review_pass_set',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  managed_review_proposal_set: {
    name: 'managed-review-evidence-proposal',
    path: 'managed-review-evidence-proposal',
    signed: false,
    producerCommand: 'managed_review_proposal_set',
    consumerGate: 'managed_review_evidence_import successful-terminal intake only',
  },
  managed_review_evidence_import: {
    name: 'managed-review-evidence-binding',
    path: 'managed-review-evidence-binding',
    signed: true,
    signature: 'signReviewPass/verifyReviewPass or signFinding/verifyFinding versioned managedEvidenceBinding domain; exact ManagedHostRun terminal receipt with sealed live-output/result/event/proposal digests and replacementSafe/reaped/no-residual cleanup, provider proposal digest, and immutable evidence-binding seal revalidated through shared Proof Admissibility at import, REVIEW gate, doctor, and retention GC',
    producerCommand: 'managed_review_evidence_import',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  review_loop_start: {
    name: 'review-loops.jsonl',
    path: 'review-loops.jsonl',
    signed: false,
    producerCommand: 'review_loop_start',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  review_loop_iteration_add: {
    name: 'review-loops.jsonl',
    path: 'review-loops.jsonl',
    signed: false,
    producerCommand: 'review_loop_iteration_add',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  review_loop_close: {
    name: 'review-loops.jsonl',
    path: 'review-loops.jsonl',
    signed: false,
    producerCommand: 'review_loop_close',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  finding_add: {
    name: 'findings.json',
    path: 'findings.json',
    signed: true,
    signature: 'signFinding/verifyFinding; direct native records bind category/evidenceState/uncertaintyReason/files/disprovenEvidence in the signed domain, native invocation consumers select the exact sealed dispatch digest while preserving purpose, inventory subject, host, broker signature and nonce-consumption checks; open Findings still require the latest lane run, and reviewRunId-inclusive records do not fall back to legacy signatures',
    producerCommand: 'finding_add',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  finding_resolve: {
    name: 'findings.json',
    path: 'findings.json',
    signed: true,
    signature: 'existing finding signature remains gate-verified',
    producerCommand: 'finding_resolve',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  finding_dismiss: {
    name: 'findings.json',
    path: 'findings.json',
    signed: true,
    signature: 'existing finding signature remains gate-verified',
    producerCommand: 'finding_dismiss',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  init_check_set: {
    name: 'init-check.json',
    path: 'init-check.json',
    signed: true,
    signature: 'signInitCheck/recomputeInitCheckHash',
    producerCommand: 'init_check_set',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    reviewerLane: 'proof-or-stop-review-story-init',
  },
  init_check_repair: {
    name: 'init-check.json',
    path: 'init-check.json',
    signed: true,
    signature: 'signInitCheck/recomputeInitCheckHash',
    producerCommand: 'init_check_repair',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  scope_boundary_set: {
    name: 'scope-boundary.json',
    path: 'scope-boundary.json',
    signed: true,
    signature: 'stable scope boundary _hash over schemaVersion/storyId/mode/allowed/excluded/confirmationNote',
    producerCommand: 'scope_boundary_set',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  execution_boundary_set: {
    name: 'execution-boundary.json',
    path: 'execution-boundary.json',
    signed: true,
    signature: 'stable execution boundary _hash over schemaVersion/storyId/allowedCommands/allowedTools/excludedCommands/excludedTools; canonical new-write schema proof-or-stop.execution_boundary.v1.1 with exact signed historical lattice.execution_boundary.v1 read compatibility',
    producerCommand: 'execution_boundary_set',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  scope_freeze_check: {
    name: 'scope-freeze-check.json',
    path: 'scope-freeze-check.json',
    signed: true,
    signature: 'stable scope freeze _hash plus freshnessHash over bounded story/checklist projection and boundary hashes; canonical new-write schema proof-or-stop.scope_freeze_check.v1.1 with exact signed historical lattice.scope_freeze_check.v1 read compatibility',
    producerCommand: 'scope_freeze_check',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  scope_extension_proposal: {
    name: 'scope-extension-proposals.json',
    path: 'scope-extension-proposals.json',
    signed: true,
    signature: 'stable proposal _hash over proposal identity, reason, patch, reviewerRunId, status, and decision hash',
    producerCommand: 'scope_extension_proposal',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  scope_extension_decide: {
    name: 'scope-extension-proposals.json',
    path: 'scope-extension-proposals.json',
    signed: true,
    signature: 'stable decision _hash folded into proposal _hash; accepted proposals require a fresh scope freeze check',
    producerCommand: 'scope_extension_decide',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  decision_doc_proposal: {
    name: 'decision-doc-proposals.json',
    path: 'decision-doc-proposals.json',
    signed: false,
    producerCommand: 'decision_doc_proposal',
    consumerGate: 'decision_doc_save proposal freshness and target render gate',
  },
  decision_doc_save: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'decision_doc_save',
    consumerGate: 'decision_doc_save audit evidence and existing decision-doc quorum DONE gate through changed docs/requirements/decisions/*.md',
  },
  delivery_check_set: {
    name: 'delivery-check.json',
    path: 'delivery-check.json',
    signed: true,
    signature: 'signDeliveryCheck/recomputeDeliveryCheckHash; native delivery broker binding is folded into the signed domain and reverified by DONE readers using canonical role identity for public and legacy dispatch aliases',
    producerCommand: 'delivery_check_set',
    consumerGate: 'storyMachine.canFinish DONE gate',
    reviewerLane: 'proof-or-stop-review-delivery',
  },
  delivery_waiver_add: {
    name: 'delivery-check.json',
    path: 'delivery-check.json',
    signed: true,
    signature: 'signDeliveryCheck/recomputeDeliveryCheckHash',
    producerCommand: 'delivery_waiver_add',
    consumerGate: 'storyMachine.canFinish DONE gate',
  },
  scope_check_save: {
    name: 'scope-check.json',
    path: 'scope-check.json',
    signed: true,
    signature: 'signScopeCheck',
    producerCommand: 'scope_check_save',
    consumerGate: 'story_review scope-check gate',
    reviewerLane: 'proof-or-stop-review-scope-plan',
  },
  scope_question_resolve: {
    name: 'scope-check.json',
    path: 'scope-check.json',
    signed: true,
    signature: 'scope-check signature domain intentionally excludes main-agent resolution',
    producerCommand: 'scope_question_resolve',
    consumerGate: 'story_review open question gate',
  },
  draft_check_set: {
    name: 'draft-check.json',
    path: 'draft-check.json',
    signed: true,
    signature: 'computeDraftCheckHash',
    producerCommand: 'draft_check_set',
    consumerGate: 'story_create fromDraft preflight',
  },
  draft_issue_resolve: {
    name: 'draft-check.json',
    path: 'draft-check.json',
    signed: true,
    signature: 'draft-check signature domain intentionally excludes issue resolution',
    producerCommand: 'draft_issue_resolve',
    consumerGate: 'story_create fromDraft preflight',
  },
  summary_set: {
    name: 'summary.json',
    path: 'summary.json',
    signed: false,
    producerCommand: 'summary_set',
    consumerGate: 'story_advance DONE summary checklist',
  },
  test_add: {
    name: 'test-evidence.json',
    path: 'test-evidence.json',
    signed: false,
    producerCommand: 'test_add',
    consumerGate: 'storyMachine.canFinish DONE gate',
  },
  test_story: {
    name: 'test-evidence.json',
    path: 'test-evidence.json',
    signed: false,
    producerCommand: 'test_story',
    consumerGate: 'storyMachine.canFinish DONE gate',
  },
  validate: {
    name: 'test-evidence.json',
    path: 'test-evidence.json',
    signed: false,
    signature: 'Mixed legacy container: routine validate requires Story-bound Ed25519 validationArtifactSignature authenticates the complete Git-backed record before execution-mode selection; non-Git FAIL is diagnostic only',
    producerCommand: 'validate',
    consumerGate: 'story_advance TEST and DONE validation gate; top-level validate conveys its typed verdict independently of JSON/text rendering to CLI exit, activity and terminal facts; nested validation does not inherit the outcome sink; routine REVIEW/TEST/DONE producers reject missing declared scope or failing current scope before execution and reuse; canonical publication requires clean pre-entry paths, current execution ownership and intended-byte hashes; foreign bytes are preserved on refusal; causal toolVersion binds the executing CLI build independently of target-project and cwd manifests',
  },
  done_required_validate: {
    name: 'done-required-evidence.json',
    path: 'done-required-evidence.json',
    signed: false,
    producerCommand: 'done_required_validate',
    consumerGate: 'story_advance DONE done-required-validation gate',
  },
  evaluate_save: {
    name: 'eval-evidence.json',
    path: 'eval-evidence.json',
    signed: false,
    producerCommand: 'evaluate_save',
    consumerGate: 'story_advance DONE evaluator evidence gate',
  },
  verify_codex: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'verify_codex',
    consumerGate: 'Codex adapter REVIEW and DONE evidence gate',
  },
  autopilot_review_submit: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'autopilot_review_submit',
    consumerGate: 'storyMachine.canFinish DONE review escalation gate and storyMachine.canFinish DONE review assurance floor gate',
  },
  quorum_submit: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'quorum_submit',
    consumerGate: 'storyMachine.canFinish DONE review escalation gate and storyMachine.canFinish DONE review assurance floor gate',
  },
  review_escalation_policy_set: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'review_escalation_policy_set',
    consumerGate: 'storyMachine.canFinish DONE review escalation gate',
  },
  review_host_availability_probe: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'review_host_availability_probe',
    consumerGate: 'storyMachine.canFinish DONE review escalation gate and storyMachine.canFinish DONE review assurance floor gate',
  },
  review_escalation_fallback_set: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'review_escalation_fallback_set',
    consumerGate: 'storyMachine.canFinish DONE review escalation gate and storyMachine.canFinish DONE review assurance floor gate',
  },
  story_create_from_repro: {
    name: 'story-evidence-binding',
    path: 'story-evidence-binding',
    signed: false,
    producerCommand: 'story_create_from_repro',
    consumerGate: 'storyMachine.canEnterPlan IDEA to PLAN gate and storyMachine.canStartDev/canSkipPlan DEV-entry gates',
  },
};

export const PROCESS_FACT_REVIEWER_LANE_NAMES = [
  'proof-or-stop-review-story-init',
  'proof-or-stop-product-reviewer',
  'proof-or-stop-review-scope-plan',
  'proof-or-stop-review-topology-critic',
  'proof-or-stop-review-concept',
  'proof-or-stop-review-quality',
  'proof-or-stop-review-test-coverage',
  'proof-or-stop-review-behavior',
  'proof-or-stop-review-docs',
  'proof-or-stop-review-channel',
  'proof-or-stop-review-delivery',
] as const;

function isRequiredArtifactRef(artifact: ProcessFactArtifactRef): boolean {
  return artifact.signed || Boolean(artifact.consumerGate);
}

export const PROCESS_FACT_REQUIRED_ARTIFACT_NAMES = [...new Set(
  Object.values(PROCESS_FACT_ARTIFACT_BY_COMMAND)
    .filter(isRequiredArtifactRef)
    .map((artifact) => artifact.path),
)] as readonly string[];

export const PROCESS_FACT_REVIEWER_LANE_DEFINITIONS = [
  {
    name: 'reviewer-lane:proof-or-stop-review-story-init',
    producer: 'proof-or-stop-review-story-init',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    reviewerLane: 'proof-or-stop-review-story-init',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.init_check_set,
    rationale: 'INIT reviewer writes signed init-check evidence before worktree bootstrap.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-product-reviewer',
    producer: 'proof-or-stop-product-reviewer',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    reviewerLane: 'proof-or-stop-product-reviewer',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.init_check_set,
    rationale: 'Product init reviewer is a required init-check producer for user-value readiness.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-scope-plan',
    producer: 'proof-or-stop-review-scope-plan',
    consumerGate: 'story_review scope-check gate',
    reviewerLane: 'proof-or-stop-review-scope-plan',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_check_save,
    rationale: 'PLAN scope reviewer signs scope-check evidence before implementation.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-topology-critic',
    producer: 'proof-or-stop-review-topology-critic',
    consumerGate: 'topology_critic_receipt_check CLI verification and review_inventory_finalize saturation gate',
    reviewerLane: 'proof-or-stop-review-topology-critic',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_inventory_critic_set,
    rationale: 'Default topology critic dispatch preserves business-author provenance. Explicit inventory-completeness dispatch derives the signed current OPEN epoch/wave/cutoff under the inventory lock, supplies no topology provenance, and requires a purpose-bound fresh ReviewRun plus terminal read evidence before signing the exact inventory critic receipt. Historical envelopes retain exact dispatch identity and registered selected-contract semantic and eligibility bindings. inventory receipts never substitute for topology proof. No topology-refusal fallback or promotion to TEST/DONE.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-concept',
    producer: 'proof-or-stop-review-concept',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'proof-or-stop-review-concept',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Baseline concept reviewer records findings or no-blocker review pass evidence.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-quality',
    producer: 'proof-or-stop-review-quality',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'proof-or-stop-review-quality',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Baseline quality reviewer records findings or no-blocker review pass evidence.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-test-coverage',
    producer: 'proof-or-stop-review-test-coverage',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'proof-or-stop-review-test-coverage',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Coverage reviewer checks verificationIntent to verificationEvidence coverage.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-behavior',
    producer: 'proof-or-stop-review-behavior',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'proof-or-stop-review-behavior',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Risk-triggered behavior reviewer records findings or no-blocker evidence.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-docs',
    producer: 'proof-or-stop-review-docs',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'proof-or-stop-review-docs',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Docs reviewer records docs drift findings or no-blocker evidence.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-delivery',
    producer: 'proof-or-stop-review-delivery',
    consumerGate: 'storyMachine.canFinish DONE gate',
    reviewerLane: 'proof-or-stop-review-delivery',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.delivery_check_set,
    rationale: 'Delivery reviewer signs delivery-check evidence before DONE only through an exact broker-attested native dispatch; raw asserted reviewer identity is advisory-only.',
  },
] as const;

function uniqueSemantics(...groups: ReadonlyArray<readonly ProcessFactSemantic[]>): ProcessFactSemantic[] {
  const out = new Set<ProcessFactSemantic>();
  for (const group of groups) {
    for (const semantic of group) out.add(semantic);
  }
  return [...out];
}

function commandFactKind(name: string, level: ProcessFactLevel): ProcessFactKind {
  if (PROCESS_FACT_KIND_BY_COMMAND[name]) return PROCESS_FACT_KIND_BY_COMMAND[name];
  if (name.startsWith('runtime:')) return 'runtime-behavior';
  return level === 'L4' ? 'gate-evidence' : 'command';
}

function commandFactSemantics(name: string, level: ProcessFactLevel): ProcessFactSemantic[] {
  if (name.startsWith('runtime:')) {
    return uniqueSemantics(PROCESS_FACT_RUNTIME_SEMANTICS[name as keyof typeof PROCESS_FACT_RUNTIME_SEMANTICS] ?? ['runtime-behavior'], level === 'L4' ? ['gate-evidence'] : []);
  }
  const required: readonly ProcessFactSemantic[] =
    PROCESS_FACT_REQUIRED_SEMANTICS[name as keyof typeof PROCESS_FACT_REQUIRED_SEMANTICS] ?? [];
  const defaults: ProcessFactSemantic[] = [];
  if (level === 'L4') defaults.push('gate-evidence');
  if (required.length === 0 && level !== 'L4') defaults.push('command');
  return uniqueSemantics(required, defaults);
}

function artifactFactSemantics(artifact: ProcessFactArtifactRef): ProcessFactSemantic[] {
  const semantics: ProcessFactSemantic[] = ['artifact'];
  if (artifact.signed) semantics.push('signed-artifact');
  if (artifact.path === 'review-runs.json') semantics.push('review-run', 'schema-contract', 'workspace-binding', 'freshness-policy');
  if (artifact.path === 'review-loops.jsonl') semantics.push('blocker-state', 'schema-contract');
  if (artifact.path === 'test-evidence.json') semantics.push('validation-result', 'test-evidence');
  if (artifact.path === 'eval-evidence.json') semantics.push('validation-result');
  if (artifact.path === 'scope-boundary.json' || artifact.path === 'execution-boundary.json') semantics.push('schema-contract');
  if (artifact.path === 'scope-freeze-check.json') semantics.push('validation-result', 'schema-contract');
  if (artifact.path === 'scope-extension-proposals.json') semantics.push('blocker-state', 'schema-contract');
  if (artifact.path === 'scope-discard-digest.json') semantics.push('supersession-policy');
  if (artifact.path === 'decision-doc-proposals.json') semantics.push('schema-contract', 'execution-evidence');
  if (artifact.path === 'story-evidence-binding') semantics.push('schema-contract', 'workspace-binding');
  if (
    artifact.path === 'original-intent-snapshot.json'
    || artifact.path === 'milestone-ledger.json'
    || artifact.path === 'slice-plan.json'
    || artifact.path === 'parent-ledger-rollup.json'
    || artifact.path === 'proofstory.json'
    || artifact.path === 'intent-collision.json'
    || artifact.path === 'scope-shrinkage-decision.json'
    || artifact.path === 'red-evidence.json'
    || artifact.path === 'spike.json'
  ) {
    semantics.push('schema-contract', 'verification-policy');
  }
  return semantics;
}

function commandPolicy(name: string): CommandPolicy | undefined {
  return COMMAND_POLICIES[name as KnownCommandName] as CommandPolicy | undefined;
}

const RUNTIME_PROCESS_FACT_SOURCE_REFS: Record<string, {
  producerSourceRefs: readonly string[];
  consumerSourceRefs: readonly string[];
}> = {
  'verification_pin_narrow': {
    producerSourceRefs: [
      'packages/main/src/core/verification-execution-evidence.ts',
      'packages/main/src/handlers/checklist.ts',
    ],
    consumerSourceRefs: [
      'packages/main/src/core/verification.ts',
      'packages/main/src/handlers/checklist.ts',
    ],
  },
  'runtime:verification_execution_assertion_reuse_gate': {
    producerSourceRefs: [
      'packages/main/src/core/verification-execution-evidence.ts',
      'packages/main/src/core/evidence-freshness.ts',
      'packages/main/src/core/proof-admissibility.ts',
      'packages/main/src/core/verification.ts',
    ],
    consumerSourceRefs: [
      'packages/main/src/core/machine.ts',
      'packages/main/src/core/lifecycle-readiness.ts',
      'packages/main/src/handlers/phase-gates.ts',
      'packages/main/src/handlers/verifier.ts',
      'packages/main/src/handlers/done-prepare.ts',
      'packages/main/src/handlers/certification-window.ts',
      'packages/main/src/handlers/checklist.ts',
      'packages/main/src/core/review-inventory-epoch.ts',
    ],
  },
  'runtime:verification_execution_key_producer_lock': {
    producerSourceRefs: [
      'packages/main/src/core/verification-execution-evidence.ts',
      'packages/main/src/handlers/checklist.ts',
    ],
    consumerSourceRefs: [
      'packages/main/src/handlers/checklist.ts',
      'packages/main/src/core/proof-admissibility.ts',
      'packages/main/src/core/verification.ts',
    ],
  },
  'runtime:external_story_worktree_bootstrap_authority_gate': {
    producerSourceRefs: [
      'packages/main/src/cli-engine.ts',
      'packages/main/src/cli/runtime-root.ts',
      'packages/main/src/cli/ownership-gate.ts',
      'packages/main/src/core/controller-config-projection.ts',
      'packages/main/src/core/runtime-artifact-registry.ts',
    ],
    consumerSourceRefs: [
      'packages/main/src/core/auto-commit-metadata.ts',
      'packages/main/src/core/scope-path-classifier.ts',
      'packages/main/src/core/scope-contract.ts',
      'packages/main/src/handlers/context.ts',
      'packages/main/src/handlers/checklist.ts',
    ],
  },
  'runtime:repository_default_baseline_gate': {
    producerSourceRefs: [
      'packages/main/src/core/git-baseline.ts',
    ],
    consumerSourceRefs: [
      'packages/main/src/core/story-aware-validation.ts',
      'packages/main/src/core/evidence-freshness.ts',
      'packages/main/src/core/scope-contract.ts',
      'packages/main/src/core/scope-diff-pack.ts',
      'packages/main/src/core/material-code-policy.ts',
      'packages/main/src/core/review-assurance-floor.ts',
      'packages/main/src/handlers/scope-contract.ts',
    ],
  },
  'runtime:go_command_acceptance_gate': {
    producerSourceRefs: [
      'packages/main/src/core/acceptance-discovery-adapters.ts',
      'packages/main/src/core/pre-review-check.ts',
      'packages/main/src/core/verification-execution-evidence.ts',
      'packages/main/src/core/validation-executor.ts',
    ],
    consumerSourceRefs: [
      'packages/main/src/core/acceptance-topology.ts',
      'packages/main/src/handlers/proofstory.ts',
      'packages/main/src/handlers/transition-orchestrator.ts',
    ],
  },
  [DYNAMIC_FINDING_VALIDATION_FLOOR_FACT_NAME]: {
    producerSourceRefs: [
      'packages/main/src/core/finding-applicability.ts',
      'packages/main/src/core/finding-applicability-projection.ts',
      'packages/main/src/handlers/finding-material-reattestation.ts',
      ...new Set(Object.values(PROCESS_FACT_DYNAMIC_FINDING_POLICY.producerSourceRefsByCommand).flat()),
      ...PROCESS_FACT_DYNAMIC_FINDING_POLICY.semanticVerifierSourceRefs,
    ],
    consumerSourceRefs: [
      'packages/main/src/handlers/transition-orchestrator.ts',
      ...new Set(Object.values(PROCESS_FACT_DYNAMIC_FINDING_POLICY.consumerSourceRefsByConsumer).flat()),
    ],
  },
};

const COMMAND_PROCESS_FACTS: ProcessFactRegistryDeclaration[] = PROCESS_FACT_LEVELS
  .filter((entry: ProcessFactLevelEntry) => !entry.name.startsWith('flow-policy:') && entry.name !== 'runtime:story_scope_budget')
  .map((entry: ProcessFactLevelEntry) => {
  const policy = commandPolicy(entry.name);
  const sourceRefs = RUNTIME_PROCESS_FACT_SOURCE_REFS[entry.name];
  const rootOnly = policy ? policy.rootOnly === true || policy.status === 'rootOnly' : undefined;
  const gateEvidence = policy ? policy.gateEvidence === true || policy.status === 'gateEvidence' : undefined;
  const isDynamicFindingValidationFloor = entry.name === DYNAMIC_FINDING_VALIDATION_FLOOR_FACT_NAME;
  const validationFloorDeclaration = (() => {
    if (!isDynamicFindingValidationFloor) return {};
    if (!sourceRefs) {
      throw new ProcessFactRegistryMappingError(
        'process-missing',
        `${DYNAMIC_FINDING_VALIDATION_FLOOR_FACT_NAME} has no authored runtime source mapping`,
      );
    }
    return {
      validationTierFloor: 'repository-full' as const,
      paths: [...new Set([...sourceRefs.producerSourceRefs, ...sourceRefs.consumerSourceRefs])],
    };
  })();
  return {
    name: entry.name,
    ...validationFloorDeclaration,
    kind: commandFactKind(entry.name, entry.level),
    semantics: commandFactSemantics(entry.name, entry.level),
    level: entry.level,
    lifecycle: policy?.status,
    allowedPhases: policy?.allowedPhases,
    rootOnly,
    legacy: policy ? policy.status === 'legacy' : undefined,
    gateEvidence,
    destructiveRisk: policy?.destructiveRisk,
    producer: entry.owner,
    producerSourceRefs: sourceRefs?.producerSourceRefs ?? (['pre_review_check', 'pre_review_check_read'].includes(entry.name)
      ? ['packages/main/src/core/pre-review-check.ts', 'packages/main/src/core/pre-review-live-proof.ts', 'scripts/run-proofstory-pre-review-live-proof.mjs']
      : ['acceptance_basis_generate', 'acceptance_basis', 'acceptance_topology_check'].includes(entry.name)
      ? ['packages/main/src/handlers/proofstory.ts', 'packages/main/src/registry.ts']
      : undefined),
    consumerGate: entry.gateConsumer,
    consumerSourceRefs: sourceRefs?.consumerSourceRefs ?? (['pre_review_check', 'pre_review_check_read'].includes(entry.name)
      ? ['packages/main/src/core/pre-review-check.ts', 'packages/main/src/handlers/transition-orchestrator.ts']
      : ['acceptance_basis_generate', 'acceptance_basis', 'acceptance_topology_check'].includes(entry.name)
      ? ['packages/main/src/core/acceptance-topology.ts', 'packages/main/src/handlers/transition-orchestrator.ts', 'scripts/verify-process-fact-contract.mjs']
      : undefined),
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND[entry.name],
    reviewerLane: PROCESS_FACT_ARTIFACT_BY_COMMAND[entry.name]?.reviewerLane,
    rationale: entry.rationale,
  };
});

// Selected canonical owners carry repository-keyed dispositions consumed independently of cached review counts.
COMMAND_PROCESS_FACTS.push({name:'runtime:plan_selected_owner_coverage',kind:'runtime-behavior',level:'L4',semantics:['runtime-behavior','signed-artifact','gate-evidence'],paths:['packages/main/src/core/plan-touchpoint-coverage.ts','packages/main/src/handlers/scope-check.ts','packages/main/src/handlers/story-review.ts','packages/main/src/core/machine.ts'],producer:'scope_check_save registered scope reviewer',consumerGate:'story_review and canStartDevGuard',rationale:'Independent canonical process-fact owner enumeration prevents simultaneous declaration omission; keyed local-role coverage binds topology, registry and relevant source bytes, allows substantive unchanged dispositions, and fails closed on invalid or stale records.'});

// Owner approval binds the exact proposal without delegating the lease.
COMMAND_PROCESS_FACTS.push({name:'runtime:independent_intent_owner_lease',kind:'runtime-behavior',level:'L4',semantics:['runtime-behavior','gate-evidence','verification-policy'],paths:['packages/main/src/cli-prompts.ts','packages/main/src/core/types.ts','packages/main/src/core/agent-dispatch-registry.ts','packages/main/src/handlers/checklist.ts','packages/main/src/handlers/story-dispatch.ts','packages/main/src/cli/command-catalog.ts','packages/main/src/cli/ownership-gate.ts','packages/main/src/core/command-policy.ts','packages/main/src/core/config.ts'],producer:'checklist_update owner-approved intent proposal',consumerGate:'active owner lease, PLAN and exact proposal binding',rationale:'Independent role proposals carry no gate authority. The actual owner approves the exact Story/item/prior-intent/replacement digest; role environment never bypasses the lease. The existing declared-path and acceptance-history validators still apply, including owner-only signed revisions. Handler-owned item attribution and process events distinguish owner proposals, dispatched-role declarations and owner direct writes; independentlyAttested is always false and grants no gate authority. No runtime reader enforces digest matching: consumers must check the semantic digest before interpreting this diagnostic marker. Append and repair clear it, while exact signed checkpoint recovery restores intent and attribution together. Checklist removal admission matches its existing INIT-only handler for pre-freeze consolidation; PLAN and DEV remain forbidden.'});

export const PROCESS_FACT_FLOW_POLICIES = FLOW_FACT_POLICIES.map((policy) => ({
  name: policy.name,
  kind: 'flow-policy' as const,
  semantics: policy.semantics as readonly ProcessFactSemantic[],
  level: policy.level as ProcessFactLevel,
  producer: policy.owner,
  consumerGate: policy.consumerGate,
  artifact: 'artifactCommand' in policy && policy.artifactCommand
    ? PROCESS_FACT_ARTIFACT_BY_COMMAND[policy.artifactCommand]
    : undefined,
  rationale: policy.rationale,
})) as readonly ProcessFactRegistryDeclaration[];

export const PROCESS_FACT_REVIEWER_LANES = PROCESS_FACT_REVIEWER_LANE_DEFINITIONS.map((entry) => ({
  ...entry,
  kind: 'reviewer-lane' as const,
  semantics: ['reviewer-lane', 'gate-evidence'] as const,
  level: 'L4' as const,
})) as readonly ProcessFactRegistryDeclaration[];

export const PROCESS_FACT_ARTIFACTS = [
  {
    name: 'artifact:.proof-or-stop/capability-releases.jsonl',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'normalization-policy'],
    level: 'L1',
    gateEvidence: false,
    producer: 'core/capability-release buildCapabilityReleaseRecord and appendCapabilityReleaseRecord',
    consumerGate: 'Post-DONE identity audit and read-only capability lineage inspection; never gate evidence',
    artifact: { name: 'capability-releases.jsonl', path: '.proof-or-stop/capability-releases.jsonl', signed: false },
    rationale: 'Current writes require changedPathsScope=capability-material, an actual classifier subset, and recomputed capabilityDigest before idempotency. Unmarked canonical v1 remains historical read-only data; retired schemas remain rejected.',
  },
  {
    name: 'artifact:index.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/story-advance',
    consumerGate: 'storyMachine phase guards and story_advance preflight gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.story_advance,
    rationale: 'Story index state is consumed by lifecycle phase guards and preflight checks.',
  },
  {
    name: 'artifact:review.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/story-review',
    consumerGate: 'storyMachine.canStartDev PLAN to DEV gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.story_review,
    rationale: 'PLAN review signature is checked before DEV.',
  },
  {
    name: 'artifact:checklist.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/checklist',
    consumerGate: 'storyMachine.checklistAllDone DEV to REVIEW gate and validate verification coverage/freshness gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.checklist_update,
    rationale: 'Checklist status and verification evidence are consumed by REVIEW and validate gates.',
  },
  {
    name: 'artifact:init-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/init-check',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.init_check_set,
    rationale: 'Init-check signature is checked before worktree bootstrap.',
  },
  {
    name: 'artifact:scope-boundary.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'schema-contract'],
    level: 'L4',
    producer: 'handlers/scope-anti-expansion',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_boundary_set,
    rationale: 'User-confirmed allowed/excluded scope is mandatory before INIT_CHECK worktree bootstrap.',
  },
  {
    name: 'artifact:execution-boundary.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'schema-contract', 'workspace-binding'],
    level: 'L4',
    producer: 'handlers/scope-anti-expansion',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.execution_boundary_set,
    rationale: 'User-confirmed execution boundary is mandatory before INIT_CHECK worktree bootstrap.',
  },
  {
    name: 'artifact:scope-freeze-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'validation-result', 'schema-contract'],
    level: 'L4',
    producer: 'handlers/scope-anti-expansion',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_freeze_check,
    rationale: 'Fresh pass/fail anti-expansion evidence is consumed before a worktree can be created.',
  },
  {
    name: 'artifact:scope-extension-proposals.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'blocker-state', 'schema-contract'],
    level: 'L4',
    producer: 'handlers/scope-anti-expansion',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_extension_proposal,
    rationale: 'Pending reviewer scope expansion proposals block INIT_CHECK until explicitly decided.',
  },
  {
    name: 'artifact:decision-doc-proposals.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence', 'schema-contract', 'execution-evidence'],
    level: 'L4',
    producer: 'handlers/decision-doc-promotion',
    consumerGate: 'decision_doc_save proposal freshness and target render gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.decision_doc_proposal,
    rationale: 'Story-local decision-doc proposals bind drafted policy content, source decision digest, target path, and save records before durable decision docs are materialized.',
  },
  {
    name: 'artifact:scope-discard-digest.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence', 'supersession-policy'],
    level: 'L4',
    producer: 'handlers/worktree story_discard',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.story_discard,
    rationale: 'Discarded story direction digests prevent repeated discarded work from being recreated without mitigation.',
  },
  {
    name: 'artifact:scope-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/scope-check',
    consumerGate: 'story_review scope-check gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_check_save,
    rationale: 'Scope-check signature is consumed by PLAN review.',
  },
  {
    name: 'artifact:candidate-spec-set.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'freshness-policy', 'workspace-binding', 'verification-policy'],
    level: 'L4',
    producer: 'handlers/candidate-spec-routing',
    consumerGate: 'scope_check_save, reviewer read-evidence candidate routing gate, and review inventory candidate-universe freshness gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.candidate_spec_route,
    rationale: 'Candidate routing artifact binds deterministic seeds, corpus digest, rollout mode, pre-budget query filtering, typed protected direct sources/missing diagnostics, bounded ordinary-only ranking/cutoff, optional sanitized host proposals, query-level omitted-score/cutoff truncation evidence, current freshness, and a fail-closed enforce-mode requiresEscalation/fullScan resolution fact for PLAN and REVIEW consumers; shadow/warn retain nonblocking diagnostics.',
  },
  {
    name: 'artifact:original-intent-snapshot.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.original_intent_snapshot_set,
    rationale: 'Original intent snapshot freezes sourceText/keyRequirementIds into an immutable requestHash for progressive intent diagnostics and opt-in enforcement.',
  },
  {
    name: 'artifact:acceptance-basis.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory.acceptance_basis_generate',
    producerSourceRefs: ['packages/main/src/handlers/proofstory.ts', 'packages/main/src/registry.ts'],
    consumerGate: 'acceptance_topology_check and transition-orchestrator PLAN to DEV structural gate',
    consumerSourceRefs: ['packages/main/src/core/acceptance-topology.ts', 'packages/main/src/handlers/proofstory.ts', 'packages/main/src/handlers/transition-orchestrator.ts', 'scripts/verify-process-fact-contract.mjs'],
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.acceptance_basis_generate,
    rationale: 'Verifier-only PLAN coverage basis receipt binds the registered adapter profile and full adapter results, deterministic union, planned paths, topology/scope/workspace identity, storyFilesHash, closureFilesHash, and the structured snapshotSeal/sealDigest integrity fact. Exact static topology projection requires a discovery-owned path and either identical existing refs or the uniquely resolved planned producer endpoint identity, role, file, and symbol; mismatched relationships and command-ref shortcuts remain outside the basis. The canonical topology evaluator verifies it before PLAN to DEV; no read-only caller can mint or rebind it.',
  },
  {
    name: 'artifact:pre-review-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory.pre_review_check',
    producerSourceRefs: ['packages/main/src/core/pre-review-check.ts', 'packages/main/src/core/pre-review-live-proof.ts', 'scripts/run-proofstory-pre-review-live-proof.mjs'],
    consumerGate: 'pre_review_check_read and transition-orchestrator DEV to REVIEW executable gate',
    consumerSourceRefs: ['packages/main/src/core/pre-review-check.ts', 'packages/main/src/handlers/transition-orchestrator.ts'],
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.pre_review_check,
    rationale: 'Verifier-owned signed pre-review artifact binds the selected verification profile, recomputed current-worktree basis, strict cutoff, and topology/scope/story/closure hashes. TypeScript and mixed workspaces retain artifact-kind/runtime-aware planned-to-actual reconciliation plus gzip-carried canonical positive, mutation, control, transcript, provenance, and independent critic proof. Pure Go workspaces use the separate go-command profile: every executable must intent needs its immutable command/selector pin and current tool-owned signed receipt, and at least one authenticated execution must be argv-structured go test. Missing, failed, stale, cutoff-invalid, mismatched, unsigned, or non-Go-only evidence fails closed; unsupported languages receive no Go authority. Non-enforcing semantic readback retains the signed artifact critic-receipt digest so legal reviewer receipt renewal alone is not mislabeled as tampering; this critic rule applies to the TypeScript profile.',
  },
  {
    name: 'artifact:acceptance-rollout-report.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'host-verdict', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory.acceptance_rollout_report',
    producerSourceRefs: ['scripts/run-proofstory-acceptance-rollout-cohort.mjs', 'packages/main/src/core/acceptance-rollout.ts', 'packages/main/src/handlers/proofstory.ts'],
    consumerGate: 'acceptance_rollout_report_read, acceptance_rollout_check, and transition-orchestrator DEV to REVIEW rollout gate',
    consumerSourceRefs: ['packages/main/src/core/acceptance-rollout.ts', 'packages/main/src/handlers/proofstory.ts', 'packages/main/src/handlers/transition-orchestrator.ts', 'scripts/verify-process-fact-contract.mjs'],
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.acceptance_rollout_report,
    rationale: 'Versioned verifier-owned report freezes every eligible source record in the declared window and deterministically derives membership, metrics, diagnostics, and verdict. The signed receipt binds source inventory, >=3 matched pairs in each arm, every registered seed, zero false pass, 100% omission detection, zero false block, zero mislabeled 3x1, non-positive waiver delta, non-shrinking inventory, supported adapters, genuine full-3x2, runner digest, and current workspace hashes. Rollback changes only flat project mode and preserves this artifact.',
  },
  {
    name: 'artifact:topology-exclusion-approvals.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'reviewer-lane'],
    level: 'L3',
    producer: 'handlers/proofstory.topology_exclusion_approval_set',
    producerSourceRefs: ['packages/main/src/core/topology-critic-receipt.ts', 'packages/main/src/handlers/proofstory.ts', 'packages/main/src/core/agent-dispatch-registry.ts'],
    consumerGate: 'topology_critic_receipt_set and topology_critic_receipt_check',
    consumerSourceRefs: ['packages/main/src/core/topology-critic-receipt.ts', 'packages/main/src/handlers/proofstory.ts', 'scripts/verify-process-fact-contract.mjs'],
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.topology_exclusion_approval_set,
    rationale: 'Every topology exclusion is covered exactly once by a signed current proof-or-stop-review-scope-plan approval that is independently attributable from both implementation and critic provenance.',
  },
  {
    name: 'artifact:topology-critic-receipt.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'reviewer-lane'],
    level: 'L3',
    producer: 'handlers/proofstory.topology_critic_receipt_set',
    producerSourceRefs: ['packages/main/src/core/topology-critic-receipt.ts', 'packages/main/src/handlers/proofstory.ts', 'packages/main/src/core/agent-dispatch-registry.ts'],
    consumerGate: 'topology_critic_receipt_check CLI verification only',
    consumerSourceRefs: ['packages/main/src/core/topology-critic-receipt.ts', 'packages/main/src/handlers/proofstory.ts', 'scripts/verify-process-fact-contract.mjs'],
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.topology_critic_receipt_set,
    rationale: 'The eligible critic receipt signs complete current basis/topology/scope/story/closure bindings, deterministic findings/exclusions, verdict/time, and four-dimensional actor/implementation provenance. Git business-author identity remains raw: retired author spellings cannot be mapped or selected as canonical implementation provenance. Partial or unsupported discovery remains non-pass.',
  },
  {
    name: 'artifact:milestone-ledger.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.milestone_ledger_set,
    rationale: 'Milestone ledger makes multi-deliverable intent countable; candidate rows guide diagnostics and confirmed rows can be gate-consumed.',
  },
  {
    name: 'artifact:milestone-closeout.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/milestone-status',
    consumerGate: 'DONE-phase milestone_status and milestone_closeout snapshot-first read path (snapshot-only; never re-blocks DONE)',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.milestone_closeout_capture,
    rationale: 'Milestone closeout snapshot freezes the DONE-time milestone report (schemaVersion-checked) so later reads stay stable without recomputing live freshness; it is written by the story_advance DONE capture in handlers/milestone-status and never re-gates DONE.',
  },
  {
    name: 'artifact:slice-plan.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission and DONE intent-equivalence gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.slice_plan_set,
    rationale: 'Slice plans bind oversized ledger exceptions to the current ledger hash and complete milestone coverage without auto-creating child stories.',
  },
  {
    name: 'artifact:parent-ledger-rollup.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DONE intent-equivalence gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.parent_ledger_rollup_set,
    rationale: 'Parent ledger roll-up records child-story coverage for slice-plan DONE equivalence.',
  },
  {
    name: 'artifact:closeout-write-receipts.jsonl',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'freshness-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'core/auto-commit-metadata',
    consumerGate: 'review-run metadata-only retention classifier (artifact gate validation remains independent)',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.closeout_write_receipt,
    rationale: 'Append-only integrity-chained cooperative local-runtime lineage. It may classify a registered nonmaterial closeout write as a review-retention descendant only when material, story-owned files, scope, review round, and HEAD evaluation remain unchanged. writerCommand is a registered writer label, not same-UID authentication; this lineage does not approve an artifact, and artifact gate validation remains independent. Immutable publication rechecks scoped worktree and index bytes before CAS and after hooks, rejects nonregular paths, preserves foreign HEAD/index changes, and attempts owned HEAD rollback independently of index recovery failure. Refresh-failure cleanup preserves foreign or unreadable index entries; outer auto-closeout rolls back only intended worktree output bytes and leaves index recovery to the publication primitive.',
  },
  {
    name: 'artifact:evidence/delivery-context-pack.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy'],
    level: 'L3',
    producer: 'handlers/delivery-context-pack',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.delivery_context_pack,
    rationale: 'Delivery context is a runtime-validated canonical closeout input, not a signed delivery verdict and not authority evidence.',
  },
  {
    name: 'artifact:proofstory.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.proofstory_contract_set,
    rationale: 'ProofStory contract stores hardening level, trigger reasons, acceptance bindings, and diagnostic gaps for diagnostics and opt-in enforcement.',
  },
  {
    name: 'artifact:intent-collision.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.intent_collision_set,
    rationale: 'Intent collision records accepted interpretation decisions; pass confirms candidate ledger rows for gate consumption.',
  },
  {
    name: 'artifact:scope-shrinkage-decision.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_shrinkage_decision_set,
    rationale: 'Scope shrinkage decisions explicitly preserve audit trail when DONE delivery no longer covers a required milestone.',
  },
  {
    name: 'artifact:red-evidence.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.red_evidence_create,
    rationale: 'Red evidence records pre-fix failures bound to baseline head/material and a green relation target; it remains distinct from green verificationEvidence.',
  },
  {
    name: 'artifact:spike.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates; withdrawal transaction preserves signed checkpoint history and propagates publication contention',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.spike_start,
    rationale: 'Spike evidence records investigation state and disposable code policy; it never satisfies red or verification evidence unless separately promoted by explicit commands.',
  },
  {
    name: 'artifact:delivery-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/delivery-check',
    consumerGate: 'storyMachine.canFinish DONE gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.delivery_check_set,
    rationale: 'Delivery-check signature is consumed by DONE only after the registered host-adapter broker one-shot attestation binds the exact delivery dispatch, writer session, host identity, and current story material; the persisted nativeEvidenceBinding is itself folded into the signed artifact and DONE re-verifies its registered-broker signature plus matching delivery dispatch event, so raw asserted reviewer identity is not authority. Its docsPromises use the shared total delivery-promise outcome normalizer: contradictions fail closed, explicit unverified stays unresolved, and only missing-status legacy rows use bounded inference. The signature folds in storyFilesHash: whole-tree materialHash drift with a matching signed storyFilesHash downgrades to a mandatory re-attestation advisory (delivery_check_drift_advisory), while a story-owned change or missing storyFilesHash stays strict stale.',
  },
  {
    name: 'artifact:prompt-envelopes.json',
    kind: 'artifact',
    semantics: ['artifact', 'prompt-envelope', 'schema-contract'],
    level: 'L1',
    producer: 'handlers/agent-prompt + handlers/review-run',
    consumerGate: 'story-dispatch rows are audit-only; review-run rows are verified through signed ReviewRun envelopeId by REVIEW and quorum gates; the assurance floor consumes host-verdict rounds emitted after quorum admission',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.agent_prompt,
    rationale: 'Content-addressed full Prompt Envelopes are append-only. Fresh Story writers persist exact proof-or-stop.* Prompt identities. Envelopes from the retired identity family remain inert historical bytes; verifyPromptEnvelopeIntegrity rejects them without fallback or rewrite. The package prompt-registry snapshot is also identity-bearing: its role-contract consumer rejects every schemaVersion or source other than the exact canonical proof-or-stop registry identities before deriving a contract. createdAt is provenance outside the envelopeId digest; story-dispatch cannot carry reviewer authority. Review-run envelopes additionally bind roleId to lane, the exact standard story-dispatch prompt bytes, the selected mode-aware host identity, and their exact delivered assembledPrompt bytes to the signed ReviewRun promptHash. Claude Code/CLI and Codex/CLI map explicitly to their matching PromptHost; a nonblank explicit unsupported provider becomes unknown before any environment inference, and antigravity/agy, fake, unknown, and absent providers fail closed instead of borrowing another host identity. The actual runtime-owned/global-thin package-registry resolver and explicit full-asset renderer return the same canonical body-free bootstrap; review_run_start supplies exactly one selected role-body render, so no modular+legacy double body is hidden. Review-run envelopes also bind an immutable as-of-run finding projection plus digest. Verification snapshots preserve optional-property absence, canonical integrity and trusted-prior selection while isolating valid arrays; explicit malformed values remain rejected, never normalized or re-signed. Later mutable finding disposition metadata cannot rewrite historical eligibility. New conditional review envelopes additionally bind optional fullStoryBaseHead from the producer-resolved main commit. First-pass and bounded-overflow replay use that immutable base with the signed run head; declared unavailable bases refuse, while absent legacy fields preserve the previous digest. Live material, scope, native identity and Finding checks remain independent.',
  },
  {
    name: 'artifact:review-runs.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'review-run', 'prompt-envelope', 'schema-contract', 'workspace-binding', 'freshness-policy'],
    level: 'L4',
    producer: 'handlers/review-run',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_run_start,
    rationale: 'Signed reviewer runs bind current REVIEW findings and passes to a fresh lane-specific boundary, including ReviewRun.storyFilesHash for unrelated main-drift freshness and, in full-envelope mode, the exact canonical promptHash-addressed body delivered by review_run_start. New records carry assembledPromptRef and slim readers do not load body files; legacy inline records remain unchanged. Gate and managed-launch consumers hydrate and verify exact content digests before accepting authority. Historical incremental eligibility uses one consistent as-of commit, while current admission and requested-full live freshness remain independently enforced. Signed reviewer runs bind current REVIEW findings and passes to a fresh lane-specific boundary, including ReviewRun.storyFilesHash for unrelated main-drift freshness and the exact canonical proof-or-stop.* assembledPrompt bytes delivered by review_run_start. Exact-field allowlists and nested scope/workspace binding verification reject mixed or unsigned identity-bearing extensions. Reference-only runs require assembledPromptRef to equal the signed promptHash and forbid simultaneous inline bytes. Authority consumers provide a trusted Story path, verify actual CAS UTF-8 bytes and digest, and then enforce current prompt identities; absent context or missing and corrupted CAS bodies are rejected. Runs from the retired identity family remain inert historical bytes; verifyReviewRun and current REVIEW gates reject them without a compatibility fallback.',
  },
  {
    name: 'artifact:prompt-bodies',
    kind: 'artifact', semantics: ['artifact', 'prompt-envelope', 'schema-contract'], level: 'L1',
    producer: 'review_run_start via StoryStore.writeReviewPromptBody',
    consumerGate: 'verifyReviewRunPromptEnvelope and managed reviewer launch hydrate exact signed promptHash references',
    artifact: { name: 'prompt-bodies', path: 'prompt-bodies', signed: false },
    rationale: 'Immutable content-addressed exact UTF-8 bodies are published before signed run references. Existing objects are verified, never overwritten. Body bytes alone grant no authority; signed run promptHash, envelope integrity and assembly verification remain required. Ordinary review-run reads carry references without reading the body, while missing, corrupted or conflicting bodies fail closed at authority consumers. review_prompt_gc uses the same inventory then review metadata locks as publication, strictly reads every run/envelope/pass/finding reference, retains all history, and refuses deletion on corruption or dangling references.',
  },
  {
    name: 'artifact:review-inventory-epochs.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'no-blocker-evidence'],
    level: 'L4',
    producer: 'handlers/review-inventory',
    producerSourceRefs: ['packages/main/src/core/review-inventory-epoch.ts', 'packages/main/src/handlers/review-inventory.ts'],
    consumerGate: 'storyMachine.canReenterDev REVIEW to DEV inventory remediation/completeness gate and certification_window_begin',
    consumerSourceRefs: ['packages/main/src/core/machine.ts', 'packages/main/src/handlers/transition-orchestrator.ts'],
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_inventory_finalize,
    rationale: 'Signed epochs freeze REVIEW material/scope/round/required lanes plus complete checklist and effective ProofStory acceptance contract/dispositions; signed critic receipts bind complete per-finding verified-family/duplicate/not-verified dispositions plus pass/finding read evidence; signed inventory receipts either prove bounded zero-new verified-finding saturation or explicitly grant review-remediation-only authority after a complete critic-certified wave; remediation-only receipts cannot enter certification. Both are revalidated against the live acceptance subject, and are single-use for aggregated remediation DEV, never TEST authority. Inventory-completeness receipts bind current head/material/storyFiles hashes; authorizesTest stays false and completeness is not PRE_CERT. Each native or managed epoch result is independently durable before its Git commit is deferred; finalize/cancel batch exact review artifacts and referenced prompt bodies through an isolated verified index and HEAD CAS. PRE_CERT preserves the canonical same-Story review epoch metadata subject only across the publisher\'s registered artifacts and prompt-body paths recognized by the canonical prompt-body store, retaining ancestry, single-parent, material and signed receipt checks. A failed commit preserves signed results, and exact retries preserve receipt authority and cancellation facts without redispatch or telemetry-only commits. Finalized next-action guidance uses the same signed receipt: remediation routes to DEV, finding-free completeness routes to fast PRE_CERT preparation, retained findings route to finding inspection, and consumed receipts route to session status without inferring the prior consumer. Invalid or mismatched authority cannot project a next action; guidance never consumes a receipt or grants transition authority.',
  },
  {
    name: 'artifact:findings.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'blocker-state', 'finding-state'],
    level: 'L4',
    producer: 'handlers/finding',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.finding_add,
    rationale: 'Reviewer finding signatures seal exactly one registered-broker invocation attestation bound to the exact story, lane, ReviewRun, writer session, signed dispatch, adapter, host, and one-shot nonce, or one managed provider receipt/proposal binding. Native signatures also bind category, evidenceState, uncertaintyReason, files, and disprovenEvidence, so rewriting blocker or refutation semantics invalidates the record. Observable mixed-provider ancestry is an additional veto; unavailable ancestry does not invalidate a trusted broker attestation. Missing, conflicting, replayed, stale, or rewritten provenance fails the REVIEW consumer.',
  },
  {
    name: 'artifact:finding-ledger.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'atomic-persistence'],
    level: 'L2',
    producer: 'handlers/finding + handlers/finding-ledger',
    artifact: {
      name: 'finding-ledger.json',
      path: 'finding-ledger.json',
      signed: true,
      signature: 'signFindingLedgerReceipt/verifyFindingLedgerReceipt; every committed semantic row is covered by an exact signed commit receipt',
      producerCommand: 'finding_add/finding_runtime_evidence_run',
    },
    rationale: 'Append-only Finding persistence carrier and REVIEW-retention metadata. Atomic multi-append preparation preserves each existing signed receipt and exact prefix, publishes one complete envelope under the original fence, and leaves disk unchanged on any preparation refusal. The carrier has no lifecycle/gate authority; protected query and runtime verification establish its receipt trust independently.',
  },
  {
    name: 'artifact:finding-ledger-lifecycle-transition',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'atomic-persistence', 'gate-evidence', 'blocker-state', 'finding-state'],
    level: 'L4',
    producer: 'handlers/finding.appendFindingLifecycleTransition + handlers/finding-ledger.bindLegacyFindingLedgerReceipts',
    consumerGate: 'StoryStore.readFindings projection consumed by storyMachine.canPassReview REVIEW to TEST gate',
    artifact: {
      name: 'finding-ledger-lifecycle-transition',
      path: 'finding-ledger.json',
      signed: true,
      signature: 'FindingLedgerReceipt covers the immutable finding_lifecycle_transition record and exact source-record CAS binding; pre-upgrade nested-digest omission additionally requires a current exact-signed legacy_lifecycle_receipt_binding over exact carrier/record/source/chain bytes',
      producerCommand: 'finding_resolve/finding_dismiss',
      consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    },
    rationale: 'Only a current exact-signed finding_lifecycle_transition, or the same current-key pre-upgrade transition with a unique valid current exact-signed legacy_lifecycle_receipt_binding, carries terminal Finding authority; the binding alone and all other ledger rows retain narrower levels.',
  },
  {
    name: 'artifact:finding-ledger-projection',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'atomic-persistence', 'gate-evidence', 'blocker-state', 'finding-state'],
    level: 'L4',
    producer: 'handlers/finding-ledger.createAuthoritativeFindingMutation',
    consumerGate: 'StoryStore.readFindings projection consumed by storyMachine.canPassReview REVIEW to TEST gate',
    artifact: {
      name: 'finding-ledger-projection',
      path: 'finding-ledger.json',
      signed: true,
      signature: 'FindingLedgerReceipt covers each immutable finding_projection record and its exact source-record/current-chain CAS binding',
      producerCommand: 'audit/gap_log/finding_cluster/validate/signature_backfill',
      consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    },
    rationale: 'Legacy live mutation surfaces gain durable exactly-once current-state authority only through a current-key exact-signed source-bound projection; unsigned findings.json changes remain non-authoritative.',
  },
  {
    name: 'artifact:review-passes.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'review-pass', 'prompt-envelope', 'no-blocker-evidence'],
    level: 'L4',
    producer: 'handlers/finding',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'No-blocker review pass signatures are accepted only with exactly one registered-broker invocation attestation bound to the exact story, lane, ReviewRun, writer session, signed dispatch, adapter, host, and one-shot nonce, or one managed provider receipt/proposal binding. Observable mixed-provider ancestry is an additional veto; unavailable ancestry does not invalidate a trusted broker attestation. Missing, conflicting, replayed, stale, or rewritten provenance fails the REVIEW consumer.',
  },

  {
    name: 'artifact:evidence/controller-config-projection.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'atomic-persistence', 'workspace-binding', 'gate-evidence'],
    level: 'L4',
    producer: 'cli/runtime-root via core/controller-config-projection',
    consumerGate: 'scope-path classifier and scope-contract REVIEW admission',
    artifact: {
      name: 'controller-config-projection-receipt',
      path: 'evidence/controller-config-projection.json',
      signed: true,
      signature: 'signValidationArtifact/verifyValidationArtifact binds first projected config digest, Story, controller root, worktree root, and config path',
      consumerGate: 'scope-contract REVIEW admission',
    },
    rationale: 'Only an untracked config pair matching both immutable first-projection receipts can be classified as a control artifact. Both receipt stores enforce canonical containment and no-follow regular-file ancestry. Editing either or both config copies, deleting, replacing, aliasing, or redirecting either receipt, changing workspace identity, using a tracked path, or losing the signing key returns the config to ordinary fail-closed scope enforcement.',
  },
  {
    name: 'artifact:managed-review-evidence-proposal',
    kind: 'artifact',
    semantics: ['artifact', 'prompt-envelope', 'reviewer-lane', 'schema-contract'],
    level: 'L3',
    producer: 'handlers/managed-review-evidence + core/managed-host-run',
    consumerGate: 'managed_review_evidence_import successful-terminal intake only',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.managed_review_proposal_set,
    rationale: 'Managed review submissions are idempotent by host/story/reviewRunId/lane, with the normalized submission digest sealed in the spec; conflicting inputs and archived or interrupted requests never launch replacements. A purpose-bound inventory-completeness critic additionally receives a controller-fetched projection of the current signed epoch, required-lane ReviewRuns, Findings, and passes in its managedPromptDigest-bound prompt, because its detached committed scratch intentionally cannot contain current uncommitted inventory metadata. The projection is inspection input only and grants no topology, TEST, DONE, or implementation authority. The provider-owned immutable proposal is stored at the dynamic managed-run evidence-proposal.json path and is not gate evidence until an exact successful terminal seals it. The formal path accepts only one schema-valid bounded Codex agent_message or exact standalone Codex raw stdout envelope, or one Claude result final-result envelope after successful provider exit, and binds the exact run/review/provider tuple. Ordinary Codex progress agent messages are ignored; envelope-looking malformed/oversized attempts remain explicit failures, and multiple valid envelopes, tool-log, ordinary or mixed raw stdout, arbitrary streamed-output, or controller-authored input fails closed. The older signed-descriptor provider callback remains compatibility-only.',
  },
  {
    name: 'artifact:convergence-progress.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'atomic-persistence', 'workspace-binding', 'gate-evidence'],
    level: 'L4',
    producer: 'review_inventory_begin/review_inventory_finalize via core/convergence-progress-journal',
    artifact: { name: 'convergence-progress.json', path: 'convergence-progress.json', signed: true, signature: 'signValidationArtifact/verifyValidationArtifact with the trusted Git common-directory key' },
    consumerGate: 'assessConvergenceProgressGate shared by CLI advance/takeover and machine REVIEW mint; story_resume signed human decision; managed burn supervisor stop only with validated live usage over its sealed limit',
    rationale: 'Current journal and nested effective-progress schemas are canonical and signature-bound; even validly signed retired domains are rejected without rewriting history. Only independently validated completed review epochs enter signed completion history; zero-wave compatibility receipts do not. Repeated observations preserve bytes. Current coverage and admissible pass lanes come from existing verifiers; claimed mechanical PASS additionally requires the exact pinned command/selector and authenticated V5 execution/publication bundle shared with remediation, binding Story, intent, command, selector and recorded freshness through the strict receipt verifier; readable legacy receipts confer no authority and remediation revalidates artifact bytes immediately before publication; canonical test:receipt-authority-v5 covers both remediation and convergence with real V5 evidence and negative controls. Private per-validation signer-location reuse retains live key and signature checks, exact requested cwd binding, and a fresh final canonical cwd/common-directory comparison; test:verification-key-location covers repeated probes and key/topology continuity. Dirty source makes observation unavailable. Finding decreases require authenticated ledger transitions, and unsigned legacy categories, heartbeats, run counts and metadata commits do not constitute progress. Signed later cancellation preserves observed completion history but interrupts consecutive stagnation. Later signed certification consumption timestamps and window ownership are lifecycle outputs excluded from both epoch and receipt completion digests; signatures and all remaining completion claims still verify, while certification independently enforces consumption authority. Missing or corrupt input is unavailable rather than fabricated progress. Only two complete stagnant epochs request a human decision; live effective progress releases the stall. Integrity failures are distinct blocked results. Human-only acknowledged decisions append signed history and reset the comparison boundary without erasing completed epochs.',
  },
  {
    name: 'artifact:scope-budget-decisions.json', kind: 'signed-artifact', level: 'L4',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'gate-evidence'],
    producer: 'handlers/story-scope-budget.scope_budget_approve',
    producerSourceRefs: ['packages/main/src/core/story-scope-budget-decisions.ts'],
    consumerSourceRefs: ['packages/main/src/core/story-scope-budget.ts'],
    consumerGate: 'machine DEV guards and acceptance amendment application',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_budget_approve,
    rationale: 'Interactive operator acknowledgement binds exact scope and amendment base plus resulting scope. Signed journal and entries enforce identity, seven-day expiry, immutable configured limits and agent refusal; unknown scope cannot be approved.',
  },
  {
    name: 'artifact:acceptance-amendments.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'atomic-persistence', 'verification-policy', 'workspace-binding', 'gate-evidence'],
    level: 'L4',
    producer: 'core/acceptance-amendment-journal',
    artifact: { name: 'acceptance-amendments.json', path: 'acceptance-amendments.json', signed: true, signature: 'signValidationArtifact/verifyValidationArtifact with schema-separated acceptance claims and the trusted Git common-directory key' },
    consumerGate: 'acceptanceCompletionBlocker checklist done and REVIEW TEST DONE gates',
    rationale: 'Current amendment journal and entry schemas are canonical and independently signature-bound; signed retired domains are rejected without re-signing historical records. Each amendment preserves a signed original scope/checklist/ProofStory snapshot and additive delta, deterministic next digest, submitter identity, and independent worker public key pinned before launch. Proposal and review leave acceptance untouched. Application verifies exact current base/source and approving provider receipt, then persists APPLYING before any acceptance artifact write and APPROVED only after complete exact readback. Interrupted application admits only original or exact derived artifact values and rechecks source; unknown drift is never overwritten. Exact retry preserves authority bytes; cancellation is audited and cannot discard an applying or approved change.',
  },
  {
    name: 'artifact:acceptance-amendment-review-receipt',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'prompt-envelope', 'execution-evidence', 'schema-contract'],
    level: 'L3',
    producer: 'core/managed-host-run acceptance_amendment_reviewer worker',
    artifact: { name: 'acceptance-amendment-review-receipt', path: 'acceptance-amendment-review-receipt', signed: true, signature: 'worker-private signCanonical; verifyCanonical against the review attempt pinned public key' },
    consumerGate: 'readManagedAcceptanceReviewReceipt exact independently pinned worker-key intake only; proposal.schemaVersion must equal ACCEPTANCE_REVIEW_FINAL_SCHEMA (proof-or-stop.acceptance_amendment_review_final.v1), including signed compatibility containers',
    rationale: 'DEV acceptance amendment review uses a distinct provider final schema and worker-private Ed25519 seal over its exact amendment/base/submitter, prompt, spec, result, root, binding projection and actual normal child cleanup. One complete provider verdict is mandatory. The signed review attempt must pin the worker public key before consumption; a receipt key supplied by its own verdict is not authority. Retention archives preserve the seal and original pinned-key verification. This receipt alone is neither a Story REVIEW pass nor authority to mutate acceptance; the amendment journal owns current-base revalidation and one-time application.',
  },
  {
    name: 'artifact:managed-review-evidence-binding',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'prompt-envelope', 'reviewer-lane', 'freshness-policy', 'blocker-state', 'execution-evidence'],
    level: 'L4',
    producer: 'handlers/managed-review-evidence + core/managed-review-evidence',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate through collectReviewerEvidenceState shared revalidation',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.managed_review_evidence_import,
    rationale: 'Managed, certification and composite-scope retention readers share core/review-maintenance-lineage for signed epoch publication and exact authenticated evidence-only refresh commits. A refresh preserves the exact semantic multiset of covered intent references, evidence kinds and results with one-to-one prior-row consumption, authenticates both old and new V5 rows against independent parent and original-reviewed anchors, and cannot add coverage or upgrade a waiver. Exact parent matches cannot grandfather unauthenticated rows introduced by an intervening commit. The refresh and TEST index checks live in independent leaf modules. Scoped retention admits only current byte-bound refresh artifacts through recomputed original-reviewed-snapshot proof; direct publication is excluded from generic canonical writers; generic closeout writer labels do not authorize direct checklist publication. Official certification consumption retains only the exact window-bound epoch delta; routine validation retains append-only causal closeout receipts and TEST retains only the existing exact index transition. These lineage checks confer no certification or validation verdict. Missing sealed launch prompt digests fail closed without a caller-binding fallback. Causal output addresses require the exact output payload digest and a verified receipt reference; prior review, finding-ledger and epoch/receipt history cannot be removed by finalization. Convergence history is preserved while current finding projections may change. Lease retention allows only heartbeat and PID changes. Validation test-run projections are shape-checked; epoch and validation metrics bind the Story. Telemetry is not authenticated execution history. An opaque cache exists only for one collector read, with module-owned verdict maps and byte checks on each current artifact. Receipt output lookup scans each commit corpus once. Caller booleans never confer strict refresh authority. Unexpected reader failures are diagnostic and fail closed. TEST round identity comes from the original immutable reviewed HEAD. Epoch publication permits a later consumer HEAD only with cutoff ancestry and both exact consumer content hashes. Native and managed critic consumption authenticate the signed wave subject; managed consumption uses its sealed launch prompt without rebuilding an OPEN-only pack. A superseded-wave PASS is removed from invalid only after its transport authority authenticates and a newer valid lane record (PASS or FINDING); omission never promotes the old PASS or releases open findings; unknown or tampered receipts remain hard failures. Cancellation, forged writer subjects, out-of-scope paths and non-evidence checklist changes remain refused. The importer persists the signed ReviewPass/Finding story evidence before sealing its immutable receipt-to-story binding under the canonical story-level metadata lock. A crash before the seal is repaired only by retrying the exact persisted receipt evidence; a crash before story persistence leaves no binding to conflict with another writer. Distinct receipts cannot lose updates or allocate duplicate ids. The surrounding ReviewPass/Finding signature and immutable evidence-binding seal bind its exact managed terminal receipt, sealed live-output/result/event/proposal digests, replacementSafe/reaped/no-residual cleanup, sole proposal artifact, provider reviewer, prompt, material, ReviewRun tuple, and every provider-authored verdict/read-provenance field. Fresh intake, idempotent replay, the REVIEW consumer, doctor, and retention GC independently revalidate those exact bytes. The REVIEW consumer classifies this managed-receipt path separately from registered-broker native direct review, unsealed cross-provider advisory output, and degraded-single-host local-only assurance.',
  },
  {
    name: 'artifact:review-loops.jsonl',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence', 'blocker-state', 'schema-contract'],
    level: 'L4',
    producer: 'handlers/review-loop',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_loop_start,
    rationale: 'Review reflection loop start/iteration/close records provide REVIEW blocker-state for bounded retry and escalation policy.',
  },
  {
    name: 'artifact:certification-window.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'blocker-state', 'freshness-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/certification-window',
    consumerGate: 'done_required_validate / validate --full PRE_CERT certification-window gate / unscoped validate --story / runValidateGate / certification_window_begin; DONE-required checks admission inside validation ownership after queued policy drift checks, without consuming routine allocation; done_prepare accepts only signed authorized ADMITTED to RUNNING deltas through isCertificationRunningOnlyAdvance',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.certification_window_begin,
    rationale: 'Signed CertificationWindow and PRE_CERT receipt bind frozen head/main/storyFiles identity. Exact canonical artifact-releases.jsonl and capability-releases.jsonl paths are review-subject causal inputs bound to actual Git blobs/tombstones, with integration/test dependency invalidation; release provenance is never gate evidence and unknown paths fail closed. Inventory completeness receipts never authorize certification.',
  },
  {
    name: 'artifact:draft-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L3',
    producer: 'handlers/draft-check',
    consumerGate: 'story_create fromDraft preflight',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.draft_check_set,
    rationale: 'Draft check signature protects reviewed draft inputs before story creation.',
  },
  {
    name: 'artifact:summary.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/summary',
    consumerGate: 'story_advance DONE summary checklist',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.summary_set,
    rationale: 'DONE summary content is consumed by completion and delivery gates.',
  },
  {
    name: 'artifact:test-evidence.json',
    kind: 'artifact',
    semantics: ['artifact', 'validation-result', 'test-evidence', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/verifier',
    consumerGate: 'storyMachine.canFinish DONE gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.validate,
    rationale: 'Validation status artifact is authenticated before TEST/DONE consumption; dynamic reuse preserves its manifest and rechecks live receipts. Unsigned historical PASS requires fresh validate. Zero-command reuse must use the shared immutable-tree/CAS metadata primitive to commit canonical PASS, terminal, and receipt before returning PASS.',
  },
  {
    name: 'artifact:done-required-evidence.json',
    kind: 'artifact',
    semantics: ['artifact', 'validation-result', 'execution-evidence', 'schema-contract', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/done-required-validation',
    consumerGate: 'story_advance DONE done-required-validation gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.done_required_validate,
    rationale: 'Opt-in DONE-required command receipts are consumed by the local DONE oracle separately from ordinary TEST validation evidence, with coverage and identity rechecked against the active policy. done_prepare may skip execution only after that canonical evaluator passes, every path touched by every intervening commit is trusted story metadata, and HEAD remains stable across evaluation. Command/phase/CLI-idle/CLI-max timeout terminals are structured and retain cleanup before result emission. The configured root suite consumes the retired vocabulary guard; its test-only envelope mutation loader admission requires exact call shape, whole-source fingerprint and producer provenance, with drift and rebinding rejection controls. Loader admission is not a validation PASS or a dynamic-code exemption.',
  },
  {
    name: 'artifact:declared-artifacts.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/artifact-declare',
    consumerGate: 'dirty-worktree classifier and DONE declared artifact gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.artifact_declare,
    rationale: 'Declared product artifacts are consumed by dirty-worktree classification and DONE reference checks.',
  },
  {
    name: 'artifact:eval-evidence.json',
    kind: 'artifact',
    semantics: ['artifact', 'validation-result', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/evaluate',
    consumerGate: 'story_advance DONE evaluator evidence gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.evaluate_save,
    rationale: 'Evaluator evidence artifact is consumed by DONE for browser projects.',
  },
  {
    name: 'artifact:process-events.jsonl',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/verify-codex',
    consumerGate: 'Codex adapter REVIEW and DONE evidence gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.verify_codex,
    rationale: 'Codex adapter verification evidence is recorded in process events and consumed by adapter gates.',
  },
  {
    name: 'artifact:story-evidence-binding',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'workspace-binding', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/repro-intake',
    consumerGate: 'storyMachine.canEnterPlan IDEA to PLAN gate and storyMachine.canStartDev/canSkipPlan DEV-entry gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.story_create_from_repro,
    rationale: 'Story evidence binding artifacts bind accepted repro candidate evidence to a story before material-code bug/feature stories may enter PLAN or DEV.',
  },
] as const satisfies readonly ProcessFactRegistryDeclaration[];

export const PROCESS_FACT_SIGNED_ARTIFACTS = PROCESS_FACT_ARTIFACTS.filter(
  (entry) => entry.artifact?.signed === true,
) as readonly ProcessFactRegistryDeclaration[];

/**
 * L4 predicates shared by the real TEST→DONE guard and the read-only
 * done_closure/done_prepare projection. These entries make the projection's
 * consumption explicit without making the shared read-only projection an
 * evidence producer. The full done_prepare command can execute mutating steps.
 */
export const PROCESS_FACT_DONE_PREFLIGHT_CONSUMERS = [
  {
    name: 'runtime:done_shared_predicate_projection',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'schema-contract', 'blocker-state', 'gate-evidence'],
    level: 'L4',
    producer: 'core/machine evaluateDonePredicates ordered lazy outcomes',
    consumerGate: 'storyMachine.canFinish DONE gate and buildDoneChecklist done_closure/done_prepare preflight',
    rationale: 'The boolean DONE gate and diagnostic consume the first failed shared outcome. Active readiness generically projects every failure, including future predicates, and preserves stricter preflight failures. Explicit actual-DONE snapshot inspection retains the pre-existing historical artifact/assurance presentation, not a new admission attempt; reviewer eligibility is informational, never a fresh PASS or full historical audit. TEST cannot select that exception. Rejected delivery contents are not traversed. Literal code/row identities, finite adapter syntax, and executable mutations guard this boundary without claiming arbitrary TypeScript semantic equivalence.',
  },
  {
    name: 'runtime:done_finish_decision_presence',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'schema-contract', 'blocker-state', 'gate-evidence'],
    level: 'L4',
    producer: 'core/machine evaluateDonePredicates via core/playbook-runtime-memory inspectDevMemoryFinishDecision',
    consumerGate: 'storyMachine.canFinish DONE gate and buildDoneChecklist done_closure/done_prepare preflight',
    rationale: 'DONE and its read-only preflight projection consume the same fail-closed finish-decision presence predicate from one inspection. Only the byte-exact proof-or-stop.dev-memory-finish-decision.v1 schema is admitted; a parsed unsupported schema yields unsupported_identity with its artifact site and bounded JSON-safe value, never a missing-record claim. A missing or malformed record yields missing_dev_memory_finish_decision; the record-only reader retains null compatibility and the projection never creates or repairs the record.',
  },
  {
    name: 'runtime:done_phase_agnostic_reviewer_verdict',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'freshness-policy', 'review-run', 'review-pass', 'blocker-state', 'gate-evidence'],
    level: 'L4',
    producer: 'core/machine evaluateDonePredicates via evaluateReviewVerdict',
    consumerGate: 'storyMachine.canFinish DONE gate and buildDoneChecklist done_closure/done_prepare preflight',
    rationale: 'DONE and its read-only preflight projection call the same phase-agnostic evaluateReviewVerdict predicate. Dynamic reviewer verdict codes use the shared review-verdict row; only review_evidence_invalid is presented through the established stale_closeout_review compatibility code, and reviewer evidence is never rebound or rewritten.',
  },
] as const satisfies readonly ProcessFactRegistryDeclaration[];

export interface DonePreflightPredicateInventoryEntry {
  blockerCode: string;
  processFactName: string;
  oracleRowId: string;
}

/**
 * Every literal machine-readable blocker code in machine.ts's shared
 * evaluateDonePredicates generator must be represented here. The DONE branch
 * and boolean guard are thin consumers of its first failed result; the oracle
 * projects all failed results without a manually maintained row whitelist.
 * The verifier checks source-owned code/row identities, finite adapter shapes,
 * and executable propagation/mutation witnesses. It does not attempt to prove
 * semantic equivalence between arbitrary independently written predicates.
 */
export const DONE_PREFLIGHT_PREDICATE_INVENTORY = [
  { blockerCode: 'acceptance_amendment_blocked', processFactName: 'artifact:acceptance-amendments.json', oracleRowId: 'acceptance-amendment' },
  {
    blockerCode: 'delivery_check_tampered',
    processFactName: 'artifact:delivery-check.json',
    oracleRowId: 'delivery-check',
  },
  {
    blockerCode: 'live_smoke_transcript_failed',
    processFactName: 'runtime:live_smoke_transcript_done_gate',
    oracleRowId: 'live-smoke-transcript',
  },
  {
    blockerCode: 'missing_delivery_check',
    processFactName: 'artifact:delivery-check.json',
    oracleRowId: 'delivery-check',
  },
  {
    blockerCode: 'missing_dev_memory_finish_decision',
    processFactName: 'runtime:done_finish_decision_presence',
    oracleRowId: 'dev-memory-finish-decision',
  },
  {
    blockerCode: 'unsupported_identity',
    processFactName: 'runtime:done_finish_decision_presence',
    oracleRowId: 'dev-memory-finish-decision',
  },
  {
    blockerCode: 'stale_closeout_review',
    processFactName: 'runtime:done_phase_agnostic_reviewer_verdict',
    oracleRowId: 'review-verdict',
  },
  {
    blockerCode: 'stale_delivery_check',
    processFactName: 'artifact:delivery-check.json',
    oracleRowId: 'delivery-check',
  },
  {
    blockerCode: 'unverified_promise',
    processFactName: 'runtime:delivery_promise_outcome_done_gate',
    oracleRowId: 'delivery-check',
  },
] as const satisfies readonly DonePreflightPredicateInventoryEntry[];

export const PROCESS_FACT_CLOSEOUT_TELEMETRY = [
  {
    name: 'runtime:closeout_phase_transition',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/transition-orchestrator',
    consumerGate: 'done_prepare convergence acceptance, with refuse-only upstream scope/review diagnosis and unchanged final DONE oracle',
    rationale: 'Typed from/to phase transitions bind attempt, review round, materialHash, and storyFilesHash so metadata-only rollback counts are mechanically derived. The gated PLAN->INIT reopen records three further durable audit semantics on the same append-only, appended-only-on-success event: transitionType: "reopen" marks the backward reopen so it is distinguishable from a forward transition, reason carries the operator reason already validated at the REOPEN remap (non-blank, at least REOPEN_REASON_MIN characters) so a validated reason is never dropped, and reopenAuditId carries the recovery idempotency key. All three are strictly additive and are set ONLY on a REOPEN; every ordinary transition must omit them and keep its exact prior event shape. RECOVERY SEMANTICS (B-70a6 F-004): the phase write and this event append are two separate fs operations, so a crash between them once left a committed reopen with NO audit record — unrecoverable, because REOPEN only fires FROM PLAN and the story had already left the only phase that could retry it. The reopen therefore writes a pendingReopenAudit recovery record (auditId, verbatim reason, fromPhase, at, materialHash, storyFilesHash, reviewRound) onto the story index in the SAME atomic writeStory rename that persists phase=INIT, so the reason is durable the instant the reopen commits; reconcilePendingReopenAudit then emits any missing event at the next ORCHESTRATED transition and clears the record, narrowed further by the OUT-OF-BAND PHASE MUTATIONS and CONCURRENCY RESIDUAL paragraphs below and never on an arbitrary read-only command. Recovery is idempotent by exact reopenAuditId identity, never by reason text: a missing event is appended exactly once, an already-audited record is cleared without appending, and the clear happens only after the event is durable. The record can only exist because the phase write it rode committed, so an aborted or refused reopen leaves neither record nor event and nothing can later fabricate a transition that did not happen. The record and reopenAuditId are audit-only recovery bookkeeping, not gate evidence: no gate consumes them, and the convergence counters above stay derived from the typed from/to phases. OUT-OF-BAND PHASE MUTATIONS (B-70a6 F-005): runStoryTransitionInner is NOT the only writer of story.phase, so the F-004 reconciliation at its entry does not by itself make the invariant framework-wide. Two production sites mutate story.phase directly through store.writeStory: story_discard (handlers/worktree.ts) and the story_reconcile zombie repair (handlers/story-query.ts). Both write a TERMINAL phase (DISCARDED / DONE) that has no outgoing machine edge, and story_discard additionally force-deletes the worktree and branch, so an unaudited reopen there was lost PERMANENTLY rather than deferred to the next transition. Both sites must therefore call reconcileReopenAuditBeforeOutOfBandPhaseChange BEFORE their destructive steps and before their phase write. That rescue reads the record from the DOOMED copy when necessary, because cli/runtime-root.ts redirects story_discard to the MAIN root while the reopen is cwd-gated into the worktree, so the handler store cannot see the record; it then appends the event to the SURVIVING store through the same reconcilePendingReopenAudit, keeping ONE append site and the same exact-auditId idempotency. The rescue never blocks the operation: discarding or reconciling a story stays legitimate, and every failure is surfaced as a warning instead of thrown, including a doomed copy that exists but cannot be read (corrupt index.json, permission error); the single deliberate silence is a doomed copy that holds no story metadata at all, which is a no-op rather than a failure. Declared residuals: the record on the DOOMED copy is deliberately not cleared, because writing into a worktree that is about to be status-checked could turn it dirty and refuse a non-force discard, so a destructive step that fails can later yield a DUPLICATE event sharing one auditId, never a lost one; and story_discard --purge removes the story metadata directory holding the log this event is appended to, so a rescued event does not survive a purge, an explicit erase of every process event this story holds rather than a silent audit loss. Stated to the precision that is actually verified: the git rollback purge performs may restore an OLDER committed copy of that directory, so metadata files can remain on disk after a purge, but that copy predates the rescue and never carries the rescued event. CONCURRENCY RESIDUAL (B-70a6 F-013): the out-of-band rescue is a one-time scan that does not hold the per-story transition lock, so it serializes against nothing. A PLAN->INIT reopen that commits its recovery record AFTER that scan has already run can still have that record destroyed by the same story_discard, and the reopen then dies against the removed worktree, so neither the record nor the event survives. The guarantee is therefore SEQUENTIAL and is claimed only at that strength: a reopen whose record is already on disk when the terminal operation starts is recovered, by the next orchestrated transition or by these two sites, while a reopen racing the terminal operation is not covered; a separate lock-independent case is story_discard --force on a story whose worktree is already gone, where the record only ever lived in that worktree and no mutex could have saved it. It is named rather than locked, and B-70a6 F-014 corrected the reason recorded for that. The earlier text argued that the transition-cas persist claim, a fail-fast 15s claim built for a millisecond fully synchronous section, could not be stretched across the git work story_discard performs. That argument was misdirected: the persist claim was never the candidate primitive. The only candidate is acquireStoryTransitionLock, whose 120s stale threshold is documented as generously exceeding any legitimate long transition, and story_discard is itself fully synchronous, so the millisecond-section objection never applied to it. The accurate reasons are three. First, acquireStoryTransitionLock is documented as a best-effort advisory contention reducer that is not the correctness guarantee and is disabled outright by PROOF_OR_STOP_TEST_DISABLE_TRANSITION_ADVISORY_LOCK, so taking it could narrow this window but never close it and the claim would still be SEQUENTIAL, which makes this a defence-in-depth question and not a correctness one. Second, story_discard is the recovery command an operator reaches for when a story is already wedged, and that lock exposes no fail-fast option: an acquire polls its 180s deadline and then throws, and a leaked lock whose recorded pid has been recycled by an unrelated live process is classified active and never stale-reclaimed at any age, so the recovery command would hang behind a lock file; the one shape without that hazard, a non-blocking try-acquire that proceeds unlocked on failure, was considered and declined because it covers only a reopen that has not yet taken the lock while leaving a mutex that reads as a serialization it does not provide. Third, and specific to story_reconcile rather than to story_discard, that repair already runs inside the main write lock, so acquiring the transition lock there would invert the established transitionLock to mainWriteLock order and let a repair block the main write lock while a DONE holding the transition lock fail-fasts on it; story_discard is not in that position, because its main write lock calls all come after the rescue and after the destruction. Hardening that race is a follow-up story and is not claimed here.',
  },
  {
    name: 'runtime:closeout_reviewer_reattestation_boundary',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'review-run', 'review-pass', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/review-run review_run_start + handlers/finding review_pass_set',
    consumerGate: 'done_prepare convergence acceptance',
    rationale: 'Signed completed reviewer run/pass pairs on the same attempt, materialHash, storyFilesHash, and reviewRound remain total telemetry. The first completed identity per lane is ordered by verified ReviewPass.createdAt with reviewRunId/pass id tie-breakers, independent of run start order. Re-attestations completed before TEST entry are exempt; completion at or after TEST entry increments the fail-closed post-TEST counter.',
  },
  {
    name: 'runtime:closeout_human_confirmation',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/story story_resume',
    consumerGate: 'done_prepare convergence acceptance',
    rationale: 'A successful human convergence-breaker acknowledgement emits a durable typed event inside the active review attempt.',
  },
  {
    name: 'runtime:closeout_validation_terminal',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'validation-result', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/verifier',
    consumerGate: 'done_prepare convergence acceptance',
    rationale: 'Generic CLI command observation consumes argument-aware effective ownership for hooks, activity and Story events; name-only read helpers never exempt writers. check apply/upgrade modes reject malformed values before ownership classification; compatibility helpers remain re-exported without being consumed internally. Ordinary observation classifier failures omit best-effort events instead of replacing command failures. Successful validate/TEST-advance canonical terminals instead fail loudly with CanonicalTerminalCloseoutError; already-failed canonical commands retain the primary error and report closeout faults to health. These command observations do not replace validation terminals or grant gate evidence. Runtime readiness uses the selected Store metadata root; queue activity includes recorded Story events and, only when those are old, non-merge commits exclusive to the integration baseline within a bounded shared probe budget; unavailable evidence is unknown-worktree, never stale proof or cleanup authority. Legacy currentValidationStoryId emits a deprecation and cannot authorize lock reentry. Command schedulerWaitMs is diagnostic intra-plan resource-conflict waiting only, excluding worker slots and cross-process capacity; it grants no gate or reuse authority. Routine validation terminals bind attempt, command-set identity, disposition, commandExecutions, materialHash, and storyFilesHash, grouped per commandSetHash, materialHash, and storyFilesHash for duplicate-suite accounting. Blocking unchangedSuiteExecutions counts only per-group duplicate executed terminals at or after TEST entry (facts.testEntryAt, B-f824) plus reused terminals with commandExecutions > 0 in any phase; reviewWindowSuiteExecutions records whole-window per-group duplicates as observable, never-blocking telemetry.',
  },
] as const satisfies readonly ProcessFactRegistryDeclaration[];

export const PROCESS_FACT_REQUIRED_ARTIFACTS = PROCESS_FACT_ARTIFACTS.filter(
  (entry) => entry.artifact && PROCESS_FACT_REQUIRED_ARTIFACT_NAMES.includes(entry.artifact.path as typeof PROCESS_FACT_REQUIRED_ARTIFACT_NAMES[number]),
) as readonly ProcessFactRegistryDeclaration[];

// Lab maintenance is an explicit local integration exception, never Story evidence.
export const PROCESS_FACT_LAB_MAINTENANCE = [{
  name: 'runtime:lab_local_maintenance_integration',
  kind: 'runtime-behavior',
  semantics: ['runtime-behavior', 'validation-result', 'gate-evidence'],
  level: 'L4',
  producer: 'scripts/lab-worktree.mjs',
  consumerGate: 'Lab finish only; never Story REVIEW/TEST/DONE',
  rationale: 'Explicit local finish requires a fresh tool-owned different-vendor CLI audit: at least one configured provider from a vendor different from the developer must pass. Built-ins are OpenAI/Codex and Anthropic/Claude; additional local stdin/JSON adapters are supported. The audit binds the candidate HEAD, main baseline, complete bounded input digest and developer host, and rejects unresolved findings, malformed provider output, failed processes or incomplete cleanup. The bounded input also carries an exact-candidate command measurement projected from authenticated local Lab history only after exit success, no process error, clean checkout and unchanged HEAD have been confirmed. Missing accepted measurements remain null; they are not independent approval. The first accepted matching record stays stable across retry replays. Developer host is pinned at creation from supported host context or an explicit declaration; legacy unpinned records require an explicit implementation-provider declaration. Provider execution holds only the per-Lab lock; main lock reacquisition revalidates branch, HEAD and dirty-state boundaries; it is attribution, not a cryptographic proof of who edited every byte. Schema 3 fences old writers after adoption. Rejected pre-release repair-content digests remain blocked across reopen and regenerated release commits. Inputs preserve exact paths and UTF-8 bytes or fail closed. Audit rejection is not a Story finding/pass. Explicit local finish requires a keyed tool-recorded RED command and fresh committed GREEN; replays after synchronizing main and on the prepared candidate and main. The optional one-Story carry-forward rule accepts only a clean registered REVIEW/TEST worktree with every checklist item done, no open Finding, recomputed material and Story-files hashes, strict authoritative receipt admission for every required intent, a fully executed validation result, and at most five failed commands whose exact executable and argv initially fail with the same exit code on built current main. A supplemental witness may add an exact source-PASS command that newly fails on built main with an explicit marker; invented, duplicate, main-mutating, or source-failing commands are refused. It stores source/evidence/material/Story-files/patch hashes, pass-command trace profiles, and failure-output digests. Finish rebuilds latest main, reruns baseline commands, then requires the built candidate and post-merge main to preserve each latest-main exit code and normalized failure identity. PASS commands whose repository trace intersects latest-main changes are replayed on candidate and post-merge main; incomplete or unknown trace closure fails closed by replaying that command. No .proof-or-stop Story state is imported. Ordinary Lab finish requires clean main; carry-forward alone may preserve non-overlapping pre-existing dirty paths under a content/index fingerprint checked before and after main-side operations, without stash, restore, commit, or copy. The shared main write lock, unchanged HEAD checks, synchronized version helper and fast-forward-only merge protect integration. Cleanup requires post-merge verification and ancestor reachability and never force-deletes. These local records grant no formal Story or signed product-release credentials.',
}] as const satisfies readonly ProcessFactRegistryDeclaration[];

export const PROCESS_FACT_VALIDATION_EXECUTION = [{
  name: 'runtime:quorum_assertion_inventory', kind: 'runtime-behavior',
  semantics: ['runtime-behavior', 'gate-evidence', 'verification-policy'], level: 'L4',
  producer: 'tasks/quorum-submit-smoke',
  producerSourceRefs: ['packages/main/src/tasks/quorum-submit-smoke.ts', 'packages/main/src/tasks/quorum-submit-smoke-case-catalog.ts','packages/main/src/tasks/quorum-submit-smoke-worker.ts','packages/main/src/tasks/quorum-submit-smoke-fixture.ts','packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts','packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts','packages/main/src/tasks/quorum-submit-smoke-pure-cases.ts'],
  consumerGate: 'configured full quorum smoke exit status and complete-suite marker',
  rationale: 'The current main modular coordinator requires the complete 73-case executable inventory and canonical partitions, rejects unresolved or duplicate registrations, and isolates worker fixtures outside the repository. Root configuration retains exactly jobs=2 and a shared Git/common-directory declaration; the executor adds the local plan barrier shared against all explicit writers. Worker receipts and terminal status determine complete success; diagnostic selectors cannot claim complete-suite success. The pre-existing B-e40f inventory, isolation, scheduling and negative controls remain authoritative; historical monolithic Lab measurements do not certify this implementation.',
}, {
  name:'runtime:acceptance_history_checkpoint',kind:'runtime-behavior',semantics:['runtime-behavior','signed-artifact','gate-evidence','verification-policy'],level:'L4',producer:'core/verification-intent-checkpoint',producerSourceRefs:['packages/main/src/core/verification-intent-checkpoint.ts','packages/main/src/core/verification-intent-amendment.ts','packages/main/src/core/store.ts','packages/main/src/handlers/checklist.ts'],consumerGate:'canonical checklist reads, all gate callers and owner-only checkpoint recovery',rationale:'Authorized INIT/PLAN revisions append signed lineage without rewriting history or bypassing field authority. Revisions reopen planning; old gate evidence retains normal freshness checks. A signed write-ahead full checklist checkpoint is anchored to a retained single-parent Git ref using compare-and-swap without moving any branch. Backend-neutral Git reads detect combined projection-history and checkpoint-mirror deletion, including reftable and in-place ref migration. Every authorized canonical write migrates the complete legacy chain and reconciles missing mirrors; contradictory newer mirrors refuse recovery. Owner recovery can rebuild the prior parentless-tip format only from a complete valid signed mirror containing the identical signed anchor record at its generation index. Corrupt mirrors are quarantined with original bytes retained, while any valid newer or conflicting signed mirror still blocks recovery. Inspection is read-only and digest, owner, phase and reason checks precede all repair writes. Every retained checkpoint and amendment signature is verified in a synchronous batch with fresh repository-key reads before and after; no validation cache or caller key is accepted. CAS errors remain typed. It survives packing and normal GC, and restores interrupted projection without rerunning commands. Typed integrity errors propagate instead of becoming empty checklists. The Git signing key and checkpoint metadata remain a local trust boundary, not hostile-host protection.',
}, {
  name: 'runtime:execution_implementation_pin', kind: 'runtime-behavior',
  semantics: ['runtime-behavior', 'workspace-binding', 'verification-policy'],
  level: 'L4', producer: 'core/execution-implementation',
  producerSourceRefs: ['packages/main/src/core/execution-implementation.ts', 'packages/main/src/cli-engine.ts', 'bin/bootstrap-runner.js', 'scripts/build-lock-target.mjs'],
  consumerGate: 'CLI dispatch when an explicit implementation transport pin is required; automatic checklist execution and canonical import implementation binding',
  rationale: 'An opt-in host transport pin compares actual implementation, bin bootstrap helpers, the build-lock helper and dependency bytes plus Node before dispatch; package version equality is not an implementation proof. Missing required pins and mismatches refuse. Unpinned invocations retain compatibility and are not claimed pinned. Checklist receipts automatically bind actual implementation bytes; same-version drift executes anew, mutation during a command cannot publish a receipt, and canonical import rechecks the current implementation.',
}, {
  name: 'runtime:headless_baseline_production', kind: 'runtime-behavior',
  semantics: ['runtime-behavior', 'validation-result', 'signed-artifact', 'workspace-binding'],
  level: 'L4', producer: 'handlers/story-aware-validation',
  producerSourceRefs: ['packages/main/src/handlers/story-aware-validation.ts', 'packages/main/src/handlers/verifier.ts'],
  consumerGate: 'Canonical full baseline production; ordinary unscoped validation retains actual command outcome',
  rationale: 'Target-aware producers and consumers bind the same async-local signing root, including concurrent invocations; explicit signing roots retain precedence. No resolvable HEAD means no reusable Git epoch: skip baseline production before signing and log the reason. Command failure remains failure; Story authority and existing committed baseline checks remain unchanged.',
}, {
  name: 'runtime:validation_machine_reservation_delegation', kind: 'runtime-behavior',
  semantics: ['runtime-behavior', 'verification-policy', 'workspace-binding'],
  level: 'L4', producer: 'core/validation-reservation-delegation',
  producerSourceRefs: ['packages/main/src/core/validation-reservation-delegation.ts', 'packages/main/src/core/validation-execution-lock.ts', 'packages/main/src/core/validation-executor.ts'],
  consumerGate: 'Actual nested validation execution admission and machine reservation release',
  rationale: 'A live admitted machine owner alone issues ephemeral subject-bound resource loans to kernel-observed controlled descendants. Inherited descriptor identity anchors the issuer; environment locators grant nothing. Exact active invocation ancestry and claim subsets permit nesting while conflicting siblings serialize and foreign unclassified commands retain global exclusion. Pending or live detached descendants prevent successful release and stale reclaim. No Story or reviewer authority is conveyed.',
}, {
  name: 'runtime:shared_validation_execution', kind: 'runtime-behavior',
  semantics: ['runtime-behavior', 'validation-result', 'signed-artifact', 'freshness-policy', 'workspace-binding'],
  level: 'L4', producer: 'core/shared-validation-execution',
  producerSourceRefs: ['packages/main/src/core/shared-validation-execution.ts', 'packages/main/src/core/validation-execution-inputs.ts', 'packages/main/src/handlers/verifier.ts', 'packages/main/src/core/causal-evidence.ts', 'packages/main/src/core/validation-execution-lock.ts', 'packages/main/src/core/story-owner-lease.ts', 'packages/main/src/handlers/checklist.ts', 'packages/main/src/handlers/done-required-validation.ts', 'packages/main/src/core/auto-commit-metadata.ts'],
  consumerGate: 'Default Story routine validate and explicit full validate require PRE_CERT, including full combined with focus; focused preparation and isolated CLI gates remain available. validate and done_required_validate retain their independent acceptance and build-proof predicates; exact verified CAS output paths are excluded from workspace input comparison, while invalid receipts, unknown files and explicit input bytes remain checked',
  rationale: 'Measured cost hints are execution-only; declared directory inputs bind fresh complete trees; consumer-local executionDecision never grants authority. Certification begin and cancel verify both registered active-identity boundaries before store access; an exit-zero semantic non-PASS remains fail through coverage decoration. Explicit exact-inputs reuse consumes signed causal PASS receipts only with current material, clean workspace, environment, executable and policy identity. Complete executor capture supplies the receipt digest; output exceeding the bounded selector window is partial and never reusable. The v2 capture identity refuses prior display-derived receipts. Forbidden reuse and build proof always execute. Canonical provider and liveness core variants schedule every former nested member independently, including the fixed seven-member liveness union. The registered whole-command-array static guard rejects unresolved nested launches and stale reviewed exceptions bound to command configuration, exact call source and traversed caller/helper/package dependencies; paired property controls remain explicit exceptions. Provider F-181 retains a real sanitized child CLI mutation and an unsanitized negative control; standalone pinned invocations retain their combined proof and selector. Declared nonconflicting resources share a machine admission barrier, including explicitly classified empty full-suite footprints. Missing or empty validation claims acquire globally exclusive same-user machine capacity; cancellation and deadline refusal launch no child. Ancestor conflicts fail closed rather than waiting on their own caller. Same-owner generation renewal is atomic with takeover and never acquires a missing lease. Reuse retains original execution attribution. DONE-required validates current PRE_CERT admission without consuming or committing the routine execution allocation; explicitly shared commands require a clean workspace, and only DONE-specific evidence belongs to its metadata writer. Dirty source and adjacent staged changes remain untrusted. Explicit exact-inputs reuse consumes signed causal PASS receipts only with current material, clean workspace, environment, executable, loaded implementation digest and policy identity. The actual loaded tool package supplies the tool version; target-project package versions cannot substitute for it. The explicit validate.sharedExecution option enables execution sharing independently of dynamic selection mode, while per-command exclusions still apply. Forbidden reuse and build proof always execute. Declared nonconflicting resources may share capacity; missing claims stay exclusive. Same-owner generation renewal is atomic with takeover and never acquires a missing lease. Reuse retains original execution attribution. Single and batch checklist evidence commands renew the existing owner generation through actual command execution and canonical publication, preserving zero-command receipt import recovery. Only a signed pending-publication capability binds the exact pre-write checklist, owner generation, request and current physical execution identity to an unpublished V5 bundle and causal receipt. Canonical publication retires that capability; a later ordinary request still executes a new observation. Signature, subject, output and current implementation checks precede recovery; recovery never relaxes selector or freshness checks.',
}] as const satisfies readonly ProcessFactRegistryDeclaration[];

export const PROCESS_FACT_EVIDENCE_HASH_INPUTS = [{
  name:'runtime:causal_complete_selector_output',kind:'runtime-behavior',semantics:['runtime-behavior','signed-artifact','gate-evidence','verification-policy'],level:'L4',producer:'core/causal-evidence',producerSourceRefs:['packages/main/src/core/causal-evidence.ts','packages/main/src/core/store.ts','packages/main/src/handlers/checklist.ts'],consumerGate:'Fresh and reused verification execution selector verdicts',rationale:'Complete redacted output is content-addressed and bound by the signed receipt, separately from bounded display probes. Independent processes verify its digest and length before selecting; missing or changed bytes refuse without rerunning or rewriting evidence. Legacy complete plain probes remain compatible; legacy truncated or redacted display text refuses selector authority. Existing secret redaction is preserved; NUL matching boundaries cannot synthesize selector text. Complete objects are bounded to 1 MiB, with a non-reusable signed selector witness for larger output or legacy stores. Exit-only checks do not read selector objects and retain reuse when durable output fits the bound. Completed output and receipt publication each retry at most twice without rerunning the command; permanent storage faults refuse. Late batch subscribers join the active retry; single-selector fallback witnesses never decide another selector.',
}, {
  name: 'runtime:evidence_hash_input_boundary', kind: 'runtime-behavior',
  semantics: ['runtime-behavior', 'freshness-policy', 'workspace-binding', 'gate-evidence'],
  level: 'L4', producer: 'core/material-path-policy and core/story-aware-validation',
  producerSourceRefs: ['packages/main/src/core/material-path-policy.ts', 'packages/main/src/core/story-aware-validation.ts', 'packages/main/src/core/evidence-freshness.ts'],
  consumerGate: 'Shared material and Story hashes used by review, validation and evidence freshness consumers',
  rationale: 'Store objects/sha256, refs/by-id and ledger/observed.jsonl are process outputs excluded from material inputs, not disposable runtime artifacts. Unknown evidence paths and policy remain material. Output digest and subject bindings require independent consumer verification; hash stability grants no artifact acceptance. NUL-delimited Git paths retain literal names and target blobs; missing objects fail closed. Existing evidence is never rewritten or automatically re-attested after this correction.',
}] as const satisfies readonly ProcessFactRegistryDeclaration[];

export const PROCESS_FACT_MANAGED_SUPERVISION = [
  {
    name: 'managed-run-owner-ui', kind: 'execution-status', level: 'L0',
    semantics: ['execution-evidence', 'schema-contract'],
    producer: 'core/managed-run-dashboard',
    producerSourceRefs: ['packages/main/src/core/managed-run-dashboard.ts', 'packages/main/src/core/managed-host-run.ts'],
    consumerSourceRefs: ['packages/main/src/handlers/graph.ts', 'packages/graph/src/core/app.ts', 'packages/graph/src/shells/web/app.js'],
    consumerGate: 'Read-only owner/UI observation; no lifecycle or replacement authority',
    rationale: 'The existing Graph status poll reads managed runtime independently of Story hashes. Only validated public stage, provider output progress, historical ETA and terminal identity are exposed. Corrupt records and bounded observation failures are explicit diagnostics. The first status snapshot primes a silent history baseline; late historical records remain silent. New terminal notifications are aggregated per poll, limited to three visible notices and auto-dismiss after eight seconds. Visible terminal notifications are deduplicated in browser storage by project, run and terminal identity, with in-memory fallback. Hidden tabs do not acknowledge delivery. Heartbeat is not provider progress; observation never signals processes or renews leases. These operational identities are not new signed review evidence or product release approval.',
  },
  {
    name: 'managed-terminal-supervision',
    kind: 'execution-status',
    semantics: ['execution-evidence', 'atomic-persistence', 'schema-contract'],
    level: 'L3',
    producer: 'core/managed-host-run + cli/managed-host-run-supervisor',
    consumerGate: 'managed_review_evidence_import successful-terminal intake only',
    rationale: 'An independent detached supervisor is ready before provider-worker launch. Worker death triggers fingerprint-bound provider cleanup and one failed terminal without status polling. A continuously missing, zombie, unverifiable or changed provider identity produces a bounded actionable diagnostic and semantic generation change, never replacement authority. Provider close is persisted before asynchronous result cleanup and is distinct from worker heartbeat and provider output progress. Status and aggregate wait are read-only observations, including interrupted journal diagnostics; explicit recovery owns transaction replay and terminal cleanup. Existing launch fencing and exclusive terminal digests remain authoritative; an orphan failure cannot grant review PASS or replacement safety without proven reap.',
  },
] as const satisfies readonly ProcessFactRegistryDeclaration[];

export const PROCESS_FACT_REGISTRY: readonly ProcessFactRegistryEntry[] = ([
  {
    name: 'runtime:full_task_scope_authority', kind: 'runtime-behavior', level: 'L4',
    semantics: ['schema-contract', 'gate-evidence'], gateEvidence: true,
    producer: 'core/prompt-contracts',
    producerSourceRefs: ['packages/main/src/core/prompt-contracts.ts', 'packages/main/src/core/scope-inventory-budget.ts'],
    consumerSourceRefs: ['packages/main/src/core/prompt-envelope.ts', 'packages/main/src/core/review-run.ts'],
    consumerGate: 'Full task scope validation before signed reviewer context consumption',
    rationale: 'Exact authority inventory shape and capacity are mechanically validated; changes to this validator or its source dependencies force full validation.',
  },
  {
    name: 'runtime:managed_review_readonly_build', kind: 'runtime-behavior', level: 'L4',
    semantics: ['runtime-behavior', 'workspace-binding', 'freshness-policy', 'gate-evidence'],
    producer: 'core/managed-review-lane + core/managed-host-run',
    producerSourceRefs: ['packages/main/src/core/managed-review-lane.ts', 'packages/main/src/core/managed-review-lane-build.mjs', 'packages/main/src/core/managed-review-lane-policy.ts', 'packages/main/src/core/managed-review-provider-state.ts'],
    consumerSourceRefs: ['packages/main/src/core/managed-host-run.ts', 'packages/main/src/core/host-run.ts', 'packages/main/src/core/managed-review-readonly.ts', 'packages/main/src/handlers/cross-host-review.ts'],
    consumerGate: 'Opted-in managed reviewer and fresh cross-host reviewer startup and successful terminal consumption',
    rationale: 'Fresh cross-host runs seal the same lane on their registered detached snapshot, retaining the cross-host profile and controller cleanup ownership. Legacy resumed specs retain their original execution facts. Trusted preflight checks the selected credential input before environment redaction and before snapshot creation. Provider state capture holds bounded no-follow file bytes in a controller-local opaque capability; each lane materializes those captured bytes into its own private directory without rereading mutable source credentials. An explicit registered project adapter seals readonly source and independent build-source/output/temp/cache paths in the existing owner-bound spec. Unsupported requested projects/platforms refuse before provider startup; unconfigured projects retain existing behavior. Real platform probes and the actual provider wrapper deny writes outside declared lane outputs. Initial source and compiled output digests are verified before execution and before successful proposal intake. Build output writes are permitted locally but drift never passes as the sealed initial build. Trusted provider attestation and proposal signing remain outside the sandbox; no provider result or PASS is manufactured by the build.',
  },

  {
    name: 'runtime:reviewer_batch_admission', kind: 'runtime-behavior', level: 'L4',
    semantics: ['runtime-behavior', 'host-readiness', 'freshness-policy', 'blocker-state'],
    producer: 'handlers/reviewer-batch-admit + core/reviewer-batch-producer',
    producerSourceRefs: ['packages/main/src/handlers/reviewer-batch-admit.ts', 'packages/main/src/core/reviewer-batch-producer.ts', 'packages/main/src/core/reviewer-batch-subject.ts', 'packages/main/src/core/reviewer-batch-admission.ts', 'packages/main/src/core/managed-execution-identity-key.ts', 'packages/main/src/core/managed-execution-input-identity.ts'],
    consumerSourceRefs: ['packages/main/src/core/managed-launch-admission.ts', 'packages/main/src/core/managed-host-run.ts', 'packages/main/src/core/acceptance-amendment-journal.ts', 'packages/main/src/handlers/cross-host-review.ts'],
    consumerGate: 'Fresh configured readonly managed review before scratch/build and worker provider launch; existing run recovery does not reprobe',
    rationale: 'A read-only subject helper checks the current signed OPEN review epoch, committed material cutoff, scope, candidate semantics and complete explicit native/managed roster. The ordinary roster remains the exact required-lane set; after a valid signed inventory-completeness critic ReviewRun binds the same epoch, round and cutoff, its dedicated critic lane joins a distinct admission subject so the mechanically required critic is runnable without granting topology authority. Trusted subject and exact roster inputs select one signed generation. Concurrent callers share one probe per host before any admitted verdict. Unchanged failures, expired readiness and interrupted controllers do not automatically reprobe. Read-only queries verify without writing, and cancelled waiters launch no probe. A separate controller-local HMAC input helper binds full effective environment, captured file credentials, physical native executable and runtime/profile identities without exporting secrets. Read-only key loading creates nothing; unsupported interpreter chains fail closed. A trusted producer can persist a captured refreshed provider seed with keyed integrity and exact host/subject/generation binding; cross-process read-only consumers receive opaque snapshots and create independent lane caches. Seed storage issues no READY decision. The owner-only REVIEW producer supplies a complete explicit roster; acceptance and cross-host controllers bind separate verified singleton subjects. Fresh configured readonly launches require admission before scratch or build and seal its binding plus complete base environment. Workers reverify signed admission, executable/runtime identity, actual PATH resolution and the materialized refreshed seed before provider launch. Explicit retries name the failed or expired prior generation; concurrent duplicates reuse one successor. A signed reservation binds pre-expiry consumption to one run and its finite deadline; it cannot restore a revoked or superseded generation. Actual provider authentication failure signs a current-generation revocation; its durable record blocks queued launches even across active-record publication interruption, and late old-generation failures cannot revoke successors. These operational records are not reviewer PASS or product completion evidence.',
  },
  {
    name: 'runtime:machine_provider_admission', kind: 'runtime-behavior', level: 'L4',
    semantics: ['runtime-behavior', 'blocker-state'], producer: 'core/provider-process-admission',
    producerSourceRefs: ['packages/main/src/core/provider-process-admission.ts', 'packages/main/src/core/provider-process-registry.ts'],
    consumerSourceRefs: ['packages/main/src/core/host-run.ts', 'packages/main/src/core/proof-or-stop-dispatch.ts', 'packages/main/src/core/planned-steps-executor.ts', 'packages/main/src/providers/supervised-process.ts', 'packages/main/src/providers/supervised-process-worker.ts', 'packages/main/src/core/host-execution-readiness.ts'],
    consumerGate: 'Every admission adapter acquisition requires both project capacity and canonical OS-user machine capacity before launch',
    rationale: 'Project configuration cannot raise the machine pool. Machine refusal releases the local reservation. Identity-aware launchers transfer both tokens to provider groups; release attempts both and unsafe provider results retain capacity. Synchronous launchers transfer both tokens before provider execution and release only after an independent control result and observed group exit; unknown cleanup forbids retry. Capability readiness probes use that same synchronous supervisor before returning READY, retaining auth/timeout classification and refusing unproven cleanup. Ordinary same-group descendants are covered, not daemon process-group escape.',
  },
  {
    name: 'runtime:story_scope_budget', kind: 'runtime-behavior', level: 'L4',
    semantics: ['runtime-behavior', 'blocker-state', 'gate-evidence'],
    producer: 'core/story-scope-budget',
    producerSourceRefs: ['packages/main/src/core/story-scope-budget.ts', 'packages/main/src/core/story-scope-budget-decisions.ts', 'packages/main/src/core/story-scope-decomposition.ts', 'packages/main/src/core/story-scope-budget-legacy.ts'],
    consumerSourceRefs: ['packages/main/src/core/machine.ts', 'packages/main/src/core/acceptance-amendment-journal.ts', 'packages/main/src/handlers/story-review.ts'],
    consumerGate: 'Every DEV entry and additive acceptance application consume the same configured semantic budget, including APPLYING recovery',
    rationale: 'Explicit responsibility mappings, registered process facts and commands, topology nodes and edges, canonical validation command IDs and semantic DEV delta determine scope cost. Legacy command labels must resolve uniquely; deleted or ambiguous command mappings fail closed. Files are not the budget unit. Unknown enforced mappings and malformed opted-in policy block; rollback cannot swallow the budget failure. Read-only diagnostic output cannot grant scope approval. Live declared decompositions require complete real child assignments, independent budgets and acceptance mappings; they never exempt parent implementation scope or prove child delivery. Unconfigured legacy projects retain compatibility. Explicit project-governance manifests preserve only exact versioned subjects captured in DEV/REVIEW/TEST with the same creation identity; read-only snapshots are not signed approvals. Reentry may consume the exact capture, but changed current, proposed or base subjects cannot. Other phase guards, filesystem safety, malformed policy and incomplete decomposition remain blocking.',
  },
  {
    factId: 'runtime:registry_component_mapping_projection',
    name: 'runtime:registry_component_mapping_projection',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'schema-contract', 'normalization-policy', 'gate-evidence'],
    level: 'L4',
    componentId: 'P0m',
    serializationBoundaryId: 'registry-component-mapping-projection',
    paths: [
      'packages/main/package.json',
      'packages/main/src/core/process-fact-registry.ts',
      'packages/main/src/core/runtime-fact-registry.ts',
      'packages/main/tests/red/red-repro-first-p0m-component-mapping.mjs',
      'proof-or-stop.config.json',
      'scripts/verify-process-fact-contract.mjs',
      'scripts/verify-runtime-fact-contract.mjs',
    ],
    producer: 'core/process-fact-registry + core/runtime-fact-registry',
    consumerGate: 'P1 classification and P2r bootstrap component manifest projection',
    rationale: 'P0m owns explicit complete registry mappings and deterministic whole-registry and component-filtered projections. Consumers fail closed with registry-component-mapping-unavailable and never infer paths or components from producer, producerSourceRefs, consumerSourceRefs, or artifact.path.',
  },
  ...PROCESS_FACT_MANAGED_SUPERVISION,
  {
    name: 'runtime:review_convergence_blocker_progress', kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'blocker-state', 'gate-evidence'], level: 'L4',
    producer: 'core/convergence-progress-gate',
    producerSourceRefs: ['packages/main/src/core/convergence-progress-gate.ts', 'packages/main/src/core/convergence-progress-journal.ts'],
    consumerGate: 'CLI enforceConvergenceBreakerGate and machine canMintReviewRoundGuard through evaluateReviewMintStallAdjudication',
    rationale: 'Both hard entries consume the same signed completed-epoch progress boundary. Legacy advance, takeover, run and round counters remain diagnostics, including historical count-only freezes. Two independently completed stagnant epochs request a human decision; actual finding or coverage reduction can release the stall. Unknown/corrupt new progress authority is an integrity block, never a provider-failure design conclusion. story_resume appends a signed human decision after interactive acknowledgement; compatibility stall_resolution_set does not clear this gate.',
  },
  ...PROCESS_FACT_EVIDENCE_HASH_INPUTS,
  ...PROCESS_FACT_VALIDATION_EXECUTION,
  ...PROCESS_FACT_LAB_MAINTENANCE,
  ...COMMAND_PROCESS_FACTS,
  ...PROCESS_FACT_REVIEWER_LANES,
  ...PROCESS_FACT_ARTIFACTS,
  ...PROCESS_FACT_FLOW_POLICIES,
  ...PROCESS_FACT_DONE_PREFLIGHT_CONSUMERS,
  ...PROCESS_FACT_CLOSEOUT_TELEMETRY,
] satisfies readonly ProcessFactRegistryDeclaration[])
  .map(entry => declareProcessFactMapping(entry));

export const PROCESS_FACT_REGISTRY_BY_NAME: Record<string, ProcessFactRegistryEntry> = Object.fromEntries(
  PROCESS_FACT_REGISTRY.map((entry) => [entry.name, entry]),
) as Record<string, ProcessFactRegistryEntry>;

export function getProcessFactRegistryEntry(name: string): ProcessFactRegistryEntry | undefined {
  return PROCESS_FACT_REGISTRY_BY_NAME[name];
}

/**
 * Return paths whose process-fact declaration explicitly requires full
 * repository validation. Accept an unknown-shaped list so a consumer cannot
 * crash while projecting a stale or independently decoded registry snapshot;
 * malformed entries contribute no validation authority.
 */
export function collectRepositoryFullProcessFactPaths(
  entries: readonly unknown[] = PROCESS_FACT_REGISTRY,
): { paths: string[]; rejectedEntryCount: number; floorOwnerIds: string[] } {
  const paths = new Set<string>();
  const floorOwnerIds = new Set<string>();
  let rejectedEntryCount = 0;
  for (const candidate of entries) {
    if (!candidate || typeof candidate !== 'object') {
      rejectedEntryCount += 1;
      continue;
    }
    const entry = candidate as {
      factId?: unknown;
      name?: unknown;
      level?: unknown;
      validationTierFloor?: unknown;
      paths?: unknown;
    };
    if (entry.validationTierFloor === undefined) continue;
    const floorOwnerId = typeof entry.factId === 'string' && entry.factId.trim() !== ''
      ? entry.factId.trim()
      : typeof entry.name === 'string' && entry.name.trim() !== ''
        ? entry.name.trim()
        : '';
    if (
      entry.validationTierFloor !== VALIDATION_TIER_FLOOR
      || entry.level !== 'L4'
      || !Array.isArray(entry.paths)
      || entry.paths.length === 0
      || floorOwnerId === ''
    ) {
      rejectedEntryCount += 1;
      continue;
    }
    let rejectedLeaf = false;
    let acceptedLeaf = false;
    for (const path of entry.paths) {
      try {
        paths.add(normalizeProcessFactPath(path, 'process-non-total'));
        acceptedLeaf = true;
      } catch {
        rejectedLeaf = true;
      }
    }
    if (acceptedLeaf) floorOwnerIds.add(floorOwnerId);
    if (rejectedLeaf) rejectedEntryCount += 1;
  }
  return {
    paths: [...paths],
    rejectedEntryCount,
    floorOwnerIds: [...floorOwnerIds].sort(compareUtf8),
  };
}

export function hasProcessFactSemantic(name: string, semantic: ProcessFactSemantic): boolean {
  return PROCESS_FACT_REGISTRY_BY_NAME[name]?.semantics.includes(semantic) ?? false;
}

// Review-maintenance reader diagnostics distinguish ordinary negative ancestry
// and missing snapshots from unexpected failures. Convergence prefix retention
// binds required completed/revoked arrays and optional human decisions to the
// persisted journal schema. The launch seal comparison, not an optional legacy
// expected digest property, remains the managed review consumption authority.

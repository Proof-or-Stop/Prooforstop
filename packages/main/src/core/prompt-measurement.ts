import {
  CURRENT_PROMPT_IDENTITIES,
  PROMPT_CONTRACT_ALGORITHMS,
  PROMPT_MEASUREMENT_SCHEMA,
  RUNTIME_CONTRACT_SCHEMA,
  canonicalJsonStringify,
  domainSeparatedDigest,
  estimatePromptTokens,
  measurePromptRepetition,
  promptLogicalLines,
  promptUtf8Bytes,
  type PromptInputLayerAvailability,
  type PromptMeasurementRecord,
  type PromptRepetitionMeasurement,
  type RuntimeContract,
  validatePromptMeasurementRecord,
  validateRuntimeContract,
} from './prompt-contracts.js';
import {
  ACTIVE_MODULAR_REVIEWER_ROLE_IDS,
  PROMPT_ENVELOPE_ROLLOUT_VERSION,
  PROMPT_ROLE_CONTRACTS,
  PROMPT_ROLE_CONTRACT_REGISTRY_VERSION,
  promptRoleContractRegistryDigest,
  resolvePromptRoleBody,
  validatePromptRoleContracts,
} from './prompt-role-contract-registry.js';
import { readPromptRegistry } from './prompt-registry.js';

export const PROMPT_MEASUREMENT_REPORT_SCHEMA_VERSION = 'proof-or-stop.prompt-measurement-report.v1';
export const PROMPT_MEASUREMENT_BASELINE_PATH = 'docs/requirements/baselines/role-prompt-measurement-baseline.json';

const KNOWN_DISPATCH_UNAVAILABLE_REASON =
  'No Story dispatch was performed; launcher/tool/context input is not observable in the no-Story baseline.';
const PROVIDER_INPUT_UNAVAILABLE_REASON =
  'No provider call was performed; provider system wrappers, cache accounting, and processed input are unobservable.';

const BASELINE_PROMPT_ENVELOPE_ROLLOUT = Object.freeze({
  version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
  roles: Object.freeze(Object.fromEntries(
    ACTIVE_MODULAR_REVIEWER_ROLE_IDS.map(roleId => [roleId, 'full-envelope']),
  )),
});

const runtimeSemanticValue = {
  schemaVersion: CURRENT_PROMPT_IDENTITIES.runtimeContract,
  lifecycleVersion: 'proof-or-stop.lifecycle.init-to-done.v2',
  ownershipVersion: 'proof-or-stop.story-owner-boundaries.v1',
  evidenceVersion: 'proof-or-stop.signed-process-facts.v1',
};

const runtimeCompactText = [
  'Lifecycle: INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE.',
  'Only the Story owner/implementer writes implementation; independent reviewers write signed findings or passes.',
  'Story and fixture facts use Proof-or-Stop CLI paths; gate evidence is structured and fail-closed.',
  'Never fabricate host, human, provider, receipt, or Authority evidence.',
].join('\n');

export const BASELINE_RUNTIME_CONTRACT: RuntimeContract = Object.freeze({
  ...runtimeSemanticValue,
  compactText: runtimeCompactText,
  semanticDigest: domainSeparatedDigest('runtime-contract.semantic.v1', runtimeSemanticValue),
  renderDigest: domainSeparatedDigest('runtime-contract.render.v1', runtimeCompactText),
});
validateRuntimeContract(BASELINE_RUNTIME_CONTRACT);

export interface PromptMeasurementAggregate {
  roleCount: number;
  activeRoleCount: number;
  compatibilityRoleCount: number;
  retiredRoleCount: number;
  bytes: number;
  lines: number;
  estimatedTokens: number;
  repetition: PromptRepetitionMeasurement;
  assembledPromptTokens: PromptInputLayerAvailability;
  knownDispatchInputTokens: PromptInputLayerAvailability;
  providerProcessedInputTokens: PromptInputLayerAvailability;
}

export interface PromptMeasurementReport {
  schemaVersion: typeof PROMPT_MEASUREMENT_REPORT_SCHEMA_VERSION;
  algorithmVersions: typeof PROMPT_CONTRACT_ALGORITHMS;
  roleContractRegistryVersion: typeof PROMPT_ROLE_CONTRACT_REGISTRY_VERSION;
  roleContractRegistryDigest: string;
  runtimeContract: RuntimeContract;
  inputLayerMeanings: {
    assembledPromptTokens: string;
    knownDispatchInputTokens: string;
    providerProcessedInputTokens: string;
  };
  records: PromptMeasurementRecord[];
  aggregate: PromptMeasurementAggregate;
  reportDigest: string;
}

function unavailable(reason: string): PromptInputLayerAvailability {
  return { availability: 'unavailable', reason };
}

export function generatePromptMeasurementReport(): PromptMeasurementReport {
  const snapshot = readPromptRegistry();
  const currentRoleIds = snapshot.agents.map(entry => entry.agentId);
  validatePromptRoleContracts(PROMPT_ROLE_CONTRACTS, currentRoleIds);
  if (snapshot.agents.length !== PROMPT_ROLE_CONTRACTS.length) {
    throw new Error('prompt measurement role set differs from lifecycle contract registry');
  }
  const contractById = new Map(PROMPT_ROLE_CONTRACTS.map(contract => [contract.roleId, contract]));
  const combinedPrompts: string[] = [];
  const records = snapshot.agents.map(entry => {
    const roleContract = contractById.get(entry.agentId);
    if (!roleContract) throw new Error(`missing role contract for ${entry.agentId}`);
    const text = resolvePromptRoleBody(
      entry.agentId,
      BASELINE_PROMPT_ENVELOPE_ROLLOUT,
      snapshot,
    ).body;
    combinedPrompts.push(text);
    const estimatedTokens = estimatePromptTokens(text);
    const record: PromptMeasurementRecord = {
      schemaVersion: CURRENT_PROMPT_IDENTITIES.measurement,
      roleId: entry.agentId,
      runtimeContractVersion: BASELINE_RUNTIME_CONTRACT.schemaVersion,
      runtimeSemanticDigest: BASELINE_RUNTIME_CONTRACT.semanticDigest,
      runtimeRenderDigest: BASELINE_RUNTIME_CONTRACT.renderDigest,
      roleContractVersion: roleContract.schemaVersion,
      roleSemanticDigest: roleContract.semanticDigest,
      roleRenderDigest: roleContract.renderDigest,
      assembledPromptDigest: domainSeparatedDigest('assembled-prompt.raw-utf8.v1', text),
      bytes: promptUtf8Bytes(text),
      lines: promptLogicalLines(text),
      estimatedTokens,
      tokenEstimatorVersion: PROMPT_CONTRACT_ALGORITHMS.tokenEstimator,
      repetition: measurePromptRepetition(text),
      assembledPromptTokens: {
        availability: 'available',
        tokens: estimatedTokens,
        source: 'selected local package role body',
      },
      knownDispatchInputTokens: unavailable(KNOWN_DISPATCH_UNAVAILABLE_REASON),
      providerProcessedInputTokens: unavailable(PROVIDER_INPUT_UNAVAILABLE_REASON),
    };
    validatePromptMeasurementRecord(record);
    return record;
  });

  if (new Set(records.map(record => record.roleId)).size !== 18 || records.length !== 18) {
    throw new Error(`prompt measurement requires exactly 18 unique roles, got ${records.length}`);
  }

  const aggregateEstimatedTokens = records.reduce((sum, record) => sum + record.estimatedTokens, 0);
  const aggregate: PromptMeasurementAggregate = {
    roleCount: records.length,
    activeRoleCount: PROMPT_ROLE_CONTRACTS.filter(contract => contract.status === 'active').length,
    compatibilityRoleCount: PROMPT_ROLE_CONTRACTS.filter(contract => contract.status === 'compatibility').length,
    retiredRoleCount: PROMPT_ROLE_CONTRACTS.filter(contract => contract.status === 'retired').length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    lines: records.reduce((sum, record) => sum + record.lines, 0),
    estimatedTokens: aggregateEstimatedTokens,
    repetition: measurePromptRepetition(combinedPrompts.join('\n')),
    assembledPromptTokens: {
      availability: 'available',
      tokens: aggregateEstimatedTokens,
      source: 'sum of selected local package role bodies',
    },
    knownDispatchInputTokens: unavailable(KNOWN_DISPATCH_UNAVAILABLE_REASON),
    providerProcessedInputTokens: unavailable(PROVIDER_INPUT_UNAVAILABLE_REASON),
  };

  const reportWithoutDigest = {
    schemaVersion: PROMPT_MEASUREMENT_REPORT_SCHEMA_VERSION as typeof PROMPT_MEASUREMENT_REPORT_SCHEMA_VERSION,
    algorithmVersions: PROMPT_CONTRACT_ALGORITHMS,
    roleContractRegistryVersion: PROMPT_ROLE_CONTRACT_REGISTRY_VERSION as typeof PROMPT_ROLE_CONTRACT_REGISTRY_VERSION,
    roleContractRegistryDigest: promptRoleContractRegistryDigest(PROMPT_ROLE_CONTRACTS),
    runtimeContract: BASELINE_RUNTIME_CONTRACT,
    inputLayerMeanings: {
      assembledPromptTokens: 'Tokens estimated from the exact locally observable role body selected by the approved rollout.',
      knownDispatchInputTokens: 'Tokens in locally observable launcher, tool, and task-context input when an actual dispatch records them.',
      providerProcessedInputTokens: 'Tokens reported by the provider after hidden wrappers and cache behavior, when available.',
    },
    records,
    aggregate,
  };
  return {
    ...reportWithoutDigest,
    reportDigest: domainSeparatedDigest('prompt-measurement-report.v1', reportWithoutDigest),
  };
}

export function canonicalPromptMeasurementReportJson(report = generatePromptMeasurementReport()): string {
  return canonicalJsonStringify(report) + '\n';
}

export function verifyPromptMeasurementReport(value: unknown): asserts value is PromptMeasurementReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('prompt measurement report must be an object');
  const report = value as PromptMeasurementReport;
  if (report.schemaVersion !== PROMPT_MEASUREMENT_REPORT_SCHEMA_VERSION) throw new Error('unsupported prompt measurement report schema');
  if (!Array.isArray(report.records) || report.records.length !== 18) throw new Error('prompt measurement report must contain 18 records');
  for (const record of report.records) validatePromptMeasurementRecord(record);
  const recomputed = generatePromptMeasurementReport();
  if (canonicalJsonStringify(report) !== canonicalJsonStringify(recomputed)) {
    throw new Error('prompt measurement report does not match current deterministic inputs');
  }
}

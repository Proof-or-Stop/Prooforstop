import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  BYTES_CHARS_ESTIMATOR_NAME,
  BYTES_CHARS_ESTIMATOR_UNIT,
  BYTES_CHARS_ESTIMATOR_VERSION,
  bytesCharsEstimator,
} from './usage-ledger/estimate.js';

export const PROMPT_CONTRACT_ALGORITHMS = Object.freeze({
  canonicalSerialization: 'proofbound.canonical-json.code-point-keys.v1',
  digest: 'sha256.domain-separated-utf8.v1',
  bytes: 'utf8-bytes.v1',
  lines: 'lf-logical-lines.v1',
  tokenEstimator: `${BYTES_CHARS_ESTIMATOR_NAME}.v${BYTES_CHARS_ESTIMATOR_VERSION}.${BYTES_CHARS_ESTIMATOR_UNIT}`,
  repetition: 'normalized-five-token-shingles.v1',
});

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

export type PromptInputLayerAvailability =
  | { availability: 'available'; tokens: number; source: string }
  | { availability: 'unavailable'; reason: string };

export interface RuntimeContract {
  schemaVersion: 'proofbound.agent-runtime.v1';
  lifecycleVersion: string;
  ownershipVersion: string;
  evidenceVersion: string;
  compactText: string;
  semanticDigest: string;
  renderDigest: string;
}

export type RoleLifecycleStatus = 'active' | 'compatibility' | 'retired';

export interface RoleContract {
  schemaVersion: 'proofbound.role-contract.v1';
  roleId: string;
  status: RoleLifecycleStatus;
  replacementAgentType?: string;
  migrationHint?: string;
  defaultDispatch: boolean;
  responsibility: string;
  requiredInputIds: string[];
  requiredCheckIds: string[];
  allowedCommandIds: string[];
  forbiddenActionIds: string[];
  requiredOutputIds: string[];
  stopConditionCodes: string[];
  semanticDigest: string;
  renderDigest: string;
}

export interface PromptRepetitionMeasurement {
  algorithmVersion: typeof PROMPT_CONTRACT_ALGORITHMS.repetition;
  shingleSize: 5;
  tokenCount: number;
  shingleCount: number;
  repeatedShingleCount: number;
  ratio: number;
}

export interface PromptMeasurementRecord {
  schemaVersion: 'proofbound.prompt-measurement.v1';
  roleId: string;
  runtimeContractVersion: string;
  runtimeSemanticDigest: string;
  runtimeRenderDigest: string;
  roleContractVersion: string;
  roleSemanticDigest: string;
  roleRenderDigest: string;
  assembledPromptDigest: string;
  bytes: number;
  lines: number;
  estimatedTokens: number;
  tokenEstimatorVersion: string;
  repetition: PromptRepetitionMeasurement;
  assembledPromptTokens: PromptInputLayerAvailability;
  knownDispatchInputTokens: PromptInputLayerAvailability;
  providerProcessedInputTokens: PromptInputLayerAvailability;
}

export interface KnownExecutionEnvironment {
  schemaVersion: 'proofbound.known-execution-environment.v1';
  nodeVersion: string;
  platform: string;
  architecture: string;
  cliVersion: string;
  source: 'trusted-local-runtime';
}

export interface FullTaskContext {
  schemaVersion: 'proofbound.full-task-context.v1';
  storyId: string;
  title: string;
  description: string;
  phase: string;
  priority: string;
  checklist: Array<{
    id: string;
    title: string;
    status: string;
    context?: string;
    userSees?: string;
  }>;
  headHash: string;
  materialHash?: string;
  storyFilesHash?: string;
  scopeContractDigest?: string;
}

export interface PromptEnvelope {
  schemaVersion: 'proofbound.prompt-envelope.v1';
  envelopeId: string;
  roleId: string;
  storyId: string;
  dispatchKind: 'story-dispatch' | 'review-run';
  reviewRunId?: string;
  reviewRound?: string;
  lane?: string;
  createdAt: string;
  headHash: string;
  runtimeContractVersion: string;
  runtimeSemanticDigest: string;
  runtimeRenderDigest: string;
  roleContractVersion: string;
  roleSemanticDigest: string;
  roleRenderDigest: string;
  contextMode: 'full' | 'incremental';
  contextDigest: string;
  priorPassRef?: string;
  materialHash?: string;
  storyFilesHash?: string;
  policyHash?: string;
  eligibilityDecision: 'full' | 'incremental';
  eligibilityDigest: string;
  freshnessClassification?: string;
  knownExecutionEnvironmentDigest: string;
  assemblerVersion: string;
  dispatchProtocolVersion: string;
  launcherSpecDigest: string;
  commandPolicyDigest: string;
  toolPolicyDigest?: string;
  systemInstructionDigest?: string;
  requestedModelId?: string;
  assembledPromptDigest: string;
  bytes: number;
  lines: number;
  estimatedTokens: number;
  tokenEstimatorVersion: string;
}

export interface PromptEnvelopeData {
  envelopes: PromptEnvelope[];
}

export interface DispatchUsageObservation {
  envelopeId: string;
  reviewRunId?: string;
  servedModelId?: string;
  assembledPromptTokens: number;
  knownDispatchInputTokens?: number;
  providerProcessedInputTokens?: number;
  uncachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  wallClockMs?: number;
  providerUsageStatus: 'reported' | 'unavailable';
}

export class PromptContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptContractValidationError';
  }
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, char => char.codePointAt(0)!);
  const b = Array.from(right, char => char.codePointAt(0)!);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/** RFC-8259-shaped JSON with recursively code-point-ordered object keys. */
export function canonicalJsonStringify(value: unknown): string {
  const ancestors = new Set<object>();

  const encode = (candidate: unknown, path: string): string => {
    if (candidate === null) return 'null';
    if (typeof candidate === 'string' || typeof candidate === 'boolean') return JSON.stringify(candidate);
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new PromptContractValidationError(`${path} must be finite`);
      return Object.is(candidate, -0) ? '0' : JSON.stringify(candidate);
    }
    if (typeof candidate !== 'object') {
      throw new PromptContractValidationError(`${path} contains unsupported ${typeof candidate}`);
    }
    if (utilTypes.isProxy(candidate)) {
      throw new PromptContractValidationError(`${path} must not be a Proxy`);
    }
    if (ancestors.has(candidate)) throw new PromptContractValidationError(`${path} is cyclic`);
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          throw new PromptContractValidationError(`${path} must use the ordinary Array prototype`);
        }
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(candidate, index)) {
            throw new PromptContractValidationError(`${path}[${index}] is sparse`);
          }
        }
        const expectedKeys = new Set<string>(['length']);
        for (let index = 0; index < candidate.length; index += 1) expectedKeys.add(String(index));
        for (const key of Reflect.ownKeys(candidate)) {
          if (typeof key !== 'string') {
            throw new PromptContractValidationError(`${path} contains an unsupported symbol-keyed array field`);
          }
          if (!expectedKeys.has(key)) {
            throw new PromptContractValidationError(`${path}.${key} is an unsupported extra array field`);
          }
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
          if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new PromptContractValidationError(`${path}.${key} is an unsupported array accessor field`);
          }
          if (key === 'length') {
            if (descriptor.enumerable || descriptor.value !== candidate.length) {
              throw new PromptContractValidationError(`${path}.length has an invalid array descriptor`);
            }
          } else if (!descriptor.enumerable) {
            throw new PromptContractValidationError(`${path}[${key}] is a non-enumerable array index`);
          }
        }
        let encoded = '[';
        for (let index = 0; index < candidate.length; index += 1) {
          if (index > 0) encoded += ',';
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index))!;
          encoded += encode(descriptor.value, `${path}[${index}]`);
        }
        return `${encoded}]`;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new PromptContractValidationError(`${path} must be a plain object`);
      }
      const record = candidate as Record<string, unknown>;
      const ownKeys = Reflect.ownKeys(record);
      for (const key of ownKeys) {
        if (typeof key !== 'string') {
          throw new PromptContractValidationError(`${path} contains an unsupported symbol-keyed own field`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
        if (!descriptor.enumerable) {
          throw new PromptContractValidationError(`${path}.${key} is a non-enumerable own field`);
        }
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw new PromptContractValidationError(`${path}.${key} is an unsupported accessor field`);
        }
      }
      const keys = (ownKeys as string[]).sort(compareCodePoints);
      return `{${keys.map(key => `${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`)}`).join(',')}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };

  return encode(value, '$');
}

export function domainSeparatedDigest(domain: string, value: unknown): string {
  requireNonblank(domain, 'digest domain');
  const bytes = canonicalJsonStringify(value);
  return createHash('sha256')
    .update(`proofbound.digest.v1\0${domain}\0`, 'utf8')
    .update(bytes, 'utf8')
    .digest('hex');
}

export function promptUtf8Bytes(text: string): number {
  requireString(text, 'prompt text');
  return Buffer.byteLength(text, 'utf8');
}

export function promptLogicalLines(text: string): number {
  requireString(text, 'prompt text');
  return text.length === 0 ? 0 : 1 + (text.match(/\n/g)?.length ?? 0);
}

export function estimatePromptTokens(text: string): number {
  requireString(text, 'prompt text');
  return bytesCharsEstimator('proofbound-observational-baseline', text).estimatedInputTokens;
}

export function measurePromptRepetition(text: string): PromptRepetitionMeasurement {
  requireString(text, 'prompt text');
  const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US');
  const tokens = normalized.match(/[\p{L}\p{N}_]+|[^\s]/gu) ?? [];
  const shingleSize = 5 as const;
  const shingles: string[] = [];
  for (let index = 0; index + shingleSize <= tokens.length; index += 1) {
    shingles.push(tokens.slice(index, index + shingleSize).join('\u001f'));
  }
  const seen = new Set<string>();
  let repeatedShingleCount = 0;
  for (const shingle of shingles) {
    if (seen.has(shingle)) repeatedShingleCount += 1;
    else seen.add(shingle);
  }
  return {
    algorithmVersion: PROMPT_CONTRACT_ALGORITHMS.repetition,
    shingleSize,
    tokenCount: tokens.length,
    shingleCount: shingles.length,
    repeatedShingleCount,
    ratio: shingles.length === 0 ? 0 : repeatedShingleCount / shingles.length,
  };
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new PromptContractValidationError(`${label} must be a string`);
}

function requireNonblank(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PromptContractValidationError(`${label} must be nonblank`);
  }
}

function requireDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new PromptContractValidationError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function requireNonnegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PromptContractValidationError(`${label} must be a nonnegative safe integer`);
  }
}

function requireStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    throw new PromptContractValidationError(`${label} must be an array of nonblank strings`);
  }
  if (new Set(value).size !== value.length) throw new PromptContractValidationError(`${label} contains duplicates`);
}

function requireExactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) throw new PromptContractValidationError(`${label}.${key} is required`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new PromptContractValidationError(`${label}.${key} is unknown`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PromptContractValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function validateRuntimeContract(value: unknown): asserts value is RuntimeContract {
  const record = asRecord(value, 'RuntimeContract');
  requireExactKeys(record, ['schemaVersion', 'lifecycleVersion', 'ownershipVersion', 'evidenceVersion', 'compactText', 'semanticDigest', 'renderDigest'], [], 'RuntimeContract');
  if (record.schemaVersion !== 'proofbound.agent-runtime.v1') throw new PromptContractValidationError('RuntimeContract.schemaVersion is unsupported');
  for (const key of ['lifecycleVersion', 'ownershipVersion', 'evidenceVersion', 'compactText']) requireNonblank(record[key], `RuntimeContract.${key}`);
  requireDigest(record.semanticDigest, 'RuntimeContract.semanticDigest');
  requireDigest(record.renderDigest, 'RuntimeContract.renderDigest');
}

export function validateRoleContract(value: unknown): asserts value is RoleContract {
  const record = asRecord(value, 'RoleContract');
  requireExactKeys(
    record,
    ['schemaVersion', 'roleId', 'status', 'defaultDispatch', 'responsibility', 'requiredInputIds', 'requiredCheckIds', 'allowedCommandIds', 'forbiddenActionIds', 'requiredOutputIds', 'stopConditionCodes', 'semanticDigest', 'renderDigest'],
    ['replacementAgentType', 'migrationHint'],
    'RoleContract',
  );
  if (record.schemaVersion !== 'proofbound.role-contract.v1') throw new PromptContractValidationError('RoleContract.schemaVersion is unsupported');
  requireNonblank(record.roleId, 'RoleContract.roleId');
  if (!['active', 'compatibility', 'retired'].includes(record.status as string)) throw new PromptContractValidationError('RoleContract.status is invalid');
  if (typeof record.defaultDispatch !== 'boolean') throw new PromptContractValidationError('RoleContract.defaultDispatch must be boolean');
  requireNonblank(record.responsibility, 'RoleContract.responsibility');
  for (const key of ['requiredInputIds', 'requiredCheckIds', 'allowedCommandIds', 'forbiddenActionIds', 'requiredOutputIds', 'stopConditionCodes']) {
    requireStringArray(record[key], `RoleContract.${key}`);
  }
  requireDigest(record.semanticDigest, 'RoleContract.semanticDigest');
  requireDigest(record.renderDigest, 'RoleContract.renderDigest');
  if (record.status === 'compatibility') {
    requireNonblank(record.replacementAgentType, 'RoleContract.replacementAgentType');
    requireNonblank(record.migrationHint, 'RoleContract.migrationHint');
    if (record.defaultDispatch) throw new PromptContractValidationError('compatibility RoleContract cannot be default dispatch');
  }
  if (record.status === 'retired' && record.defaultDispatch) throw new PromptContractValidationError('retired RoleContract cannot be default dispatch');
  if (record.replacementAgentType !== undefined) requireNonblank(record.replacementAgentType, 'RoleContract.replacementAgentType');
  if (record.migrationHint !== undefined) requireNonblank(record.migrationHint, 'RoleContract.migrationHint');
}

function validateInputLayer(value: unknown, label: string): void {
  const record = asRecord(value, label);
  if (record.availability === 'available') {
    requireExactKeys(record, ['availability', 'tokens', 'source'], [], label);
    requireNonnegativeInteger(record.tokens, `${label}.tokens`);
    requireNonblank(record.source, `${label}.source`);
    return;
  }
  if (record.availability === 'unavailable') {
    requireExactKeys(record, ['availability', 'reason'], [], label);
    requireNonblank(record.reason, `${label}.reason`);
    return;
  }
  throw new PromptContractValidationError(`${label}.availability is invalid`);
}

function validateRepetition(value: unknown): void {
  const record = asRecord(value, 'PromptMeasurementRecord.repetition');
  requireExactKeys(record, ['algorithmVersion', 'shingleSize', 'tokenCount', 'shingleCount', 'repeatedShingleCount', 'ratio'], [], 'PromptMeasurementRecord.repetition');
  if (record.algorithmVersion !== PROMPT_CONTRACT_ALGORITHMS.repetition || record.shingleSize !== 5) {
    throw new PromptContractValidationError('PromptMeasurementRecord.repetition algorithm is unsupported');
  }
  for (const key of ['tokenCount', 'shingleCount', 'repeatedShingleCount']) requireNonnegativeInteger(record[key], `PromptMeasurementRecord.repetition.${key}`);
  if (typeof record.ratio !== 'number' || !Number.isFinite(record.ratio) || record.ratio < 0 || record.ratio > 1) {
    throw new PromptContractValidationError('PromptMeasurementRecord.repetition.ratio must be in [0,1]');
  }
  if ((record.repeatedShingleCount as number) > (record.shingleCount as number)) {
    throw new PromptContractValidationError('PromptMeasurementRecord.repetition repeated count exceeds shingles');
  }
}

export function validatePromptMeasurementRecord(value: unknown): asserts value is PromptMeasurementRecord {
  const record = asRecord(value, 'PromptMeasurementRecord');
  requireExactKeys(record, [
    'schemaVersion', 'roleId', 'runtimeContractVersion', 'runtimeSemanticDigest', 'runtimeRenderDigest',
    'roleContractVersion', 'roleSemanticDigest', 'roleRenderDigest', 'assembledPromptDigest',
    'bytes', 'lines', 'estimatedTokens', 'tokenEstimatorVersion', 'repetition',
    'assembledPromptTokens', 'knownDispatchInputTokens', 'providerProcessedInputTokens',
  ], [], 'PromptMeasurementRecord');
  if (record.schemaVersion !== 'proofbound.prompt-measurement.v1') throw new PromptContractValidationError('PromptMeasurementRecord.schemaVersion is unsupported');
  for (const key of ['roleId', 'runtimeContractVersion', 'roleContractVersion', 'tokenEstimatorVersion']) requireNonblank(record[key], `PromptMeasurementRecord.${key}`);
  for (const key of ['runtimeSemanticDigest', 'runtimeRenderDigest', 'roleSemanticDigest', 'roleRenderDigest', 'assembledPromptDigest']) requireDigest(record[key], `PromptMeasurementRecord.${key}`);
  for (const key of ['bytes', 'lines', 'estimatedTokens']) requireNonnegativeInteger(record[key], `PromptMeasurementRecord.${key}`);
  validateRepetition(record.repetition);
  validateInputLayer(record.assembledPromptTokens, 'PromptMeasurementRecord.assembledPromptTokens');
  validateInputLayer(record.knownDispatchInputTokens, 'PromptMeasurementRecord.knownDispatchInputTokens');
  validateInputLayer(record.providerProcessedInputTokens, 'PromptMeasurementRecord.providerProcessedInputTokens');
  const assembled = record.assembledPromptTokens as Record<string, unknown>;
  if (assembled.availability !== 'available' || assembled.tokens !== record.estimatedTokens) {
    throw new PromptContractValidationError('PromptMeasurementRecord assembled token binding is inconsistent');
  }
}

export function validatePromptEnvelope(value: unknown): asserts value is PromptEnvelope {
  const record = asRecord(value, 'PromptEnvelope');
  const required = [
    'schemaVersion', 'envelopeId', 'roleId', 'storyId', 'dispatchKind', 'createdAt', 'headHash',
    'runtimeContractVersion', 'runtimeSemanticDigest', 'runtimeRenderDigest', 'roleContractVersion',
    'roleSemanticDigest', 'roleRenderDigest', 'contextMode', 'contextDigest', 'eligibilityDecision',
    'eligibilityDigest', 'knownExecutionEnvironmentDigest', 'assemblerVersion', 'dispatchProtocolVersion',
    'launcherSpecDigest', 'commandPolicyDigest', 'assembledPromptDigest', 'bytes', 'lines',
    'estimatedTokens', 'tokenEstimatorVersion',
  ];
  const optional = [
    'reviewRunId', 'reviewRound', 'lane', 'priorPassRef', 'materialHash', 'storyFilesHash', 'policyHash',
    'freshnessClassification', 'toolPolicyDigest', 'systemInstructionDigest', 'requestedModelId',
  ];
  requireExactKeys(record, required, optional, 'PromptEnvelope');
  if (record.schemaVersion !== 'proofbound.prompt-envelope.v1') throw new PromptContractValidationError('PromptEnvelope.schemaVersion is unsupported');
  for (const key of ['envelopeId', 'runtimeSemanticDigest', 'runtimeRenderDigest', 'roleSemanticDigest', 'roleRenderDigest', 'contextDigest', 'eligibilityDigest', 'knownExecutionEnvironmentDigest', 'launcherSpecDigest', 'commandPolicyDigest', 'assembledPromptDigest']) requireDigest(record[key], `PromptEnvelope.${key}`);
  for (const key of ['roleId', 'storyId', 'createdAt', 'headHash', 'runtimeContractVersion', 'roleContractVersion', 'assemblerVersion', 'dispatchProtocolVersion', 'tokenEstimatorVersion']) requireNonblank(record[key], `PromptEnvelope.${key}`);
  for (const key of ['bytes', 'lines', 'estimatedTokens']) requireNonnegativeInteger(record[key], `PromptEnvelope.${key}`);
  if (!['story-dispatch', 'review-run'].includes(record.dispatchKind as string)) throw new PromptContractValidationError('PromptEnvelope.dispatchKind is invalid');
  if (!['full', 'incremental'].includes(record.contextMode as string) || record.contextMode !== record.eligibilityDecision) {
    throw new PromptContractValidationError('PromptEnvelope context and eligibility bindings are inconsistent');
  }
  if (record.dispatchKind === 'review-run') {
    requireNonblank(record.reviewRunId, 'PromptEnvelope.reviewRunId');
    requireNonblank(record.reviewRound, 'PromptEnvelope.reviewRound');
    requireNonblank(record.lane, 'PromptEnvelope.lane');
  } else if (record.reviewRunId !== undefined || record.reviewRound !== undefined || record.lane !== undefined) {
    throw new PromptContractValidationError('story-dispatch PromptEnvelope cannot carry review authority');
  }
  if (record.contextMode !== 'full' || record.eligibilityDecision !== 'full' || record.priorPassRef !== undefined) {
    throw new PromptContractValidationError('Story 2 PromptEnvelope supports full context only');
  }
  const optionalDigests = ['materialHash', 'storyFilesHash', 'policyHash', 'toolPolicyDigest', 'systemInstructionDigest'];
  for (const key of optionalDigests.filter(key => record[key] !== undefined)) {
    requireDigest(record[key], `PromptEnvelope.${key}`);
  }
  const optionalText = ['priorPassRef', 'freshnessClassification', 'requestedModelId'];
  for (const key of optionalText.filter(key => record[key] !== undefined)) {
    requireNonblank(record[key], `PromptEnvelope.${key}`);
  }
}

export function validateKnownExecutionEnvironment(value: unknown): asserts value is KnownExecutionEnvironment {
  const record = asRecord(value, 'KnownExecutionEnvironment');
  requireExactKeys(
    record,
    ['schemaVersion', 'nodeVersion', 'platform', 'architecture', 'cliVersion', 'source'],
    [],
    'KnownExecutionEnvironment',
  );
  if (record.schemaVersion !== 'proofbound.known-execution-environment.v1') {
    throw new PromptContractValidationError('KnownExecutionEnvironment.schemaVersion is unsupported');
  }
  for (const key of ['nodeVersion', 'platform', 'architecture', 'cliVersion']) {
    requireNonblank(record[key], `KnownExecutionEnvironment.${key}`);
  }
  if (record.source !== 'trusted-local-runtime') {
    throw new PromptContractValidationError('KnownExecutionEnvironment.source is invalid');
  }
}

export function validateFullTaskContext(value: unknown): asserts value is FullTaskContext {
  const record = asRecord(value, 'FullTaskContext');
  requireExactKeys(
    record,
    ['schemaVersion', 'storyId', 'title', 'description', 'phase', 'priority', 'checklist', 'headHash'],
    ['materialHash', 'storyFilesHash', 'scopeContractDigest'],
    'FullTaskContext',
  );
  if (record.schemaVersion !== 'proofbound.full-task-context.v1') {
    throw new PromptContractValidationError('FullTaskContext.schemaVersion is unsupported');
  }
  for (const key of ['storyId', 'title', 'description', 'phase', 'priority', 'headHash']) {
    requireNonblank(record[key], `FullTaskContext.${key}`);
  }
  for (const key of ['materialHash', 'storyFilesHash', 'scopeContractDigest']) {
    if (record[key] !== undefined) requireDigest(record[key], `FullTaskContext.${key}`);
  }
  if (!Array.isArray(record.checklist)) throw new PromptContractValidationError('FullTaskContext.checklist must be an array');
  const seen = new Set<string>();
  for (const [index, raw] of record.checklist.entries()) {
    const item = asRecord(raw, `FullTaskContext.checklist[${index}]`);
    requireExactKeys(item, ['id', 'title', 'status'], ['context', 'userSees'], `FullTaskContext.checklist[${index}]`);
    for (const key of ['id', 'title', 'status']) requireNonblank(item[key], `FullTaskContext.checklist[${index}].${key}`);
    if (item.context !== undefined) requireNonblank(item.context, `FullTaskContext.checklist[${index}].context`);
    if (item.userSees !== undefined) requireNonblank(item.userSees, `FullTaskContext.checklist[${index}].userSees`);
    if (seen.has(item.id as string)) throw new PromptContractValidationError(`FullTaskContext.checklist contains duplicate id ${item.id}`);
    seen.add(item.id as string);
  }
}

export function validateDispatchUsageObservation(value: unknown): asserts value is DispatchUsageObservation {
  const record = asRecord(value, 'DispatchUsageObservation');
  requireExactKeys(record, ['envelopeId', 'assembledPromptTokens', 'providerUsageStatus'], [
    'reviewRunId', 'servedModelId', 'knownDispatchInputTokens', 'providerProcessedInputTokens',
    'uncachedInputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'wallClockMs',
  ], 'DispatchUsageObservation');
  requireDigest(record.envelopeId, 'DispatchUsageObservation.envelopeId');
  requireNonnegativeInteger(record.assembledPromptTokens, 'DispatchUsageObservation.assembledPromptTokens');
  if (!['reported', 'unavailable'].includes(record.providerUsageStatus as string)) throw new PromptContractValidationError('DispatchUsageObservation.providerUsageStatus is invalid');
  for (const key of ['knownDispatchInputTokens', 'providerProcessedInputTokens', 'uncachedInputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'wallClockMs']) {
    if (record[key] !== undefined) requireNonnegativeInteger(record[key], `DispatchUsageObservation.${key}`);
  }
  for (const key of ['reviewRunId', 'servedModelId']) if (record[key] !== undefined) requireNonblank(record[key], `DispatchUsageObservation.${key}`);
  if (record.providerUsageStatus === 'unavailable') {
    for (const key of ['providerProcessedInputTokens', 'uncachedInputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) {
      if (record[key] !== undefined) throw new PromptContractValidationError(`unavailable provider usage cannot include ${key}`);
    }
  } else {
    // Provider components are intentionally optional because some providers
    // report only a subset. When the processed total and all three components
    // are present, however, the documented accounting identity is mechanical.
    const providerFields = [
      'providerProcessedInputTokens',
      'uncachedInputTokens',
      'cacheReadInputTokens',
      'cacheCreationInputTokens',
    ] as const;
    if (providerFields.every(key => record[key] !== undefined)) {
      const componentTotal =
        (record.uncachedInputTokens as number) +
        (record.cacheReadInputTokens as number) +
        (record.cacheCreationInputTokens as number);
      if (record.providerProcessedInputTokens !== componentTotal) {
        throw new PromptContractValidationError(
          'reported provider usage is inconsistent: when all optional input fields are present, providerProcessedInputTokens must equal uncachedInputTokens + cacheReadInputTokens + cacheCreationInputTokens',
        );
      }
    }
  }
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PROMPT_CONTRACT_ALGORITHMS,
  canonicalJsonStringify,
  domainSeparatedDigest,
  estimatePromptTokens,
  measurePromptRepetition,
  promptLogicalLines,
  promptUtf8Bytes,
  validateDispatchUsageObservation,
  validatePromptEnvelope,
  validatePromptMeasurementRecord,
  validateRoleContract,
  validateRuntimeContract,
} from '../core/prompt-contracts.js';
import {
  BYTES_CHARS_ESTIMATOR_NAME,
  BYTES_CHARS_ESTIMATOR_UNIT,
  BYTES_CHARS_ESTIMATOR_VERSION,
  bytesCharsEstimator,
} from '../core/usage-ledger/estimate.js';
import {
  AGENT_DISPATCH_REGISTRY,
  resolveAgentDispatchType,
} from '../core/agent-dispatch-registry.js';
import {
  PROMPT_ROLE_CONTRACTS,
  buildPromptRoleContracts,
  validatePromptRoleContracts,
  validatePromptRolePolicyDefinition,
} from '../core/prompt-role-contract-registry.js';
import { readPromptRegistry } from '../core/prompt-registry.js';
import {
  PROMPT_MEASUREMENT_BASELINE_PATH,
  canonicalPromptMeasurementReportJson,
  generatePromptMeasurementReport,
  verifyPromptMeasurementReport,
} from '../core/prompt-measurement.js';
import {
  createPromptMeasurementHandlers,
  renderPromptMeasurementReportText,
} from '../handlers/prompt-measurement.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { getProcessFactLevelEntry } from '../core/process-fact-levels.js';
import { isCommandAllowed } from '../core/config.js';
import { isReadOnlyCommand } from '../cli/activity-policy.js';
import { MAIN_TOOLS } from '../cli/command-catalog.js';

function rejects(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, pattern);
}

const insertionA = { z: 3, nested: { '😀': 'emoji', a: 1 }, a: 2 };
const insertionB = { a: 2, nested: { a: 1, '😀': 'emoji' }, z: 3 };
assert.equal(canonicalJsonStringify(insertionA), canonicalJsonStringify(insertionB));
assert.equal(domainSeparatedDigest('semantic.v1', insertionA), domainSeparatedDigest('semantic.v1', insertionB));
assert.notEqual(domainSeparatedDigest('semantic.v1', insertionA), domainSeparatedDigest('render.v1', insertionA));
assert.notEqual(domainSeparatedDigest('semantic.v1', insertionA), domainSeparatedDigest('semantic.v2', insertionA));
assert.notEqual(canonicalJsonStringify('é'), canonicalJsonStringify('e\u0301'));

for (const invalid of [
  undefined,
  { nested: undefined },
  [undefined],
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  BigInt(1),
  Symbol('x'),
  () => null,
  new Date(),
]) rejects(() => canonicalJsonStringify(invalid), /unsupported|finite|plain object/);
const sparse = new Array(1);
rejects(() => canonicalJsonStringify(sparse), /sparse/);
const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
rejects(() => canonicalJsonStringify(cyclic), /cyclic/);

assert.equal(promptUtf8Bytes('ASCII'), 5);
assert.equal(promptUtf8Bytes('中'), 3);
assert.equal(promptUtf8Bytes('😀'), 4);
assert.equal(promptLogicalLines(''), 0);
assert.equal(promptLogicalLines('one'), 1);
assert.equal(promptLogicalLines('one\n'), 2);
assert.equal(promptLogicalLines('one\n\nthree'), 3);
assert.equal(promptLogicalLines('one\r\ntwo'), 2);

for (const text of ['', 'ASCII', '中文', '😀']) {
  assert.equal(estimatePromptTokens(text), bytesCharsEstimator('ignored', text).estimatedInputTokens);
}
assert.equal(
  PROMPT_CONTRACT_ALGORITHMS.tokenEstimator,
  `${BYTES_CHARS_ESTIMATOR_NAME}.v${BYTES_CHARS_ESTIMATOR_VERSION}.${BYTES_CHARS_ESTIMATOR_UNIT}`,
);

assert.deepEqual(measurePromptRepetition('one two three four five'), {
  algorithmVersion: 'normalized-five-token-shingles.v1',
  shingleSize: 5,
  tokenCount: 5,
  shingleCount: 1,
  repeatedShingleCount: 0,
  ratio: 0,
});
const repeated = measurePromptRepetition('a b c d e a b c d e');
assert.ok(repeated.ratio > 0 && repeated.ratio <= 1);
assert.deepEqual(repeated, measurePromptRepetition('a b c d e a b c d e'));

const digest = 'a'.repeat(64);
const runtimeContract = {
  schemaVersion: 'proofbound.agent-runtime.v1',
  lifecycleVersion: 'v1',
  ownershipVersion: 'v1',
  evidenceVersion: 'v1',
  compactText: 'runtime',
  semanticDigest: digest,
  renderDigest: digest,
};
validateRuntimeContract(runtimeContract);
rejects(() => validateRuntimeContract({ ...runtimeContract, schemaVersion: 'v2' }), /unsupported/);
rejects(() => validateRuntimeContract({ ...runtimeContract, renderDigest: 'bad' }), /SHA-256/);
rejects(() => validateRuntimeContract({ ...runtimeContract, extra: true }), /unknown/);

const roleContract = {
  schemaVersion: 'proofbound.role-contract.v1',
  roleId: 'role',
  status: 'active',
  defaultDispatch: true,
  responsibility: 'work',
  requiredInputIds: ['input'],
  requiredCheckIds: ['check'],
  allowedCommandIds: [],
  forbiddenActionIds: ['forbidden'],
  requiredOutputIds: ['output'],
  stopConditionCodes: ['stop'],
  semanticDigest: digest,
  renderDigest: digest,
};
validateRoleContract(roleContract);
rejects(() => validateRoleContract({ ...roleContract, status: 'unknown' }), /status/);
rejects(() => validateRoleContract({ ...roleContract, status: 'compatibility', defaultDispatch: false }), /replacement/);

const repetition = measurePromptRepetition('one two three four five');
const measurement = {
  schemaVersion: 'proofbound.prompt-measurement.v1',
  roleId: 'role',
  runtimeContractVersion: runtimeContract.schemaVersion,
  runtimeSemanticDigest: digest,
  runtimeRenderDigest: digest,
  roleContractVersion: roleContract.schemaVersion,
  roleSemanticDigest: digest,
  roleRenderDigest: digest,
  assembledPromptDigest: digest,
  bytes: 4,
  lines: 1,
  estimatedTokens: 1,
  tokenEstimatorVersion: PROMPT_CONTRACT_ALGORITHMS.tokenEstimator,
  repetition,
  assembledPromptTokens: { availability: 'available', tokens: 1, source: 'local' },
  knownDispatchInputTokens: { availability: 'unavailable', reason: 'not dispatched' },
  providerProcessedInputTokens: { availability: 'unavailable', reason: 'not called' },
};
validatePromptMeasurementRecord(measurement);
rejects(() => validatePromptMeasurementRecord({ ...measurement, bytes: -1 }), /nonnegative/);
rejects(() => validatePromptMeasurementRecord({ ...measurement, assembledPromptTokens: { availability: 'available', tokens: 0, source: 'local' } }), /inconsistent/);

const envelope = {
  schemaVersion: 'proofbound.prompt-envelope.v1',
  envelopeId: digest,
  roleId: 'role',
  storyId: 'B-test',
  dispatchKind: 'story-dispatch',
  createdAt: '2026-01-01T00:00:00.000Z',
  headHash: 'deadbeef',
  runtimeContractVersion: runtimeContract.schemaVersion,
  runtimeSemanticDigest: digest,
  runtimeRenderDigest: digest,
  roleContractVersion: roleContract.schemaVersion,
  roleSemanticDigest: digest,
  roleRenderDigest: digest,
  contextMode: 'full',
  contextDigest: digest,
  eligibilityDecision: 'full',
  eligibilityDigest: digest,
  knownExecutionEnvironmentDigest: digest,
  assemblerVersion: 'v1',
  dispatchProtocolVersion: 'v1',
  launcherSpecDigest: digest,
  commandPolicyDigest: digest,
  assembledPromptDigest: digest,
  bytes: 4,
  lines: 1,
  estimatedTokens: 1,
  tokenEstimatorVersion: PROMPT_CONTRACT_ALGORITHMS.tokenEstimator,
};
validatePromptEnvelope(envelope);
rejects(() => validatePromptEnvelope({ ...envelope, contextMode: 'incremental' }), /inconsistent/);
rejects(() => validatePromptEnvelope({ ...envelope, dispatchKind: 'review-run' }), /reviewRunId/);
rejects(() => validatePromptEnvelope({ ...envelope, bytes: Number.NaN }), /nonnegative/);

validateDispatchUsageObservation({
  envelopeId: digest,
  assembledPromptTokens: 1,
  providerUsageStatus: 'unavailable',
});
rejects(() => validateDispatchUsageObservation({
  envelopeId: digest,
  assembledPromptTokens: 1,
  providerUsageStatus: 'unavailable',
  providerProcessedInputTokens: 0,
}), /unavailable provider usage/);
validateDispatchUsageObservation({
  envelopeId: digest,
  assembledPromptTokens: 20,
  providerUsageStatus: 'reported',
  providerProcessedInputTokens: 18,
  uncachedInputTokens: 10,
  cacheReadInputTokens: 5,
  cacheCreationInputTokens: 3,
});
rejects(() => validateDispatchUsageObservation({
  envelopeId: digest,
  assembledPromptTokens: 20,
  providerUsageStatus: 'reported',
  providerProcessedInputTokens: 17,
  uncachedInputTokens: 10,
  cacheReadInputTokens: 5,
  cacheCreationInputTokens: 3,
}), /providerProcessedInputTokens must equal/);
// Optional provider components remain independently representable when the
// provider does not expose the complete accounting breakdown.
validateDispatchUsageObservation({
  envelopeId: digest,
  assembledPromptTokens: 20,
  providerUsageStatus: 'reported',
  providerProcessedInputTokens: 18,
});

const packageRoleIds = readPromptRegistry().agents.map(entry => entry.agentId).sort();
assert.equal(PROMPT_ROLE_CONTRACTS.length, 16);
assert.deepEqual(PROMPT_ROLE_CONTRACTS.map(contract => contract.roleId).sort(), packageRoleIds);
assert.equal(new Set(PROMPT_ROLE_CONTRACTS.map(contract => contract.roleId)).size, 16);
assert.equal(PROMPT_ROLE_CONTRACTS.filter(contract => contract.status === 'active').length, 12);
assert.deepEqual(
  PROMPT_ROLE_CONTRACTS.filter(contract => contract.status === 'compatibility').map(contract => contract.roleId).sort(),
  ['implementation-reviewer', 'test-case-reviewer', 'test-intent'],
);
assert.deepEqual(
  PROMPT_ROLE_CONTRACTS.filter(contract => contract.status === 'retired').map(contract => contract.roleId),
  ['lattice-review-channel'],
);
for (const contract of PROMPT_ROLE_CONTRACTS.filter(contract => contract.status !== 'active')) {
  assert.equal(contract.defaultDispatch, false);
}
const roleById = new Map(PROMPT_ROLE_CONTRACTS.map(contract => [contract.roleId, contract]));
assert.equal(roleById.get('product-reviewer')?.status, 'active');
assert.equal(roleById.get('implementation-reviewer')?.replacementAgentType, 'lattice-review-quality');
assert.match(roleById.get('implementation-reviewer')?.migrationHint ?? '', /lattice-review-behavior/);
assert.equal(roleById.get('test-intent')?.replacementAgentType, 'verification-intent');
assert.equal(roleById.get('test-case-reviewer')?.replacementAgentType, 'verification-intent');

const dispatchBefore = canonicalJsonStringify(AGENT_DISPATCH_REGISTRY);
buildPromptRoleContracts();
assert.equal(canonicalJsonStringify(AGENT_DISPATCH_REGISTRY), dispatchBefore);
assert.equal(resolveAgentDispatchType('test-intent').canonicalType, 'verification-intent');
assert.equal(resolveAgentDispatchType('test-case-reviewer').canonicalType, 'verification-intent');
assert.equal(resolveAgentDispatchType('product-reviewer').entry.allowedPhases[0], 'INIT');
assert.equal(resolveAgentDispatchType('lattice-review-channel').entry.allowedPhases[0], 'REVIEW');
assert.equal(AGENT_DISPATCH_REGISTRY.some(entry => String(entry.canonicalName) === 'implementation-reviewer'), false);

rejects(
  () => validatePromptRolePolicyDefinition({ synthetic: {} }, packageRoleIds),
  /unknown/,
);
rejects(
  () => validatePromptRolePolicyDefinition({}, packageRoleIds),
  /missing/,
);
rejects(
  () => validatePromptRolePolicyDefinition(Object.fromEntries(packageRoleIds.slice(1).map(id => [id, {}])), packageRoleIds),
  /missing/,
);
rejects(
  () => validatePromptRoleContracts([...PROMPT_ROLE_CONTRACTS, PROMPT_ROLE_CONTRACTS[0]], packageRoleIds),
  /duplicate/,
);
rejects(
  () => validatePromptRoleContracts(PROMPT_ROLE_CONTRACTS.slice(1), packageRoleIds),
  /membership/,
);
rejects(
  () => validatePromptRoleContracts([
    ...PROMPT_ROLE_CONTRACTS.slice(0, -1),
    { ...PROMPT_ROLE_CONTRACTS.at(-1)!, roleId: 'synthetic-role' },
  ], packageRoleIds),
  /membership/,
);
rejects(
  () => validatePromptRoleContracts(PROMPT_ROLE_CONTRACTS.map(contract =>
    contract.roleId === 'lattice-review-channel'
      ? { ...contract, defaultDispatch: true }
      : contract
  ), packageRoleIds),
  /retired/,
);

const reportA = generatePromptMeasurementReport();
const reportB = generatePromptMeasurementReport();
assert.equal(canonicalPromptMeasurementReportJson(reportA), canonicalPromptMeasurementReportJson(reportB));
assert.equal(reportA.records.length, 16);
assert.deepEqual(reportA.records.map(record => record.roleId).sort(), packageRoleIds);
assert.equal(reportA.aggregate.roleCount, 16);
assert.equal(reportA.aggregate.activeRoleCount, 12);
assert.equal(reportA.aggregate.compatibilityRoleCount, 3);
assert.equal(reportA.aggregate.retiredRoleCount, 1);
assert.equal(reportA.aggregate.bytes, reportA.records.reduce((sum, record) => sum + record.bytes, 0));
assert.equal(reportA.aggregate.lines, reportA.records.reduce((sum, record) => sum + record.lines, 0));
assert.equal(reportA.aggregate.estimatedTokens, reportA.records.reduce((sum, record) => sum + record.estimatedTokens, 0));
for (const record of reportA.records) {
  assert.equal(record.assembledPromptTokens.availability, 'available');
  assert.equal(record.knownDispatchInputTokens.availability, 'unavailable');
  assert.equal(record.providerProcessedInputTokens.availability, 'unavailable');
}
assert.equal(reportA.aggregate.knownDispatchInputTokens.availability, 'unavailable');
assert.equal(reportA.aggregate.providerProcessedInputTokens.availability, 'unavailable');
verifyPromptMeasurementReport(reportA);
rejects(() => verifyPromptMeasurementReport({
  ...reportA,
  records: reportA.records.slice(1),
}), /16 records/);
rejects(() => verifyPromptMeasurementReport({
  ...reportA,
  records: reportA.records.map((record, index) => index === 0 ? { ...record, bytes: record.bytes + 1 } : record),
}), /does not match/);

const handlers = createPromptMeasurementHandlers();
const jsonReport = handlers.prompt_measurement_report({ format: 'json' });
assert.equal(canonicalJsonStringify(jsonReport), canonicalJsonStringify(reportA));
const textReport = handlers.prompt_measurement_report({ format: 'text' });
assert.equal(textReport, renderPromptMeasurementReportText(reportA));
assert.equal(textReport.split('\n').filter(line => packageRoleIds.some(id => line.startsWith(`${id}:`))).length, 16);
assert.match(textReport, /knownDispatch=unavailable/);
assert.match(textReport, /providerProcessed=unavailable/);
assert.match(textReport, /L0 observational only/);

assert.equal(COMMAND_POLICIES.prompt_measurement_report.ownershipClass, 'readOnly');
assert.equal(COMMAND_POLICIES.prompt_measurement_report.allowedPhases, 'all');
assert.equal(isReadOnlyCommand('prompt_measurement_report'), true);
for (const phase of ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']) {
  assert.equal(isCommandAllowed('prompt_measurement_report', phase), true);
}
assert.equal(getProcessFactLevelEntry('prompt_measurement_report')?.level, 'L0');
assert.equal(MAIN_TOOLS.filter(tool => tool.name === 'prompt_measurement_report').length, 1);

const checkedInBaseline = readFileSync(PROMPT_MEASUREMENT_BASELINE_PATH, 'utf8');
assert.equal(checkedInBaseline, canonicalPromptMeasurementReportJson(reportA));
assert.doesNotMatch(checkedInBaseline, /prompt-envelope|envelopeId|reviewRunId/i);

console.log('prompt-contract-measurement-smoke CHK-001/CHK-002/CHK-003/CHK-004 PASS');

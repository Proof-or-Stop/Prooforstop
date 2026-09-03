import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const symbolKeyed = { a: 1 } as Record<PropertyKey, unknown>;
symbolKeyed[Symbol('hidden')] = 2;
rejects(() => canonicalJsonStringify(symbolKeyed), /symbol-keyed/);
const nonEnumerable = { a: 1 };
Object.defineProperty(nonEnumerable, 'hidden', { value: 2, enumerable: false });
rejects(() => canonicalJsonStringify(nonEnumerable), /non-enumerable/);
const accessor = { a: 1 };
Object.defineProperty(accessor, 'derived', { get: () => 2, enumerable: true });
rejects(() => canonicalJsonStringify(accessor), /accessor/);
const symbolArray = [1] as unknown[] & Record<PropertyKey, unknown>;
symbolArray[Symbol('hidden')] = 2;
rejects(() => canonicalJsonStringify(symbolArray), /symbol-keyed array field/);
const extraStringArray = [1] as unknown[] & Record<string, unknown>;
extraStringArray.hidden = 2;
rejects(() => canonicalJsonStringify(extraStringArray), /extra array field/);
const nonEnumerableArray = [1];
Object.defineProperty(nonEnumerableArray, 'hidden', { value: 2, enumerable: false });
rejects(() => canonicalJsonStringify(nonEnumerableArray), /extra array field/);
const accessorArray = [1];
Object.defineProperty(accessorArray, 'hidden', { get: () => 2, enumerable: true });
rejects(() => canonicalJsonStringify(accessorArray), /extra array field/);
const nonEnumerableIndexArray = [1];
Object.defineProperty(nonEnumerableIndexArray, '0', { value: 1, enumerable: false });
rejects(() => canonicalJsonStringify(nonEnumerableIndexArray), /non-enumerable array index/);
const accessorIndexArray = [1];
Object.defineProperty(accessorIndexArray, '0', { get: () => 1, enumerable: true });
rejects(() => canonicalJsonStringify(accessorIndexArray), /array accessor field/);
const malformedIndexArray = [1] as unknown[] & Record<string, unknown>;
malformedIndexArray['01'] = 2;
rejects(() => canonicalJsonStringify(malformedIndexArray), /extra array field/);
let maliciousMapCalled = false;
class MaliciousArray extends Array<unknown> {
  override map(): never[] {
    maliciousMapCalled = true;
    return [];
  }
}
const subclassArray = new MaliciousArray();
subclassArray[0] = 1;
rejects(() => canonicalJsonStringify(subclassArray), /ordinary Array prototype/);
assert.equal(maliciousMapCalled, false, 'canonical serializer must not invoke an array subclass method');
const customPrototypeArray = [1];
const customArrayPrototype = Object.create(Array.prototype) as Record<string, unknown>;
Object.defineProperty(customArrayPrototype, 'hiddenInheritedState', { value: 2, enumerable: false });
Object.setPrototypeOf(customPrototypeArray, customArrayPrototype);
rejects(() => canonicalJsonStringify(customPrototypeArray), /ordinary Array prototype/);
let ownMapCalled = false;
const ownMethodArray = [1] as unknown[] & { map: () => never[] };
ownMethodArray.map = () => {
  ownMapCalled = true;
  return [];
};
rejects(() => canonicalJsonStringify(ownMethodArray), /extra array field/);
assert.equal(ownMapCalled, false, 'canonical serializer must not invoke a candidate-owned array method');
assert.equal(canonicalJsonStringify([1, { b: 2, a: 1 }]), '[1,{"a":1,"b":2}]');
let plainProxyTrapCount = 0;
const plainProxy = new Proxy({ a: 1 }, {
  ownKeys(target) {
    plainProxyTrapCount += 1;
    return Reflect.ownKeys(target);
  },
  getOwnPropertyDescriptor(target, key) {
    plainProxyTrapCount += 1;
    return Reflect.getOwnPropertyDescriptor(target, key);
  },
  getPrototypeOf(target) {
    plainProxyTrapCount += 1;
    return Reflect.getPrototypeOf(target);
  },
});
rejects(() => canonicalJsonStringify(plainProxy), /must not be a Proxy/);
assert.equal(plainProxyTrapCount, 0, 'plain-object Proxy traps must not run');
let arrayProxyTrapCount = 0;
const statefulArrayProxy = new Proxy([1], {
  ownKeys(target) {
    arrayProxyTrapCount += 1;
    return Reflect.ownKeys(target);
  },
  getOwnPropertyDescriptor(target, key) {
    arrayProxyTrapCount += 1;
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (key === '0' && descriptor && 'value' in descriptor) descriptor.value = arrayProxyTrapCount;
    return descriptor;
  },
  getPrototypeOf(target) {
    arrayProxyTrapCount += 1;
    return Reflect.getPrototypeOf(target);
  },
  has(target, key) {
    arrayProxyTrapCount += 1;
    return Reflect.has(target, key);
  },
});
rejects(() => canonicalJsonStringify(statefulArrayProxy), /must not be a Proxy/);
assert.equal(arrayProxyTrapCount, 0, 'array Proxy traps must not run');
const revokedProxyHandle = Proxy.revocable({ a: 1 }, {});
revokedProxyHandle.revoke();
rejects(() => canonicalJsonStringify(revokedProxyHandle.proxy), /must not be a Proxy/);
assert.equal(canonicalJsonStringify({ a: [1, 2] }), '{"a":[1,2]}');

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
for (const requiredKey of Object.keys(runtimeContract)) {
  const missing = { ...runtimeContract } as Record<string, unknown>;
  delete missing[requiredKey];
  rejects(() => validateRuntimeContract(missing), /required/);
}
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
for (const requiredKey of Object.keys(roleContract)) {
  const missing = { ...roleContract } as Record<string, unknown>;
  delete missing[requiredKey];
  rejects(() => validateRoleContract(missing), /required/);
}
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
for (const requiredKey of Object.keys(measurement)) {
  const missing = { ...measurement } as Record<string, unknown>;
  delete missing[requiredKey];
  rejects(() => validatePromptMeasurementRecord(missing), /required/);
}
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
for (const requiredKey of Object.keys(envelope)) {
  const missing = { ...envelope } as Record<string, unknown>;
  delete missing[requiredKey];
  rejects(() => validatePromptEnvelope(missing), /required/);
}
const envelopeWithOptionalDigests = {
  ...envelope,
  materialHash: digest,
  storyFilesHash: digest,
  policyHash: digest,
  toolPolicyDigest: digest,
  systemInstructionDigest: digest,
};
validatePromptEnvelope(envelopeWithOptionalDigests);
for (const optionalDigestKey of [
  'materialHash',
  'storyFilesHash',
  'policyHash',
  'toolPolicyDigest',
  'systemInstructionDigest',
] as const) {
  rejects(
    () => validatePromptEnvelope({ ...envelopeWithOptionalDigests, [optionalDigestKey]: 'not-a-digest' }),
    new RegExp(`PromptEnvelope\\.${optionalDigestKey} must be a lowercase SHA-256 digest`),
  );
}
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
assert.equal(PROMPT_ROLE_CONTRACTS.length, 18);
assert.deepEqual(PROMPT_ROLE_CONTRACTS.map(contract => contract.roleId).sort(), packageRoleIds);
assert.equal(new Set(PROMPT_ROLE_CONTRACTS.map(contract => contract.roleId)).size, 18);
assert.equal(PROMPT_ROLE_CONTRACTS.filter(contract => contract.status === 'active').length, 14);
assert.deepEqual(
  PROMPT_ROLE_CONTRACTS.filter(contract => contract.status === 'compatibility').map(contract => contract.roleId).sort(),
  ['proof-or-stop-implementation-reviewer', 'proof-or-stop-test-case-reviewer', 'proof-or-stop-test-intent'],
);
assert.deepEqual(
  PROMPT_ROLE_CONTRACTS.filter(contract => contract.status === 'retired').map(contract => contract.roleId),
  ['proof-or-stop-review-channel'],
);
for (const contract of PROMPT_ROLE_CONTRACTS.filter(contract => contract.status !== 'active')) {
  assert.equal(contract.defaultDispatch, false);
}
const roleById = new Map(PROMPT_ROLE_CONTRACTS.map(contract => [contract.roleId, contract]));
assert.equal(roleById.get('proof-or-stop-product-reviewer')?.status, 'active');
assert.equal(roleById.get('proof-or-stop-implementation-reviewer')?.replacementAgentType, 'proof-or-stop-review-quality');
assert.match(roleById.get('proof-or-stop-implementation-reviewer')?.migrationHint ?? '', /proof-or-stop-review-behavior/);
assert.equal(roleById.get('proof-or-stop-test-intent')?.replacementAgentType, 'proof-or-stop-verification-intent');
assert.equal(roleById.get('proof-or-stop-test-case-reviewer')?.replacementAgentType, 'proof-or-stop-review-test-coverage');
assert.equal(Object.isFrozen(PROMPT_ROLE_CONTRACTS), true);
for (const contract of PROMPT_ROLE_CONTRACTS) {
  assert.equal(Object.isFrozen(contract), true, `${contract.roleId} row must be frozen`);
  for (const key of [
    'requiredInputIds',
    'requiredCheckIds',
    'allowedCommandIds',
    'forbiddenActionIds',
    'requiredOutputIds',
    'stopConditionCodes',
  ] as const) {
    assert.equal(Object.isFrozen(contract[key]), true, `${contract.roleId}.${key} must be frozen`);
  }
}

const roleRegistryModuleUrl = new URL('../core/prompt-role-contract-registry.js', import.meta.url).href;
const measurementModuleUrl = new URL('../core/prompt-measurement.js', import.meta.url).href;
const promptRegistryModuleUrl = new URL('../core/prompt-registry.js', import.meta.url).href;
const mutationChildOutput = execFileSync(process.execPath, ['--input-type=module', '--eval', `
  import {
    PROMPT_ROLE_CONTRACTS,
    validatePromptRoleContracts,
  } from ${JSON.stringify(roleRegistryModuleUrl)};
  import { generatePromptMeasurementReport } from ${JSON.stringify(measurementModuleUrl)};
  import { readPromptRegistry } from ${JSON.stringify(promptRegistryModuleUrl)};

  const first = PROMPT_ROLE_CONTRACTS[0];
  const originalStatus = first.status;
  let statusThrew = false;
  try { first.status = originalStatus === 'active' ? 'retired' : 'active'; } catch { statusThrew = true; }
  if (!statusThrew && first.status !== originalStatus) throw new Error('frozen row status mutated');

  const originalInputCount = first.requiredInputIds.length;
  let pushThrew = false;
  try { first.requiredInputIds.push('foreign-input'); } catch { pushThrew = true; }
  if (!pushThrew && first.requiredInputIds.length !== originalInputCount) throw new Error('frozen nested array mutated');

  const originalDigest = first.semanticDigest;
  let digestThrew = false;
  try { first.semanticDigest = 'b'.repeat(64); } catch { digestThrew = true; }
  if (!digestThrew && first.semanticDigest !== originalDigest) throw new Error('frozen semantic digest mutated');

  const foreign = structuredClone(PROMPT_ROLE_CONTRACTS);
  foreign[0].status = foreign[0].status === 'active' ? 'retired' : 'active';
  let foreignRejected = false;
  try {
    validatePromptRoleContracts(foreign, readPromptRegistry().agents.map(entry => entry.agentId));
  } catch {
    foreignRejected = true;
  }
  if (!foreignRejected) throw new Error('foreign corrupted registry was accepted');

  const report = generatePromptMeasurementReport();
  if (
    report.aggregate.activeRoleCount !== 14 ||
    report.aggregate.compatibilityRoleCount !== 3 ||
    report.aggregate.retiredRoleCount !== 1
  ) throw new Error('report partition changed');
  console.log('deep-freeze-consumption PASS');
`], { encoding: 'utf8' });
assert.match(mutationChildOutput, /deep-freeze-consumption PASS/);

const dispatchBefore = canonicalJsonStringify(AGENT_DISPATCH_REGISTRY);
buildPromptRoleContracts();
assert.equal(canonicalJsonStringify(AGENT_DISPATCH_REGISTRY), dispatchBefore);
assert.equal(resolveAgentDispatchType('verification-intent').canonicalType, 'proof-or-stop-verification-intent');
for (const legacyType of ['proof-or-stop-test-intent', 'proof-or-stop-test-case-reviewer', 'test-intent', 'test-case-reviewer']) {
  assert.throws(() => resolveAgentDispatchType(legacyType), /legacy read-side identity.*proof-or-stop-verification-intent/);
}
assert.equal(resolveAgentDispatchType('product-reviewer').entry.allowedPhases[0], 'INIT');
assert.throws(
  () => resolveAgentDispatchType('proof-or-stop-review-channel'),
  /retired agentType "proof-or-stop-review-channel"/,
  'retired prompt remains readable in the prompt registry but cannot be newly dispatched',
);
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
    contract.roleId === 'proof-or-stop-review-channel'
      ? { ...contract, defaultDispatch: true }
      : contract
  ), packageRoleIds),
  /retired/,
);
rejects(
  () => validatePromptRoleContracts(PROMPT_ROLE_CONTRACTS.map(contract =>
    contract.roleId === 'proof-or-stop-test-intent'
      ? { ...contract, replacementAgentType: 'lattice-review-quality' }
      : contract
  ), packageRoleIds),
  /frozen role policy/,
);
rejects(
  () => validatePromptRoleContracts(PROMPT_ROLE_CONTRACTS.map(contract =>
    contract.roleId === 'proof-or-stop-evaluator'
      ? { ...contract, defaultDispatch: false }
      : contract
  ), packageRoleIds),
  /defaultDispatch differs from the frozen role policy/,
);
rejects(
  () => validatePromptRoleContracts(PROMPT_ROLE_CONTRACTS.map(contract =>
    contract.roleId === 'proof-or-stop-evaluator'
      ? { ...contract, responsibility: 'Mutated responsibility.' }
      : contract
  ), packageRoleIds),
  /responsibility differs from the frozen role policy/,
);
rejects(
  () => validatePromptRoleContracts(PROMPT_ROLE_CONTRACTS.map(contract =>
    contract.roleId === 'proof-or-stop-evaluator'
      ? { ...contract, requiredCheckIds: [...contract.requiredCheckIds, 'mutated-check'] }
      : contract
  ), packageRoleIds),
  /requiredCheckIds differs from the frozen role policy/,
);
rejects(
  () => validatePromptRoleContracts(PROMPT_ROLE_CONTRACTS.map(contract =>
    contract.roleId === 'proof-or-stop-evaluator'
      ? { ...contract, semanticDigest: 'b'.repeat(64) }
      : contract
  ), packageRoleIds),
  /semanticDigest does not match the frozen role policy/,
);
rejects(
  () => validatePromptRoleContracts(PROMPT_ROLE_CONTRACTS.map(contract =>
    contract.roleId === 'proof-or-stop-implementation-reviewer'
      ? { ...contract, migrationHint: 'Use only lattice-review-quality.' }
      : contract
  ), packageRoleIds),
  /frozen role policy/,
);

const reportA = generatePromptMeasurementReport();
const reportB = generatePromptMeasurementReport();
assert.equal(canonicalPromptMeasurementReportJson(reportA), canonicalPromptMeasurementReportJson(reportB));
assert.equal(reportA.records.length, 18);
assert.deepEqual(reportA.records.map(record => record.roleId).sort(), packageRoleIds);
assert.equal(reportA.aggregate.roleCount, 18);
assert.equal(reportA.aggregate.activeRoleCount, 14);
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
}), /18 records/);
rejects(() => verifyPromptMeasurementReport({
  ...reportA,
  records: reportA.records.map((record, index) => index === 0 ? { ...record, bytes: record.bytes + 1 } : record),
}), /does not match/);

const handlers = createPromptMeasurementHandlers();
const jsonReport = handlers.prompt_measurement_report({ format: 'json' });
assert.equal(canonicalJsonStringify(jsonReport), canonicalJsonStringify(reportA));
const textReport = handlers.prompt_measurement_report({ format: 'text' });
assert.equal(textReport, renderPromptMeasurementReportText(reportA));
assert.equal(textReport.split('\n').filter(line => packageRoleIds.some(id => line.startsWith(`${id}:`))).length, 18);
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

const statusSnapshotDir = mkdtempSync(join(tmpdir(), 'prompt-measurement-read-only-'));
const beforeStatusPath = join(statusSnapshotDir, 'before');
const afterStatusPath = join(statusSnapshotDir, 'after');
try {
  const gitStatus = () => execFileSync('git', ['status', '--porcelain'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  const initialStatus = gitStatus();
  writeFileSync(beforeStatusPath, initialStatus, 'utf8');
  for (const format of ['text', 'json']) {
    execFileSync(process.execPath, ['bin/proof-or-stop.js', 'prompt_measurement_report', `--format=${format}`], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }
  writeFileSync(afterStatusPath, gitStatus(), 'utf8');
  assert.equal(
    readFileSync(afterStatusPath, 'utf8'),
    readFileSync(beforeStatusPath, 'utf8'),
    'text and JSON prompt measurement reports must not change repository git status',
  );

  const writeSensitivityDir = mkdtempSync(join(process.cwd(), 'prompt-measurement-write-probe-'));
  try {
    writeFileSync(join(writeSensitivityDir, 'marker'), 'detector sensitivity control\n', 'utf8');
    assert.notEqual(
      gitStatus(),
      initialStatus,
      'git-status snapshot detector must observe a temporary repository write',
    );
  } finally {
    rmSync(writeSensitivityDir, { recursive: true, force: true });
  }
  assert.equal(
    gitStatus(),
    initialStatus,
    'detector sensitivity control must restore the original repository status',
  );
} finally {
  rmSync(statusSnapshotDir, { recursive: true, force: true });
}

const checkedInBaseline = readFileSync(PROMPT_MEASUREMENT_BASELINE_PATH, 'utf8');
assert.equal(checkedInBaseline, canonicalPromptMeasurementReportJson(reportA));
assert.doesNotMatch(checkedInBaseline, /prompt-envelope|envelopeId|reviewRunId/i);

console.log('prompt-contract-measurement-smoke CHK-001/CHK-002/CHK-003/CHK-004 PASS');

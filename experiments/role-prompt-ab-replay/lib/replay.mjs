import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SUPPORTED_PROTOCOL = 'proofbound.role-prompt-ab.protocol.v1';
export const SUPPORTED_CORPUS = 'proofbound.role-prompt-ab.corpus.v1';
export const EXPERIMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class ReplayContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ReplayContractError';
    this.code = code;
  }
}

function compareCodePoints(left, right) {
  const a = Array.from(left, char => char.codePointAt(0));
  const b = Array.from(right, char => char.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function canonicalJson(value) {
  const ancestors = new Set();
  const encode = (candidate, at = '$') => {
    if (candidate === null) return 'null';
    if (typeof candidate === 'string' || typeof candidate === 'boolean') return JSON.stringify(candidate);
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new ReplayContractError('NON_CANONICAL_VALUE', `${at} must be finite`);
      return Object.is(candidate, -0) ? '0' : JSON.stringify(candidate);
    }
    if (typeof candidate !== 'object') throw new ReplayContractError('NON_CANONICAL_VALUE', `${at} contains ${typeof candidate}`);
    if (ancestors.has(candidate)) throw new ReplayContractError('NON_CANONICAL_VALUE', `${at} is cyclic`);
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.hasOwn(candidate, index)) throw new ReplayContractError('NON_CANONICAL_VALUE', `${at} is sparse`);
        }
        return `[${candidate.map((child, index) => encode(child, `${at}[${index}]`)).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ReplayContractError('NON_CANONICAL_VALUE', `${at} must be a plain object`);
      }
      const keys = Object.keys(candidate).sort(compareCodePoints);
      return `{${keys.map(key => `${JSON.stringify(key)}:${encode(candidate[key], `${at}.${key}`)}`).join(',')}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return encode(value);
}

export function digest(domain, value) {
  return createHash('sha256')
    .update(`proofbound.digest.v1\0${domain}\0`, 'utf8')
    .update(typeof value === 'string' ? value : canonicalJson(value), 'utf8')
    .digest('hex');
}

function assertObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReplayContractError(code, message);
}

function assertExactKeys(value, keys, at) {
  assertObject(value, 'INVALID_SHAPE', `${at} must be an object`);
  const actual = Object.keys(value).sort(compareCodePoints);
  const expected = [...keys].sort(compareCodePoints);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ReplayContractError('INVALID_SHAPE', `${at} keys must be exactly ${expected.join(',')}`);
  }
}

function safeRepoPath(value, at) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new ReplayContractError('PATH_ESCAPE', `${at} must be a non-empty repository-relative POSIX path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new ReplayContractError('PATH_ESCAPE', `${at} escapes or is not canonical`);
  }
  return normalized;
}

function validateAvailability(value, at) {
  assertObject(value, 'INVALID_AVAILABILITY', `${at} must be an object`);
  if (value.availability === 'available') {
    assertExactKeys(value, ['availability', 'tokens', 'source'], at);
    if (!Number.isSafeInteger(value.tokens) || value.tokens < 0 || typeof value.source !== 'string' || !value.source.trim()) {
      throw new ReplayContractError('INVALID_AVAILABILITY', `${at} available tokens/source are invalid`);
    }
    return;
  }
  if (value.availability === 'unavailable') {
    assertExactKeys(value, ['availability', 'reason'], at);
    if (typeof value.reason !== 'string' || !value.reason.trim()) {
      throw new ReplayContractError('INVALID_AVAILABILITY', `${at} requires a stable reason`);
    }
    return;
  }
  throw new ReplayContractError('INVALID_AVAILABILITY', `${at} availability must be available or unavailable`);
}

function validateHistoricalObservation(value, at) {
  validateAvailability(value, at);
  if (value.availability === 'available') {
    throw new ReplayContractError(
      'UNBOUND_HISTORICAL_METRIC',
      `${at} is numeric but this corpus schema has no mechanically verified evidenceRef/evidenceDigest binding`,
    );
  }
}

export function materialDigest(sample) {
  return digest('role-prompt-ab.material.v1', {
    task: sample.task,
    material: sample.material,
    tools: sample.tools,
  });
}

export function findingSetDigest(sample) {
  return digest('role-prompt-ab.finding-set.v1', {
    oracles: sample.oracles,
    observedFindingsByArm: sample.observedFindingsByArm,
  });
}

function validateOracle(oracle, sampleId, oracleIds) {
  assertExactKeys(
    oracle,
    ['id', 'category', 'severity', 'trigger', 'sourceBinding', 'claimBinding', 'adjudication'],
    `sample ${sampleId} oracle`,
  );
  if (oracleIds.has(oracle.id)) throw new ReplayContractError('DUPLICATE_ORACLE', `duplicate oracle ${oracle.id}`);
  oracleIds.add(oracle.id);
  if (!['critical', 'high'].includes(oracle.severity)) {
    throw new ReplayContractError('INVALID_ADJUDICATION', `${oracle.id} severity must be critical or high`);
  }
  for (const key of ['id', 'category', 'trigger', 'sourceBinding', 'claimBinding']) {
    if (typeof oracle[key] !== 'string' || !oracle[key].trim()) {
      throw new ReplayContractError('INVALID_ADJUDICATION', `${oracle.id}.${key} must be nonblank`);
    }
  }
  assertExactKeys(oracle.adjudication, ['kind', 'adjudicator', 'evidenceRef'], `${oracle.id}.adjudication`);
  if (!['machine', 'human'].includes(oracle.adjudication.kind)
      || typeof oracle.adjudication.adjudicator !== 'string' || !oracle.adjudication.adjudicator.trim()
      || typeof oracle.adjudication.evidenceRef !== 'string' || !oracle.adjudication.evidenceRef.trim()) {
    throw new ReplayContractError('ADJUDICATION_MISSING', `${oracle.id} requires independent adjudication evidence`);
  }
}

function validateObservedFindings(sample, armIds) {
  assertObject(sample.observedFindingsByArm, 'INVALID_FINDINGS', `${sample.id}.observedFindingsByArm must be an object`);
  if (canonicalJson(Object.keys(sample.observedFindingsByArm).sort()) !== canonicalJson([...armIds].sort())) {
    throw new ReplayContractError('ARM_INPUT_DRIFT', `${sample.id} must carry the exact registered arm set`);
  }
  const oracleById = new Map(sample.oracles.map(oracle => [oracle.id, oracle]));
  for (const armId of armIds) {
    const rows = sample.observedFindingsByArm[armId];
    if (!Array.isArray(rows)) throw new ReplayContractError('INVALID_FINDINGS', `${sample.id}.${armId} must be an array`);
    const seen = new Set();
    for (const row of rows) {
      assertExactKeys(row, ['oracleId', 'category', 'sourceBinding', 'claimBinding'], `${sample.id}.${armId} finding`);
      const oracle = oracleById.get(row.oracleId);
      if (!oracle) throw new ReplayContractError('INVALID_FINDINGS', `${sample.id}.${armId} references unknown oracle`);
      if (seen.has(row.oracleId)) throw new ReplayContractError('INVALID_FINDINGS', `${sample.id}.${armId} duplicates ${row.oracleId}`);
      seen.add(row.oracleId);
      if (row.category !== oracle.category || row.sourceBinding !== oracle.sourceBinding || row.claimBinding !== oracle.claimBinding) {
        throw new ReplayContractError('FINDING_DIGEST_MISMATCH', `${sample.id}.${armId}.${row.oracleId} semantic binding differs`);
      }
    }
  }
}

export function validateExperiment(protocol, corpus) {
  assertObject(protocol, 'UNSUPPORTED_PROTOCOL_VERSION', 'protocol must be an object');
  if (protocol.schemaVersion !== SUPPORTED_PROTOCOL) {
    throw new ReplayContractError('UNSUPPORTED_PROTOCOL_VERSION', String(protocol.schemaVersion));
  }
  if (protocol.status !== 'frozen') throw new ReplayContractError('PROTOCOL_NOT_FROZEN', 'protocol status must be frozen');
  if (!Array.isArray(protocol.arms) || protocol.arms.length !== 2 || new Set(protocol.arms.map(arm => arm.id)).size !== 2) {
    throw new ReplayContractError('INVALID_ARMS', 'exactly two unique arms are required');
  }
  const armIds = protocol.arms.map(arm => arm.id);
  if (protocol.sameInputRule?.onlyPermittedDifference !== 'promptContract') {
    throw new ReplayContractError('ARM_INPUT_DRIFT', 'only promptContract may differ between arms');
  }
  const repeats = protocol.sampling?.repeats;
  if (!Number.isSafeInteger(repeats) || repeats < 3 || repeats < protocol.requiredCorpus?.minimumRepeats) {
    throw new ReplayContractError('REPEAT_FLOOR_INCOMPLETE', 'at least three repeats are required');
  }
  if (!Array.isArray(protocol.sampling.armOrderByRepeat) || protocol.sampling.armOrderByRepeat.length !== repeats) {
    throw new ReplayContractError('REPEAT_FLOOR_INCOMPLETE', 'one arm order is required per repeat');
  }
  for (const order of protocol.sampling.armOrderByRepeat) {
    if (canonicalJson([...order].sort()) !== canonicalJson([...armIds].sort())) {
      throw new ReplayContractError('INVALID_RUN_ORDER', 'each repeat must contain each arm exactly once');
    }
  }
  for (const key of ['temperature', 'providerSeed', 'toolChoice']) {
    validateAvailability(protocol.sampling[key], `protocol.sampling.${key}`);
  }

  assertObject(corpus, 'UNSUPPORTED_CORPUS_VERSION', 'corpus must be an object');
  if (corpus.schemaVersion !== SUPPORTED_CORPUS) {
    throw new ReplayContractError('UNSUPPORTED_CORPUS_VERSION', String(corpus.schemaVersion));
  }
  if (corpus.status !== 'frozen' || !Array.isArray(corpus.samples)) {
    throw new ReplayContractError('CORPUS_NOT_FROZEN', 'corpus must be frozen and contain samples');
  }
  const requiredClasses = protocol.requiredCorpus.classes;
  const minimum = protocol.requiredCorpus.minimumSamplesPerClass;
  const counts = new Map(requiredClasses.map(name => [name, 0]));
  const sampleIds = new Set();
  for (const sample of corpus.samples) {
    assertObject(sample, 'INVALID_SAMPLE', 'sample must be an object');
    if (sampleIds.has(sample.id)) throw new ReplayContractError('DUPLICATE_SAMPLE', `duplicate sample ${sample.id}`);
    sampleIds.add(sample.id);
    if (!counts.has(sample.class)) throw new ReplayContractError('UNKNOWN_SAMPLE_CLASS', `${sample.id}: ${sample.class}`);
    counts.set(sample.class, counts.get(sample.class) + 1);
    if (typeof sample.task !== 'string' || !sample.task.trim() || !Array.isArray(sample.tools)) {
      throw new ReplayContractError('INVALID_SAMPLE', `${sample.id} task/tools invalid`);
    }
    assertObject(sample.material, 'MATERIAL_MISSING', `${sample.id} material missing`);
    if (sample.material.sourceKind !== 'inline-corpus-snapshot'
        || sample.material.snapshotAuthority !== 'corpus-json-content-addressed.v1') {
      throw new ReplayContractError(
        'MUTABLE_MATERIAL',
        `${sample.id} material must use content-addressed inline corpus authority`,
      );
    }
    safeRepoPath(sample.material.sourceHintPath, `${sample.id}.sourceHintPath`);
    if (sample.material.snapshotId !== sample.id) {
      throw new ReplayContractError('MATERIAL_MISSING', `${sample.id} snapshotId must equal sample id`);
    }
    assertObject(sample.material.content, 'MATERIAL_MISSING', `${sample.id} pinned snapshot content missing`);
    if (typeof sample.materialDigest !== 'string' || sample.materialDigest !== materialDigest(sample)) {
      throw new ReplayContractError('MATERIAL_DIGEST_MISMATCH', `${sample.id} material digest mismatch`);
    }
    if (!Array.isArray(sample.oracles)) throw new ReplayContractError('ADJUDICATION_MISSING', `${sample.id} oracles missing`);
    const oracleIds = new Set();
    for (const oracle of sample.oracles) validateOracle(oracle, sample.id, oracleIds);
    validateObservedFindings(sample, armIds);
    if (typeof sample.findingSetDigest !== 'string' || sample.findingSetDigest !== findingSetDigest(sample)) {
      throw new ReplayContractError('FINDING_DIGEST_MISMATCH', `${sample.id} finding-set digest mismatch`);
    }
    assertObject(sample.providerObservation, 'INVALID_AVAILABILITY', `${sample.id} provider observation missing`);
    const observationKeys = [
      'knownDispatchInputTokens',
      'providerProcessedInputTokens',
      'uncachedInputTokens',
      'cacheCreationInputTokens',
      'cacheReadInputTokens',
      'outputTokens',
    ].sort(compareCodePoints);
    if (canonicalJson(Object.keys(sample.providerObservation).sort(compareCodePoints)) !== canonicalJson(observationKeys)) {
      throw new ReplayContractError(
        'INVALID_AVAILABILITY',
        `${sample.id} provider observation must carry every availability-aware dimension`,
      );
    }
    for (const [key, observation] of Object.entries(sample.providerObservation)) {
      validateHistoricalObservation(observation, `${sample.id}.${key}`);
    }
  }
  for (const [className, count] of counts) {
    if (count < minimum) throw new ReplayContractError('SAMPLE_FLOOR_INCOMPLETE', `${className} has ${count}, requires ${minimum}`);
  }
  const adjudicatedDenominator = corpus.samples.flatMap(sample => sample.oracles).length;
  if (adjudicatedDenominator < 1) {
    throw new ReplayContractError('RECALL_DENOMINATOR_INVALID', 'at least one independently adjudicated oracle is required');
  }
  return {
    experimentId: digest('role-prompt-ab.experiment.v1', { protocol, corpus }),
    protocolDigest: digest('role-prompt-ab.protocol.v1', protocol),
    corpusDigest: digest('role-prompt-ab.corpus.v1', corpus),
    classes: counts.size,
    samples: corpus.samples.length,
    repeats,
    adjudicatedFindings: adjudicatedDenominator,
  };
}

function measure(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  return {
    bytes,
    lines: text.length === 0 ? 0 : 1 + (text.match(/\n/g)?.length ?? 0),
    estimatedTokens: bytes === 0 ? 0 : Math.ceil(bytes / 4),
    promptDigest: digest('assembled-prompt.raw-utf8.v1', text),
  };
}

function armPrompt(arm, sharedInput) {
  const contractBlock = arm.id === 'A'
    ? 'ROLE PROMPT CONTRACT: legacy-full-context.v1\nApply the complete shared runtime and role instructions.'
    : 'ROLE PROMPT CONTRACT: modular-full-context.v1\nApply the referenced runtime contract and the bounded role contract.';
  return `${contractBlock}\n\nSHARED INPUT (canonical JSON):\n${canonicalJson(sharedInput)}\n`;
}

function findingComparison(sample, armId) {
  const observed = new Set(sample.observedFindingsByArm[armId].map(row => row.oracleId));
  const seeded = sample.oracles;
  const detected = seeded.filter(oracle => observed.has(oracle.id));
  const missedCritical = seeded.filter(oracle => oracle.severity === 'critical' && !observed.has(oracle.id));
  return {
    findingSetDigest: sample.findingSetDigest,
    seededCount: seeded.length,
    detectedCount: detected.length,
    criticalAllDetected: missedCritical.length === 0,
    recall: seeded.length === 0 ? null : detected.length / seeded.length,
    status: seeded.length === 0 ? 'NO_ADJUDICATED_FINDINGS' : 'EVALUABLE',
  };
}

export function replayExperiment(options = {}) {
  assertObject(options, 'INVALID_REPLAY_INPUT', 'replay options must be an object');
  const optionKeys = Object.keys(options).sort(compareCodePoints);
  const allowedKeys = ['armOrder', 'corpus', 'protocol'];
  if (optionKeys.some(key => !allowedKeys.includes(key)) || !optionKeys.includes('protocol') || !optionKeys.includes('corpus')) {
    throw new ReplayContractError('CALLER_SUBSTITUTION_REJECTED', 'only protocol, corpus, and optional armOrder are accepted');
  }
  const { protocol, corpus, armOrder } = options;
  if (armOrder !== undefined && !Array.isArray(armOrder)) {
    throw new ReplayContractError('INVALID_RUN_ORDER', 'armOrder must be an array');
  }
  const identity = validateExperiment(protocol, corpus);
  const arms = new Map(protocol.arms.map(arm => [arm.id, arm]));
  const overrideOrder = armOrder ?? null;
  if (overrideOrder && canonicalJson([...overrideOrder].sort()) !== canonicalJson([...arms.keys()].sort())) {
    throw new ReplayContractError('INVALID_RUN_ORDER', 'armOrder must contain each registered arm exactly once');
  }
  const cells = [];
  for (const sample of corpus.samples) {
    const sharedInput = {
      task: sample.task,
      material: sample.material,
      tools: sample.tools,
      model: protocol.model,
      sampling: protocol.sampling,
    };
    const inputDigest = digest('role-prompt-ab.shared-input.v1', sharedInput);
    for (let repeat = 1; repeat <= protocol.sampling.repeats; repeat += 1) {
      const order = overrideOrder ?? protocol.sampling.armOrderByRepeat[repeat - 1];
      for (const armId of order) {
        const promptText = armPrompt(arms.get(armId), sharedInput);
        cells.push({
          cellId: `${sample.id}/${armId}/repeat-${repeat}`,
          sampleId: sample.id,
          sampleClass: sample.class,
          armId,
          repeat,
          inputDigest,
          materialDigest: sample.materialDigest,
          promptContract: arms.get(armId).promptContract,
          measurement: measure(promptText),
          providerObservation: sample.providerObservation,
          findingComparison: findingComparison(sample, armId),
        });
      }
    }
  }
  const inputPairs = new Map();
  for (const cell of cells) {
    const previous = inputPairs.get(cell.sampleId);
    if (previous && previous !== cell.inputDigest) throw new ReplayContractError('ARM_INPUT_DRIFT', cell.sampleId);
    inputPairs.set(cell.sampleId, cell.inputDigest);
  }
  return {
    schemaVersion: 'proofbound.role-prompt-ab.replay.v1',
    ...identity,
    sameInput: true,
    deterministic: true,
    gateEvidence: false,
    cells: cells.sort((a, b) => a.cellId.localeCompare(b.cellId, 'en')),
    resultDigest: digest('role-prompt-ab.replay-result.v1', cells.sort((a, b) => a.cellId.localeCompare(b.cellId, 'en'))),
  };
}

export async function loadPinnedExperiment() {
  const [protocolText, corpusText] = await Promise.all([
    readFile(path.join(EXPERIMENT_ROOT, 'protocol.json'), 'utf8'),
    readFile(path.join(EXPERIMENT_ROOT, 'corpus.json'), 'utf8'),
  ]);
  return { protocol: JSON.parse(protocolText), corpus: JSON.parse(corpusText) };
}

export function inconclusive(reasonCode, detail) {
  return {
    status: 'INCONCLUSIVE',
    reasonCode,
    detail,
    savingsClaim: null,
    recallClaim: null,
    gateEvidence: false,
  };
}

import { appendFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, digest, EXPERIMENT_ROOT, ReplayContractError } from './replay.mjs';

export const LEDGER_SCHEMA = 'proofbound.role-prompt-ab.experiment-ledger.v1';
const FORBIDDEN_KEYS = new Set([
  'prompt', 'rawprompt', 'completion', 'rawcompletion', 'transcript', 'rawtranscript',
  'messages', 'toolarguments', 'toolargs', 'authorization', 'apikey', 'secret',
  'credentials', 'authority', 'gateevidence', 'productiondone', 'storyid', 'reviewrunid',
  'reviewpass', 'finding', 'verificationevidence', 'validationevidence', 'phase',
]);
const TERMINAL_DISPOSITIONS = new Set(['succeeded', 'failed', 'crashed', 'blocked']);

function assertObject(value, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReplayContractError('INVALID_LEDGER_RECORD', `${at} must be an object`);
  }
}

function scanForbidden(value, at = '$') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanForbidden(child, `${at}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new ReplayContractError('PRIVATE_OR_AUTHORITATIVE_FIELD', `${at}.${key} is forbidden`);
    }
    scanForbidden(child, `${at}.${key}`);
  }
}

function nonblank(value, at) {
  if (typeof value !== 'string' || !value.trim()) throw new ReplayContractError('INVALID_LEDGER_RECORD', `${at} must be nonblank`);
  return value;
}

function digestText(value, at) {
  if (!/^[a-f0-9]{64}$/.test(value ?? '')) throw new ReplayContractError('INVALID_LEDGER_RECORD', `${at} must be a sha256 digest`);
  return value;
}

function count(value, at) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ReplayContractError('INVALID_LEDGER_RECORD', `${at} must be a nonnegative integer`);
  return value;
}

function availability(value, at) {
  assertObject(value, at);
  if (value.availability === 'available') {
    const keys = Object.keys(value).sort();
    if (canonicalJson(keys) !== canonicalJson(['availability', 'source', 'tokens'])) {
      throw new ReplayContractError('INVALID_LEDGER_RECORD', `${at} available shape invalid`);
    }
    count(value.tokens, `${at}.tokens`);
    nonblank(value.source, `${at}.source`);
    return { ...value };
  }
  if (value.availability === 'unavailable') {
    const keys = Object.keys(value).sort();
    if (canonicalJson(keys) !== canonicalJson(['availability', 'reason'])) {
      throw new ReplayContractError('INVALID_LEDGER_RECORD', `${at} unavailable shape invalid`);
    }
    nonblank(value.reason, `${at}.reason`);
    return { ...value };
  }
  throw new ReplayContractError('INVALID_LEDGER_RECORD', `${at}.availability invalid`);
}

async function assertNoSymlinkEscape(target) {
  const rootReal = await realpath(EXPERIMENT_ROOT);
  const relative = path.relative(rootReal, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ReplayContractError('LEDGER_PATH_ESCAPE', 'ledger path leaves the experiment namespace');
  }
  let cursor = rootReal;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    if (!part) continue;
    cursor = path.join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new ReplayContractError('LEDGER_PATH_ESCAPE', `${cursor} is a symlink`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      break;
    }
  }
  try {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) throw new ReplayContractError('LEDGER_PATH_ESCAPE', `${target} is a symlink`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function resolveLedgerPath(relativePath) {
  if (typeof relativePath !== 'string' || !/^runtime\/[a-zA-Z0-9._/-]+\.jsonl$/.test(relativePath)
      || relativePath.includes('..') || relativePath.includes('\\')) {
    throw new ReplayContractError('LEDGER_PATH_ESCAPE', 'ledger path must be runtime/<safe-name>.jsonl');
  }
  const target = path.resolve(EXPERIMENT_ROOT, relativePath);
  await assertNoSymlinkEscape(target);
  return target;
}

export function makeLedgerRecord(input, previousRecordHash = null, supersedesRecordIds = []) {
  assertObject(input, 'record input');
  scanForbidden(input);
  const expectedKeys = [
    'experimentId', 'cellId', 'ledgerCallId', 'attemptId', 'sequence', 'event',
    'disposition', 'observedAt', 'inputDigest', 'promptDigest', 'materialDigest',
    'findingSetDigest', 'modelId', 'contractVersion', 'usage', 'latencyMs',
    'findingMeasurement',
  ].sort();
  if (canonicalJson(Object.keys(input).sort()) !== canonicalJson(expectedKeys)) {
    throw new ReplayContractError('INVALID_LEDGER_RECORD', `input keys must be exactly ${expectedKeys.join(',')}`);
  }
  for (const key of ['experimentId', 'inputDigest', 'promptDigest', 'materialDigest', 'findingSetDigest']) digestText(input[key], key);
  for (const key of ['cellId', 'ledgerCallId', 'attemptId', 'modelId', 'contractVersion']) nonblank(input[key], key);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new ReplayContractError('INVALID_LEDGER_RECORD', 'sequence must be positive');
  if (!['assembled', 'dispatched', 'terminal'].includes(input.event)) throw new ReplayContractError('INVALID_LEDGER_RECORD', 'event invalid');
  if (input.event === 'terminal') {
    if (!TERMINAL_DISPOSITIONS.has(input.disposition)) throw new ReplayContractError('INVALID_LEDGER_RECORD', 'terminal disposition invalid');
  } else if (input.disposition !== null) {
    throw new ReplayContractError('INVALID_LEDGER_RECORD', 'nonterminal disposition must be null');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.observedAt)) {
    throw new ReplayContractError('INVALID_LEDGER_RECORD', 'observedAt must be an ISO UTC timestamp');
  }
  assertObject(input.usage, 'usage');
  const usage = {
    assembledPromptTokens: availability(input.usage.assembledPromptTokens, 'usage.assembledPromptTokens'),
    knownDispatchInputTokens: availability(input.usage.knownDispatchInputTokens, 'usage.knownDispatchInputTokens'),
    providerProcessedInputTokens: availability(input.usage.providerProcessedInputTokens, 'usage.providerProcessedInputTokens'),
    uncachedInputTokens: availability(input.usage.uncachedInputTokens, 'usage.uncachedInputTokens'),
    cacheCreationInputTokens: availability(input.usage.cacheCreationInputTokens, 'usage.cacheCreationInputTokens'),
    cacheReadInputTokens: availability(input.usage.cacheReadInputTokens, 'usage.cacheReadInputTokens'),
    outputTokens: availability(input.usage.outputTokens, 'usage.outputTokens'),
  };
  if (canonicalJson(Object.keys(input.usage).sort()) !== canonicalJson(Object.keys(usage).sort())) {
    throw new ReplayContractError('INVALID_LEDGER_RECORD', 'usage dimensions must be exact');
  }
  for (const key of [
    'providerProcessedInputTokens',
    'uncachedInputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
    'outputTokens',
  ]) {
    const dimension = usage[key];
    if (dimension.availability === 'available' && dimension.source !== 'pinned provider terminal usage') {
      throw new ReplayContractError(
        'INVALID_LEDGER_RECORD',
        `${key} may be numeric only when bound to a pinned provider terminal usage observation`,
      );
    }
  }
  const providerParts = [
    usage.uncachedInputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheReadInputTokens,
  ];
  if (usage.providerProcessedInputTokens.availability === 'available'
      && providerParts.every(dimension => dimension.availability === 'available')) {
    const recomputed = providerParts.reduce((sum, dimension) => sum + dimension.tokens, 0);
    if (recomputed !== usage.providerProcessedInputTokens.tokens) {
      throw new ReplayContractError(
        'INVALID_LEDGER_RECORD',
        'providerProcessedInputTokens must equal uncached + cacheCreation + cacheRead when all dimensions are available',
      );
    }
  }
  const latencyMs = input.latencyMs === null
    ? { availability: 'unavailable', reason: 'Historical replay has no trusted wall-clock observation.' }
    : { availability: 'available', value: count(input.latencyMs, 'latencyMs'), source: 'pinned historical observation' };
  assertObject(input.findingMeasurement, 'findingMeasurement');
  if (canonicalJson(Object.keys(input.findingMeasurement).sort()) !== canonicalJson(['detectedCount', 'seededCount', 'status'])) {
    throw new ReplayContractError('INVALID_LEDGER_RECORD', 'findingMeasurement shape invalid');
  }
  count(input.findingMeasurement.seededCount, 'findingMeasurement.seededCount');
  count(input.findingMeasurement.detectedCount, 'findingMeasurement.detectedCount');
  if (input.findingMeasurement.detectedCount > input.findingMeasurement.seededCount
      || !['EVALUABLE', 'NO_ADJUDICATED_FINDINGS'].includes(input.findingMeasurement.status)) {
    throw new ReplayContractError('INVALID_LEDGER_RECORD', 'findingMeasurement values invalid');
  }
  if (previousRecordHash !== null) digestText(previousRecordHash, 'previousRecordHash');
  if (!Array.isArray(supersedesRecordIds) || supersedesRecordIds.some(value => !/^[a-f0-9]{64}$/.test(value))) {
    throw new ReplayContractError('INVALID_LEDGER_RECORD', 'supersedesRecordIds must contain record digests');
  }
  const body = {
    schemaVersion: LEDGER_SCHEMA,
    namespace: 'experiment-only',
    gateEvidence: false,
    experimentId: input.experimentId,
    cellId: input.cellId,
    ledgerCallId: input.ledgerCallId,
    attemptId: input.attemptId,
    sequence: input.sequence,
    event: input.event,
    disposition: input.disposition,
    observedAt: input.observedAt,
    inputDigest: input.inputDigest,
    promptDigest: input.promptDigest,
    materialDigest: input.materialDigest,
    findingSetDigest: input.findingSetDigest,
    modelId: input.modelId,
    contractVersion: input.contractVersion,
    usage,
    latency: latencyMs,
    findingMeasurement: { ...input.findingMeasurement },
    privacy: { contentStored: false, secretFieldsAccepted: false },
    supersedesRecordIds: [...supersedesRecordIds],
    previousRecordHash,
  };
  const recordId = digest('role-prompt-ab.ledger-record-id.v1', {
    experimentId: body.experimentId,
    cellId: body.cellId,
    ledgerCallId: body.ledgerCallId,
    attemptId: body.attemptId,
    sequence: body.sequence,
  });
  const recordHash = digest('role-prompt-ab.ledger-record.v1', { ...body, recordId });
  return { ...body, recordId, recordHash };
}

export function verifyLedgerRows(rows) {
  if (!Array.isArray(rows)) throw new ReplayContractError('INVALID_LEDGER', 'rows must be an array');
  const ids = new Set();
  const attempts = new Map();
  let previous = null;
  for (const row of rows) {
    if (row.schemaVersion !== LEDGER_SCHEMA || row.namespace !== 'experiment-only' || row.gateEvidence !== false) {
      throw new ReplayContractError('FORGED_LEDGER_AUTHORITY', 'ledger row is not an experiment-only record');
    }
    if (ids.has(row.recordId)) throw new ReplayContractError('DUPLICATE_LEDGER_RECORD', row.recordId);
    ids.add(row.recordId);
    if (row.previousRecordHash !== previous) throw new ReplayContractError('LEDGER_CHAIN_BROKEN', row.recordId);
    const expectedHash = digest('role-prompt-ab.ledger-record.v1', Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== 'recordHash'),
    ));
    if (expectedHash !== row.recordHash) throw new ReplayContractError('LEDGER_CHAIN_BROKEN', row.recordId);
    const key = `${row.experimentId}/${row.cellId}/${row.ledgerCallId}/${row.attemptId}`;
    const state = attempts.get(key) ?? { sequence: 0, terminal: false };
    if (state.terminal || row.sequence !== state.sequence + 1) {
      throw new ReplayContractError('ATTEMPT_ORDER_INVALID', key);
    }
    state.sequence = row.sequence;
    state.terminal = row.event === 'terminal';
    if (row.event === 'terminal' && state.sequence > 1 && (!Array.isArray(row.supersedesRecordIds) || row.supersedesRecordIds.length < 1)) {
      throw new ReplayContractError('ATTEMPT_ORDER_INVALID', `${key} terminal row must supersede its earlier accounting row`);
    }
    attempts.set(key, state);
    previous = row.recordHash;
  }
  return { rows: rows.length, attempts, lastRecordHash: previous };
}

export async function readLedger(relativePath) {
  const target = await resolveLedgerPath(relativePath);
  let text;
  try {
    text = await readFile(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const rows = text.split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new ReplayContractError('INVALID_LEDGER', `line ${index + 1} is not JSON`);
    }
  });
  verifyLedgerRows(rows);
  return rows;
}

export async function appendLedgerRecord(relativePath, input) {
  const target = await resolveLedgerPath(relativePath);
  const rows = await readLedger(relativePath);
  const state = verifyLedgerRows(rows);
  const attemptRows = rows.filter(row => row.experimentId === input.experimentId
    && row.cellId === input.cellId
    && row.ledgerCallId === input.ledgerCallId
    && row.attemptId === input.attemptId);
  const supersedes = input.event === 'terminal' ? attemptRows.map(row => row.recordId) : [];
  const record = makeLedgerRecord(input, state.lastRecordHash, supersedes);
  verifyLedgerRows([...rows, record]);
  await mkdir(path.dirname(target), { recursive: true });
  await assertNoSymlinkEscape(target);
  await appendFile(target, `${canonicalJson(record)}\n`, { encoding: 'utf8', flag: 'a' });
  return record;
}

export function summarizeLedger(rows) {
  const checked = verifyLedgerRows(rows);
  const terminal = rows.filter(row => row.event === 'terminal');
  const attempts = [...checked.attempts.values()];
  const incompleteAttempts = attempts.filter(state => !state.terminal).length;
  const finalProviderInputTokens = terminal.reduce((sum, row) => {
    const dimension = row.usage.providerProcessedInputTokens;
    return dimension.availability === 'available' ? sum + dimension.tokens : sum;
  }, 0);
  return {
    schemaVersion: 'proofbound.role-prompt-ab.experiment-summary.v1',
    gateEvidence: false,
    records: rows.length,
    attempts: attempts.length,
    terminalAttempts: terminal.length,
    incompleteAttempts,
    finalProviderInputTokens,
    providerInputAvailability: terminal.every(row => row.usage.providerProcessedInputTokens.availability === 'available')
      ? 'available'
      : 'partial-or-unavailable',
  };
}

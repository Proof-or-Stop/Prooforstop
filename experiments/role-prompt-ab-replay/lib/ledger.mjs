import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, digest, EXPERIMENT_ROOT, ReplayContractError } from './replay.mjs';

export const LEDGER_SCHEMA = 'proof-or-stop.role-prompt-ab.experiment-ledger.v1';
const FORBIDDEN_KEYS = new Set([
  'prompt', 'rawprompt', 'completion', 'rawcompletion', 'transcript', 'rawtranscript',
  'messages', 'toolarguments', 'toolargs', 'authorization', 'apikey', 'secret',
  'credentials', 'authority', 'gateevidence', 'productiondone', 'storyid', 'reviewrunid',
  'reviewpass', 'finding', 'verificationevidence', 'validationevidence', 'phase',
]);
const TERMINAL_DISPOSITIONS = new Set(['succeeded', 'failed', 'crashed', 'blocked']);
const STORED_RECORD_KEYS = [
  'schemaVersion', 'namespace', 'gateEvidence', 'experimentId', 'cellId',
  'ledgerCallId', 'attemptId', 'sequence', 'event', 'disposition', 'observedAt',
  'inputDigest', 'promptDigest', 'materialDigest', 'findingSetDigest', 'modelId',
  'contractVersion', 'usage', 'latency', 'findingMeasurement', 'privacy',
  'supersedesRecordIds', 'previousRecordHash', 'recordId', 'recordHash',
].sort();

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
  if (typeof relativePath !== 'string' || !/^runtime\/[a-zA-Z0-9._-]+\.jsonl$/.test(relativePath)) {
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
  for (const key of ['experimentId', 'inputDigest', 'materialDigest', 'findingSetDigest']) digestText(input[key], key);
  if (input.promptDigest !== null) {
    throw new ReplayContractError(
      'UNBOUND_PROMPT_SNAPSHOT',
      'promptDigest must remain null until exact prompt snapshot bytes are content-addressed',
    );
  }
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
  if (usage.assembledPromptTokens.availability === 'available') {
    throw new ReplayContractError(
      'UNBOUND_PROMPT_SNAPSHOT',
      'assembledPromptTokens requires a bound promptDigest and reconstruction evidence, which this ledger schema does not accept',
    );
  }
  for (const key of [
    'knownDispatchInputTokens',
    'providerProcessedInputTokens',
    'uncachedInputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
    'outputTokens',
  ]) {
    const dimension = usage[key];
    if (dimension.availability === 'available') {
      throw new ReplayContractError(
        'UNBOUND_HISTORICAL_METRIC',
        `${key} is numeric but the experiment ledger schema carries no verified evidenceRef/evidenceDigest binding`,
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
  if (input.latencyMs !== null) {
    throw new ReplayContractError(
      'UNBOUND_HISTORICAL_METRIC',
      'latencyMs must remain unavailable until a content-addressed observation is pinned',
    );
  }
  const latencyMs = { availability: 'unavailable', reason: 'Historical replay has no trusted wall-clock observation.' };
  assertObject(input.findingMeasurement, 'findingMeasurement');
  if (canonicalJson(Object.keys(input.findingMeasurement).sort()) !== canonicalJson([
    'detectedCount', 'reasonCode', 'seededOracleCount', 'status',
  ])) {
    throw new ReplayContractError('INVALID_LEDGER_RECORD', 'findingMeasurement shape invalid');
  }
  count(input.findingMeasurement.seededOracleCount, 'findingMeasurement.seededOracleCount');
  if (input.findingMeasurement.detectedCount !== null
      || input.findingMeasurement.status !== 'INCONCLUSIVE'
      || !['FINDING_OUTPUT_UNAVAILABLE', 'ADJUDICATION_EVIDENCE_UNVERIFIED'].includes(input.findingMeasurement.reasonCode)) {
    throw new ReplayContractError('UNBOUND_FINDING_OUTPUT', 'findingMeasurement must remain INCONCLUSIVE without output evidence');
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
    scanForbidden(Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== 'gateEvidence'),
    ));
    if (canonicalJson(Object.keys(row).sort()) !== canonicalJson(STORED_RECORD_KEYS)) {
      throw new ReplayContractError('INVALID_LEDGER_RECORD', 'stored row has missing or extra fields');
    }
    if (row.schemaVersion !== LEDGER_SCHEMA || row.namespace !== 'experiment-only' || row.gateEvidence !== false) {
      throw new ReplayContractError('FORGED_LEDGER_AUTHORITY', 'ledger row is not an experiment-only record');
    }
    const rebuilt = makeLedgerRecord({
      experimentId: row.experimentId,
      cellId: row.cellId,
      ledgerCallId: row.ledgerCallId,
      attemptId: row.attemptId,
      sequence: row.sequence,
      event: row.event,
      disposition: row.disposition,
      observedAt: row.observedAt,
      inputDigest: row.inputDigest,
      promptDigest: row.promptDigest,
      materialDigest: row.materialDigest,
      findingSetDigest: row.findingSetDigest,
      modelId: row.modelId,
      contractVersion: row.contractVersion,
      usage: row.usage,
      latencyMs: row.latency?.availability === 'unavailable' ? null : row.latency?.value,
      findingMeasurement: row.findingMeasurement,
    }, row.previousRecordHash, row.supersedesRecordIds);
    if (canonicalJson(rebuilt) !== canonicalJson(row)) {
      throw new ReplayContractError('INVALID_LEDGER_RECORD', 'stored row does not match the canonical validated shape');
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

function parseLedgerText(text) {
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

export async function readLedger(relativePath) {
  const target = await resolveLedgerPath(relativePath);
  let text;
  try {
    text = await readFile(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return parseLedgerText(text);
}

async function assertParentIdentity(parentHandle, parentPath) {
  const held = await parentHandle.stat();
  if (!held.isDirectory()) {
    throw new ReplayContractError('LEDGER_PATH_ESCAPE', 'ledger parent descriptor is not a directory');
  }
  let current;
  let canonical;
  try {
    [current, canonical] = await Promise.all([lstat(parentPath), realpath(parentPath)]);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ReplayContractError('LEDGER_PATH_ESCAPE', 'ledger parent directory disappeared');
    }
    throw error;
  }
  if (current.isSymbolicLink() || !current.isDirectory()
      || current.dev !== held.dev || current.ino !== held.ino
      || canonical !== path.resolve(parentPath)) {
    throw new ReplayContractError('LEDGER_PATH_ESCAPE', 'ledger parent directory identity changed');
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function recoverStaleLock(lockPath, parentHandle, parentPath) {
  await assertParentIdentity(parentHandle, parentPath);
  let pathStat;
  let handle;
  try {
    pathStat = await lstat(lockPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) return false;
    handle = await open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const held = await handle.stat();
    if (held.dev !== pathStat.dev || held.ino !== pathStat.ino) return false;
    const text = await handle.readFile('utf8');
    let owner;
    try {
      owner = JSON.parse(text);
    } catch {
      owner = null;
    }
    const validOwner = owner
      && Number.isSafeInteger(owner.pid) && owner.pid > 0
      && typeof owner.createdAt === 'string' && Number.isFinite(Date.parse(owner.createdAt))
      && typeof owner.lockId === 'string' && /^[a-f0-9-]{36}$/.test(owner.lockId)
      && canonicalJson(Object.keys(owner).sort()) === canonicalJson(['createdAt', 'lockId', 'pid']);
    const ageMs = Date.now() - pathStat.mtimeMs;
    const ownerAgeMs = validOwner ? Date.now() - Date.parse(owner.createdAt) : -1;
    const reclaimable = validOwner
      ? !processIsAlive(owner.pid) && ageMs >= 250 && ownerAgeMs >= 250
      : ageMs >= 30_000;
    if (!reclaimable) return false;
    await assertParentIdentity(parentHandle, parentPath);
    const current = await lstat(lockPath);
    if (current.dev !== held.dev || current.ino !== held.ino) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function acquireLedgerLock(target, parentHandle, parentPath) {
  const lockPath = `${target}.lock`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await assertParentIdentity(parentHandle, parentPath);
      const handle = await open(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await assertParentIdentity(parentHandle, parentPath);
        const owner = {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          lockId: randomUUID(),
        };
        await handle.writeFile(`${canonicalJson(owner)}\n`, 'utf8');
        await handle.sync();
        return { handle, lockPath, lockId: owner.lockId };
      } catch (error) {
        await handle.close();
        try {
          await unlink(lockPath);
        } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        }
        throw error;
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await recoverStaleLock(lockPath, parentHandle, parentPath)) continue;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw new ReplayContractError('LEDGER_LOCK_TIMEOUT', 'experiment ledger lock remained busy');
}

async function releaseLedgerLock(lock) {
  const held = await lock.handle.stat();
  await lock.handle.close();
  try {
    const current = await lstat(lock.lockPath);
    if (current.dev === held.dev && current.ino === held.ino) await unlink(lock.lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function appendLedgerRecord(relativePath, input, hooks = {}) {
  const target = await resolveLedgerPath(relativePath);
  const parentPath = path.dirname(target);
  await mkdir(parentPath, { recursive: true });
  await assertNoSymlinkEscape(target);
  let parentHandle;
  try {
    parentHandle = await open(
      parentPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new ReplayContractError('LEDGER_PATH_ESCAPE', 'ledger parent became a symlink');
    }
    throw error;
  }
  await assertParentIdentity(parentHandle, parentPath);
  let lock;
  try {
    lock = await acquireLedgerLock(target, parentHandle, parentPath);
    if (hooks.afterLockAcquired) await hooks.afterLockAcquired();
    await assertParentIdentity(parentHandle, parentPath);
    await assertNoSymlinkEscape(target);
    let handle;
    try {
      handle = await open(
        target,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (error?.code === 'ELOOP') throw new ReplayContractError('LEDGER_PATH_ESCAPE', 'ledger target became a symlink');
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ReplayContractError('LEDGER_PATH_ESCAPE', 'ledger target is not a regular file');
      await assertParentIdentity(parentHandle, parentPath);
      const expectedPath = path.resolve(target);
      const openedPath = await realpath(target);
      const pathStat = await lstat(target);
      if (openedPath !== expectedPath || pathStat.isSymbolicLink()
          || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
        throw new ReplayContractError(
          'LEDGER_PATH_ESCAPE',
          `opened ledger descriptor does not match canonical target: ${openedPath}`,
        );
      }
      const text = await handle.readFile({ encoding: 'utf8' });
      const rows = parseLedgerText(text);
      const state = verifyLedgerRows(rows);
      const attemptRows = rows.filter(row => row.experimentId === input.experimentId
        && row.cellId === input.cellId
        && row.ledgerCallId === input.ledgerCallId
        && row.attemptId === input.attemptId);
      const supersedes = input.event === 'terminal' ? attemptRows.map(row => row.recordId) : [];
      const record = makeLedgerRecord(input, state.lastRecordHash, supersedes);
      verifyLedgerRows([...rows, record]);
      await assertParentIdentity(parentHandle, parentPath);
      await handle.write(`${canonicalJson(record)}\n`, null, 'utf8');
      await handle.sync();
      return record;
    } finally {
      await handle.close();
    }
  } finally {
    try {
      if (lock) await releaseLedgerLock(lock);
    } finally {
      await parentHandle.close();
    }
  }
}

export function summarizeLedger(rows) {
  const checked = verifyLedgerRows(rows);
  const terminal = rows.filter(row => row.event === 'terminal');
  const attempts = [...checked.attempts.values()];
  const incompleteAttempts = attempts.filter(state => !state.terminal).length;
  const availableProviderDimensions = terminal
    .map(row => row.usage.providerProcessedInputTokens)
    .filter(dimension => dimension.availability === 'available');
  const allProviderDimensionsAvailable = terminal.length > 0
    && availableProviderDimensions.length === terminal.length;
  const someProviderDimensionsAvailable = availableProviderDimensions.length > 0;
  const finalProviderInputTokens = allProviderDimensionsAvailable
    ? availableProviderDimensions.reduce((sum, dimension) => sum + dimension.tokens, 0)
    : null;
  const providerInputAvailability = allProviderDimensionsAvailable
    ? 'available'
    : someProviderDimensionsAvailable ? 'partial-or-unavailable' : 'unavailable';
  const providerInputUnavailableReason = allProviderDimensionsAvailable
    ? null
    : terminal.length === 0
      ? 'NO_TERMINAL_ATTEMPTS'
      : someProviderDimensionsAvailable
        ? 'PROVIDER_INPUT_TOKENS_PARTIAL'
        : 'PROVIDER_INPUT_TOKENS_UNAVAILABLE';
  return {
    schemaVersion: 'proof-or-stop.role-prompt-ab.experiment-summary.v1',
    gateEvidence: false,
    records: rows.length,
    attempts: attempts.length,
    terminalAttempts: terminal.length,
    incompleteAttempts,
    finalProviderInputTokens,
    providerInputAvailability,
    providerInputUnavailableReason,
  };
}

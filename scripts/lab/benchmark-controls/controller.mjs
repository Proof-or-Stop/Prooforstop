import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const dimensions = ['calls', 'cachedInput', 'uncachedInput', 'output'];
const tokenDimensions = dimensions.slice(1);
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const text = value => typeof value === 'string' && value.length > 0;
const number = value => Number.isSafeInteger(value) && value >= 0;
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new Error('invalid_json');
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function validLimits(value) {
  return plain(value) && dimensions.every(key => number(value[key]));
}
function normalizeUsage(raw) {
  if (!plain(raw) || !['input_tokens', 'cached_input_tokens', 'output_tokens'].every(k => number(raw[k])) ||
      raw.cached_input_tokens > raw.input_tokens ||
      (raw.reasoning_output_tokens !== undefined && (!number(raw.reasoning_output_tokens) || raw.reasoning_output_tokens > raw.output_tokens))) return null;
  // Cached input and reasoning output are SUBSETS, not extra tokens.
  return { cachedInput: raw.cached_input_tokens, uncachedInput: raw.input_tokens - raw.cached_input_tokens,
    output: raw.output_tokens };
}
function executionKey(request) {
  if (!plain(request) || !['task', 'candidate', 'policy', 'cwd', 'witness', 'provider', 'source', 'partition'].every(k => text(request[k])) ||
      !Array.isArray(request.command) || request.command.length === 0 || !request.command.every(text) ||
      !plain(request.ceiling) || !tokenDimensions.every(k => number(request.ceiling[k]))) throw new Error('invalid_request');
  return hash(Object.fromEntries(['task', 'candidate', 'policy', 'cwd', 'command', 'witness', 'provider'].map(k => [k, request[k]])));
}

/** In-process Lab boundary. All adapters in this experiment must enter here.
 * Production use needs durable reservations/outbox, provider upper bounds and
 * complete upstream witness fingerprints. A token ceiling alone is no guarantee
 * that an uncooperative external provider will obey it.
 */
export function createController(config) {
  if (!plain(config) || !validLimits(config.limits) || !plain(config.partitions) ||
      !Object.values(config.partitions).every(validLimits) || !number(config.maxWallMs) ||
      !number(config.maxContextBytes)) throw new Error('invalid_budget');
  const cfg = structuredClone(config);
  const started = performance.now();
  const executions = new Map(); const responseIds = new Set(); const rows = [];
  let fingerprint; let invalid = false; let externalBlock = false; let stopped = null;
  function observe(event) {
    let next;
    try {
      if (!plain(event) || event.verified !== true || !['task', 'phase', 'candidate', 'policy'].every(k => text(event[k])) ||
          !plain(event.execution) || !text(event.execution.id) ||
          !['running', 'completed', 'failed', 'cancelled', 'idle'].includes(event.execution.status) ||
          !(event.blocker === null || (plain(event.blocker) && text(event.blocker.code) && text(event.blocker.binding) && plain(event.blocker.dependencies)))) throw new Error('invalid_observation');
      next = hash({ task: event.task, phase: event.phase, candidate: event.candidate, policy: event.policy,
        blocker: event.blocker, execution: { id: event.execution.id, status: event.execution.status } });
    } catch {
      const wake = !invalid; invalid = true;
      return { wake, reason: 'invalid_observation' };
    }
    const wake = invalid || next !== fingerprint;
    const reason = invalid ? 'observation_recovered' : fingerprint === undefined ? 'initialization' : wake ? 'relevant_change' : 'unchanged';
    invalid = false; fingerprint = next; externalBlock = event.blocker !== null;
    return { wake, reason, state: externalBlock ? 'BLOCKED_EXTERNAL' : 'READY', fingerprint };
  }
  function fits(ceiling, partition) {
    for (const [budget, relevant] of [[cfg.limits, rows], [cfg.partitions[partition], rows.filter(r => r.partition === partition)]]) {
      for (const dimension of dimensions) {
        const consumed = relevant.reduce((n, r) => n + (dimension === 'calls' ? 1 : (r.usage ?? r.ceiling)[dimension]), 0);
        if (consumed + ceiling[dimension] > budget[dimension]) return false;
      }
    }
    return true;
  }
  function run(input, execute) {
    let request; let key;
    try { request = structuredClone(input); key = executionKey(request); }
    catch { return Promise.resolve({ status: 'blocked', reason: 'invalid_request' }); }
    // Collect existing work even after a later budget/external block. Never relaunch.
    if (executions.has(key)) return executions.get(key);
    if (invalid || externalBlock) return Promise.resolve({ status: 'blocked', reason: invalid ? 'invalid_observation' : 'external_dependency' });
    if (stopped) return Promise.resolve({ status: 'blocked', reason: stopped });
    const remaining = cfg.maxWallMs - (performance.now() - started);
    if (remaining <= 0) return Promise.resolve({ status: 'blocked', reason: 'wall_budget' });
    if (!Object.hasOwn(cfg.partitions, request.partition)) return Promise.resolve({ status: 'blocked', reason: 'unknown_partition' });
    const ceiling = { calls: 1, ...Object.fromEntries(tokenDimensions.map(k => [k, request.ceiling[k]])) };
    if (!fits(ceiling, request.partition)) return Promise.resolve({ status: 'blocked', reason: 'budget_exhausted' });
    // Reserve synchronously BEFORE invoking the adapter or yielding to another request.
    const row = { executionKey: key, source: request.source, provider: request.provider, partition: request.partition,
      ceiling, usage: null, status: 'running', responseId: null, overrun: false };
    rows.push(row);
    const promise = Promise.resolve().then(async () => {
      const abort = new AbortController(); let timer;
      try {
        const timeLeft = cfg.maxWallMs - (performance.now() - started);
        if (timeLeft <= 0) throw new Error('wall_budget');
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
          abort.abort(); reject(new Error('wall_budget'));
        }, timeLeft); });
        const result = await Promise.race([Promise.resolve().then(() => execute({ signal: abort.signal,
          ceiling: structuredClone(ceiling), executionKey: key })), timeout]);
        const identity = text(result?.responseId) ? hash([request.provider, result.responseId]) : null;
        const duplicate = identity !== null && responseIds.has(identity);
        if (identity) responseIds.add(identity);
        row.responseId = identity ? result.responseId : null;
        row.usage = identity && !duplicate ? normalizeUsage(result.usage) : null;
        row.status = 'completed';
        row.overrun = row.usage !== null && tokenDimensions.some(k => row.usage[k] > ceiling[k]);
        if (row.usage === null) stopped = duplicate ? 'duplicate_response_identity' : 'unknown_usage';
        if (row.overrun) stopped = 'provider_overrun';
        return { status: 'completed', executionKey: key, accounting: stopped ?? 'known' };
      } catch (error) {
        row.status = 'failed'; row.error = error.message; stopped = 'unknown_usage';
        return { status: 'failed', executionKey: key, error: error.message };
      } finally { clearTimeout(timer); }
    });
    executions.set(key, promise);
    return promise;
  }
  function context(state) {
    const keys = ['task', 'phase', 'blocker', 'decision', 'logRefs'];
    if (!plain(state) || Object.keys(state).length !== keys.length || !keys.every(k => Object.hasOwn(state, k)) ||
        !['task', 'phase', 'decision'].every(k => text(state[k])) || !(state.blocker === null || text(state.blocker)) ||
        !Array.isArray(state.logRefs) || !state.logRefs.every(text)) throw new Error('invalid_context');
    const value = JSON.stringify(state);
    if (Buffer.byteLength(value, 'utf8') > cfg.maxContextBytes) throw new Error('context_budget');
    return value; // Never truncate decision facts to make a request fit.
  }
  return { observe, run, context, ledger: () => structuredClone(rows) };
}

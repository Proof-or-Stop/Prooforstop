import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveValidationCommandEnvironment } from './validation-command-environment.js';

/**
 * CausalEvidence is deliberately a small, dependency-light boundary.  The
 * checklist and validator handlers adapt their existing stores/executors to
 * this API; the key, receipt, preflight, dependency, and metric rules live
 * here so a second caller cannot accidentally create a weaker identity.
 */
export const CAUSAL_EVIDENCE_SCHEMA = 'proofbound.causal-evidence-receipt.v1' as const;
export const CAUSAL_EXECUTION_KEY_SCHEMA = 'proofbound.causal-execution-key.v1' as const;
export const CAUSAL_SELECTOR_POLICY_SCHEMA = 'proofbound.causal-selector-policy.v1' as const;
export const CAUSAL_LEDGER_SCHEMA = 'proofbound.causal-evidence-ledger.v1' as const;
export const CAUSAL_PREFLIGHT_SCHEMA = 'proofbound.causal-evidence-preflight.v1' as const;
export const CAUSAL_DEPENDENCY_SCHEMA = 'proofbound.causal-dependency-decision.v1' as const;
export const CAUSAL_RECEIPT_DIRECTORY = 'causal-evidence/receipts';
export const CAUSAL_RECEIPT_INDEX_FILE = 'causal-evidence/index.json';
export const CAUSAL_OUTPUT_TAIL_CHARS = 4_000;
export const CAUSAL_MAX_OUTPUT_CHARS = 12_000;

export const CAUSAL_DEPENDENCY_DOMAINS = [
  'source',
  'test',
  'build-input',
  'manifest-semantic',
  'integration',
  'review-subject',
] as const;

export type CausalDependencyDomain = (typeof CAUSAL_DEPENDENCY_DOMAINS)[number];
export type CausalReceiptStatus = 'pass' | 'fail' | 'timeout' | 'cancelled' | 'partial';

/** Stable, structured command identity. Selector text is intentionally absent. */
export interface CausalCommandSpec {
  executable: string;
  args: string[];
  shell?: boolean;
  env?: Record<string, string>;
}

export interface CausalExecutionIdentityInput {
  storyId: string;
  cwd: string;
  command: CausalCommandSpec | string;
  bootstrap?: CausalCommandSpec | string | null;
  /** Explicit command inputs. An omitted value is incomplete; {} is explicit. */
  inputs?: unknown;
  storyFilesHash?: string;
  effectiveEnvironment?: Record<string, string>;
  runtimeVersion?: string;
  toolVersion?: string;
  /** Structured selector policy; individual selector IDs are not key material. */
  selectorPolicy?: unknown;
}

export interface CausalExecutionIdentity {
  schemaVersion: typeof CAUSAL_EXECUTION_KEY_SCHEMA;
  storyId: string;
  cwd: string;
  command: CausalCommandSpec;
  bootstrap: CausalCommandSpec | null;
  inputs: unknown;
  storyFilesHash: string;
  effectiveEnvironment: Record<string, string>;
  runtimeVersion: string;
  toolVersion: string;
  selectorPolicyDigest: string;
  complete: boolean;
}

export interface CausalExecutionKey {
  key: string;
  identity: CausalExecutionIdentity;
  identityDigest: string;
  reusable: boolean;
  incompleteReasons: string[];
}

export interface CausalCommandResult {
  code: number;
  output: string;
  timedOut?: boolean;
  cancelled?: boolean;
  partial?: boolean;
  durationMs?: number;
  timeoutMs?: number;
}

export interface CausalEvidenceReceipt {
  schemaVersion: typeof CAUSAL_EVIDENCE_SCHEMA;
  storyId: string;
  executionKey: string;
  identityDigest: string;
  identity: CausalExecutionIdentity;
  status: CausalReceiptStatus;
  exitCode: number;
  outputDigest: string;
  outputTail: string;
  /** A bounded prefix+tail probe used for independent selector verdicts. */
  outputProbe: string;
  outputLength: number;
  executedAt: string;
  durationMs?: number;
  timeoutMs?: number;
  /** Receipt hash excludes this field, like a normal CAS self-address. */
  receiptHash: string;
  /** Only complete identities can be used as a cached PASS. */
  reusable: boolean;
  commandReruns: 0;
}

export interface CausalEvidenceReceiptStore {
  readCausalEvidenceReceipt(storyId: string, executionKey: string): CausalEvidenceReceipt | null;
  writeCausalEvidenceReceipt(storyId: string, receipt: CausalEvidenceReceipt): void;
  /**
   * Optional cross-request single-flight boundary. The callback must re-read
   * the receipt before executing so callers that missed the initial read can
   * converge on the first request's receipt.
   */
  withCausalEvidenceExecution?<T>(
    storyId: string,
    executionKey: string,
    fn: () => Promise<T>,
  ): Promise<T>;
}

export interface CausalSelectorVerdict {
  intentRef?: string;
  selector: string;
  matched: boolean;
  result: 'pass' | 'fail';
  reason?: 'selectorMismatch' | 'executionFailure' | 'receiptInvalid' | 'legacyIdentity';
  executionKey: string;
  receiptHash?: string;
}

export interface CausalExecutionLedgerEntry {
  executionKey: string;
  identityDigest: string;
  receiptHash?: string;
  disposition: 'executed' | 'reused';
  executionAttempts: number;
}

export interface CausalEvidenceLedger {
  schemaVersion: typeof CAUSAL_LEDGER_SCHEMA;
  intentCount: number;
  executions: CausalExecutionLedgerEntry[];
  selectorVerdicts: CausalSelectorVerdict[];
  commitFailureReruns: number;
  unrelatedSpecializedRerun: number;
  affectedNodeRerun: number;
  falseFresh: number;
  _hash: string;
}

export interface CausalEvidenceMetrics {
  intentCount: number;
  uniqueExecutionKeys: number;
  commandExecutions: number;
  cacheHitRate: number;
  commandReruns: number;
  commitFailureReruns: number;
  unrelatedSpecializedRerun: number;
  affectedNodeRerun: number;
  falseFresh: number;
}

export interface CausalEvidenceBatch {
  executions: Map<string, Promise<CausalEvidenceReceipt>>;
  ledger: CausalEvidenceLedger;
}

export const DEFAULT_CAUSAL_SELECTOR_POLICY = Object.freeze({
  schemaVersion: CAUSAL_SELECTOR_POLICY_SCHEMA,
  matcher: 'literal-output-inclusion',
  output: 'bounded-redacted-tail',
  verdicts: ['pass', 'selectorMismatch', 'executionFailure'],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Deterministic JSON used for every digest in this module. */
export function causalCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(causalCanonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${causalCanonical(item)}`)
    .join(',')}}`;
}

export function causalDigest(value: unknown): string {
  return createHash('sha256').update(causalCanonical(value)).digest('hex');
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(causalCanonical(value)) as T;
}

function normalizeCommand(command: CausalCommandSpec | string | null | undefined): CausalCommandSpec | null {
  if (!command) return null;
  if (typeof command === 'string') {
    const parsed = parseCommandString(command);
    return { executable: parsed.executable, args: [...parsed.args] };
  }
  if (!isRecord(command) || typeof command.executable !== 'string' || !Array.isArray(command.args)) return null;
  if (!command.args.every(arg => typeof arg === 'string')) return null;
  return {
    executable: command.executable,
    args: command.args.map(String),
    ...(command.shell !== undefined ? { shell: Boolean(command.shell) } : {}),
    ...(command.env ? { env: redactEnvironment(command.env as Record<string, unknown>) } : {}),
  };
}

function parseCommandString(command: string): { executable: string; args: string[] } {
  const tokens: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | null = null;
  let hasToken = false;
  for (const char of command.trim()) {
    if (quote === 'single') {
      if (char === "'") quote = null;
      else token += char;
      hasToken = true;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      else token += char;
      hasToken = true;
      continue;
    }
    if (char === "'") { quote = 'single'; hasToken = true; continue; }
    if (char === '"') { quote = 'double'; hasToken = true; continue; }
    if (/\s/.test(char)) {
      if (hasToken) { tokens.push(token); token = ''; hasToken = false; }
      continue;
    }
    token += char;
    hasToken = true;
  }
  if (quote) throw new Error('causal command has an unterminated quote');
  if (hasToken) tokens.push(token);
  if (tokens.length === 0) throw new Error('causal command is empty');
  const [executable, ...args] = tokens;
  return { executable, args };
}

const REDACTED = '<redacted>';
const SECRET_ENV_KEY = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|authorization|auth)/i;
const TRANSPORT_ENV_KEY = /^(?:PWD|OLDPWD|SHLVL|_|TERM_SESSION_ID|.*SESSION(?:_ID)?|LATTICE_ACTIVITY_.*)$/i;

/** Redact values without ever copying credential material into a key/receipt. */
export function redactEnvironment(environment: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(environment)) {
    if (rawValue === undefined) continue;
    const key = rawKey.toUpperCase();
    if (TRANSPORT_ENV_KEY.test(key)) continue;
    result[key] = SECRET_ENV_KEY.test(key) ? REDACTED : String(rawValue);
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function realCanonicalCwd(cwd: string): string | null {
  try {
    return realpathSync(cwd);
  } catch { // PROBE: a missing cwd makes the identity incomplete and non-reusable.
    return null;
  }
}

function selectorPolicyDigest(policy: unknown): string {
  return causalDigest(policy ?? DEFAULT_CAUSAL_SELECTOR_POLICY);
}

export function createCausalExecutionKey(input: CausalExecutionIdentityInput): CausalExecutionKey {
  const cwd = realCanonicalCwd(input.cwd);
  const command = normalizeCommand(input.command);
  const bootstrap = normalizeCommand(input.bootstrap);
  const incompleteReasons: string[] = [];
  if (!cwd) incompleteReasons.push('cwd_unavailable');
  if (!command) incompleteReasons.push('command_spec_incomplete');
  if (!Object.prototype.hasOwnProperty.call(input, 'inputs')) incompleteReasons.push('inputs_missing');
  if (typeof input.storyFilesHash !== 'string') incompleteReasons.push('storyFilesHash_missing');
  if (!input.effectiveEnvironment) incompleteReasons.push('effective_environment_missing');
  if (!input.runtimeVersion) incompleteReasons.push('runtime_version_missing');
  if (!input.toolVersion) incompleteReasons.push('tool_version_missing');
  if (!Object.prototype.hasOwnProperty.call(input, 'selectorPolicy')) incompleteReasons.push('selector_policy_missing');

  const identity: CausalExecutionIdentity = {
    schemaVersion: CAUSAL_EXECUTION_KEY_SCHEMA,
    storyId: input.storyId,
    cwd: cwd ?? input.cwd,
    command: command ?? { executable: '<incomplete>', args: [] },
    bootstrap,
    inputs: cloneCanonical(input.inputs ?? null),
    storyFilesHash: input.storyFilesHash ?? '<missing>',
    effectiveEnvironment: redactEnvironment(input.effectiveEnvironment ?? {}),
    runtimeVersion: input.runtimeVersion ?? '<missing>',
    toolVersion: input.toolVersion ?? '<missing>',
    selectorPolicyDigest: selectorPolicyDigest(input.selectorPolicy),
    complete: incompleteReasons.length === 0,
  };
  const identityDigest = causalDigest(identity);
  return {
    key: `ce:v1:${identityDigest}`,
    identity,
    identityDigest,
    reusable: identity.complete,
    incompleteReasons,
  };
}

/** Build the exact environment used by the existing command runner. */
export function effectiveCausalEnvironment(
  overlay: Record<string, string> | undefined,
  cwd: string,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return effectiveValidationCommandEnvironment(processEnvironment, overlay, cwd);
}

export function resolveCausalToolVersion(projectRoot: string): string | undefined {
  const packagePaths = [
    join(projectRoot, 'packages', 'main', 'package.json'),
    join(process.cwd(), 'packages', 'main', 'package.json'),
  ].filter((path, index, paths) => paths.indexOf(path) === index);
  for (const packagePath of packagePaths) {
    if (!existsSync(packagePath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch { // PROBE: an unreadable tool manifest is skipped; no version is fabricated.
      continue;
    }
  }
  return undefined;
}

export function serializeCausalReceipt(receipt: CausalEvidenceReceipt): string {
  const { receiptHash: _ignored, ...payload } = receipt;
  return causalCanonical(payload);
}

export function computeCausalReceiptHash(receipt: CausalEvidenceReceipt): string {
  return createHash('sha256').update(serializeCausalReceipt(receipt)).digest('hex');
}

export function verifyCausalEvidenceReceipt(
  receipt: CausalEvidenceReceipt | null | undefined,
  expectedKey?: string,
): boolean {
  if (!receipt || receipt.schemaVersion !== CAUSAL_EVIDENCE_SCHEMA) return false;
  if (expectedKey && receipt.executionKey !== expectedKey) return false;
  if (!receipt.receiptHash || receipt.receiptHash !== computeCausalReceiptHash(receipt)) return false;
  if (typeof receipt.outputProbe !== 'string' || receipt.outputProbe.length > CAUSAL_MAX_OUTPUT_CHARS) return false;
  if (receipt.identity.schemaVersion !== CAUSAL_EXECUTION_KEY_SCHEMA) return false;
  if (receipt.identityDigest !== causalDigest(receipt.identity)) return false;
  if (receipt.executionKey !== `ce:v1:${receipt.identityDigest}`) return false;
  if (receipt.storyId !== receipt.identity.storyId) return false;
  if (receipt.identity.complete !== receipt.reusable) return false;
  if (receipt.commandReruns !== 0) return false;
  if (!['pass', 'fail', 'timeout', 'cancelled', 'partial'].includes(receipt.status)) return false;
  return true;
}

function statusForRun(run: CausalCommandResult): CausalReceiptStatus {
  if (run.cancelled) return 'cancelled';
  if (run.partial) return 'partial';
  if (run.timedOut) return 'timeout';
  return run.code === 0 ? 'pass' : 'fail';
}

function boundedOutputTail(output: string): string {
  return output.length <= CAUSAL_OUTPUT_TAIL_CHARS ? output : output.slice(-CAUSAL_OUTPUT_TAIL_CHARS);
}

function boundedOutputProbe(output: string): string {
  if (output.length <= CAUSAL_MAX_OUTPUT_CHARS) return output;
  const half = Math.floor(CAUSAL_MAX_OUTPUT_CHARS / 2);
  return `${output.slice(0, half)}\n<causal-output-gap>\n${output.slice(-half)}`;
}

function redactCausalOutput(output: string, effectiveEnvironment: Record<string, string>): string {
  let redacted = String(output ?? '');
  for (const value of Object.values(effectiveEnvironment)) {
    if (value.length >= 8 && value !== REDACTED) redacted = redacted.split(value).join(REDACTED);
  }
  return redacted
    .replace(/(authorization\s*[:=]\s*|bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/((?:token|secret|password|passwd|api[_-]?key|credential)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`);
}

function recordExecution(batch: CausalEvidenceBatch | undefined, entry: CausalExecutionLedgerEntry): void {
  if (!batch) return;
  const prior = batch.ledger.executions.find(item => item.executionKey === entry.executionKey);
  if (prior) {
    prior.executionAttempts += entry.executionAttempts;
    if (prior.disposition === 'reused' && entry.disposition === 'executed') prior.disposition = 'executed';
    if (!prior.receiptHash) prior.receiptHash = entry.receiptHash;
  } else {
    batch.ledger.executions.push({ ...entry });
  }
}

export function createCausalEvidenceBatch(): CausalEvidenceBatch {
  const ledgerWithoutHash = {
    schemaVersion: CAUSAL_LEDGER_SCHEMA,
    intentCount: 0,
    executions: [],
    selectorVerdicts: [],
    commitFailureReruns: 0,
    unrelatedSpecializedRerun: 0,
    affectedNodeRerun: 0,
    falseFresh: 0,
  } satisfies Omit<CausalEvidenceLedger, '_hash'>;
  return {
    executions: new Map(),
    ledger: { ...ledgerWithoutHash, _hash: causalDigest(ledgerWithoutHash) },
  };
}

function refreshLedgerHash(batch: CausalEvidenceBatch): void {
  const { _hash: _ignored, ...payload } = batch.ledger;
  batch.ledger._hash = causalDigest(payload);
}

export function verifyCausalEvidenceLedger(ledger: CausalEvidenceLedger): boolean {
  const { _hash: _ignored, ...payload } = ledger;
  return ledger.schemaVersion === CAUSAL_LEDGER_SCHEMA && ledger._hash === causalDigest(payload);
}

function selectorVerdict(
  receipt: CausalEvidenceReceipt,
  selector: string,
  intentRef?: string,
): CausalSelectorVerdict {
  const matched = receipt.outputProbe.includes(selector) || receipt.outputTail.includes(selector)
    || (receipt.status === 'pass' && selector.length === 0);
  const result = receipt.status === 'pass' && matched ? 'pass' : 'fail';
  return {
    ...(intentRef ? { intentRef } : {}),
    selector,
    matched,
    result,
    ...(result === 'pass'
      ? {}
      : { reason: !matched ? 'selectorMismatch' as const : receipt.status === 'pass' ? 'selectorMismatch' as const : 'executionFailure' as const }),
    executionKey: receipt.executionKey,
    receiptHash: receipt.receiptHash,
  };
}

export interface ExecuteCausalEvidenceArgs {
  identity: CausalExecutionIdentityInput;
  selector: string;
  intentRef?: string;
  run: () => Promise<CausalCommandResult>;
  receiptStore?: CausalEvidenceReceiptStore;
  batch?: CausalEvidenceBatch;
  preflight?: CausalPreflightReport;
  /** Required atomic state check immediately before the child runner is called. */
  revalidateBeforeRun: () => boolean;
}

export interface ExecuteCausalEvidenceResult {
  key: CausalExecutionKey;
  receipt: CausalEvidenceReceipt;
  verdict: CausalSelectorVerdict;
  disposition: 'executed' | 'reused';
}

/** Execute/reuse one key, then evaluate the caller's selector independently. */
export async function executeCausalEvidence(args: ExecuteCausalEvidenceArgs): Promise<ExecuteCausalEvidenceResult> {
  const key = createCausalExecutionKey(args.identity);
  if (!args.preflight || !verifyCausalPreflight(args.preflight)) {
    throw new Error('causal evidence refused: missing_or_forged_preflight commandExecutions=0 evidenceWrites=0 [causal_preflight_invalid]');
  }

  const readReceipt = (): CausalEvidenceReceipt | null => {
    const existing = key.reusable ? args.receiptStore?.readCausalEvidenceReceipt(key.identity.storyId, key.key) : null;
    if (existing && !verifyCausalEvidenceReceipt(existing, key.key)) {
      throw new Error(`causal evidence refused: receipt for ${key.key} is tampered or has the wrong identity [causal_receipt_tampered]`);
    }
    return existing ?? null;
  };

  const existing = readReceipt();
  if (existing && existing.reusable) {
    const verdict = selectorVerdict(existing, args.selector, args.intentRef);
    if (args.batch) {
      args.batch.ledger.intentCount++;
      args.batch.ledger.selectorVerdicts.push(verdict);
      recordExecution(args.batch, {
        executionKey: key.key,
        identityDigest: key.identityDigest,
        receiptHash: existing.receiptHash,
        disposition: 'reused',
        executionAttempts: 0,
      });
      refreshLedgerHash(args.batch);
    }
    return { key, receipt: existing, verdict, disposition: 'reused' };
  }

  // Incomplete identities are intentionally never deduplicated: a legacy or
  // partial identity cannot turn a second selector into a cached PASS.
  const executeFresh = async (): Promise<CausalEvidenceReceipt> => {
      // This check is deliberately the last operation before invoking the child
      // runner. A post-run check can only reject the evidence after the command
      // has already executed, which violates the zero-execution refusal contract.
      if (!args.revalidateBeforeRun) {
        throw new Error('causal preflight refused: missing_last_moment_revalidation commandExecutions=0 evidenceWrites=0 [causal_preflight_refused]');
      }
      if (!args.revalidateBeforeRun()) {
        throw new Error('causal preflight refused: state_changed_before_launch commandExecutions=0 evidenceWrites=0 [causal_preflight_refused]');
      }
      const run = await args.run();
      const redactedOutput = redactCausalOutput(run.output, key.identity.effectiveEnvironment);
      const receiptWithoutHash: Omit<CausalEvidenceReceipt, 'receiptHash'> = {
        schemaVersion: CAUSAL_EVIDENCE_SCHEMA,
        storyId: key.identity.storyId,
        executionKey: key.key,
        identityDigest: key.identityDigest,
        identity: key.identity,
        status: statusForRun(run),
        exitCode: run.timedOut ? 124 : run.code,
        // The digest is non-reversible and remains over the complete observed
        // command output for compatibility; persisted bytes are redacted and bounded.
        outputDigest: createHash('sha256').update(run.output).digest('hex'),
        outputTail: boundedOutputTail(redactedOutput),
        outputProbe: boundedOutputProbe(redactedOutput),
        outputLength: run.output.length,
        executedAt: new Date().toISOString(),
        ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
        ...(run.timeoutMs !== undefined ? { timeoutMs: run.timeoutMs } : {}),
        reusable: key.reusable,
        commandReruns: 0,
      };
      const receipt = {
        ...receiptWithoutHash,
        receiptHash: computeCausalReceiptHash(receiptWithoutHash as CausalEvidenceReceipt),
      } as CausalEvidenceReceipt;
      if (args.receiptStore && key.reusable) {
        args.receiptStore.writeCausalEvidenceReceipt(key.identity.storyId, receipt);
      }
      return receipt;
  };

  type ExecutionOutcome = {
    receipt: CausalEvidenceReceipt;
    disposition: 'executed' | 'reused';
  };
  let execution: Promise<ExecutionOutcome>;
  const batchPromise = key.reusable ? args.batch?.executions.get(key.key) : undefined;
  if (batchPromise) {
    // Preserve the existing per-batch dedup semantics. A batch hit is always a
    // reuse from this caller's perspective, regardless of who created it.
    execution = batchPromise.then(receipt => ({ receipt, disposition: 'reused' as const }));
  } else if (key.reusable && args.receiptStore?.withCausalEvidenceExecution) {
    // Separate requests do not share `batch`. The store boundary re-reads
    // inside its single-flight region so only the winner can launch the child.
    execution = args.receiptStore.withCausalEvidenceExecution(
      key.identity.storyId,
      key.key,
      async () => {
        const lockedExisting = readReceipt();
        if (lockedExisting && lockedExisting.reusable) {
          return { receipt: lockedExisting, disposition: 'reused' as const };
        }
        return { receipt: await executeFresh(), disposition: 'executed' as const };
      },
    );
  } else {
    execution = executeFresh().then(receipt => ({ receipt, disposition: 'executed' as const }));
  }
  if (key.reusable && args.batch && !batchPromise) {
    const batchReceipt = execution.then(({ receipt }) => receipt);
    // The caller awaits `execution` directly. Observe the derived promise too
    // so a failed first execution cannot become an unhandled rejection merely
    // because the batch cache retains the same failure for later callers.
    void batchReceipt.catch(() => undefined);
    args.batch.executions.set(key.key, batchReceipt);
  }
  const { receipt, disposition } = await execution;
  const verdict = selectorVerdict(receipt, args.selector, args.intentRef);
  if (args.batch) {
    args.batch.ledger.intentCount++;
    args.batch.ledger.selectorVerdicts.push(verdict);
    recordExecution(args.batch, {
      executionKey: key.key,
      identityDigest: key.identityDigest,
      receiptHash: receipt.receiptHash,
      disposition,
      executionAttempts: disposition === 'executed' ? 1 : 0,
    });
    refreshLedgerHash(args.batch);
  }
  return { key, receipt, verdict, disposition };
}

export interface CausalPreflightFacts {
  cli?: { available: boolean; path?: string; reason?: string };
  worktree?: { expected: string; actual: string; reason?: string };
  gitIndex?: { readable: boolean; path?: string; expected?: string; actual?: string; reason?: string };
  gitMaterial?: { available: boolean; headHash?: string; materialHash?: string; storyFilesHash?: string; reason?: string };
  writerLease?: { available: boolean; valid: boolean; reason?: string };
  providerCapability?: { required: string[]; available: string[]; reason?: string };
  resources?: { required: Record<string, number>; available: Record<string, number>; reason?: string };
  evidenceTarget?: { writable: boolean; path?: string; probe?: string; reason?: string };
  sideChannel?: { available: boolean; maxOutputChars: number; maxProgressEvents: number };
}

export interface CausalPreflightReport {
  schemaVersion: typeof CAUSAL_PREFLIGHT_SCHEMA;
  ready: boolean;
  checks: Record<string, { status: 'pass' | 'fail'; reason?: string }>;
  failedChecks: string[];
  commandExecutions: 0;
  evidenceWrites: 0;
  readinessHash: string;
}

function preflightFailure(report: Record<string, { status: 'pass' | 'fail'; reason?: string }>, name: string, reason: string): void {
  report[name] = { status: 'fail', reason };
}

export function preflightCausalEvidence(
  facts: CausalPreflightFacts,
  revalidate?: () => boolean,
): CausalPreflightReport {
  const checks: Record<string, { status: 'pass' | 'fail'; reason?: string }> = {};
  if (!facts.cli?.available || !facts.cli.path) preflightFailure(checks, 'cli', facts.cli?.reason ?? 'cli_unavailable');
  else checks.cli = { status: 'pass' };

  if (!facts.worktree?.expected || !facts.worktree.actual) preflightFailure(checks, 'worktree', 'worktree_unavailable');
  else if (facts.worktree.expected !== facts.worktree.actual) preflightFailure(checks, 'worktree', `worktree_mismatch expected=${facts.worktree.expected} actual=${facts.worktree.actual}`);
  else checks.worktree = { status: 'pass' };

  if (!facts.gitIndex?.readable || !facts.gitIndex.path) preflightFailure(checks, 'gitIndex', facts.gitIndex?.reason ?? 'git_index_unavailable');
  else if (facts.gitIndex.expected && facts.gitIndex.actual && facts.gitIndex.expected !== facts.gitIndex.actual) preflightFailure(checks, 'gitIndex', `git_index_mismatch expected=${facts.gitIndex.expected} actual=${facts.gitIndex.actual}`);
  else checks.gitIndex = { status: 'pass' };

  if (!facts.gitMaterial?.available || !facts.gitMaterial.headHash || !facts.gitMaterial.materialHash || !facts.gitMaterial.storyFilesHash) {
    preflightFailure(checks, 'gitMaterial', facts.gitMaterial?.reason ?? 'git_material_unavailable');
  } else checks.gitMaterial = { status: 'pass' };

  if (!facts.writerLease?.available) preflightFailure(checks, 'writerLease', 'writer_unavailable');
  else if (!facts.writerLease.valid) preflightFailure(checks, 'writerLease', `lease_invalid${facts.writerLease.reason ? ` ${facts.writerLease.reason}` : ''}`);
  else checks.writerLease = { status: 'pass' };

  const missingCapability = (facts.providerCapability?.required ?? []).find(cap => !(facts.providerCapability?.available ?? []).includes(cap));
  if (!facts.providerCapability || missingCapability) preflightFailure(checks, 'providerCapability', facts.providerCapability?.reason ?? `provider_capability_missing${missingCapability ? ` ${missingCapability}` : ''}`);
  else checks.providerCapability = { status: 'pass' };

  const insufficient = Object.entries(facts.resources?.required ?? {}).find(([name, required]) => (facts.resources?.available[name] ?? 0) < required);
  if (!facts.resources || insufficient) preflightFailure(checks, 'resources', facts.resources?.reason ?? (insufficient ? `insufficient_resources ${insufficient[0]} required=${insufficient[1]} available=${facts.resources?.available[insufficient[0]] ?? 0}` : 'insufficient_resources'));
  else checks.resources = { status: 'pass' };

  if (!facts.evidenceTarget?.writable || !facts.evidenceTarget.path) preflightFailure(checks, 'evidenceTarget', facts.evidenceTarget?.reason ?? `evidence_target_not_writable${facts.evidenceTarget?.path ? ` ${facts.evidenceTarget.path}` : ''}${facts.evidenceTarget?.probe ? ` ${facts.evidenceTarget.probe}` : ''}`);
  else checks.evidenceTarget = { status: 'pass' };

  if (!facts.sideChannel?.available || facts.sideChannel.maxOutputChars <= 0 || facts.sideChannel.maxProgressEvents <= 0) preflightFailure(checks, 'sideChannel', 'bounded_side_channel_unavailable');
  else checks.sideChannel = { status: 'pass' };

  if (Object.values(checks).some(check => check.status === 'fail')) {
    const failedChecks = Object.entries(checks).filter(([, check]) => check.status === 'fail').map(([name, check]) => `${name}:${check.reason}`);
    const payload = { schemaVersion: CAUSAL_PREFLIGHT_SCHEMA, ready: false, checks, failedChecks, commandExecutions: 0 as const, evidenceWrites: 0 as const };
    return { ...payload, ready: false, readinessHash: causalDigest(payload) };
  }
  if (revalidate && !revalidate()) {
    const failedChecks = ['state_changed_before_launch'];
    const payload = { schemaVersion: CAUSAL_PREFLIGHT_SCHEMA, ready: false, checks: { ...checks, atomicRevalidation: { status: 'fail' as const, reason: 'state_changed_before_launch' } }, failedChecks, commandExecutions: 0 as const, evidenceWrites: 0 as const };
    return { ...payload, ready: false, readinessHash: causalDigest(payload) };
  }
  const payload = { schemaVersion: CAUSAL_PREFLIGHT_SCHEMA, ready: true, checks, failedChecks: [] as string[], commandExecutions: 0 as const, evidenceWrites: 0 as const };
  return { ...payload, ready: true, readinessHash: causalDigest(payload) };
}

export function verifyCausalPreflight(report: CausalPreflightReport): boolean {
  const { readinessHash: _ignored, ...payload } = report;
  return report.schemaVersion === CAUSAL_PREFLIGHT_SCHEMA
    && report.ready === true
    && report.failedChecks.length === 0
    && report.commandExecutions === 0
    && report.evidenceWrites === 0
    && report.readinessHash === causalDigest(payload);
}

export interface CausalDependencyNode {
  id: string;
  domain: CausalDependencyDomain;
  inputIds: string[];
  dependencyIds?: string[];
  recordedInputHashes: Record<string, string>;
}

export interface CausalDependencyDecision {
  schemaVersion: typeof CAUSAL_DEPENDENCY_SCHEMA;
  causalDecision: 'fresh' | 'advisory' | 'rerun' | 'strict';
  affectedNodeIds: string[];
  invalidatedNodeIds: string[];
  changedInputIds: string[];
  specializedRerun: number;
  affectedNodeRerun: number;
  falseFresh: number;
  materialHashStrict: boolean;
  storyFilesHashAdvisory: boolean;
  doneRequiredStrict: boolean;
  gateAdmissible: boolean;
  reason: string;
  _hash: string;
}

function dependencyClosure(nodes: readonly CausalDependencyNode[], changed: Set<string>): Set<string> {
  const affected = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (affected.has(node.id)) continue;
      if ((node.dependencyIds ?? []).some(dep => affected.has(dep))) {
        affected.add(node.id);
        grew = true;
      }
    }
  }
  return affected;
}

export function evaluateCausalDependencies(args: {
  nodes: readonly CausalDependencyNode[];
  currentInputHashes: Record<string, string>;
  previousMaterialHash?: string;
  currentMaterialHash?: string;
  previousStoryFilesHash?: string;
  currentStoryFilesHash?: string;
  doneRequired?: boolean;
  rerunNodeIds?: string[];
}): CausalDependencyDecision {
  const changedInputIds = new Set<string>();
  let identityComplete = true;
  for (const node of args.nodes) {
    for (const inputId of node.inputIds) {
      const previous = node.recordedInputHashes[inputId];
      const current = args.currentInputHashes[inputId];
      if (!previous || !current) identityComplete = false;
      if (previous !== current) changedInputIds.add(inputId);
    }
  }
  const changedNodes = args.nodes.filter(node => node.inputIds.some(inputId => changedInputIds.has(inputId))).map(node => node.id);
  const affected = dependencyClosure(args.nodes, new Set(changedNodes));
  const materialDrift = Boolean(args.previousMaterialHash && args.currentMaterialHash && args.previousMaterialHash !== args.currentMaterialHash);
  const storyFilesMatch = Boolean(args.previousStoryFilesHash && args.currentStoryFilesHash && args.previousStoryFilesHash === args.currentStoryFilesHash);
  const doneRequiredStrict = args.doneRequired === true;
  let causalDecision: CausalDependencyDecision['causalDecision'] = 'fresh';
  let reason = 'causal dependency inputs match';
  let storyFilesHashAdvisory = false;
  let gateAdmissible = true;
  if (!identityComplete) {
    causalDecision = 'strict';
    reason = 'dependency identity is missing or uncomputable; materialHash strict fallback applies';
    gateAdmissible = !materialDrift;
  } else if (affected.size > 0) {
    causalDecision = 'rerun';
    reason = 'affected dependency closure requires fresh execution';
    gateAdmissible = false;
  } else if (materialDrift && storyFilesMatch && !doneRequiredStrict) {
    causalDecision = 'advisory';
    storyFilesHashAdvisory = true;
    reason = 'whole-tree materialHash drift is unrelated; storyFilesHash matches and specialized evidence may remain advisory';
  } else if (materialDrift) {
    causalDecision = 'strict';
    reason = doneRequiredStrict
      ? 'DONE-required whole-tree materialHash policy remains strict'
      : 'materialHash drift has no admissible causal proof';
    gateAdmissible = false;
  }
  const rerunSet = new Set(args.rerunNodeIds ?? []);
  const missingReruns = [...affected].filter(id => !rerunSet.has(id));
  const affectedNodeRerun = affected.size === 0 ? 0 : Math.round(((affected.size - missingReruns.length) / affected.size) * 100);
  const causalRerunComplete = causalDecision === 'rerun' && missingReruns.length === 0;
  const finalGateAdmissible = causalRerunComplete || (causalDecision !== 'rerun' && gateAdmissible && missingReruns.length === 0);
  const decisionWithoutHash = {
    schemaVersion: CAUSAL_DEPENDENCY_SCHEMA,
    causalDecision,
    affectedNodeIds: [...affected].sort(),
    invalidatedNodeIds: [...affected].sort(),
    changedInputIds: [...changedInputIds].sort(),
    specializedRerun: causalDecision === 'rerun' ? affected.size : 0,
    affectedNodeRerun,
    falseFresh: missingReruns.length,
    materialHashStrict: !storyFilesHashAdvisory,
    storyFilesHashAdvisory,
    doneRequiredStrict,
    gateAdmissible: finalGateAdmissible,
    reason: causalRerunComplete ? 'affected dependency closure rerun is complete' : reason,
  };
  return { ...decisionWithoutHash, _hash: causalDigest(decisionWithoutHash) };
}

export function verifyCausalDependencyDecision(decision: CausalDependencyDecision): boolean {
  const { _hash: _ignored, ...payload } = decision;
  return decision.schemaVersion === CAUSAL_DEPENDENCY_SCHEMA && decision._hash === causalDigest(payload);
}

export function deriveCausalMetrics(ledger: CausalEvidenceLedger): CausalEvidenceMetrics {
  if (!verifyCausalEvidenceLedger(ledger)) throw new Error('causal metrics refused: execution ledger tampered [causal_ledger_tampered]');
  const uniqueKeys = new Set(ledger.executions.map(entry => entry.executionKey));
  if (uniqueKeys.size !== ledger.executions.length) throw new Error('causal metrics refused: duplicate execution key [causal_ledger_duplicate_key]');
  const commandExecutions = ledger.executions.filter(entry => entry.disposition === 'executed').length;
  const commandReruns = ledger.executions.reduce((sum, entry) => sum + Math.max(0, entry.executionAttempts - 1), 0);
  return {
    intentCount: ledger.intentCount,
    uniqueExecutionKeys: uniqueKeys.size,
    commandExecutions,
    cacheHitRate: ledger.intentCount === 0 ? 0 : Math.max(0, (ledger.intentCount - commandExecutions) / ledger.intentCount),
    commandReruns,
    commitFailureReruns: ledger.commitFailureReruns,
    unrelatedSpecializedRerun: ledger.unrelatedSpecializedRerun,
    affectedNodeRerun: ledger.affectedNodeRerun,
    falseFresh: ledger.falseFresh,
  };
}

export function renderCausalMetrics(metrics: CausalEvidenceMetrics): string {
  return `CausalEvidence: intentCount=${metrics.intentCount} uniqueExecutionKeys=${metrics.uniqueExecutionKeys} commandExecutions=${metrics.commandExecutions} cacheHitRate=${Math.round(metrics.cacheHitRate * 100)}% commandReruns=${metrics.commandReruns} commitFailureReruns=${metrics.commitFailureReruns} unrelatedSpecializedRerun=${metrics.unrelatedSpecializedRerun} affectedNodeRerun=${metrics.affectedNodeRerun}% falseFresh=${metrics.falseFresh}`;
}

export interface CausalImportArgs {
  receipt: CausalEvidenceReceipt | null | undefined;
  expectedStoryId: string;
  expectedExecutionKey: string;
  expectedMaterialHash?: string;
  expectedStoryFilesHash?: string;
  revalidate: () => boolean;
  commit: () => void;
  maxAttempts?: number;
  batch?: CausalEvidenceBatch;
}

/** Import is a separate transaction: failures retry commit/index work only. */
export function importCausalEvidenceReceipt(args: CausalImportArgs): { receiptHash: string; attempts: number; commandReruns: 0 } {
  const receipt = args.receipt;
  if (!receipt || !verifyCausalEvidenceReceipt(receipt, args.expectedExecutionKey)) {
    throw new Error('causal evidence import refused: raw, unsigned, partial, receiptless, or tampered receipt [causal_receipt_invalid]');
  }
  if (receipt.storyId !== args.expectedStoryId) throw new Error('causal evidence import refused: story mismatch [causal_receipt_story_mismatch]');
  if (args.expectedMaterialHash) {
    const recordedMaterial = receipt.identity.inputs && isRecord(receipt.identity.inputs)
      ? receipt.identity.inputs.materialHash
      : undefined;
    if (recordedMaterial !== args.expectedMaterialHash) throw new Error('causal evidence import refused: materialHash changed [causal_receipt_material_mismatch]');
  }
  if (args.expectedStoryFilesHash && receipt.identity.storyFilesHash !== args.expectedStoryFilesHash) throw new Error('causal evidence import refused: storyFilesHash changed [causal_receipt_story_files_mismatch]');
  const maxAttempts = Math.max(1, Math.floor(args.maxAttempts ?? 2));
  let attempts = 0;
  let lastError: unknown;
  while (attempts < maxAttempts) {
    attempts++;
    if (!args.revalidate()) throw new Error('causal evidence import refused: lease/index/material revalidation failed [causal_import_revalidation_failed]');
    try {
      args.commit();
      if (args.batch && attempts > 1) {
        args.batch.ledger.commitFailureReruns += attempts - 1;
        refreshLedgerHash(args.batch);
      }
      return { receiptHash: receipt.receiptHash, attempts, commandReruns: 0 };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`causal evidence import failed after ${attempts} transaction attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)} [causal_import_failed]`);
}

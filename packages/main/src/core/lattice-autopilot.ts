import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  checkAutopilotPolicy,
  type AutopilotPolicyCheckOptions,
  type AutopilotPolicyCheckResult,
  type AutopilotPolicy as PersistedAutopilotPolicy,
  type AutopilotMode as PersistedAutopilotMode,
} from './autopilot-policy.js';
import {
  buildDispatchMergePlan,
  cancelDispatch,
  dispatchAuto,
  dispatchWatch,
  reviewDispatch,
  type DispatchAutoResult,
  type DispatchMergePlanResult,
  type DispatchReviewResult,
  type DispatchWatchResult,
  type HostRuntimeId,
} from './lattice-dispatch.js';
import type { StoryStore } from './store.js';

export const AUTOPILOT_RUN_SCHEMA_VERSION = 'lattice.autopilot_run.v1' as const;
export const AUTOPILOT_WATCH_SCHEMA_VERSION = 'lattice.autopilot_watch.v1' as const;
export const AUTOPILOT_CANCEL_SCHEMA_VERSION = 'lattice.autopilot_cancel.v1' as const;
export const AUTOPILOT_REVIEW_SCHEMA_VERSION = 'lattice.autopilot_review.v1' as const;
export const AUTOPILOT_RESUME_SCHEMA_VERSION = 'lattice.autopilot_resume.v1' as const;

export const AUTOPILOT_STOP_REASONS = [
  'max_iterations',
  'timeout',
  'budget_exhausted',
  'conflict',
  'scope_violation',
  'validation_failed',
  'missing_receipt',
  'missing_authority',
] as const;

export type AutopilotMode = 'conservative' | 'authority-verified' | 'full-autopilot';
type AutopilotModeAssertion = AutopilotMode | 'authority_verified' | 'full_autopilot';
export type AutopilotStatus =
  | 'created'
  | 'running'
  | 'needs_receipt'
  | 'manual_review_ready'
  | 'missing_authority_receipt'
  | 'cancelled'
  | 'failed';
export type AutopilotStopReason = typeof AUTOPILOT_STOP_REASONS[number];

export interface AutopilotAuthorityBoundary {
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
  serverReceiptRequired: boolean;
  serverReceiptPresent: boolean;
  serverReceiptVerified: boolean;
  integrationAttempted: false;
  doneAttempted: false;
  mainMergeAttempted: false;
}

export interface AutopilotDelegationContract {
  hostNative: true;
  receiptRequired: true;
  transcriptRequired: true;
  handoff: {
    expectation: string;
  };
  receipt: {
    expectation: string;
  };
  transcript: {
    expectation: string;
  };
  nextAction: string;
}

export interface AutopilotMergeDecision {
  decision: 'manual_review' | 'withheld';
  manualOnly: true;
  mergeable: boolean;
  commands: string[];
  warnings: string[];
  nextAction: string;
}

export interface AutopilotAuthorityReceiptGate {
  required: boolean;
  present: boolean;
  verified: boolean;
  source: 'missing' | 'local-diagnostic' | 'server' | 'fake-test-server' | 'invalid';
  receiptRef?: string;
  missing: string[];
  nextAction: string;
}

export interface AutopilotIteration {
  index: number;
  startedAt: string;
  endedAt?: string;
  status: AutopilotStatus;
  dispatchId?: string;
  stopReason?: AutopilotStopReason;
  nextAction: string;
  warnings: string[];
}

export interface AutopilotEvent {
  at: string;
  type: string;
  message: string;
  dispatchId?: string;
  stopReason?: AutopilotStopReason;
}

export interface AutopilotRunRecord {
  schemaVersion: typeof AUTOPILOT_RUN_SCHEMA_VERSION;
  runId: string;
  storyId: string;
  mode: AutopilotMode;
  status: AutopilotStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  runFile: string;
  repoRoot: string;
  policy?: string;
  dispatchPolicy?: string;
  policyCheck?: AutopilotPolicyCheckResult;
  host?: HostRuntimeId | string;
  dispatchId?: string;
  maxIterations: number;
  timeoutMs: number;
  maxBudgetUSD?: number;
  budgetSpentUSD: number;
  stopReason?: AutopilotStopReason;
  stopDetails?: string;
  delegation: AutopilotDelegationContract;
  dispatch?: {
    auto?: DispatchAutoResult;
    watch?: DispatchWatchResult;
    review?: DispatchReviewResult;
    mergePlan?: DispatchMergePlanResult;
  };
  authorityReceiptGate: AutopilotAuthorityReceiptGate;
  mergeDecision?: AutopilotMergeDecision;
  iterations: AutopilotIteration[];
  events: AutopilotEvent[];
  warnings: string[];
  errors: string[];
  nextAction: string;
  authority: AutopilotAuthorityBoundary;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface AutopilotRunArgs {
  storyId: string;
  mode?: AutopilotModeAssertion;
  runId?: string;
  policy?: string;
  host?: string;
  fromHost?: string;
  role?: string;
  objective?: string;
  allowedPaths?: string[] | string;
  deniedPaths?: string[] | string;
  requiredCommands?: string[] | string;
  successCriteria?: string[] | string;
  baseSha?: string;
  packId?: string;
  authorityBoundary?: string;
  executionInstructions?: string[] | string;
  parallel?: number;
  maxIterations?: number;
  timeoutMs?: number;
  maxBudgetUSD?: number;
  budgetSpentUSD?: number;
  authorityReceipt?: unknown;
  serverAuthorityReceipt?: unknown;
  verifiedAuthorityReceipt?: unknown;
  serverReceipt?: unknown;
}

export interface AutopilotWatchResult {
  schemaVersion: typeof AUTOPILOT_WATCH_SCHEMA_VERSION;
  runId: string;
  storyId: string;
  mode: AutopilotMode;
  status: AutopilotStatus;
  dispatchId?: string;
  dispatchWatch?: DispatchWatchResult;
  iterationCount: number;
  stopReason?: AutopilotStopReason;
  authorityReceiptGate: AutopilotAuthorityReceiptGate;
  mergeDecision?: AutopilotMergeDecision;
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface AutopilotCancelResult {
  schemaVersion: typeof AUTOPILOT_CANCEL_SCHEMA_VERSION;
  runId: string;
  status: 'cancelled';
  dispatchId?: string;
  nextAction: string;
  record: AutopilotRunRecord;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface AutopilotReviewResult {
  schemaVersion: typeof AUTOPILOT_REVIEW_SCHEMA_VERSION;
  runId: string;
  storyId: string;
  status: AutopilotStatus;
  dispatchReview?: DispatchReviewResult;
  mergePlan?: DispatchMergePlanResult;
  mergeDecision?: AutopilotMergeDecision;
  authorityReceiptGate: AutopilotAuthorityReceiptGate;
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface AutopilotResumeArgs {
  runId: string;
  maxResumeAgeMs?: number;
}

export interface AutopilotResumeResult {
  schemaVersion: typeof AUTOPILOT_RESUME_SCHEMA_VERSION;
  runId: string;
  status: 'refused';
  reason: 'unsafe_state' | 'stale_state';
  record: AutopilotRunRecord;
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeList(value: string[] | string | undefined): string[] | undefined {
  if (Array.isArray(value)) {
    const filtered = value.filter(item => typeof item === 'string' && item.trim().length > 0).map(item => item.trim());
    return filtered.length > 0 ? filtered : undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  return undefined;
}

function normalizeMode(mode: AutopilotModeAssertion | undefined): AutopilotMode {
  if (mode === undefined || mode === 'conservative') return 'conservative';
  if (mode === 'authority-verified' || mode === 'authority_verified') return 'authority-verified';
  if (mode === 'full-autopilot' || mode === 'full_autopilot') return 'full-autopilot';
  throw new Error(`autopilot_run: unknown mode "${String(mode)}"; expected conservative, authority-verified, or full-autopilot`);
}

function safeSegment(value: string, field: string): string {
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(trimmed)) {
    throw new Error(`${field} must be 1-128 alphanumeric, dot, underscore, or hyphen characters`);
  }
  return trimmed;
}

function generateRunId(storyId: string): string {
  const safeStory = storyId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64) || 'story';
  return `AP-${safeStory}-${Date.now().toString(36)}`;
}

function runsDir(root: string): string {
  return join(root, '.koala', 'autopilot-runs');
}

function runDir(root: string, runId: string): string {
  return join(runsDir(root), safeSegment(runId, 'runId'));
}

function runJsonPath(root: string, runId: string): string {
  return join(runDir(root, runId), 'run.json');
}

function runJsonRelPath(runId: string): string {
  return join('.koala', 'autopilot-runs', safeSegment(runId, 'runId'), 'run.json').replace(/\\/g, '/');
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    JSON.parse(readFileSync(tmp, 'utf8'));
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

function readRunRecord(root: string, runId: string): AutopilotRunRecord {
  const file = runJsonPath(root, runId);
  if (!existsSync(file)) {
    throw new Error(`autopilot run not found: ${runId}`);
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as AutopilotRunRecord;
  if (parsed.schemaVersion !== AUTOPILOT_RUN_SCHEMA_VERSION) {
    throw new Error(`unsupported autopilot run schema for ${runId}: ${String((parsed as { schemaVersion?: unknown }).schemaVersion)}`);
  }
  return parsed;
}

function persist(root: string, record: AutopilotRunRecord): AutopilotRunRecord {
  const updated = { ...record, updatedAt: nowIso() };
  writeJsonAtomic(runJsonPath(root, updated.runId), updated);
  return updated;
}

function event(type: string, message: string, extra: Pick<AutopilotEvent, 'dispatchId' | 'stopReason'> = {}): AutopilotEvent {
  return {
    at: nowIso(),
    type,
    message,
    ...extra,
  };
}

function buildDelegationContract(mode: AutopilotMode): AutopilotDelegationContract {
  return {
    hostNative: true,
    receiptRequired: true,
    transcriptRequired: true,
    handoff: {
      expectation: 'dispatch_auto must create or reuse a bounded Lattice handoff pack with allowedPaths, deniedPaths, requiredCommands, successCriteria, and authority boundaries intact.',
    },
    receipt: {
      expectation: mode === 'authority-verified'
        ? 'A host local receipt is diagnostic only; authority-verified mode additionally requires an explicit server AuthorityReceipt before integration, DONE, or main merge may be considered.'
        : 'A host local receipt is diagnostic only and must be reviewed manually; it cannot claim productionDone or replace DONE authority.',
    },
    transcript: {
      expectation: 'The host-native runner must provide a transcript path and the transcript must exist before the run can leave needs_receipt.',
    },
    nextAction: 'Run dispatch_review and dispatch_merge_plan, then inspect local receipt and transcript evidence manually before any integration.',
  };
}

function emptyAuthority(required: boolean): AutopilotAuthorityBoundary {
  return {
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
    serverReceiptRequired: required,
    serverReceiptPresent: false,
    serverReceiptVerified: false,
    integrationAttempted: false,
    doneAttempted: false,
    mainMergeAttempted: false,
  };
}

function localDiagnosticGate(required: boolean, nextAction?: string): AutopilotAuthorityReceiptGate {
  return {
    required,
    present: false,
    verified: false,
    source: 'missing',
    missing: required ? ['verifiedAuthorityReceipt'] : [],
    nextAction: nextAction ?? 'No server authority receipt was provided. Stay before integration, DONE, and main merge.',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstExplicitAuthorityReceipt(args: AutopilotRunArgs): unknown {
  return args.verifiedAuthorityReceipt
    ?? args.serverAuthorityReceipt
    ?? args.authorityReceipt
    ?? args.serverReceipt;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const raw = value[field];
  return typeof raw === 'string' ? raw : '';
}

function receiptRefField(value: Record<string, unknown>): string {
  for (const field of ['receiptRef', 'receiptId', 'id', 'ref']) {
    const candidate = stringField(value, field).trim();
    if (candidate) return candidate;
  }
  return '';
}

function authorityReceiptShape(candidate: Record<string, unknown>): {
  receiptRef: string;
  subjectDigest: string;
  signature: string;
  verified: boolean;
  sourceText: string;
} {
  const sourceText = [
    stringField(candidate, 'schemaVersion'),
    stringField(candidate, 'source'),
    stringField(candidate, 'issuer'),
    stringField(candidate, 'type'),
    stringField(candidate, 'kind'),
    stringField(candidate, 'klass'),
    stringField(candidate, 'classification'),
  ].join(' ');
  return {
    receiptRef: receiptRefField(candidate),
    subjectDigest: stringField(candidate, 'subjectDigest').trim(),
    signature: stringField(candidate, 'signature').trim(),
    verified: candidate.verified === true || candidate.receiptVerified === true || stringField(candidate, 'status') === 'verified',
    sourceText,
  };
}

function classifyAuthorityReceiptCandidate(candidate: unknown, required: boolean): AutopilotAuthorityReceiptGate {
  if (!required) {
    return {
      required: false,
      present: false,
      verified: false,
      source: 'missing',
      missing: [],
      nextAction: 'Server authority receipt is not required for this conservative run; continue manual review only.',
    };
  }

  if (!isRecord(candidate)) return localDiagnosticGate(true);

  const schemaVersion = stringField(candidate, 'schemaVersion');
  const status = stringField(candidate, 'status');
  if (
    schemaVersion === 'lattice.handoff_receipt_submit.v1'
    || schemaVersion === 'lattice.handoff_receipt.v1'
    || status === 'accepted-local'
    || status === 'diagnostic'
  ) {
    return {
      required: true,
      present: true,
      verified: false,
      source: 'local-diagnostic',
      missing: ['verifiedAuthorityReceipt'],
      nextAction: 'Local diagnostic receipts are not server authority receipts. Stay before integration, DONE, and main merge.',
    };
  }

  const shape = authorityReceiptShape(candidate);
  const hasRequiredReceiptShape = !!shape.receiptRef && !!shape.subjectDigest && !!shape.signature && shape.verified;
  const fakeTestServerMarked = /fake-test-server/i.test(shape.sourceText);
  const realAuthorityServerMarked =
    /lattice-authority-server|authority-server|python-authority-server/i.test(shape.sourceText)
    || (
      (candidate.klass === 'receipt-backed-l2-plus' || candidate.classification === 'receipt-backed-l2-plus')
      && /authority|server/i.test(shape.sourceText)
    );

  if (hasRequiredReceiptShape && (fakeTestServerMarked || realAuthorityServerMarked)) {
    return {
      required: true,
      present: true,
      verified: true,
      source: fakeTestServerMarked ? 'fake-test-server' : 'server',
      receiptRef: shape.receiptRef,
      missing: [],
      nextAction: 'Server authority receipt is present. Continue to manual review; this autopilot still will not auto-merge, auto-DONE, or claim productionDone.',
    };
  }

  return {
    required: true,
    present: true,
    verified: false,
    source: 'invalid',
    missing: ['verifiedAuthorityReceipt'],
    nextAction: 'The provided receipt is not recognizable as a verified server authority receipt. Stay before integration, DONE, and main merge.',
  };
}

function policyCheckOptionsFromGate(gate: AutopilotAuthorityReceiptGate): AutopilotPolicyCheckOptions | undefined {
  if (!gate.verified || !gate.receiptRef) return undefined;
  return {
    serverAuthorityReceipt: {
      authority: 'server',
      verified: true,
      receiptRef: gate.receiptRef,
      verifiedBy: gate.source,
      verifiedAt: nowIso(),
    },
  };
}

function buildMergeDecision(mergePlan: DispatchMergePlanResult | undefined): AutopilotMergeDecision | undefined {
  if (!mergePlan) return undefined;
  return {
    decision: mergePlan.mergeable ? 'manual_review' : 'withheld',
    manualOnly: true,
    mergeable: mergePlan.mergeable,
    commands: [...mergePlan.commands],
    warnings: [...mergePlan.warnings],
    nextAction: mergePlan.nextAction,
  };
}

function finalize(
  root: string,
  record: AutopilotRunRecord,
  patch: Partial<AutopilotRunRecord> & { status: AutopilotStatus; nextAction: string },
): AutopilotRunRecord {
  const finalRecord: AutopilotRunRecord = {
    ...record,
    ...patch,
    completedAt: nowIso(),
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
    authority: {
      ...(patch.authority ?? record.authority),
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
      integrationAttempted: false,
      doneAttempted: false,
      mainMergeAttempted: false,
    },
  };
  return persist(root, finalRecord);
}

function markIterationEnded(
  iteration: AutopilotIteration,
  status: AutopilotStatus,
  nextAction: string,
  stopReason?: AutopilotStopReason,
): AutopilotIteration {
  return {
    ...iteration,
    endedAt: nowIso(),
    status,
    nextAction,
    ...(stopReason ? { stopReason } : {}),
  };
}

function classifyDispatchError(message: string): AutopilotStopReason {
  if (/maxParallel|active dispatch|conflict/i.test(message)) return 'conflict';
  if (/scope|allowedPaths|deniedPaths|path traversal|escapes/i.test(message)) return 'scope_violation';
  if (/timeout|timed out/i.test(message)) return 'timeout';
  if (/budget/i.test(message)) return 'budget_exhausted';
  return 'validation_failed';
}

function classifyFailedDispatchResult(message: string): AutopilotStopReason {
  if (/command failed|hit command failure|required command|process\.exit/i.test(message)) return 'validation_failed';
  return classifyDispatchError(message);
}

function budgetExhausted(record: Pick<AutopilotRunRecord, 'maxBudgetUSD' | 'budgetSpentUSD'>): boolean {
  return record.maxBudgetUSD !== undefined && record.budgetSpentUSD >= record.maxBudgetUSD;
}

function timedOut(startMs: number, timeoutMs: number): boolean {
  return Date.now() - startMs >= timeoutMs;
}

function dispatchArgs(args: AutopilotRunArgs, dispatchPolicy: string): Parameters<typeof dispatchAuto>[2] {
  return {
    storyId: args.storyId,
    policy: dispatchPolicy,
    host: args.host,
    fromHost: args.fromHost,
    role: args.role,
    objective: args.objective,
    allowedPaths: normalizeList(args.allowedPaths),
    deniedPaths: normalizeList(args.deniedPaths),
    requiredCommands: normalizeList(args.requiredCommands),
    successCriteria: normalizeList(args.successCriteria),
    baseSha: args.baseSha,
    packId: args.packId,
    authorityBoundary: args.authorityBoundary,
    executionInstructions: normalizeList(args.executionInstructions),
    parallel: args.parallel,
  };
}

interface ValidationRetryDecision {
  retry: boolean;
  refusal?: {
    stopReason: AutopilotStopReason;
    stopDetails: string;
    nextAction: string;
  };
  budgetSpentUSD?: number;
}

function validationRetryDecision(
  policy: Pick<PersistedAutopilotPolicy, 'mode' | 'allowAutoFix'>,
  stopReason: AutopilotStopReason,
  index: number,
  maxIterations: number,
  startMs: number,
  timeoutMs: number,
  record: Pick<AutopilotRunRecord, 'maxBudgetUSD' | 'budgetSpentUSD'>,
  measuredSpendDeltaUSD?: number,
): ValidationRetryDecision {
  const retryCandidate = policy.mode === 'full-autopilot'
    && policy.allowAutoFix === true
    && stopReason === 'validation_failed'
    && index + 1 < maxIterations
    && !timedOut(startMs, timeoutMs);
  if (!retryCandidate) return { retry: false };

  if (budgetExhausted(record)) {
    return {
      retry: false,
      refusal: {
        stopReason: 'budget_exhausted',
        stopDetails: `budgetSpentUSD=${record.budgetSpentUSD} reached maxBudgetUSD=${record.maxBudgetUSD}`,
        nextAction: 'Budget cap reached. Review the existing run manually before any further retry.',
      },
    };
  }

  if (record.maxBudgetUSD !== undefined && measuredSpendDeltaUSD === undefined) {
    return {
      retry: false,
      refusal: {
        stopReason: 'budget_exhausted',
        stopDetails: `full-autopilot retry refused: maxBudgetUSD=${record.maxBudgetUSD} is set, but autopilot v1 cannot measure provider spend after dispatch attempts.`,
        nextAction: 'Fail closed: remove maxBudgetUSD to allow retries bounded by maxIterations/runtime only, or add measured spend support before budget-capped retries.',
      },
    };
  }

  const budgetSpentUSD = measuredSpendDeltaUSD === undefined
    ? record.budgetSpentUSD
    : record.budgetSpentUSD + measuredSpendDeltaUSD;
  if (record.maxBudgetUSD !== undefined && budgetSpentUSD >= record.maxBudgetUSD) {
    return {
      retry: false,
      refusal: {
        stopReason: 'budget_exhausted',
        stopDetails: `budgetSpentUSD=${budgetSpentUSD} reached maxBudgetUSD=${record.maxBudgetUSD}`,
        nextAction: 'Budget cap reached. Review the existing run manually before any further retry.',
      },
      budgetSpentUSD,
    };
  }

  return { retry: true, budgetSpentUSD };
}

function mergePlanStopReason(mergePlan: DispatchMergePlanResult): AutopilotStopReason {
  return classifyFailedDispatchResult([
    ...mergePlan.warnings,
    mergePlan.nextAction,
  ].join('\n'));
}

export function autopilotRun(store: StoryStore, root: string, args: AutopilotRunArgs): AutopilotRunRecord {
  if (!args.storyId || !args.storyId.trim()) {
    throw new Error('autopilot_run requires storyId');
  }
  const policyName = (args.policy ?? '').trim();
  if (!policyName) {
    throw new Error('autopilot_run requires an autopilot policy name; set --policy=<autopilot-policy>');
  }

  const preliminaryPolicyCheck = checkAutopilotPolicy(root, policyName);
  const preliminaryPolicy = preliminaryPolicyCheck.normalizedPolicy;
  const preliminaryAuthorityRequired = preliminaryPolicy.requireServerReceipt || preliminaryPolicy.mode !== 'conservative';
  const authorityReceiptGate = classifyAuthorityReceiptCandidate(firstExplicitAuthorityReceipt(args), preliminaryAuthorityRequired);
  const policyCheck = checkAutopilotPolicy(root, policyName, policyCheckOptionsFromGate(authorityReceiptGate));
  const policy = policyCheck.normalizedPolicy;
  const mode = policy.mode as PersistedAutopilotMode;
  const assertedMode = args.mode !== undefined ? normalizeMode(args.mode) : undefined;
  const runId = safeSegment(args.runId ?? generateRunId(args.storyId), 'runId');
  const authorityRequired = policy.requireServerReceipt || mode !== 'conservative';
  const createdAt = nowIso();
  const maxIterations = Math.max(0, Math.floor(policy.maxIterations));
  const timeoutMs = Math.max(1, Math.floor((policy.maxRuntimeMinutes ?? 5) * 60 * 1000));
  const startMs = Date.now();

  let record: AutopilotRunRecord = {
    schemaVersion: AUTOPILOT_RUN_SCHEMA_VERSION,
    runId,
    storyId: args.storyId,
    mode,
    status: 'running',
    createdAt,
    updatedAt: createdAt,
    runFile: runJsonRelPath(runId),
    repoRoot: resolve(root),
    policy: policyName,
    dispatchPolicy: policy.dispatchPolicy,
    policyCheck,
    host: args.host,
    maxIterations,
    timeoutMs,
    maxBudgetUSD: policy.maxBudgetUSD,
    budgetSpentUSD: args.budgetSpentUSD ?? 0,
    delegation: buildDelegationContract(mode),
    authorityReceiptGate,
    iterations: [],
    events: [
      event('run_started', `autopilot_run started in ${mode} mode using autopilot policy ${policyName} and dispatch policy ${policy.dispatchPolicy}`),
      event('policy_checked', `autopilot policy ${policyName} check status=${policyCheck.status}`),
    ],
    warnings: [],
    errors: [],
    nextAction: 'Checking autopilot policy authorization before dispatch_auto.',
    authority: {
      ...emptyAuthority(authorityRequired),
      serverReceiptPresent: authorityReceiptGate.present,
      serverReceiptVerified: authorityReceiptGate.verified,
    },
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
  record = persist(root, record);

  if (policyCheck.status === 'refused') {
    return finalize(root, record, {
      status: 'failed',
      stopReason: 'validation_failed',
      stopDetails: policyCheck.reasons.join('; ') || policyCheck.nextAction,
      errors: [...record.errors, ...policyCheck.reasons],
      nextAction: policyCheck.nextAction,
      events: [...record.events, event('policy_refused', policyCheck.nextAction, { stopReason: 'validation_failed' })],
    });
  }

  if (assertedMode && assertedMode !== mode) {
    const message = `autopilot_run mode assertion "${assertedMode}" does not match persisted autopilot policy "${policyName}" mode "${mode}"`;
    return finalize(root, record, {
      status: 'failed',
      stopReason: 'validation_failed',
      stopDetails: message,
      errors: [...record.errors, message],
      nextAction: 'Edit the autopilot policy or rerun without a conflicting --mode assertion. CLI mode cannot widen persisted policy authority.',
      events: [...record.events, event('policy_mode_mismatch', message, { stopReason: 'validation_failed' })],
    });
  }

  if (policyCheck.status === 'supervised') {
    const missingAuthority = policy.requireServerReceipt && !authorityReceiptGate.verified;
    const nextAction = missingAuthority
      ? 'missing_authority_receipt: provide a verified server AuthorityReceipt before starting unattended autopilot. Local dispatch receipts are diagnostic only.'
      : policyCheck.nextAction;
    return finalize(root, record, {
      status: missingAuthority ? 'missing_authority_receipt' : 'failed',
      stopReason: missingAuthority ? 'missing_authority' : 'validation_failed',
      stopDetails: policyCheck.degradations.join('; ') || policyCheck.nextAction,
      warnings: [...record.warnings, ...policyCheck.degradations],
      nextAction,
      events: [...record.events, event(
        missingAuthority ? 'missing_authority_receipt' : 'policy_supervised',
        nextAction,
        { stopReason: missingAuthority ? 'missing_authority' : 'validation_failed' },
      )],
    });
  }

  if (maxIterations <= 0) {
    return finalize(root, record, {
      status: 'failed',
      stopReason: 'max_iterations',
      stopDetails: 'maxIterations must be at least 1 for autopilot_run to start dispatch_auto',
      nextAction: 'Increase maxIterations and rerun autopilot_run.',
      events: [...record.events, event('stopped', 'maxIterations exhausted before dispatch_auto could start', { stopReason: 'max_iterations' })],
    });
  }

  if (budgetExhausted(record)) {
    return finalize(root, record, {
      status: 'failed',
      stopReason: 'budget_exhausted',
      stopDetails: `budgetSpentUSD=${record.budgetSpentUSD} reached maxBudgetUSD=${record.maxBudgetUSD}`,
      nextAction: 'Increase budget or review the existing run manually.',
      events: [...record.events, event('stopped', 'budget exhausted before dispatch_auto could start', { stopReason: 'budget_exhausted' })],
    });
  }

  for (let index = 0; index < maxIterations; index++) {
    if (timedOut(startMs, timeoutMs)) {
      return finalize(root, record, {
        status: 'failed',
        stopReason: 'timeout',
        stopDetails: `timeoutMs=${timeoutMs} elapsed before the next iteration could start`,
        nextAction: 'Inspect the persisted run and dispatch records manually before retrying.',
        events: [...record.events, event('stopped', 'autopilot_run timed out before next iteration', { stopReason: 'timeout' })],
      });
    }

    const iteration: AutopilotIteration = {
      index,
      startedAt: nowIso(),
      status: 'running',
      nextAction: 'dispatch_auto running',
      warnings: [],
    };
    record = persist(root, {
      ...record,
      iterations: [...record.iterations, iteration],
      events: [...record.events, event('iteration_started', `iteration ${index} started`)],
    });

    let auto: DispatchAutoResult;
    try {
      auto = dispatchAuto(store, root, dispatchArgs(args, policy.dispatchPolicy));
    } catch (error) {
      const message = String((error as { message?: unknown }).message ?? error);
      const stopReason = classifyDispatchError(message);
      const ended = markIterationEnded(iteration, 'failed', 'dispatch_auto refused or failed before any integration step.', stopReason);
      const nextIterations = [...record.iterations.slice(0, -1), ended];
      const retryDecision = validationRetryDecision(policy, stopReason, index, maxIterations, startMs, timeoutMs, record);
      if (retryDecision.retry) {
        record = persist(root, {
          ...record,
          ...(retryDecision.budgetSpentUSD !== undefined ? { budgetSpentUSD: retryDecision.budgetSpentUSD } : {}),
          iterations: nextIterations,
          errors: [...record.errors, message],
          nextAction: 'Validation failed and policy allowAutoFix=true; scheduling the next bounded full-autopilot iteration.',
          events: [
            ...record.events,
            event('dispatch_auto_failed', message, { stopReason }),
            event('retry_scheduled', `iteration ${index + 1} scheduled after validation failure`, { stopReason }),
          ],
        });
        continue;
      }
      if (retryDecision.refusal) {
        return finalize(root, record, {
          status: 'failed',
          stopReason: retryDecision.refusal.stopReason,
          stopDetails: retryDecision.refusal.stopDetails,
          ...(retryDecision.budgetSpentUSD !== undefined ? { budgetSpentUSD: retryDecision.budgetSpentUSD } : {}),
          iterations: nextIterations,
          errors: [...record.errors, message, retryDecision.refusal.stopDetails],
          nextAction: retryDecision.refusal.nextAction,
          events: [
            ...record.events,
            event('dispatch_auto_failed', message, { stopReason }),
            event('retry_refused', retryDecision.refusal.stopDetails, { stopReason: retryDecision.refusal.stopReason }),
          ],
        });
      }
      return finalize(root, record, {
        status: 'failed',
        stopReason,
        stopDetails: message,
        iterations: nextIterations,
        errors: [...record.errors, message],
        nextAction: stopReason === 'conflict'
          ? 'Manual repair required: resolve active dispatch or merge conflict evidence before rerunning autopilot_run.'
          : 'Fix the dispatch policy, host readiness, scope, or command validation issue and rerun autopilot_run.',
        events: [...record.events, event('dispatch_auto_failed', message, { stopReason })],
      });
    }

    const dispatchId = auto.dispatchId;
    const watch = dispatchWatch(root, dispatchId);
    const review = reviewDispatch(root, dispatchId);
    const mergePlan = buildDispatchMergePlan(root, dispatchId);
    const mergeDecision = buildMergeDecision(mergePlan);
    const hasLocalReceipt = review.localReceiptStatus === 'accepted-local';
    const hasTranscript = review.transcriptExists === true;
    const warnings = [...auto.warnings, ...review.warnings, ...mergePlan.warnings];
    const baseDispatch = { auto, watch, review, mergePlan };

    record = persist(root, {
      ...record,
      host: auto.host,
      dispatchId,
      dispatch: baseDispatch,
      mergeDecision,
      warnings: [...record.warnings, ...warnings],
      events: [...record.events, event('dispatch_auto_completed', `dispatch_auto produced ${dispatchId} with status ${auto.status}`, { dispatchId })],
    });

    if (auto.status === 'failed') {
      const message = [...auto.warnings, auto.nextAction].join('; ') || 'dispatch_auto returned failed status';
      const stopReason = classifyFailedDispatchResult(message);
      const nextAction = 'dispatch_auto returned failed status; autopilot preserved dispatch evidence before any integration step.';
      const ended = markIterationEnded(iteration, 'failed', nextAction, stopReason);
      const nextIterations = [...record.iterations.slice(0, -1), { ...ended, dispatchId, warnings }];
      const measuredSpendDeltaUSD = auto.host === 'fake' ? 0 : undefined;
      const retryDecision = validationRetryDecision(policy, stopReason, index, maxIterations, startMs, timeoutMs, record, measuredSpendDeltaUSD);
      if (retryDecision.retry) {
        record = persist(root, {
          ...record,
          ...(retryDecision.budgetSpentUSD !== undefined ? { budgetSpentUSD: retryDecision.budgetSpentUSD } : {}),
          iterations: nextIterations,
          errors: [...record.errors, message],
          nextAction: 'Validation failed and policy allowAutoFix=true; scheduling the next bounded full-autopilot iteration.',
          events: [
            ...record.events,
            event('validation_failed', message, { dispatchId, stopReason }),
            event('retry_scheduled', `iteration ${index + 1} scheduled after validation failure`, { dispatchId, stopReason }),
          ],
        });
        continue;
      }
      if (retryDecision.refusal) {
        return finalize(root, record, {
          status: 'failed',
          stopReason: retryDecision.refusal.stopReason,
          stopDetails: retryDecision.refusal.stopDetails,
          ...(retryDecision.budgetSpentUSD !== undefined ? { budgetSpentUSD: retryDecision.budgetSpentUSD } : {}),
          iterations: nextIterations,
          errors: [...record.errors, message, retryDecision.refusal.stopDetails],
          nextAction: retryDecision.refusal.nextAction,
          events: [
            ...record.events,
            event('validation_failed', message, { dispatchId, stopReason }),
            event('retry_refused', retryDecision.refusal.stopDetails, { dispatchId, stopReason: retryDecision.refusal.stopReason }),
          ],
        });
      }
      return finalize(root, record, {
        status: 'failed',
        stopReason,
        stopDetails: message,
        iterations: nextIterations,
        errors: [...record.errors, message],
        nextAction,
        events: [...record.events, event('validation_failed', message, { dispatchId, stopReason })],
      });
    }

    if (!hasLocalReceipt || !hasTranscript) {
      const missing = [
        ...(!hasLocalReceipt ? ['local diagnostic receipt'] : []),
        ...(!hasTranscript ? ['host transcript'] : []),
      ].join(', ');
      const nextAction = `Collect missing host-native evidence (${missing}) and rerun autopilot_review. No integration, DONE, or main merge is allowed.`;
      const ended = markIterationEnded(iteration, 'needs_receipt', nextAction, 'missing_receipt');
      return finalize(root, record, {
        status: 'needs_receipt',
        stopReason: 'missing_receipt',
        stopDetails: `missing ${missing}`,
        iterations: [...record.iterations.slice(0, -1), { ...ended, dispatchId, warnings }],
        nextAction,
        events: [...record.events, event('needs_receipt', `missing ${missing}`, { dispatchId, stopReason: 'missing_receipt' })],
      });
    }

    if (mode === 'conservative') {
      const nextAction = 'Manual review ready. Inspect dispatch_review and dispatch_merge_plan output; merge remains manual-only and productionDone=false.';
      const ended = markIterationEnded(iteration, 'manual_review_ready', nextAction);
      return finalize(root, record, {
        status: 'manual_review_ready',
        iterations: [...record.iterations.slice(0, -1), { ...ended, dispatchId, warnings }],
        nextAction,
        events: [...record.events, event('manual_review_ready', 'conservative autopilot stopped before authority or merge actions', { dispatchId })],
      });
    }

    if (!authorityReceiptGate.verified) {
      const nextAction = 'missing_authority_receipt: provide a verified server AuthorityReceipt before integration, DONE, or main merge. Local dispatch receipts are diagnostic only.';
      const ended = markIterationEnded(iteration, 'missing_authority_receipt', nextAction, 'missing_authority');
      return finalize(root, record, {
        status: 'missing_authority_receipt',
        stopReason: 'missing_authority',
        stopDetails: authorityReceiptGate.nextAction,
        iterations: [...record.iterations.slice(0, -1), { ...ended, dispatchId, warnings }],
        nextAction,
        events: [...record.events, event('missing_authority_receipt', authorityReceiptGate.nextAction, { dispatchId, stopReason: 'missing_authority' })],
      });
    }

    if (mode === 'full-autopilot' && !mergePlan.mergeable) {
      const stopReason = mergePlanStopReason(mergePlan);
      const nextAction = stopReason === 'conflict'
        ? 'Full-autopilot stopped at a conflict boundary. Manual repair required before rerunning autopilot_run.'
        : 'Full-autopilot stopped before integration because dispatch_merge_plan withheld merge guidance. Review validation diagnostics manually.';
      const ended = markIterationEnded(iteration, 'failed', nextAction, stopReason);
      const nextIterations = [...record.iterations.slice(0, -1), { ...ended, dispatchId, warnings }];
      const stopDetails = mergePlan.warnings.join('; ') || 'dispatch_merge_plan was not mergeable';
      const measuredSpendDeltaUSD = auto.host === 'fake' ? 0 : undefined;
      const retryDecision = validationRetryDecision(policy, stopReason, index, maxIterations, startMs, timeoutMs, record, measuredSpendDeltaUSD);
      if (retryDecision.retry) {
        record = persist(root, {
          ...record,
          ...(retryDecision.budgetSpentUSD !== undefined ? { budgetSpentUSD: retryDecision.budgetSpentUSD } : {}),
          iterations: nextIterations,
          errors: [...record.errors, stopDetails],
          nextAction: 'Validation failed and policy allowAutoFix=true; scheduling the next bounded full-autopilot iteration.',
          events: [
            ...record.events,
            event('validation_failed', stopDetails, { dispatchId, stopReason }),
            event('retry_scheduled', `iteration ${index + 1} scheduled after validation failure`, { dispatchId, stopReason }),
          ],
        });
        continue;
      }
      if (retryDecision.refusal) {
        return finalize(root, record, {
          status: 'failed',
          stopReason: retryDecision.refusal.stopReason,
          stopDetails: retryDecision.refusal.stopDetails,
          ...(retryDecision.budgetSpentUSD !== undefined ? { budgetSpentUSD: retryDecision.budgetSpentUSD } : {}),
          iterations: nextIterations,
          errors: [...record.errors, stopDetails, retryDecision.refusal.stopDetails],
          nextAction: retryDecision.refusal.nextAction,
          events: [
            ...record.events,
            event('validation_failed', stopDetails, { dispatchId, stopReason }),
            event('retry_refused', retryDecision.refusal.stopDetails, { dispatchId, stopReason: retryDecision.refusal.stopReason }),
          ],
        });
      }
      return finalize(root, record, {
        status: 'failed',
        stopReason,
        stopDetails,
        iterations: nextIterations,
        nextAction,
        events: [...record.events, event('validation_failed', 'dispatch_merge_plan was not mergeable', { dispatchId, stopReason })],
      });
    }

    const nextAction = 'Authority receipt gate passed, but autopilot v1 remains manual-review only. Inspect mergeDecision and perform any integration outside autopilot.';
    const ended = markIterationEnded(iteration, 'manual_review_ready', nextAction);
    return finalize(root, record, {
      status: 'manual_review_ready',
      iterations: [...record.iterations.slice(0, -1), { ...ended, dispatchId, warnings }],
      nextAction,
      events: [...record.events, event('manual_review_ready', 'authority receipt gate passed; autopilot stopped before manual integration', { dispatchId })],
    });
  }

  return finalize(root, record, {
    status: 'failed',
    stopReason: 'max_iterations',
    stopDetails: `maxIterations=${maxIterations} exhausted`,
    nextAction: 'Inspect the persisted run and dispatch records manually before retrying.',
    events: [...record.events, event('stopped', 'maxIterations exhausted', { stopReason: 'max_iterations' })],
  });
}

export function autopilotStatus(root: string, runId: string): AutopilotRunRecord {
  return readRunRecord(root, runId);
}

export function autopilotWatch(root: string, runId: string): AutopilotWatchResult {
  const record = readRunRecord(root, runId);
  let watch: DispatchWatchResult | undefined;
  if (record.dispatchId) {
    try {
      watch = dispatchWatch(root, record.dispatchId);
    } catch {
      watch = record.dispatch?.watch;
    }
  }
  return {
    schemaVersion: AUTOPILOT_WATCH_SCHEMA_VERSION,
    runId: record.runId,
    storyId: record.storyId,
    mode: record.mode,
    status: record.status,
    ...(record.dispatchId ? { dispatchId: record.dispatchId } : {}),
    ...(watch ? { dispatchWatch: watch } : {}),
    iterationCount: record.iterations.length,
    ...(record.stopReason ? { stopReason: record.stopReason } : {}),
    authorityReceiptGate: record.authorityReceiptGate,
    ...(record.mergeDecision ? { mergeDecision: record.mergeDecision } : {}),
    nextAction: record.nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function autopilotCancel(root: string, runId: string): AutopilotCancelResult {
  const record = readRunRecord(root, runId);
  if (record.dispatchId && !['manual_review_ready', 'missing_authority_receipt', 'failed', 'cancelled'].includes(record.status)) {
    cancelDispatch(root, record.dispatchId);
  }
  const nextAction = 'Autopilot run cancelled. Review persisted dispatch and run records manually; no authority state changed.';
  const cancelled = persist(root, {
    ...record,
    status: 'cancelled',
    completedAt: nowIso(),
    nextAction,
    events: [...record.events, event('cancelled', nextAction, record.dispatchId ? { dispatchId: record.dispatchId } : {})],
  });
  return {
    schemaVersion: AUTOPILOT_CANCEL_SCHEMA_VERSION,
    runId: cancelled.runId,
    status: 'cancelled',
    ...(cancelled.dispatchId ? { dispatchId: cancelled.dispatchId } : {}),
    nextAction,
    record: cancelled,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function autopilotReview(root: string, runId: string): AutopilotReviewResult {
  let record = readRunRecord(root, runId);
  let dispatchReviewResult: DispatchReviewResult | undefined;
  let mergePlan: DispatchMergePlanResult | undefined;
  if (record.dispatchId) {
    dispatchReviewResult = reviewDispatch(root, record.dispatchId);
    mergePlan = buildDispatchMergePlan(root, record.dispatchId);
    const mergeDecision = buildMergeDecision(mergePlan);
    const status: AutopilotStatus =
      dispatchReviewResult.localReceiptStatus === 'accepted-local' && dispatchReviewResult.transcriptExists
        ? record.status === 'missing_authority_receipt' ? 'missing_authority_receipt' : 'manual_review_ready'
        : 'needs_receipt';
    record = persist(root, {
      ...record,
      status,
      dispatch: {
        ...record.dispatch,
        review: dispatchReviewResult,
        mergePlan,
      },
      mergeDecision,
      nextAction: status === 'needs_receipt'
        ? 'Host-native receipt or transcript evidence is still missing. Stay before integration, DONE, and main merge.'
        : record.nextAction,
      events: [...record.events, event('review_refreshed', 'autopilot_review refreshed dispatch_review and dispatch_merge_plan', { dispatchId: record.dispatchId })],
    });
  }
  return {
    schemaVersion: AUTOPILOT_REVIEW_SCHEMA_VERSION,
    runId: record.runId,
    storyId: record.storyId,
    status: record.status,
    ...(dispatchReviewResult ? { dispatchReview: dispatchReviewResult } : {}),
    ...(mergePlan ? { mergePlan } : {}),
    ...(record.mergeDecision ? { mergeDecision: record.mergeDecision } : {}),
    authorityReceiptGate: record.authorityReceiptGate,
    nextAction: record.nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function autopilotResume(_store: StoryStore, root: string, args: AutopilotResumeArgs): AutopilotResumeResult {
  let record = readRunRecord(root, args.runId);
  const maxAge = Math.max(1, Math.floor(args.maxResumeAgeMs ?? 15 * 60 * 1000));
  const updatedAtMs = Date.parse(record.updatedAt);
  const stale = Number.isNaN(updatedAtMs) || Date.now() - updatedAtMs > maxAge;
  const reason: AutopilotResumeResult['reason'] = stale ? 'stale_state' : 'unsafe_state';
  const nextAction = stale
    ? 'Resume refused: persisted autopilot state is stale. Start a new autopilot_run after manually reviewing dispatch state.'
    : 'Resume refused: autopilot v1 does not safely resume host-native runs. Start a new autopilot_run or review the dispatch manually.';
  record = persist(root, {
    ...record,
    events: [...record.events, event('resume_refused', nextAction)],
    nextAction,
  });
  return {
    schemaVersion: AUTOPILOT_RESUME_SCHEMA_VERSION,
    runId: record.runId,
    status: 'refused',
    reason,
    record,
    nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function renderAutopilotRunText(record: AutopilotRunRecord): string {
  const lines = [
    `Autopilot run (${record.schemaVersion})`,
    `runId: ${record.runId}`,
    `storyId: ${record.storyId}`,
    `mode: ${record.mode}`,
    `status: ${record.status}`,
    ...(record.dispatchId ? [`dispatchId: ${record.dispatchId}`] : []),
    ...(record.stopReason ? [`stopReason: ${record.stopReason}`] : []),
    `authorityChanged: false`,
    `receiptVerified: false`,
    `productionDone: false`,
    `serverReceiptRequired: ${record.authority.serverReceiptRequired}`,
    `serverReceiptVerified: ${record.authority.serverReceiptVerified}`,
    `nextAction: ${record.nextAction}`,
    `runFile: ${record.runFile}`,
  ];
  if (record.mergeDecision) {
    lines.push('', 'mergeDecision:');
    lines.push(`  decision: ${record.mergeDecision.decision}`);
    lines.push(`  manualOnly: ${record.mergeDecision.manualOnly}`);
    lines.push(`  mergeable: ${record.mergeDecision.mergeable}`);
  }
  if (record.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...record.warnings.map(warning => `  - ${warning}`));
  }
  if (record.errors.length > 0) {
    lines.push('', 'errors:');
    lines.push(...record.errors.map(error => `  - ${error}`));
  }
  return lines.join('\n');
}

export function renderAutopilotWatchText(result: AutopilotWatchResult): string {
  return [
    `Autopilot watch (${result.schemaVersion})`,
    `runId: ${result.runId}`,
    `storyId: ${result.storyId}`,
    `mode: ${result.mode}`,
    `status: ${result.status}`,
    ...(result.dispatchId ? [`dispatchId: ${result.dispatchId}`] : []),
    ...(result.stopReason ? [`stopReason: ${result.stopReason}`] : []),
    `iterations: ${result.iterationCount}`,
    `serverReceiptVerified: ${result.authorityReceiptGate.verified}`,
    `nextAction: ${result.nextAction}`,
  ].join('\n');
}

export function renderAutopilotCancelText(result: AutopilotCancelResult): string {
  return [
    `Autopilot cancel (${result.schemaVersion})`,
    `runId: ${result.runId}`,
    `status: ${result.status}`,
    ...(result.dispatchId ? [`dispatchId: ${result.dispatchId}`] : []),
    `nextAction: ${result.nextAction}`,
  ].join('\n');
}

export function renderAutopilotReviewText(result: AutopilotReviewResult): string {
  const lines = [
    `Autopilot review (${result.schemaVersion})`,
    `runId: ${result.runId}`,
    `storyId: ${result.storyId}`,
    `status: ${result.status}`,
    `serverReceiptVerified: ${result.authorityReceiptGate.verified}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.dispatchReview) {
    lines.push(`dispatchReview.status: ${result.dispatchReview.status}`);
    lines.push(`localReceiptStatus: ${result.dispatchReview.localReceiptStatus}`);
    lines.push(`transcriptExists: ${result.dispatchReview.transcriptExists}`);
  }
  if (result.mergeDecision) {
    lines.push(`mergeDecision: ${result.mergeDecision.decision}`);
    lines.push(`manualOnly: ${result.mergeDecision.manualOnly}`);
  }
  return lines.join('\n');
}

export function renderAutopilotResumeText(result: AutopilotResumeResult): string {
  return [
    `Autopilot resume (${result.schemaVersion})`,
    `runId: ${result.runId}`,
    `status: ${result.status}`,
    `reason: ${result.reason}`,
    `nextAction: ${result.nextAction}`,
  ].join('\n');
}

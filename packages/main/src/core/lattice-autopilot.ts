import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, fsyncSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  checkAutopilotPolicy,
  type AutopilotPolicyCheckOptions,
  type AutopilotPolicyCheckResult,
  type AutopilotPolicy as PersistedAutopilotPolicy,
  type AutopilotMode as PersistedAutopilotMode,
} from './autopilot-policy.js';
import { checkDispatchPolicy, type DispatchPolicy } from './dispatch-policy.js';
import { currentGitHead, currentMaterialHash, isMaterialExcludedPath } from './evidence-freshness.js';
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
import {
  buildProviderHealthRecoveredEvents,
  buildProviderHealthTransition,
  classifyAutopilotProviderFailure,
  type AutopilotFailureClass,
} from './autopilot-reliability.js';
import { LATTICE_DIR } from './lattice-paths.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';
import type { StoryStore } from './store.js';

export const AUTOPILOT_RUN_SCHEMA_VERSION = 'lattice.autopilot_run.v1' as const;
export const AUTOPILOT_WATCH_SCHEMA_VERSION = 'lattice.autopilot_watch.v1' as const;
export const AUTOPILOT_CANCEL_SCHEMA_VERSION = 'lattice.autopilot_cancel.v1' as const;
export const AUTOPILOT_REVIEW_SCHEMA_VERSION = 'lattice.autopilot_review.v1' as const;
export const AUTOPILOT_RESUME_SCHEMA_VERSION = 'lattice.autopilot_resume.v1' as const;
export const AUTOPILOT_CHECKPOINT_LEDGER_SCHEMA_VERSION = 'lattice.autopilot_checkpoint_ledger.v1' as const;

export const AUTOPILOT_STOP_REASONS = [
  'max_iterations',
  'timeout',
  'budget_exhausted',
  'conflict',
  'scope_violation',
  'validation_failed',
  'missing_receipt',
  'missing_authority',
  'provider_unhealthy',
  'human_required',
] as const;

export type AutopilotMode = 'conservative' | 'authority-verified' | 'full-autopilot'; // legacy retired non-conservative modes are refused.
type AutopilotModeAssertion = AutopilotMode;
export type AutopilotStatus =
  | 'created'
  | 'running'
  | 'needs_receipt'
  | 'waiting_for_provider_health'
  | 'paused_requires_resume'
  | 'blocked_requires_human'
  | 'manual_review_ready'
  | 'local_assurance_incomplete'
  | 'cancelled'
  | 'failed';
export type AutopilotStopReason = typeof AUTOPILOT_STOP_REASONS[number];

export interface AutopilotAuthorityBoundary {
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
  localAssuranceRequired: boolean;
  localAssurancePresent: boolean;
  localAssuranceVerified: boolean;
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

export interface AutopilotLocalAssuranceGate {
  required: boolean;
  present: boolean;
  verified: boolean;
  source: 'missing' | 'local-diagnostic' | 'local-admissibility' | 'invalid';
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
  failureClass?: AutopilotFailureClass;
  healthCategory?: 'llm_rate_limit' | 'llm_overload' | 'llm_network';
  retryAfterMs?: number;
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
  checkpointLedger?: AutopilotCheckpointLedgerProjection;
  localAssuranceGate: AutopilotLocalAssuranceGate;
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
  localProofEvidence?: unknown;
  localAssuranceEvidence?: unknown;
  localAdmissibilityEvidence?: unknown;
  trustedTestLocalAssuranceEvidence?: unknown;
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
  localAssuranceGate: AutopilotLocalAssuranceGate;
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
  localAssuranceGate: AutopilotLocalAssuranceGate;
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
  status: 'resume_ready' | 'refused';
  reason?: 'unsafe_state' | 'stale_state' | 'corrupt_state';
  projection?: AutopilotResumeProjection;
  record: AutopilotRunRecord;
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export type AutopilotCheckpointStatus = 'pending' | 'running' | 'done' | 'failed' | 'stale';

export interface AutopilotStepIdentity {
  stepId: string;
  iterationIndex: number;
  stepInputClosureHash: string;
}

export interface AutopilotRunBasis {
  runBasisHash: string;
  frozenRunPlanHash: string;
  storyId: string;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
  validityPolicyDigest: string;
  producerRuntimeIdentity: string;
  producerRuntimeInput: {
    host?: string;
    fromHost?: string;
  };
  declaredOutputPaths: string[];
  stepIdentities: AutopilotStepIdentity[];
}

export interface AutopilotCheckpointLedgerProjection {
  schemaVersion: typeof AUTOPILOT_CHECKPOINT_LEDGER_SCHEMA_VERSION;
  ledgerFile: string;
  runBasisHash: string;
  frozenRunPlanHash: string;
  storyFilesHash?: string;
  checkpointCount: number;
  lastEventHash?: string;
}

export interface AutopilotResumeProjection {
  ledgerFile: string;
  runBasisHash: string;
  frozenRunPlanHash: string;
  skippedDoneSteps: string[];
  nextStepId?: string;
  nextStepIndex?: number;
  remainingSteps: number;
  checkpointCount: number;
  recoveredFromLedger: boolean;
}

interface AutopilotCheckpointEvent {
  schemaVersion: typeof AUTOPILOT_CHECKPOINT_LEDGER_SCHEMA_VERSION;
  sequence: number;
  at: string;
  runId: string;
  type: 'run_basis' | 'checkpoint' | 'snapshot';
  previousHash: string | null;
  eventHash: string;
  runBasis?: AutopilotRunBasis;
  checkpoint?: AutopilotCheckpoint;
  snapshot?: AutopilotRunRecord;
}

interface AutopilotCheckpoint {
  stepId: string;
  iterationIndex: number;
  stepInputClosureHash: string;
  status: AutopilotCheckpointStatus;
  dispatchId?: string;
  note?: string;
}

interface ReplayedCheckpointLedger {
  ok: true;
  basis: AutopilotRunBasis;
  events: AutopilotCheckpointEvent[];
  checkpoints: Map<string, AutopilotCheckpoint>;
  lastSnapshot?: AutopilotRunRecord;
  lastEventHash?: string;
  hasStaleCheckpoint: boolean;
}

interface FailedCheckpointReplay {
  ok: false;
  reason: string;
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
  if (mode === 'authority-verified') return 'authority-verified'; // legacy retired mode assertion.
  if (mode === 'full-autopilot') return 'full-autopilot';
  throw new Error(`autopilot_run: unknown mode "${String(mode)}"; expected conservative; legacy retired aliases authority-verified/full-autopilot are refused by policy`);
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
  return join(root, LATTICE_DIR, 'autopilot-runs');
}

function runDir(root: string, runId: string): string {
  return join(runsDir(root), safeSegment(runId, 'runId'));
}

function runJsonPath(root: string, runId: string): string {
  return join(runDir(root, runId), 'run.json');
}

function checkpointLedgerPath(root: string, runId: string): string {
  return join(runDir(root, runId), 'checkpoint-events.jsonl');
}

function runJsonRelPath(runId: string): string {
  return join(LATTICE_DIR, 'autopilot-runs', safeSegment(runId, 'runId'), 'run.json').replace(/\\/g, '/');
}

function checkpointLedgerRelPath(runId: string): string {
  return join(LATTICE_DIR, 'autopilot-runs', safeSegment(runId, 'runId'), 'checkpoint-events.jsonl').replace(/\\/g, '/');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function eventDigest(eventRecord: Omit<AutopilotCheckpointEvent, 'eventHash'>): string {
  return digest(eventRecord);
}

function appendLineFsync(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function eventWithHash(eventRecord: Omit<AutopilotCheckpointEvent, 'eventHash'>): AutopilotCheckpointEvent {
  return {
    ...eventRecord,
    eventHash: eventDigest(eventRecord),
  };
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

function readRunRecordMaybe(root: string, runId: string): { record?: AutopilotRunRecord; error?: string } {
  const file = runJsonPath(root, runId);
  if (!existsSync(file)) {
    return { error: `autopilot run not found: ${runId}` };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as AutopilotRunRecord;
    if (parsed.schemaVersion !== AUTOPILOT_RUN_SCHEMA_VERSION) {
      return { error: `unsupported autopilot run schema for ${runId}: ${String((parsed as { schemaVersion?: unknown }).schemaVersion)}` };
    }
    return { record: parsed };
  } catch (error) {
    return { error: String((error as { message?: unknown }).message ?? error) };
  }
}

function readRunRecord(root: string, runId: string): AutopilotRunRecord {
  const read = readRunRecordMaybe(root, runId);
  if (read.record) return read.record;
  throw new Error(read.error ?? `autopilot run not found: ${runId}`);
}

function persist(root: string, record: AutopilotRunRecord): AutopilotRunRecord {
  const updated = { ...record, updatedAt: nowIso() };
  writeJsonAtomic(runJsonPath(root, updated.runId), updated);
  return updated;
}

function cloneRunRecord(record: AutopilotRunRecord): AutopilotRunRecord {
  return JSON.parse(JSON.stringify(record)) as AutopilotRunRecord;
}

function event(type: string, message: string, extra: Omit<Partial<AutopilotEvent>, 'at' | 'type' | 'message'> = {}): AutopilotEvent {
  return {
    at: nowIso(),
    type,
    message,
    ...extra,
  };
}

function healthEventsForRun(healthEvents: ReturnType<typeof buildProviderHealthRecoveredEvents>): AutopilotEvent[] {
  return healthEvents.map(healthEvent => ({
    at: healthEvent.at,
    type: healthEvent.type,
    message: healthEvent.message,
    ...(healthEvent.failureClass ? { failureClass: healthEvent.failureClass } : {}),
    ...(healthEvent.healthCategory ? { healthCategory: healthEvent.healthCategory } : {}),
    ...(healthEvent.retryAfterMs !== undefined ? { retryAfterMs: healthEvent.retryAfterMs } : {}),
  }));
}

function normalizeOutputPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function pathMatchesDeclaredOutput(path: string, declaredOutputPaths: string[]): boolean {
  const normalized = normalizeOutputPath(path);
  return declaredOutputPaths.some(output => {
    const candidate = normalizeOutputPath(output);
    if (!candidate) return false;
    return normalized === candidate || normalized.startsWith(`${candidate}/`);
  });
}

function currentStoryFilesHashExcludingOutputs(
  metadataRoot: string,
  gitCwd: string,
  declaredOutputPaths: string[],
): string | undefined {
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 1024,
    });
    const entries = raw.split('\0').filter(Boolean);
    const materialEntries: string[] = [];
    for (const entry of entries) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const meta = entry.slice(0, tab);
      const filePath = entry.slice(tab + 1);
      if (isMaterialExcludedPath(filePath, metadataRoot)) continue;
      if (pathMatchesDeclaredOutput(filePath, declaredOutputPaths)) continue;
      const objectId = meta.trim().split(/\s+/)[2];
      if (!objectId) continue;
      materialEntries.push(`${filePath}\0${objectId}`);
    }
    return createHash('sha256').update(materialEntries.sort().join('\0')).digest('hex');
  } catch {
    return undefined;
  }
}

function buildRunPlanDigest(args: AutopilotRunArgs, policy: PersistedAutopilotPolicy, declaredOutputPaths: string[]): string {
  return digest({
    storyId: args.storyId,
    mode: policy.mode,
    policy: args.policy,
    dispatchPolicy: policy.dispatchPolicy,
    maxIterations: Math.max(0, Math.floor(policy.maxIterations)),
    maxRuntimeMinutes: policy.maxRuntimeMinutes,
    maxBudgetUSD: policy.maxBudgetUSD,
    host: args.host,
    fromHost: args.fromHost,
    role: args.role,
    objective: args.objective,
    allowedPaths: declaredOutputPaths,
    deniedPaths: normalizeList(args.deniedPaths) ?? [],
    requiredCommands: normalizeList(args.requiredCommands) ?? [],
    successCriteria: normalizeList(args.successCriteria) ?? [],
    baseSha: args.baseSha,
    packId: args.packId,
    authorityBoundary: args.authorityBoundary,
    executionInstructions: normalizeList(args.executionInstructions) ?? [],
    parallel: args.parallel,
  });
}

function dispatchPolicyMaterial(policy: DispatchPolicy): Omit<DispatchPolicy, 'createdAt'> {
  const { createdAt: _createdAt, ...material } = policy;
  return material;
}

function buildDispatchPolicyMaterialDigest(root: string, policyName: string): { ok: true; digest: string } | { ok: false; reason: string } {
  try {
    const check = checkDispatchPolicy(root, policyName);
    if (check.status === 'refused') {
      const reason = check.reasons.length > 0 ? check.reasons.join('; ') : check.nextAction;
      return { ok: false, reason: `dispatch policy ${policyName} refused: ${reason}` };
    }
    return {
      ok: true,
      digest: digest({
        schema: 'lattice.dispatch_policy_material.v1',
        policy: dispatchPolicyMaterial(check.normalizedPolicy),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `dispatch policy ${policyName} could not be loaded: ${String((error as { message?: unknown }).message ?? error)}`,
    };
  }
}

function buildValidityPolicyDigest(root: string, policy: PersistedAutopilotPolicy): string {
  const dispatchPolicyDigest = buildDispatchPolicyMaterialDigest(root, policy.dispatchPolicy);
  if (!dispatchPolicyDigest.ok) {
    throw new Error(dispatchPolicyDigest.reason);
  }
  return digest({
    schema: AUTOPILOT_CHECKPOINT_LEDGER_SCHEMA_VERSION,
    policyName: policy.policy,
    dispatchPolicy: policy.dispatchPolicy,
    dispatchPolicyDigest: dispatchPolicyDigest.digest,
    mode: policy.mode,
    allowAutoDispatch: policy.allowAutoDispatch,
    allowAutoValidate: policy.allowAutoValidate,
    allowAutoFix: policy.allowAutoFix,
    allowStoryIntegration: policy.allowStoryIntegration,
    allowDoneAdvance: policy.allowDoneAdvance,
    allowMainMerge: policy.allowMainMerge,
    stopOnConflict: policy.stopOnConflict,
    stopOnScopeViolation: policy.stopOnScopeViolation,
    requireLocalAssurance: policy.requireLocalAssurance,
    maxIterations: policy.maxIterations,
    maxRuntimeMinutes: policy.maxRuntimeMinutes,
    maxBudgetUSD: policy.maxBudgetUSD,
  });
}

function buildProducerRuntimeIdentity(args: AutopilotRunArgs): string {
  return digest({
    executor: 'lattice-autopilot-m1',
    host: args.host ?? args.fromHost ?? 'policy-default',
    adapterBoundary: 'host-native-dispatch',
  });
}

function buildRunBasis(
  root: string,
  gitCwd: string,
  args: AutopilotRunArgs,
  policy: PersistedAutopilotPolicy,
  declaredOutputPaths: string[],
): AutopilotRunBasis {
  const frozenRunPlanHash = buildRunPlanDigest(args, policy, declaredOutputPaths);
  const validityPolicyDigest = buildValidityPolicyDigest(root, policy);
  const headHash = currentGitHead(gitCwd);
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', root);
  const storyFilesHash = currentStoryFilesHashExcludingOutputs(root, gitCwd, declaredOutputPaths);
  const producerRuntimeInput = {
    ...(args.host ? { host: args.host } : {}),
    ...(args.fromHost ? { fromHost: args.fromHost } : {}),
  };
  const producerRuntimeIdentity = buildProducerRuntimeIdentity(args);
  const maxIterations = Math.max(0, Math.floor(policy.maxIterations));
  const basisInput = {
    storyId: args.storyId,
    headHash,
    materialHash,
    storyFilesHash,
    validityPolicyDigest,
    producerRuntimeIdentity,
    producerRuntimeInput,
    frozenRunPlanHash,
    declaredOutputPaths,
  };
  const runBasisHash = digest(basisInput);
  const stepInputs = dispatchArgs(args, policy.dispatchPolicy);
  const stepIdentities = Array.from({ length: maxIterations }, (_, index): AutopilotStepIdentity => ({
    stepId: `iteration-${index}`,
    iterationIndex: index,
    stepInputClosureHash: digest({
      runBasisHash,
      frozenRunPlanHash,
      iterationIndex: index,
      dispatch: stepInputs,
    }),
  }));
  return {
    ...basisInput,
    runBasisHash,
    stepIdentities,
  };
}

function checkpointProjection(runId: string, basis: AutopilotRunBasis, checkpointCount: number, lastEventHash?: string): AutopilotCheckpointLedgerProjection {
  return {
    schemaVersion: AUTOPILOT_CHECKPOINT_LEDGER_SCHEMA_VERSION,
    ledgerFile: checkpointLedgerRelPath(runId),
    runBasisHash: basis.runBasisHash,
    frozenRunPlanHash: basis.frozenRunPlanHash,
    ...(basis.storyFilesHash ? { storyFilesHash: basis.storyFilesHash } : {}),
    checkpointCount,
    ...(lastEventHash ? { lastEventHash } : {}),
  };
}

function appendCheckpointEvent(root: string, record: AutopilotRunRecord, eventRecord: Omit<AutopilotCheckpointEvent, 'eventHash'>): AutopilotCheckpointEvent {
  const checkpointEvent = eventWithHash(eventRecord);
  appendLineFsync(checkpointLedgerPath(root, record.runId), JSON.stringify(checkpointEvent) + '\n');
  return checkpointEvent;
}

function initializeCheckpointLedger(root: string, record: AutopilotRunRecord, basis: AutopilotRunBasis): AutopilotRunRecord {
  const file = checkpointLedgerPath(root, record.runId);
  rmSync(file, { force: true });
  const checkpointEvent = appendCheckpointEvent(root, record, {
    schemaVersion: AUTOPILOT_CHECKPOINT_LEDGER_SCHEMA_VERSION,
    sequence: 0,
    at: nowIso(),
    runId: record.runId,
    type: 'run_basis',
    previousHash: null,
    runBasis: basis,
    snapshot: record,
  });
  return persist(root, {
    ...record,
    checkpointLedger: checkpointProjection(record.runId, basis, 0, checkpointEvent.eventHash),
  });
}

function checkpointForBasis(basis: AutopilotRunBasis, iterationIndex: number): AutopilotCheckpoint {
  const step = basis.stepIdentities[iterationIndex];
  if (!step) {
    throw new Error(`autopilot checkpoint missing step identity for iteration ${iterationIndex}`);
  }
  return {
    stepId: step.stepId,
    iterationIndex,
    stepInputClosureHash: step.stepInputClosureHash,
    status: 'running',
  };
}

function recordCheckpoint(
  root: string,
  record: AutopilotRunRecord,
  basis: AutopilotRunBasis,
  sequence: number,
  previousHash: string,
  iterationIndex: number,
  status: AutopilotCheckpointStatus,
  options: { dispatchId?: string; note?: string; snapshot?: AutopilotRunRecord } = {},
): AutopilotCheckpointEvent {
  const checkpoint = {
    ...checkpointForBasis(basis, iterationIndex),
    status,
    ...(options.dispatchId ? { dispatchId: options.dispatchId } : {}),
    ...(options.note ? { note: options.note } : {}),
  };
  return appendCheckpointEvent(root, record, {
    schemaVersion: AUTOPILOT_CHECKPOINT_LEDGER_SCHEMA_VERSION,
    sequence,
    at: nowIso(),
    runId: record.runId,
    type: 'checkpoint',
    previousHash,
    checkpoint,
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
  });
}

function recordSnapshot(
  root: string,
  record: AutopilotRunRecord,
  sequence: number,
  previousHash: string,
  snapshot: AutopilotRunRecord,
): AutopilotCheckpointEvent {
  return appendCheckpointEvent(root, record, {
    schemaVersion: AUTOPILOT_CHECKPOINT_LEDGER_SCHEMA_VERSION,
    sequence,
    at: nowIso(),
    runId: record.runId,
    type: 'snapshot',
    previousHash,
    snapshot,
  });
}

function replayCheckpointLedger(root: string, runId: string): ReplayedCheckpointLedger | FailedCheckpointReplay {
  const file = checkpointLedgerPath(root, runId);
  if (!existsSync(file)) return { ok: false, reason: `checkpoint ledger not found for ${runId}` };
  let lines: string[];
  try {
    lines = readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
  } catch (error) {
    return { ok: false, reason: `checkpoint ledger unreadable: ${String((error as { message?: unknown }).message ?? error)}` };
  }
  if (lines.length === 0) return { ok: false, reason: 'checkpoint ledger is empty' };

  const events: AutopilotCheckpointEvent[] = [];
  let previousHash: string | null = null;
  let basis: AutopilotRunBasis | undefined;
  let lastSnapshot: AutopilotRunRecord | undefined;
  const checkpoints = new Map<string, AutopilotCheckpointEvent['checkpoint'] & {}>();
  let hasStaleCheckpoint = false;

  for (let index = 0; index < lines.length; index++) {
    let parsed: AutopilotCheckpointEvent;
    try {
      parsed = JSON.parse(lines[index]) as AutopilotCheckpointEvent;
    } catch (error) {
      return { ok: false, reason: `checkpoint ledger line ${index + 1} is not valid JSON: ${String((error as { message?: unknown }).message ?? error)}` };
    }
    if (parsed.schemaVersion !== AUTOPILOT_CHECKPOINT_LEDGER_SCHEMA_VERSION) {
      return { ok: false, reason: `checkpoint ledger line ${index + 1} has unsupported schemaVersion` };
    }
    if (parsed.runId !== runId) {
      return { ok: false, reason: `checkpoint ledger line ${index + 1} runId mismatch` };
    }
    if (parsed.sequence !== index) {
      return { ok: false, reason: `checkpoint ledger line ${index + 1} sequence mismatch` };
    }
    if (parsed.previousHash !== previousHash) {
      return { ok: false, reason: `checkpoint ledger line ${index + 1} hash chain mismatch` };
    }
    const { eventHash: _eventHash, ...withoutHash } = parsed;
    if (parsed.eventHash !== eventDigest(withoutHash)) {
      return { ok: false, reason: `checkpoint ledger line ${index + 1} eventHash mismatch` };
    }
    if (parsed.snapshot) lastSnapshot = parsed.snapshot;
    if (parsed.type === 'run_basis') {
      if (basis) return { ok: false, reason: 'checkpoint ledger contains multiple run_basis events' };
      if (!parsed.runBasis?.runBasisHash || !parsed.runBasis.frozenRunPlanHash) {
        return { ok: false, reason: 'checkpoint ledger run_basis is missing required hashes' };
      }
      if (digest({
        storyId: parsed.runBasis.storyId,
        headHash: parsed.runBasis.headHash,
        materialHash: parsed.runBasis.materialHash,
        storyFilesHash: parsed.runBasis.storyFilesHash,
        validityPolicyDigest: parsed.runBasis.validityPolicyDigest,
        producerRuntimeIdentity: parsed.runBasis.producerRuntimeIdentity,
        producerRuntimeInput: parsed.runBasis.producerRuntimeInput ?? {},
        frozenRunPlanHash: parsed.runBasis.frozenRunPlanHash,
        declaredOutputPaths: parsed.runBasis.declaredOutputPaths,
      }) !== parsed.runBasis.runBasisHash) {
        return { ok: false, reason: 'checkpoint ledger runBasisHash does not match its material fields' };
      }
      basis = parsed.runBasis;
    } else if (parsed.type === 'checkpoint') {
      if (!basis) return { ok: false, reason: 'checkpoint ledger checkpoint appeared before run_basis' };
      const checkpoint = parsed.checkpoint;
      if (!checkpoint) return { ok: false, reason: `checkpoint ledger line ${index + 1} is missing checkpoint payload` };
      const expected = basis.stepIdentities[checkpoint.iterationIndex];
      if (!expected || expected.stepId !== checkpoint.stepId || expected.stepInputClosureHash !== checkpoint.stepInputClosureHash) {
        return { ok: false, reason: `checkpoint ledger line ${index + 1} checkpoint identity mismatch` };
      }
      const existing = checkpoints.get(checkpoint.stepId);
      if (existing && existing.stepInputClosureHash !== checkpoint.stepInputClosureHash) {
        return { ok: false, reason: `checkpoint ledger conflicting identity for ${checkpoint.stepId}` };
      }
      if (checkpoint.status === 'stale') hasStaleCheckpoint = true;
      checkpoints.set(checkpoint.stepId, checkpoint);
    } else if (parsed.type === 'snapshot') {
      if (!basis) return { ok: false, reason: 'checkpoint ledger snapshot appeared before run_basis' };
      if (!parsed.snapshot) return { ok: false, reason: `checkpoint ledger line ${index + 1} is missing snapshot payload` };
    } else {
      return { ok: false, reason: `checkpoint ledger line ${index + 1} has unsupported event type` };
    }
    events.push(parsed);
    previousHash = parsed.eventHash;
  }

  if (!basis) return { ok: false, reason: 'checkpoint ledger is missing run_basis' };
  return {
    ok: true,
    basis,
    events,
    checkpoints,
    ...(lastSnapshot ? { lastSnapshot } : {}),
    ...(previousHash ? { lastEventHash: previousHash } : {}),
    hasStaleCheckpoint,
  };
}

function currentRunBasisMatches(
  root: string,
  gitCwd: string,
  basis: AutopilotRunBasis,
  record: AutopilotRunRecord,
): { matches: boolean; reason?: string } {
  const currentHead = currentGitHead(gitCwd);
  if (basis.headHash && !currentHead) {
    return { matches: false, reason: 'headHash could not be recomputed' };
  }
  if (basis.headHash && currentHead !== basis.headHash) {
    return { matches: false, reason: 'headHash changed since run start' };
  }
  const currentMaterial = currentMaterialHash(gitCwd, 'HEAD', root);
  if (basis.materialHash && !currentMaterial) {
    return { matches: false, reason: 'materialHash could not be recomputed' };
  }
  if (basis.materialHash && currentMaterial !== basis.materialHash) {
    return { matches: false, reason: 'materialHash changed since run start' };
  }
  const currentStoryFiles = currentStoryFilesHashExcludingOutputs(root, gitCwd, basis.declaredOutputPaths);
  if (basis.storyFilesHash && !currentStoryFiles) {
    return { matches: false, reason: 'storyFilesHash could not be recomputed' };
  }
  if (basis.storyFilesHash && currentStoryFiles !== basis.storyFilesHash) {
    return { matches: false, reason: 'storyFilesHash changed since run start' };
  }
  if (!record.policy) {
    return { matches: false, reason: 'autopilot policy is missing from run record' };
  }
  let currentPolicy: PersistedAutopilotPolicy;
  try {
    currentPolicy = checkAutopilotPolicy(root, record.policy).normalizedPolicy;
  } catch (error) {
    return {
      matches: false,
      reason: `autopilot policy could not be recomputed: ${String((error as { message?: unknown }).message ?? error)}`,
    };
  }
  let currentValidityPolicyDigest: string;
  try {
    currentValidityPolicyDigest = buildValidityPolicyDigest(root, currentPolicy);
  } catch (error) {
    return {
      matches: false,
      reason: `validityPolicyDigest could not be recomputed: ${String((error as { message?: unknown }).message ?? error)}`,
    };
  }
  if (basis.validityPolicyDigest !== currentValidityPolicyDigest) {
    return { matches: false, reason: 'validityPolicyDigest changed since run start' };
  }
  const currentRuntimeIdentity = buildProducerRuntimeIdentity({
    storyId: basis.storyId,
    policy: record.policy,
    host: basis.producerRuntimeInput?.host,
    fromHost: basis.producerRuntimeInput?.fromHost,
  });
  if (basis.producerRuntimeIdentity !== currentRuntimeIdentity) {
    return { matches: false, reason: 'producerRuntimeIdentity changed since run start' };
  }
  return { matches: true };
}

function resumeProjectionFromReplay(replay: ReplayedCheckpointLedger, recoveredFromLedger: boolean): AutopilotResumeProjection {
  const skippedDoneSteps: string[] = [];
  let nextStep: AutopilotStepIdentity | undefined;
  for (const step of replay.basis.stepIdentities) {
    const checkpoint = replay.checkpoints.get(step.stepId);
    if (checkpoint?.status === 'done') {
      skippedDoneSteps.push(step.stepId);
      continue;
    }
    nextStep = step;
    break;
  }
  const remainingSteps = nextStep
    ? replay.basis.stepIdentities.length - nextStep.iterationIndex
    : 0;
  return {
    ledgerFile: checkpointLedgerRelPath(replay.events[0]?.runId ?? ''),
    runBasisHash: replay.basis.runBasisHash,
    frozenRunPlanHash: replay.basis.frozenRunPlanHash,
    skippedDoneSteps,
    ...(nextStep ? { nextStepId: nextStep.stepId, nextStepIndex: nextStep.iterationIndex } : {}),
    remainingSteps,
    checkpointCount: replay.checkpoints.size,
    recoveredFromLedger,
  };
}

function finalStatusCheckpointStatus(status: AutopilotStatus): AutopilotCheckpointStatus {
  if (status === 'manual_review_ready' || status === 'needs_receipt' || status === 'local_assurance_incomplete') return 'done';
  if (status === 'failed') return 'failed';
  return 'running';
}

function buildDelegationContract(mode: AutopilotMode): AutopilotDelegationContract {
  return {
    hostNative: true,
    receiptRequired: true,
    transcriptRequired: true,
    handoff: {
      expectation: 'dispatch_auto must create or reuse a bounded Proofbound handoff pack with allowedPaths, deniedPaths, requiredCommands, successCriteria, and authority boundaries intact.',
    },
    receipt: {
      expectation: mode === 'authority-verified' // legacy retired mode.
        ? 'Authority-verified mode is retired; local autopilot requires local proof-admissibility and review quorum evidence before any integration discussion.'
        : 'A host local receipt is diagnostic only and must be reviewed manually; it cannot claim release readiness or replace DONE authority.',
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
    localAssuranceRequired: required,
    localAssurancePresent: false,
    localAssuranceVerified: false,
    integrationAttempted: false,
    doneAttempted: false,
    mainMergeAttempted: false,
  };
}

function localDiagnosticGate(required: boolean, nextAction?: string): AutopilotLocalAssuranceGate {
  return {
    required,
    present: false,
    verified: false,
    source: 'missing',
    missing: required ? ['localAdmissibilityEvidence'] : [],
    nextAction: nextAction ?? 'Local assurance is incomplete. Record local proof-admissibility, receipt-bundle, and review quorum evidence before integration, DONE, or main merge.',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstExplicitLocalAssuranceEvidence(args: AutopilotRunArgs): unknown {
  return args.localAdmissibilityEvidence
    ?? args.localAssuranceEvidence
    ?? args.localProofEvidence;
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

function localAssuranceShape(candidate: Record<string, unknown>): {
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

function classifyLocalAssuranceEvidenceCandidate(candidate: unknown, required: boolean, options: { trustedTestReceipt?: boolean } = {}): AutopilotLocalAssuranceGate {
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
      missing: ['localAdmissibilityEvidence'],
      nextAction: 'Local diagnostic receipts are evidence candidates only. Record admissible local gate evidence and review quorum before integration, DONE, or main merge.',
    };
  }

  const shape = localAssuranceShape(candidate);
  const hasRequiredReceiptShape = !!shape.receiptRef && !!shape.subjectDigest && !!shape.signature && shape.verified;
  const localAdmissibilityMarked = /local-admissibility|local-gate-evidence|offline-receipt-bundle/i.test(shape.sourceText);

  if (hasRequiredReceiptShape && (localAdmissibilityMarked || options.trustedTestReceipt === true)) {
    return {
      required: true,
      present: true,
      verified: true,
      source: 'local-admissibility',
      receiptRef: shape.receiptRef,
      missing: [],
      nextAction: 'Local admissibility evidence is present. Continue to manual review; this autopilot still will not auto-merge, auto-DONE, or claim release readiness.',
    };
  }

  return {
    required: true,
    present: true,
    verified: false,
    source: 'invalid',
    missing: ['localAdmissibilityEvidence'],
    nextAction: 'The provided evidence is not recognizable as admissible local gate evidence. Stay before integration, DONE, and main merge.',
  };
}

function policyCheckOptionsFromGate(gate: AutopilotLocalAssuranceGate): AutopilotPolicyCheckOptions | undefined {
  if (!gate.verified || !gate.receiptRef) return undefined;
  return {
    localAssuranceEvidence: {
      authority: 'local',
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

function isPersistedTerminalStatus(status: AutopilotStatus): boolean {
  return status !== 'created' && status !== 'running';
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
  if (/budget/i.test(message)) return 'budget_exhausted';
  if (/not unattended-safe|allowRealHostSubprocess/i.test(message)) return 'validation_failed';
  if (/timeout|timed out/i.test(message)) return 'timeout';
  if (/^dispatch_auto:\s+(unknown host|host ".+" is not in policy|policy ".+" could not be loaded|policy ".+" is supervised-only)/i.test(message)) {
    return 'validation_failed';
  }
  if (/dispatch_auto refused by policy commandAllowlist/i.test(message)) return 'validation_failed';
  const providerFailure = classifyAutopilotProviderFailure(message);
  if (providerFailure.retryableProviderHealth) return 'provider_unhealthy';
  if (providerFailure.requiresHuman) return 'human_required';
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

function providerFailureStatus(stopReason: AutopilotStopReason): AutopilotStatus | null {
  if (stopReason === 'provider_unhealthy') return 'paused_requires_resume';
  if (stopReason === 'human_required') return 'blocked_requires_human';
  return null;
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
  const preliminaryAuthorityRequired = preliminaryPolicy.requireLocalAssurance || preliminaryPolicy.mode !== 'conservative';
  const trustedTestReceipt = args.trustedTestLocalAssuranceEvidence !== undefined;
  const localAssuranceGate = classifyLocalAssuranceEvidenceCandidate(
    trustedTestReceipt ? args.trustedTestLocalAssuranceEvidence : firstExplicitLocalAssuranceEvidence(args),
    preliminaryAuthorityRequired,
    { trustedTestReceipt },
  );
  const policyCheck = checkAutopilotPolicy(root, policyName, policyCheckOptionsFromGate(localAssuranceGate));
  const policy = policyCheck.normalizedPolicy;
  const mode = policy.mode as PersistedAutopilotMode;
  const assertedMode = args.mode !== undefined ? normalizeMode(args.mode) : undefined;
  const runId = safeSegment(args.runId ?? generateRunId(args.storyId), 'runId');
  const authorityRequired = policy.requireLocalAssurance || mode !== 'conservative';
  const createdAt = nowIso();
  const maxIterations = Math.max(0, Math.floor(policy.maxIterations));
  const timeoutMs = Math.max(1, Math.floor((policy.maxRuntimeMinutes ?? 5) * 60 * 1000));
  const startMs = Date.now();
  const declaredOutputPaths = normalizeList(args.allowedPaths) ?? [];
  const gitCwd = resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root });
  const runBasis = buildRunBasis(root, gitCwd, args, policy, declaredOutputPaths);

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
    localAssuranceGate,
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
      localAssurancePresent: localAssuranceGate.present,
      localAssuranceVerified: localAssuranceGate.verified,
    },
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
  record = persist(root, record);
  record = initializeCheckpointLedger(root, record, runBasis);
  let checkpointSequence = 1;
  let previousCheckpointHash = record.checkpointLedger?.lastEventHash ?? '';
  const finalizeWithCheckpoint = (
    sourceRecord: AutopilotRunRecord,
    patch: Partial<AutopilotRunRecord> & { status: AutopilotStatus; nextAction: string },
    iterationIndex: number,
    options: { dispatchId?: string; note?: string } = {},
  ): AutopilotRunRecord => {
    let finalRecord = finalize(root, sourceRecord, patch);
    const checkpointStatus = finalStatusCheckpointStatus(finalRecord.status);
    const checkpointEvent = recordCheckpoint(
      root,
      finalRecord,
      runBasis,
      checkpointSequence,
      previousCheckpointHash,
      iterationIndex,
      checkpointStatus,
      { ...options, snapshot: finalRecord },
    );
    checkpointSequence += 1;
    previousCheckpointHash = checkpointEvent.eventHash;
    const replay = replayCheckpointLedger(root, finalRecord.runId);
    if (replay.ok) {
      finalRecord = persist(root, {
        ...finalRecord,
        checkpointLedger: checkpointProjection(finalRecord.runId, runBasis, replay.checkpoints.size, checkpointEvent.eventHash),
      });
    }
    return finalRecord;
  };
  const finalizeWithSnapshot = (
    sourceRecord: AutopilotRunRecord,
    patch: Partial<AutopilotRunRecord> & { status: AutopilotStatus; nextAction: string },
  ): AutopilotRunRecord => {
    let finalRecord = finalize(root, sourceRecord, patch);
    const checkpointEvent = recordSnapshot(root, finalRecord, checkpointSequence, previousCheckpointHash, finalRecord);
    checkpointSequence += 1;
    previousCheckpointHash = checkpointEvent.eventHash;
    const replay = replayCheckpointLedger(root, finalRecord.runId);
    if (replay.ok) {
      finalRecord = persist(root, {
        ...finalRecord,
        checkpointLedger: checkpointProjection(finalRecord.runId, runBasis, replay.checkpoints.size, checkpointEvent.eventHash),
      });
    }
    return finalRecord;
  };
  const recordFailedCheckpoint = (
    sourceRecord: AutopilotRunRecord,
    iterationIndex: number,
    options: { dispatchId?: string; note?: string } = {},
  ): void => {
    const checkpointEvent = recordCheckpoint(root, sourceRecord, runBasis, checkpointSequence, previousCheckpointHash, iterationIndex, 'failed', {
      ...options,
      snapshot: sourceRecord,
    });
    checkpointSequence += 1;
    previousCheckpointHash = checkpointEvent.eventHash;
  };

  if (policyCheck.status === 'refused') {
    return finalizeWithSnapshot(record, {
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
    return finalizeWithSnapshot(record, {
      status: 'failed',
      stopReason: 'validation_failed',
      stopDetails: message,
      errors: [...record.errors, message],
      nextAction: 'Edit the autopilot policy or rerun without a conflicting --mode assertion. CLI mode cannot widen persisted policy authority.',
      events: [...record.events, event('policy_mode_mismatch', message, { stopReason: 'validation_failed' })],
    });
  }

  if (policyCheck.status === 'supervised') {
    const localAssuranceIncomplete = policy.requireLocalAssurance && !localAssuranceGate.verified;
    const nextAction = localAssuranceIncomplete
      ? 'local_assurance_incomplete: record local proof-admissibility, receipt-bundle, and review quorum evidence before starting unattended autopilot.'
      : policyCheck.nextAction;
    return finalizeWithSnapshot(record, {
      status: localAssuranceIncomplete ? 'local_assurance_incomplete' : 'failed',
      stopReason: localAssuranceIncomplete ? 'missing_authority' : 'validation_failed',
      stopDetails: policyCheck.degradations.join('; ') || policyCheck.nextAction,
      warnings: [...record.warnings, ...policyCheck.degradations],
      nextAction,
      events: [...record.events, event(
        localAssuranceIncomplete ? 'local_assurance_incomplete' : 'policy_supervised',
        nextAction,
        { stopReason: localAssuranceIncomplete ? 'missing_authority' : 'validation_failed' },
      )],
    });
  }

  if (maxIterations <= 0) {
    return finalizeWithSnapshot(record, {
      status: 'failed',
      stopReason: 'max_iterations',
      stopDetails: 'maxIterations must be at least 1 for autopilot_run to start dispatch_auto',
      nextAction: 'Increase maxIterations and rerun autopilot_run.',
      events: [...record.events, event('stopped', 'maxIterations exhausted before dispatch_auto could start', { stopReason: 'max_iterations' })],
    });
  }

  if (budgetExhausted(record)) {
    return finalizeWithSnapshot(record, {
      status: 'failed',
      stopReason: 'budget_exhausted',
      stopDetails: `budgetSpentUSD=${record.budgetSpentUSD} reached maxBudgetUSD=${record.maxBudgetUSD}`,
      nextAction: 'Increase budget or review the existing run manually.',
      events: [...record.events, event('stopped', 'budget exhausted before dispatch_auto could start', { stopReason: 'budget_exhausted' })],
    });
  }

  for (let index = 0; index < maxIterations; index++) {
    if (timedOut(startMs, timeoutMs)) {
      return finalizeWithSnapshot(record, {
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
    const runningCheckpoint = recordCheckpoint(root, record, runBasis, checkpointSequence, previousCheckpointHash, index, 'running');
    checkpointSequence += 1;
    previousCheckpointHash = runningCheckpoint.eventHash;

    let auto: DispatchAutoResult;
    try {
      auto = dispatchAuto(store, root, dispatchArgs(args, policy.dispatchPolicy));
    } catch (error) {
      const message = String((error as { message?: unknown }).message ?? error);
      const stopReason = classifyDispatchError(message);
      const providerStatus = providerFailureStatus(stopReason);
      if (providerStatus) {
        const transition = buildProviderHealthTransition({
          error: message,
          nowIso: nowIso(),
          processAlive: false,
        });
        const ended = markIterationEnded(iteration, providerStatus, transition.nextAction, stopReason);
        return finalizeWithCheckpoint(record, {
          status: providerStatus,
          stopReason,
          stopDetails: `${transition.classification.failureClass}: ${message}`,
          iterations: [...record.iterations.slice(0, -1), ended],
          errors: transition.classification.requiresHuman ? [...record.errors, message] : record.errors,
          nextAction: transition.nextAction,
          events: [
            ...record.events,
            event('dispatch_auto_failed', message, { stopReason, failureClass: transition.classification.failureClass }),
            ...healthEventsForRun(transition.events),
          ],
        }, index, { note: `${transition.classification.failureClass}: ${message}` });
      }
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
        recordFailedCheckpoint(record, index, { note: message });
        continue;
      }
      if (retryDecision.refusal) {
        return finalizeWithCheckpoint(record, {
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
        }, index, { note: retryDecision.refusal.stopDetails });
      }
      return finalizeWithCheckpoint(record, {
        status: 'failed',
        stopReason,
        stopDetails: message,
        iterations: nextIterations,
        errors: [...record.errors, message],
        nextAction: stopReason === 'conflict'
          ? 'Manual repair required: resolve active dispatch or merge conflict evidence before rerunning autopilot_run.'
          : 'Fix the dispatch policy, host readiness, scope, or command validation issue and rerun autopilot_run.',
        events: [...record.events, event('dispatch_auto_failed', message, { stopReason })],
      }, index, { note: message });
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
      const providerStatus = providerFailureStatus(stopReason);
      if (providerStatus) {
        const transition = buildProviderHealthTransition({
          error: message,
          nowIso: nowIso(),
          processAlive: false,
        });
        const ended = markIterationEnded(iteration, providerStatus, transition.nextAction, stopReason);
        return finalizeWithCheckpoint(record, {
          status: providerStatus,
          stopReason,
          stopDetails: `${transition.classification.failureClass}: ${message}`,
          iterations: [...record.iterations.slice(0, -1), { ...ended, dispatchId, warnings }],
          errors: transition.classification.requiresHuman ? [...record.errors, message] : record.errors,
          nextAction: transition.nextAction,
          events: [
            ...record.events,
            event('validation_failed', message, { dispatchId, stopReason, failureClass: transition.classification.failureClass }),
            ...healthEventsForRun(transition.events),
          ],
        }, index, { dispatchId, note: `${transition.classification.failureClass}: ${message}` });
      }
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
        recordFailedCheckpoint(record, index, { dispatchId, note: message });
        continue;
      }
      if (retryDecision.refusal) {
        return finalizeWithCheckpoint(record, {
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
        }, index, { dispatchId, note: retryDecision.refusal.stopDetails });
      }
      return finalizeWithCheckpoint(record, {
        status: 'failed',
        stopReason,
        stopDetails: message,
        iterations: nextIterations,
        errors: [...record.errors, message],
        nextAction,
        events: [...record.events, event('validation_failed', message, { dispatchId, stopReason })],
      }, index, { dispatchId, note: message });
    }

    if (!hasLocalReceipt || !hasTranscript) {
      const missing = [
        ...(!hasLocalReceipt ? ['local diagnostic receipt'] : []),
        ...(!hasTranscript ? ['host transcript'] : []),
      ].join(', ');
      const nextAction = `Collect missing host-native evidence (${missing}) and rerun autopilot_review. No integration, DONE, or main merge is allowed.`;
      const ended = markIterationEnded(iteration, 'needs_receipt', nextAction, 'missing_receipt');
      return finalizeWithCheckpoint(record, {
        status: 'needs_receipt',
        stopReason: 'missing_receipt',
        stopDetails: `missing ${missing}`,
        iterations: [...record.iterations.slice(0, -1), { ...ended, dispatchId, warnings }],
        nextAction,
        events: [...record.events, event('needs_receipt', `missing ${missing}`, { dispatchId, stopReason: 'missing_receipt' })],
      }, index, { dispatchId, note: `missing ${missing}` });
    }

    if (mode === 'conservative') {
      const nextAction = 'Manual review ready. Inspect dispatch_review and dispatch_merge_plan output; merge remains manual-only and evidenceScope stays local-review.';
      const ended = markIterationEnded(iteration, 'manual_review_ready', nextAction);
      return finalizeWithCheckpoint(record, {
        status: 'manual_review_ready',
        iterations: [...record.iterations.slice(0, -1), { ...ended, dispatchId, warnings }],
        nextAction,
        events: [...record.events, event('manual_review_ready', 'conservative autopilot stopped before authority or merge actions', { dispatchId })],
      }, index, { dispatchId, note: 'manual_review_ready' });
    }

    if (!localAssuranceGate.verified) {
      const nextAction = 'local_assurance_incomplete: record local proof-admissibility, receipt-bundle, and review quorum evidence before integration, DONE, or main merge.';
      const ended = markIterationEnded(iteration, 'local_assurance_incomplete', nextAction, 'missing_authority');
      return finalizeWithCheckpoint(record, {
        status: 'local_assurance_incomplete',
        stopReason: 'missing_authority',
        stopDetails: localAssuranceGate.nextAction,
        iterations: [...record.iterations.slice(0, -1), { ...ended, dispatchId, warnings }],
        nextAction,
        events: [...record.events, event('local_assurance_incomplete', localAssuranceGate.nextAction, { dispatchId, stopReason: 'missing_authority' })],
      }, index, { dispatchId, note: localAssuranceGate.nextAction });
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
        recordFailedCheckpoint(record, index, { dispatchId, note: stopDetails });
        continue;
      }
      if (retryDecision.refusal) {
        return finalizeWithCheckpoint(record, {
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
        }, index, { dispatchId, note: retryDecision.refusal.stopDetails });
      }
      return finalizeWithCheckpoint(record, {
        status: 'failed',
        stopReason,
        stopDetails,
        iterations: nextIterations,
        nextAction,
        events: [...record.events, event('validation_failed', 'dispatch_merge_plan was not mergeable', { dispatchId, stopReason })],
      }, index, { dispatchId, note: stopDetails });
    }

    const nextAction = 'Local admissibility and review gates passed, but autopilot v1 remains manual-review only. Inspect mergeDecision and perform any integration outside autopilot.';
    const ended = markIterationEnded(iteration, 'manual_review_ready', nextAction);
    return finalizeWithCheckpoint(record, {
      status: 'manual_review_ready',
      iterations: [...record.iterations.slice(0, -1), { ...ended, dispatchId, warnings }],
      nextAction,
      events: [...record.events, event('manual_review_ready', 'local admissibility and review gates passed; autopilot stopped before manual integration', { dispatchId })],
    }, index, { dispatchId, note: 'manual_review_ready' });
  }

  return finalizeWithSnapshot(record, {
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
    localAssuranceGate: record.localAssuranceGate,
    ...(record.mergeDecision ? { mergeDecision: record.mergeDecision } : {}),
    nextAction: record.nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function autopilotCancel(root: string, runId: string): AutopilotCancelResult {
  const record = readRunRecord(root, runId);
  if (record.dispatchId && !['manual_review_ready', 'local_assurance_incomplete', 'failed', 'cancelled'].includes(record.status)) {
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
  const persistedRecord = readRunRecord(root, runId);
  let reviewRecord = cloneRunRecord(persistedRecord);
  let dispatchReviewResult: DispatchReviewResult | undefined;
  let mergePlan: DispatchMergePlanResult | undefined;
  if (persistedRecord.dispatchId) {
    dispatchReviewResult = reviewDispatch(root, persistedRecord.dispatchId);
    mergePlan = buildDispatchMergePlan(root, persistedRecord.dispatchId);
    const mergeDecision = buildMergeDecision(mergePlan);
    const isTerminal = isPersistedTerminalStatus(persistedRecord.status);
    const status: AutopilotStatus =
      isTerminal
        ? persistedRecord.status
        : dispatchReviewResult.localReceiptStatus === 'accepted-local' && dispatchReviewResult.transcriptExists
        ? persistedRecord.status === 'local_assurance_incomplete' ? 'local_assurance_incomplete' : 'manual_review_ready'
        : 'needs_receipt';
    reviewRecord = {
      ...reviewRecord,
      status,
      dispatch: {
        ...reviewRecord.dispatch,
        review: dispatchReviewResult,
        mergePlan,
      },
      mergeDecision,
      nextAction: !isTerminal && status === 'needs_receipt'
        ? 'Host-native receipt or transcript evidence is still missing. Stay before integration, DONE, and main merge.'
        : reviewRecord.nextAction,
    };
  }
  return {
    schemaVersion: AUTOPILOT_REVIEW_SCHEMA_VERSION,
    runId: reviewRecord.runId,
    storyId: reviewRecord.storyId,
    status: reviewRecord.status,
    ...(dispatchReviewResult ? { dispatchReview: dispatchReviewResult } : {}),
    ...(mergePlan ? { mergePlan } : {}),
    ...(reviewRecord.mergeDecision ? { mergeDecision: reviewRecord.mergeDecision } : {}),
    localAssuranceGate: reviewRecord.localAssuranceGate,
    nextAction: reviewRecord.nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function autopilotResume(store: StoryStore, root: string, args: AutopilotResumeArgs): AutopilotResumeResult {
  const read = readRunRecordMaybe(root, args.runId);
  const replay = replayCheckpointLedger(root, args.runId);
  if (!read.record && !replay.ok) {
    throw new Error(read.error ?? replay.reason);
  }
  if (!replay.ok) {
    let record = read.record!;
    const nextAction = `Resume refused: checkpoint ledger is missing or corrupt (${replay.reason}). Start a new autopilot_run after manually reviewing dispatch state.`;
    record = persist(root, {
      ...record,
      events: [...record.events, event('resume_refused', nextAction)],
      nextAction,
    });
    return {
      schemaVersion: AUTOPILOT_RESUME_SCHEMA_VERSION,
      runId: record.runId,
      status: 'refused',
      reason: 'corrupt_state',
      record,
      nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }

  const recoveredFromLedger = !read.record;
  let record = read.record ?? replay.lastSnapshot;
  if (!record) {
    throw new Error(`autopilot_resume cannot recover ${args.runId}: checkpoint ledger has no snapshot projection`);
  }
  const maxAge = Math.max(1, Math.floor(args.maxResumeAgeMs ?? 15 * 60 * 1000));
  const updatedAtMs = Date.parse(record.updatedAt);
  const stale = Number.isNaN(updatedAtMs) || Date.now() - updatedAtMs > maxAge;
  const gitCwd = resolveGitCwd({ store, storyId: replay.basis.storyId, metadataRoot: root, projectRoot: root });
  const basisFreshness = currentRunBasisMatches(root, gitCwd, replay.basis, record);
  const unsafe = record.status === 'cancelled' || (record.status === 'failed' && replay.checkpoints.size === 0);
  const staleReason = replay.hasStaleCheckpoint
    ? 'checkpoint ledger contains a stale checkpoint'
    : !basisFreshness.matches
      ? basisFreshness.reason ?? 'run basis changed since run start'
      : stale
        ? 'persisted autopilot state is older than maxResumeAgeMs'
        : '';
  if (staleReason || unsafe) {
    const reason: AutopilotResumeResult['reason'] = staleReason ? 'stale_state' : 'unsafe_state';
    const nextAction = staleReason
      ? `Resume refused: ${staleReason}. Start a new autopilot_run after manually reviewing dispatch state.`
      : record.status === 'cancelled'
        ? 'Resume refused: cancelled autopilot runs are not resumable. Start a new autopilot_run or review the dispatch manually.'
        : 'Resume refused: failed autopilot runs without a committed step checkpoint are not resumable. Start a new autopilot_run or review the dispatch manually.';
    record = persist(root, {
      ...record,
      checkpointLedger: checkpointProjection(record.runId, replay.basis, replay.checkpoints.size, replay.lastEventHash),
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

  const projection = resumeProjectionFromReplay(replay, recoveredFromLedger);
  const skipped = projection.skippedDoneSteps.length;
  const nextAction = projection.remainingSteps === 0
    ? `Resume projection ready: ${skipped} committed done checkpoint(s) will not be re-dispatched; no remaining step is eligible for M1 worker launch. Continue manual review/watch from the persisted run state.`
    : `Resume projection ready: ${skipped} committed done checkpoint(s) will not be re-dispatched; resume at ${projection.nextStepId}. M1 returns guidance only and does not launch workers.`;
  const recoveredHealthEvents = record.status === 'paused_requires_resume' || record.status === 'waiting_for_provider_health'
    ? healthEventsForRun(buildProviderHealthRecoveredEvents(nowIso()))
    : [];
  record = persist(root, {
    ...record,
    checkpointLedger: checkpointProjection(record.runId, replay.basis, replay.checkpoints.size, replay.lastEventHash),
    events: [
      ...record.events,
      ...recoveredHealthEvents,
      event(recoveredFromLedger ? 'resume_projection_recovered' : 'resume_projection_ready', nextAction),
    ],
    nextAction,
  });
  return {
    schemaVersion: AUTOPILOT_RESUME_SCHEMA_VERSION,
    runId: record.runId,
    status: 'resume_ready',
    projection,
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
    'admissibilityStatus: autopilot-run-record',
    'assuranceLevel: local',
    'evidenceScope: autopilot-run-metadata',
    `localAssuranceRequired: ${record.authority.localAssuranceRequired}`,
    `localAssuranceVerified: ${record.authority.localAssuranceVerified}`,
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
    `localAssuranceVerified: ${result.localAssuranceGate.verified}`,
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
    `localAssuranceVerified: ${result.localAssuranceGate.verified}`,
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
    ...(result.reason ? [`reason: ${result.reason}`] : []),
    ...(result.projection ? [
      `skippedDoneSteps: ${result.projection.skippedDoneSteps.length}`,
      `remainingSteps: ${result.projection.remainingSteps}`,
      ...(result.projection.nextStepId ? [`nextStepId: ${result.projection.nextStepId}`] : []),
      `recoveredFromLedger: ${result.projection.recoveredFromLedger}`,
      `ledgerFile: ${result.projection.ledgerFile}`,
    ] : []),
    `nextAction: ${result.nextAction}`,
  ].join('\n');
}

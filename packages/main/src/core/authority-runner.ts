import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { JobSpec, ProviderEvent, ProviderEventsEnvelope } from './authority-runner-contracts.js';
import { signRunnerEnvelope } from './authority-runner-contracts.js';
import type { PrivateKeyBase64 } from './authority-signing.js';
import {
  derivePublicKeyHexFromPrivateKey,
  signLatticeAuthorityEnvelope,
  type LatticeAuthorityKeyEncoding,
} from './lattice-authority-native.js';
import {
  DEVELOPMENT_WORKFLOWS,
  PLANNER_RUN_MODES,
  PLANNER_UNTIL_PHASES,
  PlannedStepsSchema,
  type DevelopmentWorkflow,
  type JobPlan,
  type PlannerRunMode,
  type PlannerStoreLike,
  type PlannerUntilPhase,
} from './planner.js';
import {
  executePlannedSteps,
  type AuthorityGateEvaluator,
  type PlannedStepsExecutionResult,
} from './planned-steps-executor.js';
import type { AuthorityGateDecision } from './authority-client.js';
import type { MaterialOverlapAuditContract } from './authority-contracts.js';
import {
  evaluateAuthorityCompletion,
  completionToFinalizeInput,
  type AuthorityCompletionVerdict,
  type MultiHostReconciliation,
} from './authority-completion.js';
import { buildGateEvidenceRefResolver } from './evidence-uploader.js';
import {
  finalizeAuthorityJob,
  jobResultDigest,
  type AuthorityJobLoop,
  type FinalizeAuthorityJobResult,
} from './authority-job-loop.js';

// Re-export the Stage B job-loop lease/heartbeat surface so callers that already
// import the runner get the lease lifecycle from one place.
export {
  createAuthorityJobLoop,
  finalizeAuthorityJob,
  parseClaimedLease,
  jobResultDigest,
  HEARTBEAT_PHASES,
} from './authority-job-loop.js';
export type {
  ActiveLease,
  AuthorityJobLoop,
  AuthorityJobLoopOptions,
  JobLeaseTransport,
  JobLeaseStatus,
  JobLeaseSnapshot,
  HeartbeatPhase,
  HeartbeatOutcome,
  LeaseHealth,
  LeaseRenewResult,
  LeaseReleaseResult,
  LeaseCompleteResult,
  ReleaseOutcome,
  CompleteInput,
  CompleteOutcome,
  ClaimedLeaseInput,
  ParseClaimedLeaseResult,
  FinalizeAuthorityJobInput,
  FinalizeAuthorityJobResult,
} from './authority-job-loop.js';

export const AUTHORITY_RUNNER_PLANNED_STEPS = [
  'register_runner',
  'runner_heartbeat',
  'claim_job',
] as const;

export type AuthorityRunnerPlannedStep = typeof AUTHORITY_RUNNER_PLANNED_STEPS[number];

export interface AuthorityRunnerPlan {
  schemaVersion: 'lattice.authority_enforce_runner.v1';
  mode: 'enforce';
  once: boolean;
  dryRun: boolean;
  live?: boolean;
  plannedSteps: AuthorityRunnerPlannedStep[];
  spawned: false;
  providerEvents: [];
  networkEvents?: AuthorityRunnerNetworkEvent[];
  claimedJobId?: string | null;
  releasedJobId?: string | null;
  releaseReason?: string;
  localWorkflowUsable: true;
  status: 'pass' | 'fail';
  readinessWarnings: string[];
  nextActions: string[];
  note: string;
}

export interface AuthorityRunnerNetworkEvent {
  step: AuthorityRunnerPlannedStep | 'register_actor_key' | 'release_job';
  ok: boolean;
  status?: number;
  message?: string;
}

export interface LatticeAuthorityLiveRunnerOptions {
  baseURL: string;
  timeoutMS: number;
  actorId: string;
  role: string;
  actorKeyId: string;
  actorPrivateKey: string;
  actorPrivateKeyEncoding?: LatticeAuthorityKeyEncoding;
  runnerId: string;
  sessionId: string;
  projectId: string;
  customerApiKey?: string;
  bootstrapToken?: string;
  once: boolean;
  fetchImpl?: typeof fetch;
}

interface PostJsonResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  message?: string;
}

export interface FakeProviderExecutionOptions {
  jobSpec: JobSpec;
  runnerId: string;
  actorId: string;
  privateKey: PrivateKeyBase64;
  expectedRunId?: string;
  now?: string;
}

export interface FakeProviderExecutionResult {
  ok: boolean;
  jobId: string;
  runId: string;
  provider: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  transcript: string;
  transcriptHash: string;
  eventKinds: string[];
  envelopes: ProviderEventsEnvelope[];
  envelope: ProviderEventsEnvelope;
  envelopeDigest: string;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function joinURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function nonce(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function pythonCanonicalTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

async function postJson(
  options: LatticeAuthorityLiveRunnerOptions,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<PostJsonResult> {
  if (!options.customerApiKey?.trim()) {
    return {
      ok: false,
      message: 'customer_api_key_unconfigured_fails_closed: customer API key is required for mutating Authority calls',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMS);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(joinURL(options.baseURL, path), {
      method: 'POST',
      headers: buildAuthorityPostHeaders(options, extraHeaders),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      body: parsed,
      message: response.ok ? undefined : `authority server rejected request (${response.status})${text ? `: ${text}` : ''}`,
    };
  } catch (error: any) {
    return {
      ok: false,
      message: error?.name === 'AbortError'
        ? 'authority request timed out'
        : (error?.message || String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildAuthorityPostHeaders(
  options: LatticeAuthorityLiveRunnerOptions,
  extraHeaders: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extraHeaders,
  };
  const customerApiKey = options.customerApiKey?.trim();
  if (customerApiKey) headers.Authorization = `Bearer ${customerApiKey}`;
  return headers;
}

function signedEnvelope<T extends { actorId: string; role: string; nonce: string; timestamp: string; signature?: string }>(
  options: LatticeAuthorityLiveRunnerOptions,
  envelope: T,
): T & { signature: string } {
  return signLatticeAuthorityEnvelope(
    envelope,
    options.actorPrivateKey,
    options.actorPrivateKeyEncoding ?? 'auto',
  ).signed;
}

function runnerCapability() {
  return {
    provider: 'codex',
    available: true,
    cliPathMode: 'path',
    loggedIn: true,
    supportsNonInteractive: true,
    supportsPty: false,
    supportsSandbox: true,
    supportsWorktreeIsolation: true,
    metadata: {
      source: 'lattice-cli',
      providerExecution: 'disabled-control-plane-smoke',
    },
  };
}

function extractJobId(claimBody: unknown): string | null {
  const record = claimBody as { job?: { jobId?: unknown } | null } | null;
  const jobId = record?.job?.jobId;
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : null;
}

function eventFromResult(
  step: AuthorityRunnerNetworkEvent['step'],
  result: PostJsonResult,
): AuthorityRunnerNetworkEvent {
  return {
    step,
    ok: result.ok,
    status: result.status,
    message: result.message,
  };
}

export function readActorPrivateKeyFromPath(path: string): string {
  return readFileSync(path, 'utf8').trim();
}

export async function runLatticeAuthorityControlPlaneOnce(
  options: LatticeAuthorityLiveRunnerOptions,
): Promise<Pick<AuthorityRunnerPlan, 'networkEvents' | 'claimedJobId' | 'releasedJobId' | 'releaseReason' | 'status' | 'note'>> {
  const events: AuthorityRunnerNetworkEvent[] = [];
  const publicKeyHex = derivePublicKeyHexFromPrivateKey(
    options.actorPrivateKey,
    options.actorPrivateKeyEncoding ?? 'auto',
  );
  const registrationHeaders: Record<string, string> = options.bootstrapToken
    ? { 'X-Lattice-Bootstrap-Token': options.bootstrapToken }
    : {};
  const actorKey = await postJson(
    options,
    `/v1/actors/${encodeURIComponent(options.actorId)}/keys`,
    {
      role: options.role,
      publicKeyHex,
      keyId: options.actorKeyId,
      status: 'active',
      runnerId: options.runnerId,
      capabilities: {
        source: 'lattice-cli',
        providerExecution: 'disabled-control-plane-smoke',
      },
    },
    registrationHeaders,
  );
  events.push(eventFromResult('register_actor_key', actorKey));
  if (!actorKey.ok) {
    return { networkEvents: events, claimedJobId: null, releasedJobId: null, status: 'fail', note: 'Live runner stopped at actor key registration.' };
  }

  const capability = runnerCapability();
  const timestamp = pythonCanonicalTimestamp();
  const registerRunner = await postJson(
    options,
    '/v1/runners/register',
    signedEnvelope(options, {
      actorId: options.actorId,
      role: options.role,
      nonce: nonce(`${options.runnerId}:register`),
      timestamp,
      request: {
        runnerId: options.runnerId,
        projectId: options.projectId,
        sessionId: options.sessionId,
        capabilities: [capability],
        hostname: hostname(),
        heartbeatTtlSeconds: 60,
        metadata: {
          source: 'lattice-cli',
          providerExecution: 'disabled-control-plane-smoke',
        },
      },
    }),
  );
  events.push(eventFromResult('register_runner', registerRunner));
  if (!registerRunner.ok) {
    return { networkEvents: events, claimedJobId: null, releasedJobId: null, status: 'fail', note: 'Live runner stopped at runner registration.' };
  }

  const heartbeat = await postJson(
    options,
    `/v1/runners/${encodeURIComponent(options.runnerId)}/heartbeat`,
    signedEnvelope(options, {
      actorId: options.actorId,
      role: options.role,
      nonce: nonce(`${options.runnerId}:heartbeat`),
      timestamp: pythonCanonicalTimestamp(),
      runnerId: options.runnerId,
      heartbeat: {
        sessionId: options.sessionId,
        capabilities: [capability],
        heartbeatTtlSeconds: 60,
        metadata: {
          source: 'lattice-cli',
          providerExecution: 'disabled-control-plane-smoke',
        },
      },
    }),
  );
  events.push(eventFromResult('runner_heartbeat', heartbeat));
  if (!heartbeat.ok) {
    return { networkEvents: events, claimedJobId: null, releasedJobId: null, status: 'fail', note: 'Live runner stopped at runner heartbeat.' };
  }

  const claim = await postJson(
    options,
    `/v1/runners/${encodeURIComponent(options.runnerId)}/jobs/claim`,
    signedEnvelope(options, {
      actorId: options.actorId,
      role: options.role,
      nonce: nonce(`${options.runnerId}:claim`),
      timestamp: pythonCanonicalTimestamp(),
      runnerId: options.runnerId,
      claim: {
        sessionId: options.sessionId,
        provider: 'codex',
        leaseTtlSeconds: 60,
      },
    }),
  );
  events.push(eventFromResult('claim_job', claim));
  if (!claim.ok) {
    return { networkEvents: events, claimedJobId: null, releasedJobId: null, status: 'fail', note: 'Live runner stopped at job claim.' };
  }

  const claimedJobId = extractJobId(claim.body);
  if (!claimedJobId) {
    return {
      networkEvents: events,
      claimedJobId: null,
      releasedJobId: null,
      status: 'pass',
      note: 'Live runner registered, heartbeated, and claimed no job; provider execution stayed disabled.',
    };
  }

  const releaseReason = 'control-plane-smoke-no-provider-execution';
  const release = await postJson(
    options,
    `/v1/jobs/${encodeURIComponent(claimedJobId)}/release`,
    signedEnvelope(options, {
      actorId: options.actorId,
      role: options.role,
      nonce: nonce(`${claimedJobId}:release`),
      timestamp: pythonCanonicalTimestamp(),
      jobId: claimedJobId,
      release: {
        runnerId: options.runnerId,
        sessionId: options.sessionId,
        reason: releaseReason,
      },
    }),
  );
  events.push(eventFromResult('release_job', release));
  return {
    networkEvents: events,
    claimedJobId,
    releasedJobId: release.ok ? claimedJobId : null,
    releaseReason,
    status: release.ok ? 'pass' : 'fail',
    note: release.ok
      ? 'Live runner claimed one job and immediately released it without provider execution.'
      : 'Live runner claimed a job but release failed; inspect networkEvents before retrying.',
  };
}

function commandFromJob(jobSpec: JobSpec): string[] {
  const command = jobSpec.metadata?.command;
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error('fake provider job metadata.command must be a non-empty string array');
  }
  const parts = command.map((part, index) => requireString(part, `metadata.command[${index}]`));
  if (parts[0].includes('/')) {
    throw new Error('fake provider command must use a bare executable name');
  }
  return parts;
}

function assertClaimedFakeJob(jobSpec: JobSpec, runnerId: string, expectedRunId?: string): void {
  if (jobSpec.provider !== 'fake-provider') {
    throw new Error(`fake provider runner can only execute provider=fake-provider, got ${jobSpec.provider ?? 'unset'}`);
  }
  if (jobSpec.metadata?.allowLocalCommand !== true) {
    throw new Error('fake provider job must set metadata.allowLocalCommand=true');
  }
  if (jobSpec.metadata?.runnerId !== runnerId) {
    throw new Error(`claimed job runnerId mismatch: expected ${runnerId}, got ${String(jobSpec.metadata?.runnerId ?? 'unset')}`);
  }
  if (expectedRunId !== undefined && jobSpec.runId !== expectedRunId) {
    throw new Error(`claimed job runId mismatch: expected ${expectedRunId}, got ${jobSpec.runId}`);
  }
  requireString(jobSpec.jobId, 'jobSpec.jobId');
  requireString(jobSpec.runId, 'jobSpec.runId');
}

function transcriptHash(transcript: string): string {
  return createHash('sha256').update(transcript, 'utf8').digest('hex');
}

export function executeFakeProviderJob(options: FakeProviderExecutionOptions): FakeProviderExecutionResult {
  const { jobSpec, runnerId, actorId, privateKey } = options;
  assertClaimedFakeJob(jobSpec, runnerId, options.expectedRunId);
  const provider = requireString(jobSpec.provider, 'jobSpec.provider');
  const command = commandFromJob(jobSpec);
  const spawned = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const stdout = spawned.stdout ?? '';
  const stderr = spawned.stderr ?? '';
  const exitCode = typeof spawned.status === 'number' ? spawned.status : 1;
  const transcript = [
    `$ ${command.join(' ')}`,
    stdout ? `stdout:\n${stdout}` : 'stdout:',
    stderr ? `stderr:\n${stderr}` : 'stderr:',
    `exitCode:${exitCode}`,
  ].join('\n');
  const hash = transcriptHash(transcript);
  const occurredAt = options.now ?? new Date().toISOString();
  const providerEvents: ProviderEvent[] = [
    ...(stdout
      ? [{
          eventId: `${jobSpec.jobId}:stdout:1`,
          runId: jobSpec.runId,
          provider,
          type: 'stdout_delta' as const,
          occurredAt,
          delta: stdout,
          transcriptHash: hash,
        }]
      : []),
    ...(stderr
      ? [{
          eventId: `${jobSpec.jobId}:stderr:1`,
          runId: jobSpec.runId,
          provider,
          type: 'stderr_delta' as const,
          occurredAt,
          delta: stderr,
          transcriptHash: hash,
        }]
      : []),
    {
      eventId: `${jobSpec.jobId}:${exitCode === 0 ? 'completed' : 'failed'}`,
      runId: jobSpec.runId,
      provider,
      type: exitCode === 0 ? 'completed' : 'failed',
      occurredAt,
      ...(exitCode === 0 ? { outputText: stdout } : { message: stderr || 'Provider run failed.', errorCode: 'provider_failed' }),
      exitCode,
      transcriptHash: hash,
      artifactRefs: [],
    },
  ];
  const signedEnvelopes = providerEvents.map((providerEvent, index) => signRunnerEnvelope({
    actorId,
    role: 'runner',
    nonce: `${jobSpec.jobId}:${jobSpec.runId}:provider-event:${index + 1}`,
    timestamp: occurredAt,
    providerEvent,
  }, privateKey));
  const last = signedEnvelopes.at(-1);
  if (!last) {
    throw new Error('fake provider must emit at least one provider event');
  }
  return {
    ok: exitCode === 0,
    jobId: jobSpec.jobId,
    runId: jobSpec.runId,
    provider,
    exitCode,
    stdout,
    stderr,
    transcript,
    transcriptHash: hash,
    eventKinds: providerEvents.map(event => event.type),
    envelopes: signedEnvelopes.map(item => item.signed),
    envelope: last.signed,
    envelopeDigest: last.digest,
  };
}

// ===========================================================================
// Claimed authority job consumption (Stage B: beyond projection)
//
// A claimed Authority job may carry typed plannedSteps[]. Instead of releasing
// the lease immediately with no execution (control-plane-only smoke), the runner
// can drive those bounded steps through the shared plannedSteps executor and then
// release or complete the lease cleanly based on the result.
//
// Hard invariants enforced here:
// - authority DONE stays gated by a verified native gate_decision receipt; the
//   gate.evaluate step blocks authority+DONE, so execution never reaches `done`
//   for that target without server-issued receipt verification;
// - this path never mints a receipt client-side; `authorityDone` can only be true
//   when the caller supplies an already-verified native receipt AND execution
//   reached `done`;
// - the lease is always either completed or released — never left dangling.
// ===========================================================================

export type ClaimedAuthorityJobDisposition = 'completed' | 'released' | 'blocked' | 'failed';

export interface ClaimedAuthorityJob {
  jobId: string;
  /** Linked Authority run id, required for terminal run events on the live path. */
  runId?: string;
  /** Authority project id from the server-issued job; anchors gate input digests. */
  projectId?: string;
  storyId: string;
  mode: PlannerRunMode;
  until: PlannerUntilPhase;
  /** Typed plannedSteps[] payload; validated against PlannedStepsSchema. */
  plannedSteps: unknown;
  developmentWorkflow?: DevelopmentWorkflow;
  coverageMap?: JobPlan['coverageMap'];
  providerPolicy?: JobPlan['providerPolicy'];
  worktreePolicy?: JobPlan['worktreePolicy'];
  retryPolicy?: JobPlan['retryPolicy'];
  stopPolicy?: JobPlan['stopPolicy'];
  budgetPolicy?: JobPlan['budgetPolicy'];
  lease?: JobPlan['lease'];
  evidencePolicy?: JobPlan['evidencePolicy'];
  receiptPolicy?: JobPlan['receiptPolicy'];
}

export type ParseClaimedAuthorityJobResult =
  | { ok: true; job: ClaimedAuthorityJob }
  | { ok: false; reason: string };

/**
 * Coerce an untrusted JSON payload (e.g. a claimed Authority job file passed to
 * `lattice autopilot execute --jobFile`) into a typed ClaimedAuthorityJob.
 *
 * This validates only the job envelope (identity + target). The typed
 * `plannedSteps[]` payload is deliberately left as `unknown` here and is deeply
 * validated against PlannedStepsSchema inside consumeClaimedAuthorityJob, so a
 * malformed step list fails closed at execution time with a clear release
 * reason rather than passing a half-validated job to the executor. Fail-closed:
 * any shape problem returns `{ ok: false }` instead of a partial job.
 */
export function parseClaimedAuthorityJob(raw: unknown): ParseClaimedAuthorityJobResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'claimed job must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;

  const jobId = obj.jobId;
  if (typeof jobId !== 'string' || jobId.trim().length === 0) {
    return { ok: false, reason: 'claimed job jobId must be a non-empty string' };
  }
  const storyId = obj.storyId;
  if (typeof storyId !== 'string' || storyId.trim().length === 0) {
    return { ok: false, reason: 'claimed job storyId must be a non-empty string' };
  }
  const mode = obj.mode;
  if (typeof mode !== 'string' || !(PLANNER_RUN_MODES as readonly string[]).includes(mode)) {
    return { ok: false, reason: `claimed job mode must be one of ${PLANNER_RUN_MODES.join('|')}, got ${String(mode)}` };
  }
  const until = obj.until;
  if (typeof until !== 'string' || !(PLANNER_UNTIL_PHASES as readonly string[]).includes(until)) {
    return { ok: false, reason: `claimed job until must be one of ${PLANNER_UNTIL_PHASES.join('|')}, got ${String(until)}` };
  }
  if (!('plannedSteps' in obj) || obj.plannedSteps === undefined || obj.plannedSteps === null) {
    return { ok: false, reason: 'claimed job plannedSteps[] is required' };
  }
  const runId = obj.runId;
  if (runId !== undefined && (typeof runId !== 'string' || runId.trim().length === 0)) {
    return { ok: false, reason: 'claimed job runId must be a non-empty string when present' };
  }
  const projectId = obj.projectId;
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId.trim().length === 0)) {
    return { ok: false, reason: 'claimed job projectId must be a non-empty string when present' };
  }

  let developmentWorkflow: DevelopmentWorkflow | undefined;
  if (obj.developmentWorkflow !== undefined) {
    if (typeof obj.developmentWorkflow !== 'string' || !(DEVELOPMENT_WORKFLOWS as readonly string[]).includes(obj.developmentWorkflow)) {
      return { ok: false, reason: `claimed job developmentWorkflow must be one of ${DEVELOPMENT_WORKFLOWS.join('|')}, got ${String(obj.developmentWorkflow)}` };
    }
    developmentWorkflow = obj.developmentWorkflow as DevelopmentWorkflow;
  }

  return {
    ok: true,
    job: {
      jobId,
      ...(typeof runId === 'string' ? { runId } : {}),
      ...(typeof projectId === 'string' ? { projectId } : {}),
      storyId,
      mode: mode as PlannerRunMode,
      until: until as PlannerUntilPhase,
      plannedSteps: obj.plannedSteps,
      ...(developmentWorkflow ? { developmentWorkflow } : {}),
      ...(obj.coverageMap !== undefined ? { coverageMap: obj.coverageMap as JobPlan['coverageMap'] } : {}),
      ...(obj.providerPolicy !== undefined ? { providerPolicy: obj.providerPolicy as JobPlan['providerPolicy'] } : {}),
      ...(obj.worktreePolicy !== undefined ? { worktreePolicy: obj.worktreePolicy as JobPlan['worktreePolicy'] } : {}),
      ...(obj.retryPolicy !== undefined ? { retryPolicy: obj.retryPolicy as JobPlan['retryPolicy'] } : {}),
      ...(obj.stopPolicy !== undefined ? { stopPolicy: obj.stopPolicy as JobPlan['stopPolicy'] } : {}),
      ...(obj.budgetPolicy !== undefined ? { budgetPolicy: obj.budgetPolicy as JobPlan['budgetPolicy'] } : {}),
      ...(obj.lease !== undefined ? { lease: obj.lease as JobPlan['lease'] } : {}),
      ...(obj.evidencePolicy !== undefined ? { evidencePolicy: obj.evidencePolicy as JobPlan['evidencePolicy'] } : {}),
      ...(obj.receiptPolicy !== undefined ? { receiptPolicy: obj.receiptPolicy as JobPlan['receiptPolicy'] } : {}),
    },
  };
}

export interface ConsumeClaimedAuthorityJobOptions {
  root: string;
  store: PlannerStoreLike;
  job: ClaimedAuthorityJob;
  /**
   * Result of an out-of-band native gate_decision receipt verification. This
   * function never produces a receipt; it only consumes a verified verdict the
   * caller already obtained. Defaults to false (fail-closed).
   */
  receiptVerified?: boolean;
  maxSteps?: number;
  now?: () => Date;
  /**
   * Multi-host reconciliation result, when a final verification wave already ran.
   * Absent by default — fullAuthorityDone then fails closed for any authority/DONE
   * job (its policy requires multi-host certification).
   */
  multiHost?: MultiHostReconciliation;
  /**
   * Resolved native gate evaluator for this claimed job. Live callers resolve it
   * before entering this synchronous consumption path; absent means authority
   * DONE fails closed at gate.evaluate, matching --jobFile behavior.
   */
  authorityGate?: AuthorityGateEvaluator;
  /** Resolved gate decision paired with authorityGate, for completion receipt refs. */
  gateDecision?: AuthorityGateDecision;
  /** Material-overlap audit paired with authorityGate so the executor gate digest matches the signed gate request. */
  materialOverlapAudit?: MaterialOverlapAuditContract;
}

export interface ConsumeClaimedAuthorityJobResult {
  schemaVersion: 'lattice.authority_job_consume.v1';
  jobId: string;
  storyId: string;
  mode: PlannerRunMode;
  until: PlannerUntilPhase;
  receiptRequired: boolean;
  receiptVerified: boolean;
  authorityDone: boolean;
  fullAuthorityDone: boolean;
  /** The single fail-closed completion verdict that drives the release/complete decision. */
  completion: AuthorityCompletionVerdict;
  disposition: ClaimedAuthorityJobDisposition;
  releaseReason: string;
  execution: PlannedStepsExecutionResult | null;
  nextActions: string[];
}

/**
 * Build a fail-closed completion verdict for a claimed job that never reached the
 * executor (e.g. an invalid plannedSteps payload). No run executed, so nothing is
 * validated, no receipt is verified, and no authority DONE flag is projected.
 */
function preExecutionBlockedVerdict(
  job: ClaimedAuthorityJob,
  receiptRequired: boolean,
  reason: string,
): AuthorityCompletionVerdict {
  return {
    schemaVersion: 'lattice.authority_completion.v1',
    mode: job.mode,
    until: job.until,
    completed: false,
    validationPassed: false,
    receiptVerified: false,
    authorityDone: false,
    fullAuthorityDone: false,
    multiHostRequired: receiptRequired,
    multiHostVerified: false,
    requiredHostVerdictCount: 0,
    independentHostVerdictCount: 0,
    requiredReviewWaveCount: 0,
    satisfiedReviewWaveCount: 0,
    reviewWaveRefs: [],
    hostVerdictRefs: [],
    receiptRefs: [],
    lifecyclePhase: null,
    blockingReasons: [reason],
    stopReason: reason,
    nextAction: 'Reissue the Authority job with a valid typed plannedSteps[] payload before claiming it again.',
  };
}

function claimedJobDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function buildClaimedJobPlan(job: ClaimedAuthorityJob, plannedSteps: JobPlan['plannedSteps']): JobPlan {
  const plannedStepsDigest = claimedJobDigest(plannedSteps);
  return {
    schemaVersion: 'lattice.job_plan.v1',
    plannerRunId: `claimed-job:${job.jobId}`,
    ...(job.runId ? { authorityRunId: job.runId } : {}),
    storyId: job.storyId,
    mode: job.mode,
    until: job.until,
    developmentWorkflow: job.developmentWorkflow ?? 'standard',
    ...(job.providerPolicy ? { providerPolicy: job.providerPolicy } : {}),
    ...(job.worktreePolicy ? { worktreePolicy: job.worktreePolicy } : {}),
    ...(job.retryPolicy ? { retryPolicy: job.retryPolicy } : {}),
    ...(job.stopPolicy ? { stopPolicy: job.stopPolicy } : {}),
    ...(job.budgetPolicy ? { budgetPolicy: job.budgetPolicy } : {}),
    ...(job.lease ? { lease: job.lease } : {}),
    ...(job.evidencePolicy ? { evidencePolicy: job.evidencePolicy } : {}),
    ...(job.receiptPolicy ? { receiptPolicy: job.receiptPolicy } : {}),
    ...(job.projectId && job.mode === 'authority'
      ? {
          jobCreateRequest: {
            projectId: job.projectId,
            storyId: job.storyId,
            plannerRunId: `claimed-job:${job.jobId}`,
            plannedSteps,
            mode: 'authority',
          } satisfies JobPlan['jobCreateRequest'],
        }
      : {}),
    plannedSteps,
    coverageMap: job.coverageMap ?? [],
    multiHostPolicy: {
      minIndependentHosts: 2,
      targetHostsPerWave: 2,
      preferredHostsForReleaseCertification: 3,
      preferredVerifierProviders: [],
      requireMultiHost: false,
      requiredHostVerdictCount: 2,
      fullAuthorityDoneRequired: job.mode === 'authority' && job.until === 'DONE',
    },
    plannerDigest: plannedStepsDigest,
    jobPlanDigest: claimedJobDigest({
      jobId: job.jobId,
      projectId: job.projectId ?? null,
      storyId: job.storyId,
      mode: job.mode,
      until: job.until,
      plannedStepsDigest,
    }),
    status: 'planned',
  };
}

export type BuildClaimedAuthorityJobPlanResult =
  | { ok: true; jobPlan: JobPlan }
  | { ok: false; reason: string };

export function buildClaimedAuthorityJobPlan(job: ClaimedAuthorityJob): BuildClaimedAuthorityJobPlanResult {
  const parsed = PlannedStepsSchema.safeParse(job.plannedSteps);
  if (!parsed.success) {
    const reason = parsed.error.issues.map(issue => issue.message).slice(0, 3).join('; ') || 'invalid plannedSteps payload';
    return { ok: false, reason };
  }
  return { ok: true, jobPlan: buildClaimedJobPlan(job, parsed.data as JobPlan['plannedSteps']) };
}

/**
 * Consume a claimed Authority job: validate its typed plannedSteps[], drive the
 * bounded steps through the shared plannedSteps executor, and decide whether the
 * lease should be completed or released. Authority DONE remains gated by a
 * verified native receipt; this never mints one.
 */
export function consumeClaimedAuthorityJob(
  options: ConsumeClaimedAuthorityJobOptions,
): ConsumeClaimedAuthorityJobResult {
  const { root, store, job } = options;
  const receiptRequired = job.mode === 'authority' && job.until === 'DONE';

  const base = {
    schemaVersion: 'lattice.authority_job_consume.v1' as const,
    jobId: job.jobId,
    storyId: job.storyId,
    mode: job.mode,
    until: job.until,
    receiptRequired,
    receiptVerified: false,
  };

  const planned = buildClaimedAuthorityJobPlan(job);
  if (!planned.ok) {
    const reason = planned.reason;
    const blockReason = `authority-job-invalid-planned-steps:${reason}`;
    return {
      ...base,
      authorityDone: false,
      fullAuthorityDone: false,
      completion: preExecutionBlockedVerdict(job, receiptRequired, blockReason),
      disposition: 'blocked',
      releaseReason: blockReason,
      execution: null,
      nextActions: ['Reissue the Authority job with a valid typed plannedSteps[] payload before claiming it again.'],
    };
  }

  const jobPlan = planned.jobPlan;
  const execution = executePlannedSteps({
    root,
    store,
    jobPlan,
    now: options.now,
    maxSteps: options.maxSteps,
    ...(options.authorityGate ? { authorityGate: options.authorityGate } : {}),
    ...(options.authorityGate ? { gateEvidenceRefResolver: buildGateEvidenceRefResolver(jobPlan) } : {}),
    ...(options.materialOverlapAudit ? { materialOverlapAudit: options.materialOverlapAudit } : {}),
  });

  let finalPhase: string | null = null;
  try {
    finalPhase = store.readStory(job.storyId).phase ?? null;
  } catch {
    finalPhase = null;
  }

  // The single fail-closed completion gate. authorityDone/fullAuthorityDone are
  // derived ONLY from the executor's verified native gate_decision receipt
  // (execution.receiptVerified) plus the required multi-host reconciliation — never
  // from the out-of-band receiptVerified hint or a client-minted value. The claimed
  // job plan marks authority/DONE as fullAuthorityDoneRequired, so fullAuthorityDone
  // stays false until a multi-host wave is reconciled and supplied here.
  const completion = evaluateAuthorityCompletion({
    jobPlan,
    execution,
    finalPhase,
    ...(options.gateDecision ? { gateDecision: options.gateDecision } : {}),
    ...(options.multiHost ? { multiHost: options.multiHost } : {}),
  });
  const authorityDone = completion.authorityDone;
  const fullAuthorityDone = completion.fullAuthorityDone;

  let disposition: ClaimedAuthorityJobDisposition;
  let releaseReason: string;
  const nextActions = new Set<string>(execution.nextActions);

  if (execution.status === 'failed') {
    disposition = 'failed';
    releaseReason = `authority-job-step-failed:${execution.failedStepId ?? 'unknown'}`;
    nextActions.add('Release the lease, repair the failing planned step, and reissue the Authority job.');
  } else if (execution.status === 'blocked') {
    disposition = 'blocked';
    releaseReason = `authority-job-blocked:${execution.stopReason}`;
    if (execution.stopReason === 'authority_gate_decision_receipt_required') {
      nextActions.add('Authority DONE is gated: obtain and verify a native gate_decision receipt before completing the job.');
    }
  } else if (receiptRequired && !completion.completed) {
    // Steps finished but authority/DONE still requires the FULL completion gate:
    // a verified native gate_decision receipt PLUS the required multi-host
    // reconciliation. The completion verdict is the single source of truth.
    disposition = 'released';
    releaseReason = completion.receiptVerified === false
      ? 'authority-done-requires-verified-gate-decision-receipt'
      : completion.blockingReasons.includes('multi_host_verification_incomplete')
        ? 'authority-done-requires-multi-host-verification'
        : `authority-done-final-policy-not-satisfied:${completion.stopReason}`;
    if (completion.receiptVerified === false) {
      nextActions.add('Verify a native Lattice Authority gate_decision receipt before completing this job for DONE.');
    }
    nextActions.add(completion.nextAction);
  } else {
    disposition = 'completed';
    releaseReason = receiptRequired
      ? 'authority-job-completed-with-verified-receipt'
      : 'authority-job-completed-no-receipt-required';
  }

  try {
    store.appendProcessEvent(job.storyId, {
      type: 'authority_job_consumed',
      jobId: job.jobId,
      storyId: job.storyId,
      mode: job.mode,
      until: job.until,
      receiptRequired,
      receiptVerified: completion.receiptVerified,
      authorityDone,
      fullAuthorityDone,
      completed: completion.completed,
      blockingReasons: completion.blockingReasons,
      disposition,
      releaseReason,
      executionStatus: execution.status,
      executedStepCount: execution.executedStepCount,
    });
  } catch {
    // Process-event evidence is best-effort; consumption result is still authoritative.
  }

  return {
    ...base,
    receiptVerified: completion.receiptVerified,
    authorityDone,
    fullAuthorityDone,
    completion,
    disposition,
    releaseReason,
    execution,
    nextActions: [...nextActions],
  };
}

/**
 * Drive the claimed job's lease to a terminal state from a consumption result.
 *
 * This is the seam between "what the bounded steps decided" (the
 * ConsumeClaimedAuthorityJobResult disposition) and "what happens to the lease"
 * (§B7 tail / §B12 release-or-complete). It always routes through
 * finalizeAuthorityJob, which heartbeats before completion and FAILS CLOSED to a
 * clean release on an unsafe lease, an unmet receipt gate, or a stale-lease
 * completion rejection:
 *
 * - a `completed` disposition is offered for completion (finalPolicySatisfied),
 *   but the loop still only completes when the receipt gate is satisfied AND the
 *   lease is safe — otherwise it releases;
 * - any non-completed disposition (released / blocked / failed) is released with
 *   the consumption result's release reason.
 *
 * The job is never left dangling, and authority DONE is never claimed on an
 * unsafe lease or without a verified receipt.
 */
export function finalizeConsumedAuthorityJobLease(options: {
  loop: AuthorityJobLoop;
  result: ConsumeClaimedAuthorityJobResult;
}): FinalizeAuthorityJobResult {
  const { loop, result } = options;
  const resultDigest = jobResultDigest({
    jobId: result.jobId,
    storyId: result.storyId,
    mode: result.mode,
    until: result.until,
    disposition: result.disposition,
    authorityDone: result.authorityDone,
    executionStatus: result.execution?.status ?? null,
  });
  // Feed the completion verdict into the lease complete-or-release decision. The
  // verdict's `completed` flag is the FULL completion gate (validation + verified
  // native receipt + required multi-host reconciliation for authority/DONE), so the
  // lease machine completes only when the verdict already says the job may complete
  // and releases otherwise. The richer disposition-derived release reason is kept.
  const finalizeInput = completionToFinalizeInput(result.completion, resultDigest);
  return finalizeAuthorityJob({
    loop,
    ...finalizeInput,
    releaseReason: result.releaseReason,
  });
}

import { hostname } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import {
  createAuthorityJobLoop,
  buildClaimedAuthorityJobPlan,
  finalizeConsumedAuthorityJobLease,
  parseClaimedAuthorityJob,
  parseClaimedLease,
  readActorPrivateKeyFromPath,
  type ActiveLease,
  type ClaimedAuthorityJob,
  type ConsumeClaimedAuthorityJobResult,
  type JobLeaseTransport,
  type LatticeAuthorityLiveRunnerOptions,
  type LeaseHealth,
} from './authority-runner.js';
import {
  loadAuthorityConfig,
  resolveAuthorityGateEvaluator,
  resolveAuthorityCustomerApiKey,
  type AuthorityFetch,
  type AuthorityConfigLoadOptions,
  type AuthorityGateEvaluatorResolution,
} from './authority-client.js';
import {
  derivePublicKeyHexFromPrivateKey,
  signLatticeAuthorityEnvelope,
  type LatticeAuthorityKeyEncoding,
} from './lattice-authority-native.js';
import {
  authorityModeEnabled,
  type AuthorityConfig,
} from './authority-mode.js';
import type { JobReleaseOutcome } from './authority-runner-contracts.js';
import { buildNoOverlapMaterialOverlapAuditDefault } from './authority-contracts.js';
import type { PlannerRunMode, PlannerUntilPhase } from './planner.js';
import {
  executeAutopilot,
  type AutopilotExecuteResult,
  type ExecuteAutopilotOptions,
} from './autopilot-executor.js';

// ===========================================================================
// Live Stage B authority job loop for `lattice autopilot execute`
//
// This is the network seam that turns the otherwise-standalone Stage B engines
// (AuthorityClient runner contracts, the job-lease state machine, the shared
// plannedSteps executor, and the claimed-job consumption/finalize path) into a
// single unattended loop: register the runner, heartbeat, claim ONE queued job,
// hand its typed plannedSteps[] to the in-process executor (driven by the
// caller through consumeClaimedAuthorityJob), then drive the lease to a clean
// terminal state (complete-or-release) over the network.
//
// Hard fail-closed invariants (mirroring the in-process claimed-job path):
// - no live settings configured while mode=authority -> fail closed with an
//   authorityJobLoop trace; never silently synthesize local fallback execution;
// - no job claimed / runner control-plane failure -> fail closed, never
//   synthesize local argv steps;
// - a claimed job whose envelope/lease is malformed is RELEASED (never left
//   dangling) and the loop fails closed;
// - the claimed job's plannedSteps consumption + receipt gate happen in the
//   caller (consumeClaimedAuthorityJob); this module only decides + performs the
//   lease lifecycle, so authority DONE stays gated by a verified native receipt
//   exactly as the --jobFile / in-process claimedJob seams already enforce.
// ===========================================================================

/** Whether the environment has the full live-runner config the loop requires. */
export function authorityLiveRunnerConfigured(
  env: Record<string, string | undefined> = process.env,
  options: AuthorityConfigLoadOptions = {},
): boolean {
  const settings = loadAuthorityConfig(env, {}, options);
  if (!authorityModeEnabled(settings.mode)) return false;
  if (!settings.baseURL) return false;
  if (!settings.runnerId) return false;
  const hasKey =
    liveEnv(env, 'ACTOR_KEY') !== undefined ||
    readLiveSecretFromPath(liveEnv(env, 'ACTOR_KEY_PATH'), options) !== undefined ||
    settings.keyMaterial.actorKey !== undefined ||
    readLiveSecretFromPath(settings.keyMaterial.actorKeyPath, options) !== undefined;
  if (!hasKey) return false;
  if (!settings.projectId) return false;
  if (!resolveAuthorityCustomerApiKey(env, options).value) return false;
  return true;
}

/**
 * Build the live runner options from the environment. Throws (fail-closed) when
 * any required field is missing — callers gate on {@link authorityLiveRunnerConfigured}
 * first, so a throw here means the env changed under us or the gate was bypassed.
 */
export function buildLiveRunnerOptionsFromEnv(
  env: Record<string, string | undefined>,
  settings: AuthorityConfig,
  options: { once?: boolean; fetchImpl?: typeof fetch } & AuthorityConfigLoadOptions = {},
): LatticeAuthorityLiveRunnerOptions {
  if (!settings.baseURL) throw new Error('LATTICE_AUTHORITY_URL is required for the live authority job loop');
  const actorKeyPath = liveEnv(env, 'ACTOR_KEY_PATH');
  const actorPrivateKey = liveEnv(env, 'ACTOR_KEY')
    ?? readLiveSecretFromPath(actorKeyPath, options)
    ?? settings.keyMaterial.actorKey
    ?? readLiveSecretFromPath(settings.keyMaterial.actorKeyPath, options);
  if (!actorPrivateKey) throw new Error('LATTICE_AUTHORITY_ACTOR_KEY or LATTICE_AUTHORITY_ACTOR_KEY_PATH is required for the live authority job loop');
  const runnerId = settings.runnerId;
  if (!runnerId) throw new Error('LATTICE_AUTHORITY_RUNNER_ID is required for the live authority job loop');
  const projectId = settings.projectId;
  if (!projectId) throw new Error('LATTICE_AUTHORITY_PROJECT_ID is required for the live authority job loop');
  const sessionId = settings.sessionId ?? `${runnerId}:session`;
  const keyEncoding = (liveEnv(env, 'ACTOR_KEY_ENCODING') ?? settings.keyMaterial.actorKeyEncoding ?? 'auto') as LatticeAuthorityKeyEncoding;
  const customerApiKey = resolveAuthorityCustomerApiKey(env, options).value;
  if (!customerApiKey) throw new Error('LATTICE_AUTHORITY_CUSTOMER_API_KEY or LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH is required for the live authority job loop');
  return {
    baseURL: settings.baseURL,
    timeoutMS: settings.timeoutMS,
    actorId: liveEnv(env, 'ACTOR_ID') ?? settings.keyMaterial.actorId ?? runnerId,
    role: liveEnv(env, 'ACTOR_ROLE') ?? settings.keyMaterial.actorRole ?? 'runner',
    actorKeyId: liveEnv(env, 'ACTOR_KEY_ID') ?? settings.keyMaterial.actorKeyId ?? 'default',
    actorPrivateKey,
    actorPrivateKeyEncoding: keyEncoding,
    runnerId,
    sessionId,
    projectId,
    customerApiKey,
    bootstrapToken: liveEnv(env, 'BOOTSTRAP_TOKEN'),
    once: options.once !== false,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
}

// --- Network trace ----------------------------------------------------------

export interface LiveJobLoopNetworkEvent {
  step:
    | 'register_actor_key'
    | 'register_runner'
    | 'runner_heartbeat'
    | 'claim_job'
    | 'job_heartbeat'
    | 'complete_job'
    | 'release_job';
  ok: boolean;
  status?: number;
  message?: string;
}

export type AuthorityJobLoopClaimStatus =
  | 'claimed'
  | 'no-job'
  | 'runner-failed'
  | 'invalid-job'
  | 'lease-invalid';

export interface AuthorityJobLoopExpectation {
  storyId: string;
  mode: PlannerRunMode;
  until: PlannerUntilPhase;
}

export interface AuthorityJobLoopClaim {
  status: AuthorityJobLoopClaimStatus;
  networkEvents: LiveJobLoopNetworkEvent[];
  claimedJobId: string | null;
  /** The mapped claimed job, present only when status === 'claimed'. */
  job: ClaimedAuthorityJob | null;
  /** The parsed runtime lease, present only when status === 'claimed'. */
  lease: ActiveLease | null;
  reason: string;
}

/**
 * Register the runner, heartbeat, and claim at most one queued job. Maps the
 * claimed JobSpec into a typed ClaimedAuthorityJob + runtime lease. Fail-closed:
 * a malformed claimed job is RELEASED (never dangling) and reported, and a
 * missing job stops the loop without synthesizing local steps.
 */
export async function claimAuthorityJobForLoop(
  options: LatticeAuthorityLiveRunnerOptions,
  expected: AuthorityJobLoopExpectation,
): Promise<AuthorityJobLoopClaim> {
  const phase = await registerHeartbeatAndClaim(options);
  if (!phase.ok) {
    return { status: 'runner-failed', networkEvents: phase.events, claimedJobId: null, job: null, lease: null, reason: phase.failureNote ?? 'live authority runner control plane failed' };
  }
  if (!phase.claimedJobId) {
    return { status: 'no-job', networkEvents: phase.events, claimedJobId: null, job: null, lease: null, reason: 'authority runner claimed no queued job' };
  }

  const mapped = mapClaimedJobSpec(phase.claimBody, phase.claimedJobId, expected);
  if (!mapped.ok) {
    const release = await releaseClaimedJob(options, phase.claimedJobId, `authority-job-invalid:${mapped.reason}`);
    phase.events.push(release);
    return { status: 'invalid-job', networkEvents: phase.events, claimedJobId: phase.claimedJobId, job: null, lease: null, reason: mapped.reason };
  }

  const leaseResult = extractClaimedLease(phase.claimBody, phase.claimedJobId, options);
  if (!leaseResult.ok) {
    const release = await releaseClaimedJob(options, phase.claimedJobId, `authority-job-lease-invalid:${leaseResult.reason}`);
    phase.events.push(release);
    return { status: 'lease-invalid', networkEvents: phase.events, claimedJobId: phase.claimedJobId, job: mapped.job, lease: null, reason: leaseResult.reason };
  }

  return { status: 'claimed', networkEvents: phase.events, claimedJobId: phase.claimedJobId, job: mapped.job, lease: leaseResult.lease, reason: 'claimed' };
}

// --- Lease finalize over the network ----------------------------------------

export interface AuthorityJobLoopFinalizeInput {
  options: LatticeAuthorityLiveRunnerOptions;
  job: ClaimedAuthorityJob;
  lease: ActiveLease;
  /**
   * The in-process consumption result, or null when the caller's identity gate
   * rejected the claimed job (story/mode mismatch). A null consumption always
   * routes to a clean release — the lease is never left dangling.
   */
  consume: ConsumeClaimedAuthorityJobResult | null;
  now?: () => Date;
}

export interface AuthorityJobLoopFinalize {
  disposition: 'completed' | 'released';
  completed: boolean;
  releaseReason: string;
  releaseOutcome: JobReleaseOutcome;
  leaseHealth: LeaseHealth;
  failClosedReason?: string;
  networkEvents: LiveJobLoopNetworkEvent[];
}

/**
 * Drive the claimed job's lease to a clean terminal state. The deterministic
 * job-lease state machine makes the complete-or-release DECISION (heartbeat
 * before completion, fail-closed on an unsafe lease / unmet receipt gate); this
 * function performs the single real terminal network call (release with the
 * mapped outcome) for the EFFECT, after one real lease heartbeat.
 */
export async function finalizeAuthorityJobLoopLease(
  input: AuthorityJobLoopFinalizeInput,
): Promise<AuthorityJobLoopFinalize> {
  const { options, job, lease, consume } = input;
  const nowMs = () => (input.now ? input.now() : new Date()).getTime();
  const events: LiveJobLoopNetworkEvent[] = [];

  // One real lease heartbeat before the completion decision (§B12). Its success
  // feeds the synchronous transport's renew so the state machine sees the live
  // lease health; the actual release/complete effect is performed below.
  const heartbeat = await heartbeatClaimedJob(options, job.jobId);
  events.push(heartbeat.event);

  const transport: JobLeaseTransport = {
    renew: () => ({ ok: heartbeat.ok }),
    release: () => ({ ok: true }),
    complete: () => ({ ok: true }),
  };
  const loop = createAuthorityJobLoop({ jobId: job.jobId, lease, transport, now: nowMs });

  let disposition: 'completed' | 'released';
  let completed: boolean;
  let releaseReason: string;
  let failClosedReason: string | undefined;

  if (consume) {
    const finalize = finalizeConsumedAuthorityJobLease({ loop, result: consume });
    disposition = finalize.disposition;
    completed = finalize.completed;
    releaseReason = finalize.releaseReason ?? finalize.failClosedReason ?? consume.releaseReason;
    failClosedReason = finalize.failClosedReason;
  } else {
    // Identity gate rejected the claimed job upstream: release, never complete.
    const released = loop.release('authority-job-identity-mismatch');
    disposition = 'released';
    completed = false;
    releaseReason = released.reason;
    failClosedReason = 'authority-job-identity-mismatch';
  }

  const releaseOutcome: JobReleaseOutcome = disposition === 'completed'
    ? 'completed'
    : releaseOutcomeForConsumption(consume);
  if (disposition === 'completed') {
    const terminal = await completeClaimedRun(options, job, releaseReason);
    events.push(terminal);
    if (!terminal.ok) {
      const release = await releaseClaimedJob(options, job.jobId, `authority-job-completion-event-failed:${releaseReason}`);
      events.push(release);
      return {
        disposition: 'released',
        completed: false,
        releaseReason: 'authority-job-completion-event-failed',
        releaseOutcome: 'abandoned',
        leaseHealth: loop.leaseHealth(),
        failClosedReason: 'authority-job-completion-event-failed',
        networkEvents: events,
      };
    }
  } else {
    const terminal = await releaseClaimedJob(options, job.jobId, releaseReason);
    events.push(terminal);
  }

  return {
    disposition,
    completed,
    releaseReason,
    releaseOutcome,
    leaseHealth: loop.leaseHealth(),
    ...(failClosedReason ? { failClosedReason } : {}),
    networkEvents: events,
  };
}

// --- Internal: network primitives (signed runner control plane) -------------

interface PostJsonResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  message?: string;
}

function liveEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const lattice = env[`LATTICE_AUTHORITY_${name}`];
  return typeof lattice === 'string' && lattice.trim() !== '' ? lattice.trim() : undefined;
}

function readLiveSecretFromPath(
  path: string | undefined,
  options: AuthorityConfigLoadOptions = {},
): string | undefined {
  if (!path) return undefined;
  const resolved = resolvePath(options.cwd ?? process.cwd(), path);
  const reader = options.fileReader;
  try {
    if (reader) {
      const text = reader(resolved);
      if (typeof text === 'string' && text.trim().length > 0) return text.trim();
      return undefined;
    }
    return readActorPrivateKeyFromPath(resolved);
  } catch {
    return undefined;
  }
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
      try { parsed = JSON.parse(text); } catch { parsed = text; }
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
      message: error?.name === 'AbortError' ? 'authority request timed out' : (error?.message || String(error)),
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
    metadata: { source: 'lattice-cli', providerExecution: 'autopilot-job-loop' },
  };
}

function extractJobId(claimBody: unknown): string | null {
  const record = claimBody as { job?: { jobId?: unknown } | null } | null;
  const jobId = record?.job?.jobId;
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : null;
}

interface ClaimPhaseResult {
  events: LiveJobLoopNetworkEvent[];
  ok: boolean;
  claimedJobId: string | null;
  claimBody: unknown;
  failureNote?: string;
}

async function registerHeartbeatAndClaim(options: LatticeAuthorityLiveRunnerOptions): Promise<ClaimPhaseResult> {
  const events: LiveJobLoopNetworkEvent[] = [];
  const publicKeyHex = derivePublicKeyHexFromPrivateKey(options.actorPrivateKey, options.actorPrivateKeyEncoding ?? 'auto');
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
      capabilities: { source: 'lattice-cli', providerExecution: 'autopilot-job-loop' },
    },
    registrationHeaders,
  );
  events.push(event('register_actor_key', actorKey));
  if (!actorKey.ok) return { events, ok: false, claimedJobId: null, claimBody: null, failureNote: 'Live job loop stopped at actor key registration.' };

  const capability = runnerCapability();
  const registerRunner = await postJson(options, '/v1/runners/register', signedEnvelope(options, {
    actorId: options.actorId,
    role: options.role,
    nonce: nonce(`${options.runnerId}:register`),
    timestamp: pythonCanonicalTimestamp(),
    request: {
      runnerId: options.runnerId,
      projectId: options.projectId,
      sessionId: options.sessionId,
      capabilities: [capability],
      hostname: hostname(),
      heartbeatTtlSeconds: 60,
      metadata: { source: 'lattice-cli', providerExecution: 'autopilot-job-loop' },
    },
  }));
  events.push(event('register_runner', registerRunner));
  if (!registerRunner.ok) return { events, ok: false, claimedJobId: null, claimBody: null, failureNote: 'Live job loop stopped at runner registration.' };

  const heartbeat = await postJson(options, `/v1/runners/${encodeURIComponent(options.runnerId)}/heartbeat`, signedEnvelope(options, {
    actorId: options.actorId,
    role: options.role,
    nonce: nonce(`${options.runnerId}:heartbeat`),
    timestamp: pythonCanonicalTimestamp(),
    runnerId: options.runnerId,
    heartbeat: {
      sessionId: options.sessionId,
      capabilities: [capability],
      heartbeatTtlSeconds: 60,
      metadata: { source: 'lattice-cli', providerExecution: 'autopilot-job-loop' },
    },
  }));
  events.push(event('runner_heartbeat', heartbeat));
  if (!heartbeat.ok) return { events, ok: false, claimedJobId: null, claimBody: null, failureNote: 'Live job loop stopped at runner heartbeat.' };

  const claim = await postJson(options, `/v1/runners/${encodeURIComponent(options.runnerId)}/jobs/claim`, signedEnvelope(options, {
    actorId: options.actorId,
    role: options.role,
    nonce: nonce(`${options.runnerId}:claim`),
    timestamp: pythonCanonicalTimestamp(),
    runnerId: options.runnerId,
    claim: { sessionId: options.sessionId, provider: 'codex', leaseTtlSeconds: 3600 },
  }));
  events.push(event('claim_job', claim));
  if (!claim.ok) return { events, ok: false, claimedJobId: null, claimBody: null, failureNote: 'Live job loop stopped at job claim.' };

  return { events, ok: true, claimedJobId: extractJobId(claim.body), claimBody: claim.body };
}

async function heartbeatClaimedJob(
  options: LatticeAuthorityLiveRunnerOptions,
  jobId: string,
): Promise<{ ok: boolean; event: LiveJobLoopNetworkEvent }> {
  const res = await postJson(options, `/v1/jobs/${encodeURIComponent(jobId)}/heartbeat`, signedEnvelope(options, {
    actorId: options.actorId,
    role: options.role,
    nonce: nonce(`${jobId}:job-heartbeat`),
    timestamp: pythonCanonicalTimestamp(),
    jobId,
    heartbeat: { runnerId: options.runnerId, sessionId: options.sessionId, leaseTtlSeconds: 3600 },
  }));
  return { ok: res.ok, event: event('job_heartbeat', res) };
}

async function releaseClaimedJob(
  options: LatticeAuthorityLiveRunnerOptions,
  jobId: string,
  reason: string,
): Promise<LiveJobLoopNetworkEvent> {
  const res = await postJson(options, `/v1/jobs/${encodeURIComponent(jobId)}/release`, signedEnvelope(options, {
    actorId: options.actorId,
    role: options.role,
    nonce: nonce(`${jobId}:release`),
    timestamp: pythonCanonicalTimestamp(),
    jobId,
    release: { runnerId: options.runnerId, sessionId: options.sessionId, reason },
  }));
  return event('release_job', res);
}

async function completeClaimedRun(
  options: LatticeAuthorityLiveRunnerOptions,
  job: ClaimedAuthorityJob,
  reason: string,
): Promise<LiveJobLoopNetworkEvent> {
  if (!job.runId) {
    return {
      step: 'complete_job',
      ok: false,
      message: 'claimed job runId is required to complete the Python Authority job',
    };
  }
  const res = await postJson(options, `/v1/runs/${encodeURIComponent(job.runId)}/events`, signedEnvelope(options, {
    actorId: options.actorId,
    role: options.role,
    nonce: nonce(`${job.runId}:response-completed`),
    timestamp: pythonCanonicalTimestamp(),
    runId: job.runId,
    event: {
      type: 'response.completed',
      payload: {
        jobId: job.jobId,
        reason,
        source: 'lattice-authority-job-loop',
      },
    },
  }));
  return event('complete_job', res);
}

function event(step: LiveJobLoopNetworkEvent['step'], res: PostJsonResult): LiveJobLoopNetworkEvent {
  return { step, ok: res.ok, ...(res.status !== undefined ? { status: res.status } : {}), ...(res.message ? { message: res.message } : {}) };
}

// --- Internal: claimed JobSpec mapping --------------------------------------

type MapClaimedJobResult = { ok: true; job: ClaimedAuthorityJob } | { ok: false; reason: string };

/**
 * Map a claim response (`{ job: JobSpec }`) into a typed ClaimedAuthorityJob.
 * The typed plannedSteps[] + target live in the JobSpec.metadata; identity
 * (storyId/mode/until) is taken from the server with the expected target as a
 * fallback only when the server omits it. Deep plannedSteps[] validation is
 * deferred to consumeClaimedAuthorityJob (the caller).
 */
function mapClaimedJobSpec(claimBody: unknown, claimedJobId: string, expected: AuthorityJobLoopExpectation): MapClaimedJobResult {
  const record = claimBody as { job?: Record<string, unknown> | null } | null;
  const jobRecord = record?.job;
  if (!jobRecord || typeof jobRecord !== 'object') {
    return { ok: false, reason: 'claim response did not carry a job spec' };
  }
  const jobSpec = objectField(jobRecord, 'spec') ?? jobRecord;
  const meta = objectField(jobRecord, 'metadata') ?? objectField(jobSpec, 'metadata') ?? {};
  const runRecord = objectField(record ?? {}, 'run') ?? {};
  const receiptPolicy = objectField(jobSpec, 'receiptPolicy') ?? {};
  const candidate: Record<string, unknown> = {
    jobId: firstString(jobRecord.jobId, jobSpec.jobId) ?? claimedJobId,
    runId: firstString(jobRecord.runId, jobSpec.runId, runRecord.runId),
    projectId: firstString(jobRecord.projectId, jobSpec.projectId, meta.projectId),
    storyId: firstString(jobRecord.storyId, jobSpec.storyId, meta.storyId),
    mode: firstString(meta.mode) ?? expected.mode,
    until: firstString(meta.until, receiptPolicy.targetPhase) ?? expected.until,
    plannedSteps: firstDefined(meta.plannedSteps, jobRecord.plannedSteps, jobSpec.plannedSteps),
    ...(meta.developmentWorkflow !== undefined ? { developmentWorkflow: meta.developmentWorkflow } : {}),
    ...(meta.coverageMap !== undefined ? { coverageMap: meta.coverageMap } : {}),
  };
  const parsed = parseClaimedAuthorityJob(candidate);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, job: parsed.job };
}

function extractClaimedLease(claimBody: unknown, claimedJobId: string, options: LatticeAuthorityLiveRunnerOptions) {
  const record = claimBody as { job?: Record<string, unknown> | null } | null;
  const jobRecord = (record?.job && typeof record.job === 'object' ? record.job : {}) as Record<string, unknown>;
  const jobSpec = objectField(jobRecord, 'spec') ?? jobRecord;
  const meta = objectField(jobRecord, 'metadata') ?? objectField(jobSpec, 'metadata') ?? {};
  const leaseMetadata = objectField(jobSpec, 'leaseMetadata') ?? objectField(jobRecord, 'leaseMetadata') ?? {};
  return parseClaimedLease({
    leaseId: firstString(jobRecord.leaseId, jobSpec.leaseId, meta.leaseId) ?? `${claimedJobId}:lease`,
    leasedByRunnerId: firstString(jobRecord.leasedByRunnerId, meta.leasedByRunnerId) ?? options.runnerId,
    leasedBySessionId: firstString(jobRecord.leasedBySessionId, meta.leasedBySessionId) ?? options.sessionId,
    leaseExpiresAt: firstDefined(jobRecord.leaseExpiresAt, jobSpec.leaseExpiresAt, meta.leaseExpiresAt),
    leaseTtlMs: numberOr(meta.leaseTtlMs, secondsToMs(leaseMetadata.defaultTtlSeconds), 60_000),
    renewalThresholdMs: numberOr(meta.renewalThresholdMs, secondsToMs(leaseMetadata.heartbeatIntervalSeconds), 20_000),
    graceMs: numberOr(meta.graceMs, 5_000),
    leaseVersion: numberOr(meta.leaseVersion, jobRecord.leaseVersion, 0),
  });
}

function releaseOutcomeForConsumption(consume: ConsumeClaimedAuthorityJobResult | null): JobReleaseOutcome {
  if (!consume) return 'abandoned';
  switch (consume.disposition) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'blocked': return 'abandoned';
    case 'released': return 'abandoned';
    default: return 'abandoned';
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function secondsToMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value * 1000) : undefined;
}

function numberOr(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

// ===========================================================================
// Autopilot orchestration: live `--mode=authority --until=DONE` job loop
//
// This is the single entry the `autopilot execute` handler awaits. It:
//  1. delegates to the synchronous executor for every non-live path (preserving
//     local / shadow / dry-run / in-process claimedJob / --jobFile behavior);
//  2. on the live path, registers/heartbeats/claims a queued job, hands its
//     typed plannedSteps[] to the in-process executor (identical identity +
//     receipt gating to --jobFile), then drives the lease to a clean terminal
//     state and surfaces the full runtime trace on `result.authorityJobLoop`.
// ===========================================================================

export interface AuthorityJobLoopTrace {
  schemaVersion: 'lattice.authority_job_loop.v1';
  claimStatus: AuthorityJobLoopClaimStatus;
  claimedJobId: string | null;
  storyId: string;
  mode: string;
  until: string;
  leaseId: string | null;
  leaseHealth: LeaseHealth | null;
  disposition: 'completed' | 'released' | AuthorityJobLoopClaimStatus;
  completed: boolean;
  releaseReason: string | null;
  releaseOutcome: JobReleaseOutcome | null;
  receiptRequired: boolean;
  receiptVerified: boolean;
  evidenceRefs: string[];
  executedStepCount: number;
  executionStatus: string | null;
  failClosedReason: string | null;
  stopReason: string;
  networkEvents: LiveJobLoopNetworkEvent[];
}

export async function executeAutopilotLive(options: ExecuteAutopilotOptions): Promise<AutopilotExecuteResult> {
  const args = options.args ?? {};
  const env = options.env ?? process.env;

  // Every non-live path keeps the existing synchronous behavior byte-for-byte.
  if (
    options.claimedJob ||
    args.dryRun === true ||
    (typeof args.jobFile === 'string' && args.jobFile.length > 0) ||
    args.mode !== 'authority'
  ) {
    return executeAutopilot(options);
  }

  // Side-effect-free plan to resolve the bound story identity + target phase.
  const dryBase = executeAutopilot({ ...options, args: { ...args, dryRun: true } });
  if (!authorityLiveRunnerConfigured(env, { cwd: options.root })) {
    return failClosedLive(
      dryBase,
      'runner-failed',
      null,
      'authority-live-runner-not-configured',
      'authority live runner is not fully configured; set Authority URL, runner id, project id, customer API key, and actor key before running authority mode',
      [],
    );
  }
  if (!dryBase.story.storyId || !dryBase.story.exists) {
    // Defer to the real synchronous executor's fail-closed story gate (no network).
    return executeAutopilot(options);
  }
  const expected: AuthorityJobLoopExpectation = {
    storyId: dryBase.story.storyId,
    mode: 'authority',
    until: dryBase.targetPhase as PlannerUntilPhase,
  };

  let liveOptions;
  try {
    liveOptions = buildLiveRunnerOptionsFromEnv(env, loadAuthorityConfig(env, {}, { cwd: options.root }), {
      once: true,
      cwd: options.root,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch (error: any) {
    return failClosedLive(dryBase, 'runner-failed', null, 'authority-live-config-missing', error?.message || String(error), []);
  }

  let claim: AuthorityJobLoopClaim;
  try {
    claim = await claimAuthorityJobForLoop(liveOptions, expected);
  } catch (error: any) {
    return failClosedLive(dryBase, 'runner-failed', null, 'authority-runner-failed', error?.message || String(error), []);
  }

  if (claim.status !== 'claimed' || !claim.job || !claim.lease) {
    return failClosedLive(dryBase, claim.status, claim.claimedJobId, claimStopReason(claim.status), claim.reason, claim.networkEvents);
  }

  const gateResolution = await resolveClaimedJobGate({
    job: claim.job,
    env,
    cwd: options.root,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });

  // Consume the claimed typed plannedSteps[] in-process: identity gate + receipt
  // gate are identical to the --jobFile seam (authority DONE blocks without a
  // verified native receipt).
  const base = executeAutopilot({
    ...options,
    claimedJob: claim.job,
    ...(gateResolution?.evaluator ? { claimedJobAuthorityGate: gateResolution.evaluator } : {}),
    ...(gateResolution?.decision ? { claimedJobGateDecision: gateResolution.decision } : {}),
    ...(gateResolution?.materialOverlapAudit ? { claimedJobMaterialOverlapAudit: gateResolution.materialOverlapAudit } : {}),
  });

  // Drive the lease to a clean terminal state over the network.
  const finalize = await finalizeAuthorityJobLoopLease({
    options: liveOptions,
    job: claim.job,
    lease: claim.lease,
    consume: base.claimedJobExecution,
    ...(options.now ? { now: options.now } : {}),
  });

  const trace = buildClaimedTrace(claim, base, finalize);
  return liveFinalizeInvalidatesCompletion(finalize)
    ? downgradeAfterLiveFinalizeFailure(base, trace, finalize)
    : { ...base, authorityJobLoop: trace };
}

async function resolveClaimedJobGate(input: {
  job: ClaimedAuthorityJob;
  env: Record<string, string | undefined>;
  cwd?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<AuthorityGateEvaluatorResolution | null> {
  const planned = buildClaimedAuthorityJobPlan(input.job);
  if (!planned.ok) return null;
  const materialOverlapAudit = buildNoOverlapMaterialOverlapAuditDefault();
  return resolveAuthorityGateEvaluator(planned.jobPlan, {
    env: input.env,
    cwd: input.cwd,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl as unknown as AuthorityFetch } : {}),
    ...(input.now ? { now: input.now } : {}),
    materialOverlapAudit,
  });
}

function buildClaimedTrace(
  claim: AuthorityJobLoopClaim,
  base: AutopilotExecuteResult,
  finalize: AuthorityJobLoopFinalize,
): AuthorityJobLoopTrace {
  const consume = base.claimedJobExecution;
  const job = claim.job!;
  const lease = claim.lease!;
  return {
    schemaVersion: 'lattice.authority_job_loop.v1',
    claimStatus: 'claimed',
    claimedJobId: job.jobId,
    storyId: job.storyId,
    mode: job.mode,
    until: job.until,
    leaseId: lease.leaseId,
    leaseHealth: finalize.leaseHealth,
    disposition: finalize.disposition,
    completed: finalize.completed,
    releaseReason: finalize.releaseReason,
    releaseOutcome: finalize.releaseOutcome,
    receiptRequired: consume?.receiptRequired ?? base.receiptRequired,
    // Source receipt verification from the completion verdict (the executor's REAL
    // gate.evaluate result on a verified native receipt), not the out-of-band
    // pre-execution plan hint on consume.receiptVerified — only the verdict reflects
    // whether the live gate actually verified a receipt this run.
    receiptVerified: base.completion?.receiptVerified ?? base.receipt.verified,
    evidenceRefs: consume?.execution?.evidenceRefs ?? [],
    executedStepCount: consume?.execution?.executedStepCount ?? 0,
    executionStatus: consume?.execution?.status ?? null,
    failClosedReason: finalize.failClosedReason ?? null,
    stopReason: base.stopReason,
    networkEvents: [...claim.networkEvents, ...finalize.networkEvents],
  };
}

function liveFinalizeInvalidatesCompletion(finalize: AuthorityJobLoopFinalize): boolean {
  const reason = finalize.failClosedReason ?? '';
  return (
    reason === 'authority-job-completion-event-failed' ||
    reason === 'completion-rejected' ||
    reason === 'job-already-completed-with-different-result-digest' ||
    reason === 'job-already-released' ||
    reason.startsWith('stale-lease') ||
    reason.startsWith('lease-unsafe')
  );
}

function withReason(values: string[], reason: string): string[] {
  return values.includes(reason) ? values : [...values, reason];
}

function downgradeAfterLiveFinalizeFailure(
  base: AutopilotExecuteResult,
  trace: AuthorityJobLoopTrace,
  finalize: AuthorityJobLoopFinalize,
): AutopilotExecuteResult {
  const reason = finalize.failClosedReason ?? finalize.releaseReason ?? 'authority-job-finalize-failed';
  const nextAction = `Live Authority completion failed closed: ${reason}. Repair the Authority terminal state and rerun the live job loop.`;
  const blockingReasons = withReason(base.blockingReasons, reason);
  const nextActions = withReason(base.nextActions, nextAction);
  const completion = base.completion
    ? {
        ...base.completion,
        completed: false,
        authorityDone: false,
        fullAuthorityDone: false,
        blockingReasons: withReason(base.completion.blockingReasons, reason),
        stopReason: reason,
        nextAction,
      }
    : null;
  return {
    ...base,
    status: 'fail',
    stopReason: reason,
    authorityDone: false,
    fullAuthorityDone: false,
    completion,
    blockingReasons,
    nextAction,
    nextActions,
    authorityJobLoop: trace,
  };
}

function failClosedLive(
  dryBase: AutopilotExecuteResult,
  claimStatus: AuthorityJobLoopClaimStatus,
  claimedJobId: string | null,
  stopReason: string,
  reason: string,
  networkEvents: LiveJobLoopNetworkEvent[],
): AutopilotExecuteResult {
  const next = new Set(dryBase.nextActions);
  next.add(reason);
  next.add('Live authority job loop fail-closed: no authority DONE without a cleanly claimed, receipt-verified job.');
  const trace: AuthorityJobLoopTrace = {
    schemaVersion: 'lattice.authority_job_loop.v1',
    claimStatus,
    claimedJobId,
    storyId: dryBase.story.storyId ?? '',
    mode: dryBase.mode,
    until: dryBase.targetPhase,
    leaseId: null,
    leaseHealth: null,
    disposition: claimStatus,
    completed: false,
    releaseReason: reason,
    releaseOutcome: claimedJobId ? 'abandoned' : null,
    receiptRequired: dryBase.receiptRequired,
    receiptVerified: false,
    evidenceRefs: [],
    executedStepCount: 0,
    executionStatus: null,
    failClosedReason: reason,
    stopReason,
    networkEvents,
  };
  return {
    ...dryBase,
    dryRun: false,
    status: 'fail',
    stopReason,
    authorityDone: false,
    fullAuthorityDone: false,
    nextActions: [...next],
    authorityJobLoop: trace,
  };
}

function claimStopReason(status: AuthorityJobLoopClaimStatus): string {
  switch (status) {
    case 'no-job': return 'authority-no-job';
    case 'runner-failed': return 'authority-runner-failed';
    case 'invalid-job': return 'authority-job-invalid';
    case 'lease-invalid': return 'authority-lease-invalid';
    default: return 'authority-live-failed';
  }
}

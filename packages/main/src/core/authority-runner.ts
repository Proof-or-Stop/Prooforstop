import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { JobSpec, ProviderEventsEnvelope } from './authority-runner-contracts.js';
import { signRunnerEnvelope } from './authority-runner-contracts.js';
import type { PrivateKeyBase64 } from './authority-signing.js';
import {
  derivePublicKeyHexFromPrivateKey,
  signLatticeAuthorityEnvelope,
  type LatticeAuthorityKeyEncoding,
} from './lattice-authority-native.js';

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
  step: AuthorityRunnerPlannedStep | 'release_job';
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMS);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(joinURL(options.baseURL, path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...extraHeaders,
      },
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
    ? { Authorization: `Bearer ${options.bootstrapToken}` }
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
  events.push(eventFromResult('register_runner', actorKey));
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
  const events = [
    ...(stdout
      ? [{
          eventId: `${jobSpec.jobId}:stdout:1`,
          kind: 'stdout_delta',
          occurredAt,
          payload: { text: stdout, transcriptHash: hash },
        }]
      : []),
    ...(stderr
      ? [{
          eventId: `${jobSpec.jobId}:stderr:1`,
          kind: 'stderr_delta',
          occurredAt,
          payload: { text: stderr, transcriptHash: hash },
        }]
      : []),
    {
      eventId: `${jobSpec.jobId}:${exitCode === 0 ? 'completed' : 'failed'}`,
      kind: exitCode === 0 ? 'completed' : 'failed',
      occurredAt,
      payload: { exitCode, transcriptHash: hash },
    },
  ];
  const envelopeBase: ProviderEventsEnvelope = {
    actorId,
    nonce: `${jobSpec.jobId}:${jobSpec.runId}:provider-events`,
    createdAt: occurredAt,
    runId: jobSpec.runId,
    events,
  };
  const { signed, digest } = signRunnerEnvelope(envelopeBase, privateKey);
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
    eventKinds: events.map(event => event.kind),
    envelope: signed,
    envelopeDigest: digest,
  };
}

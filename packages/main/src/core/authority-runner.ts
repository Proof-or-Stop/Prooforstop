import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { JobSpec, ProviderEventsEnvelope } from './authority-runner-contracts.js';
import { signRunnerEnvelope } from './authority-runner-contracts.js';
import type { PrivateKeyBase64 } from './authority-signing.js';

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
  plannedSteps: AuthorityRunnerPlannedStep[];
  spawned: false;
  providerEvents: [];
  localWorkflowUsable: true;
  status: 'pass' | 'fail';
  readinessWarnings: string[];
  nextActions: string[];
  note: string;
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

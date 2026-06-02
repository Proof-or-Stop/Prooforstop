#!/usr/bin/env node

import assert from 'node:assert/strict';
import { executeFakeProviderJob } from '../core/authority-runner.js';
import { verifyRunnerEnvelope, type JobSpec } from '../core/authority-runner-contracts.js';
import { generateEd25519KeyPair } from '../core/authority-signing.js';

const PASS_LINE =
  '✓ authority runner events smoke passed: stdout/completed/failed events are signed and transcript-bound';

const keys = generateEd25519KeyPair();
const baseJob: JobSpec = {
  jobId: 'job-1',
  runId: 'run-1',
  kind: 'verify',
  provider: 'fake-provider',
  model: 'fake-local',
  vendor: 'koala',
  metadata: {
    allowLocalCommand: true,
    runnerId: 'runner-1',
    command: ['node', '-e', 'process.stdout.write("ok\\n")'],
  },
};

{
  const result = executeFakeProviderJob({
    jobSpec: baseJob,
    runnerId: 'runner-1',
    actorId: 'actor-1',
    privateKey: keys.privateKey,
    expectedRunId: 'run-1',
    now: '2026-06-02T18:00:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert(result.stdout.includes('ok'));
  assert(result.transcriptHash.length === 64);
  assert.deepEqual(result.eventKinds, ['stdout_delta', 'completed']);
  assert.equal(result.envelope.runId, 'run-1');
  assert.equal(verifyRunnerEnvelope(result.envelope, keys.publicKey), true);
  assert.equal(result.envelope.events.at(-1)?.payload?.exitCode, 0);
  assert.equal(result.envelope.events.at(-1)?.payload?.transcriptHash, result.transcriptHash);
}

{
  const failingJob: JobSpec = {
    ...baseJob,
    jobId: 'job-2',
    runId: 'run-2',
    metadata: {
      allowLocalCommand: true,
      runnerId: 'runner-1',
      command: ['node', '-e', 'process.stderr.write("bad\\n"); process.exit(7)'],
    },
  };
  const result = executeFakeProviderJob({
    jobSpec: failingJob,
    runnerId: 'runner-1',
    actorId: 'actor-1',
    privateKey: keys.privateKey,
    expectedRunId: 'run-2',
    now: '2026-06-02T18:00:00.000Z',
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert(result.stderr.includes('bad'));
  assert.deepEqual(result.eventKinds, ['stderr_delta', 'failed']);
  assert.equal(verifyRunnerEnvelope(result.envelope, keys.publicKey), true);
  assert.equal(result.envelope.events.at(-1)?.payload?.exitCode, 7);
}

{
  assert.throws(
    () => executeFakeProviderJob({
      jobSpec: { ...baseJob, metadata: { ...baseJob.metadata, runnerId: 'other-runner' } },
      runnerId: 'runner-1',
      actorId: 'actor-1',
      privateKey: keys.privateKey,
      expectedRunId: 'run-1',
    }),
    /runnerId mismatch/,
  );
  assert.throws(
    () => executeFakeProviderJob({
      jobSpec: { ...baseJob, runId: 'other-run' },
      runnerId: 'runner-1',
      actorId: 'actor-1',
      privateKey: keys.privateKey,
      expectedRunId: 'run-1',
    }),
    /runId mismatch/,
  );
  assert.throws(
    () => executeFakeProviderJob({
      jobSpec: { ...baseJob, provider: 'claude-code' },
      runnerId: 'runner-1',
      actorId: 'actor-1',
      privateKey: keys.privateKey,
    }),
    /provider=fake-provider/,
  );
}

console.log(PASS_LINE);

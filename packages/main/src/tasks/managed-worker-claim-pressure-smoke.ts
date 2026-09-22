#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getManagedHostRunStatus,
  runManagedHostRunWorker,
  submitManagedHostRun,
} from '../core/managed-host-run.js';

const root = mkdtempSync(join(tmpdir(), 'managed-worker-claim-pressure-'));
const delayedClaimMs = 6_000;

try {
  let workerFailure: unknown = null;
  let resolveWorker!: () => void;
  const workerFinished = new Promise<void>(resolve => { resolveWorker = resolve; });
  const submitted = await submitManagedHostRun({
    root,
    cwd: root,
    host: 'codex',
    storyId: null,
    phase: 'REVIEW',
    agentType: 'claim-pressure-probe',
    promptText: 'Delayed worker claim under concurrent cold-start pressure.',
    deadlineMs: 20_000,
    projectRootHash: 'sha256:claim-pressure-probe',
    profile: null,
  }, {
    launchWorker: async request => {
      setTimeout(() => {
        void runManagedHostRunWorker(request, {
          runner: async () => ({
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            terminalReason: 'completed',
            finalAssistantResult: null,
            finalAssistantResultCount: 0,
            finalAssistantResultTruncated: false,
          }),
        }).catch(error => { workerFailure = error; }).finally(resolveWorker);
      }, delayedClaimMs);
      return { pid: process.pid };
    },
    claimPollMs: 10,
  });
  await workerFinished;
  assert.equal(workerFailure, null, 'delayed worker must settle without an execution error');
  const status = await getManagedHostRunStatus({ root, runId: submitted.runId });
  assert.equal(
    status.run.terminal?.state,
    'completed',
    `a healthy delayed worker must claim within the production handshake budget; got ${status.run.terminal?.reason}`,
  );
  assert.equal(status.run.terminal?.replacementSafe, true);
  console.log('MANAGED_WORKER_CLAIM_PRESSURE_GREEN');
} finally {
  rmSync(root, { recursive: true, force: true });
}

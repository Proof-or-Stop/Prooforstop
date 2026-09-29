#!/usr/bin/env node

// Regression: a status reader that runs while a worker is inside its
// snapshot/event write briefly sees snapshot-event-transition.json and threw
// "snapshot/event recovery pending", which made the REVIEW barrier controller
// abort a healthy collective review. A transient sidecar must be waited out;
// only one that persists (a crashed writer) is reported.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync as writeFile } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getManagedHostRunStatus,
  managedHostRunDirectory,
  runManagedHostRunWorker,
  submitManagedHostRun,
  type ManagedHostRunWorkerLauncher,
} from '../core/managed-host-run.js';
import type { HostRunRunner, HostRunSpawnResult } from '../core/host-run.js';


function submitArgs(caseRoot: string, promptText: string) {
  return {
    root: caseRoot,
    cwd: caseRoot,
    host: 'codex' as const,
    storyId: 'B-managed',
    phase: 'REVIEW',
    agentType: 'lattice-review-quality',
    reviewRunId: 'B-managed:RR-001',
    lane: 'lattice-review-quality',
    promptText,
    deadlineMs: 20_000,
    projectRootHash: 'sha256:test-root',
    profile: 'managed_reviewer',
    reviewBinding: {
      headHash: 'head-managed',
      materialHash: 'material-managed',
      storyFilesHash: 'story-managed',
      promptHash: 'prompt-managed',
      envelopeId: null,
      managedPromptDigest: `sha256:${createHash('sha256').update(promptText, 'utf8').digest('hex')}`,
    },
  };
}

function plainResult(): HostRunSpawnResult {
  const finalAssistantResult = JSON.stringify({
    schemaVersion: 'lattice.managed_review_final_proposal.v1',
    storyId: 'B-managed',
    providerAgent: 'lattice-review-quality',
    lane: 'lattice-review-quality',
    reviewRunId: 'B-managed:RR-001',
    conclusion: 'pass',
    note: 'Provider inspected the managed changes and found no blocking issue.',
    readManifest: {
      filesReadFully: ['packages/main/src/core/managed-host-run.ts'],
      filesTriagedByName: [],
      scanEscalationReason: null,
      candidateSpecSetDigest: 'a'.repeat(64),
      corpusDigest: 'b'.repeat(64),
    },
    readLog: {
      filesReadFully: ['packages/main/src/core/managed-host-run.ts'],
      filesTriagedByName: [],
      summary: { readCount: 1, tokenCount: null },
      digest: 'c'.repeat(64),
    },
  });
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    terminalReason: 'completed',
    finalAssistantResult,
    finalAssistantResultCount: 1,
    finalAssistantResultTruncated: false,
  };
}

const SELF = fileURLToPath(import.meta.url);
const PROGRESS_MS = 1_500;

/** Child mode: an out-of-process worker whose provider streams progress, then completes. */
async function workerOnly(root: string, runId: string): Promise<void> {
  const runner: HostRunRunner = async plan => {
    const stopAt = Date.now() + PROGRESS_MS;
    let i = 0;
    while (Date.now() < stopAt) {
      plan.onChunk?.({ stream: 'stdout', text: `{"type":"item.progress","n":${i++}}\n` });
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return plainResult();
  };
  await runManagedHostRunWorker({ root, runId }, { runner, env: { PROOF_OR_STOP_USAGE_LEDGER: '0' }, cancelPollMs: 5 });
}

async function main(): Promise<void> {
  const caseRoot = mkdtempSync(join(tmpdir(), 'managed-host-run-status-read-race-'));
  try {
    // Separate process: the run's mkdir ticket locks wait synchronously, so an
    // in-process worker and status reader could starve each other.
    const launcher: ManagedHostRunWorkerLauncher = async request => {
      const child = spawn(process.execPath, [SELF, 'worker-only', request.root, request.runId], { stdio: 'inherit' });
      return { pid: child.pid! };
    };
    const submitted = await submitManagedHostRun(submitArgs(caseRoot, 'implement'), {
      launchWorker: launcher, claimTimeoutMs: 500, claimPollMs: 5,
    });
    for (let i = 0; i < 400; i++) {
      if ((await getManagedHostRunStatus({ root: caseRoot, runId: submitted.runId })).run.terminal) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const sidecar = join(managedHostRunDirectory(caseRoot, submitted.runId), 'snapshot-event-transition.json');
    // A concurrent writer's in-flight transition: it disappears 300 ms later.
    writeFile(sidecar, '{}\n');
    spawn('sh', ['-c', `sleep 0.3; rm -f '${sidecar}'`], { stdio: 'ignore' });
    let status;
    try {
      status = await getManagedHostRunStatus({ root: caseRoot, runId: submitted.runId });
    } catch (error) {
      assert.fail(`status read aborted on a transient snapshot/event transition: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert.notEqual(status.run.terminal, null);
    // A sidecar that never goes away is still reported.
    writeFile(sidecar, '{}\n');
    await assert.rejects(getManagedHostRunStatus({ root: caseRoot, runId: submitted.runId }), /snapshot\/event recovery pending/);
    console.log('managed-host-run-status-read-race-smoke: PASS');
  } finally {
    rmSync(caseRoot, { recursive: true, force: true });
  }
}

if (process.argv[2] === 'worker-only') await workerOnly(process.argv[3]!, process.argv[4]!);
else await main();

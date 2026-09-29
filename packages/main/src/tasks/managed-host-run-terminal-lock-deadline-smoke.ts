#!/usr/bin/env node

// Regression: the terminal authority lock gave waiters only 5 s. Under load a
// live holder (heartbeat, reconcile, status recovery) kept it longer, and the
// worker failed a finished 9-minute review lane with "managed terminal ... lock
// timeout after 5000ms". A live holder must be waited out, not turned into a
// worker failure.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hostname } from 'node:os';
import { acquireMkdirLock } from '../core/mkdir-lock.js';
import {
  cancelManagedHostRun,
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
const PROGRESS_MS = 15_000;
const HOLD_MS = 7_000;

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
  const caseRoot = mkdtempSync(join(tmpdir(), 'managed-host-run-terminal-lock-deadline-'));
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
    const lockDir = join(managedHostRunDirectory(caseRoot, submitted.runId), 'terminal.lock');
    const holder = spawn(process.execPath, [SELF, 'hold-lock', lockDir], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>(resolve => holder.stdout!.once('data', () => resolve()));
    const startedAt = Date.now();
    try {
      await cancelManagedHostRun({ root: caseRoot, runId: submitted.runId, reason: 'lock deadline smoke' });
    } catch (error) {
      assert.fail(`terminal lock waiter failed while a live holder kept the lock: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert.ok(Date.now() - startedAt >= HOLD_MS - 1_500, 'the cancel waited for the live holder');
    for (let i = 0; i < 800; i++) {
      if ((await getManagedHostRunStatus({ root: caseRoot, runId: submitted.runId })).run.terminal) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    console.log('managed-host-run-terminal-lock-deadline-smoke: PASS');
  } finally {
    rmSync(caseRoot, { recursive: true, force: true });
  }
}

if (process.argv[2] === 'hold-lock') {
  const lock = acquireMkdirLock(process.argv[3]!, {
    label: 'smoke holder', deadlineMs: 5_000, staleMs: 2_000, pollMs: 10, requireHolderToken: true,
    holderInfo: { pid: process.pid, hostname: hostname(), command: 'smoke holder', acquiredAt: new Date().toISOString(),
      lockId: 'smoke-holder', processStartTimeMs: Math.floor(Date.now() - process.uptime() * 1_000) },
  } as never);
  process.stdout.write('held\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HOLD_MS);
  lock.release();
} else if (process.argv[2] === 'worker-only') await workerOnly(process.argv[3]!, process.argv[4]!);
else await main();

#!/usr/bin/env node

// Regression: an owner waiting for one managed worker must be able to block
// until the run is terminal. A plain long-poll returns on every provider
// progress generation (often within a second) and is capped at 30 s, so a
// Story owner that only needs the terminal receipt polls dozens of times per
// worker, re-reading its whole model context on each poll.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as managedHostRun from '../core/managed-host-run.js';
import {
  getManagedHostRunStatus,
  runManagedHostRunWorker,
  submitManagedHostRun,
  type ManagedHostRunWorkerLauncher,
} from '../core/managed-host-run.js';
import type { HostRunRunner, HostRunSpawnResult } from '../core/host-run.js';

type StatusArgs = Parameters<typeof getManagedHostRunStatus>[0] & { untilTerminal?: boolean };
const statusUntilTerminal = (args: StatusArgs) => getManagedHostRunStatus(args as Parameters<typeof getManagedHostRunStatus>[0]);

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
  const caseRoot = mkdtempSync(join(tmpdir(), 'managed-host-run-until-terminal-'));
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
    const startedAt = Date.now();
    const status = await statusUntilTerminal({
      root: caseRoot, runId: submitted.runId, waitMs: 10_000, untilTerminal: true,
    });
    const waitedMs = Date.now() - startedAt;
    assert.notEqual(status.run.terminal, null,
      `untilTerminal returned before the run was terminal (state=${status.run.state} after ${waitedMs} ms)`);
    assert.equal(status.changed, true);
    assert.ok(status.receipt, 'a terminal untilTerminal wait carries the receipt');

    const again = await statusUntilTerminal({ root: caseRoot, runId: submitted.runId, waitMs: 5_000, untilTerminal: true });
    assert.notEqual(again.run.terminal, null, 'an already terminal run returns immediately');

    const terminalCap = (managedHostRun as Record<string, unknown>).MANAGED_HOST_RUN_STATUS_TERMINAL_WAIT_MAX_MS;
    assert.ok(typeof terminalCap === 'number' && terminalCap >= 300_000 && terminalCap <= 900_000,
      'the terminal wait stays bounded');
    console.log(`managed-host-run-until-terminal-smoke: PASS (one call waited ${waitedMs} ms through progress to terminal)`);
  } finally {
    rmSync(caseRoot, { recursive: true, force: true });
  }
}

if (process.argv[2] === 'worker-only') await workerOnly(process.argv[3]!, process.argv[4]!);
else await main();

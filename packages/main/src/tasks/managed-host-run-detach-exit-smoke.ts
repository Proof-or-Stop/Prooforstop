#!/usr/bin/env node

// Regression: a detached `host_run` submitter must exit once the run is
// submitted. The formal-review capability travels over an inherited fd-3 pipe
// that the worker keeps open for its whole provider lifetime; if the
// submitter keeps its end of that pipe referenced, `--detach` silently becomes
// an attach and every owner launch blocks until the worker finishes.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defaultManagedHostRunWorkerLauncher,
  managedHostRunDirectory,
  submitManagedHostRun,
} from '../core/managed-host-run.js';

const SELF = fileURLToPath(import.meta.url);
const WORKER_HOLD_MS = 4_000;

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
    deadlineMs: 10_000,
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

/** Child mode: submit one detached run with a capability key, then return. */
async function submitOnly(caseRoot: string, payloadPath: string): Promise<void> {
  const runId = `mhr-${randomUUID()}`;
  mkdirSync(managedHostRunDirectory(caseRoot, runId), { recursive: true });
  const holder = join(caseRoot, 'hold-worker-capability-fd.cjs');
  writeFileSync(holder, [
    `const fs = require('node:fs');`,
    `fs.writeFileSync(${JSON.stringify(payloadPath)}, fs.readFileSync(3, 'utf8'));`,
    `setTimeout(() => process.exit(0), ${WORKER_HOLD_MS});`,
  ].join('\n'));
  process.argv[1] = holder;
  await submitManagedHostRun(submitArgs(caseRoot, 'detach exit'), {
    randomId: () => runId, claimTimeoutMs: 10,
    launchWorker: request => defaultManagedHostRunWorkerLauncher({ ...request,
      proposalInvocationPrivateKey: 'detach-exit-test-key' }),
  });
  process.stdout.write(`submitted ${Date.now()}\n`);
}

async function main(): Promise<void> {
  const caseRoot = mkdtempSync(join(tmpdir(), 'managed-host-run-detach-exit-'));
  const payloadPath = join(caseRoot, 'payload.txt');
  try {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [SELF, 'submit-only', caseRoot, payloadPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
    const elapsedMs = Date.now() - startedAt;
    assert.equal(code, 0, `submitter failed: ${stdout}`);
    assert.match(stdout, /^submitted \d+/m, 'submitter reached the post-submit point');
    const payloadDeadline = Date.now() + 2_000;
    while (!existsSync(payloadPath) && Date.now() < payloadDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(payloadPath), 'worker received the capability delivered before the submitter exited');
    assert.equal(readFileSync(payloadPath, 'utf8'), 'detach-exit-test-key');
    assert.ok(elapsedMs < WORKER_HOLD_MS - 1_000,
      `detached submitter exit waited for the worker capability pipe (${elapsedMs} ms >= ${WORKER_HOLD_MS - 1_000} ms)`);
    console.log(`managed-host-run-detach-exit-smoke: PASS (submitter exited after ${elapsedMs} ms; worker holds fd 3 for ${WORKER_HOLD_MS} ms)`);
  } finally {
    await new Promise(resolve => setTimeout(resolve, WORKER_HOLD_MS));
    rmSync(caseRoot, { recursive: true, force: true });
  }
}

if (process.argv[2] === 'submit-only') {
  await submitOnly(process.argv[3]!, process.argv[4]!);
} else {
  await main();
}

#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { managedHostRunDirectory, readManagedHostRunOutput } from '../core/managed-host-run.js';

const root = mkdtempSync(join(tmpdir(), 'managed-host-run-output-reader-'));
const runId = 'output-reader-smoke';
const runDir = managedHostRunDirectory(root, runId);
const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const now = '2026-08-24T00:00:00.000Z';

function writeSnapshot(overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(runDir, 'snapshot.json'), `${JSON.stringify({
    schemaVersion: 'lattice.managed_host_run.v1',
    runId,
    state: 'running',
    generation: 1,
    createdAt: now,
    deadlineAt: '2026-08-24T01:00:00.000Z',
    workerPid: null,
    workerHeartbeatAt: null,
    lastProviderProgressAt: null,
    providerProgressMode: 'output-observable',
    providerLaunchState: 'pending',
    providerIdentity: null,
    outputSequence: 0,
    outputRetainedBytes: 0,
    outputTruncated: false,
    replacementSafe: false,
    ...overrides,
  })}\n`, 'utf8');
}

try {
  mkdirSync(runDir, { recursive: true });
  const spec = `${JSON.stringify({
    schemaVersion: 'lattice.managed_host_run.v1',
    runId,
    host: 'codex',
    storyId: null,
    phase: 'DEV',
    agentType: 'output-reader-smoke',
    reviewRunId: null,
    lane: null,
    cwd: root,
    root,
    createdAt: now,
    deadlineAt: '2026-08-24T01:00:00.000Z',
    timeoutMs: 60_000,
    projectRootHash: 'sha256:project',
    profile: null,
    reviewBinding: null,
  })}\n`;
  writeFileSync(join(runDir, 'spec.json'), spec, 'utf8');
  writeFileSync(join(runDir, 'owner.json'), `${JSON.stringify({
    schemaVersion: 'lattice.managed_host_run.v1',
    runId,
    capabilityDigest: 'sha256:capability',
    proposalInvocationPublicKey: null,
    specDigest: sha256(spec),
    promptDigest: 'sha256:prompt',
    environmentDigest: null,
    createdAt: now,
  })}\n`, 'utf8');

  const frames = Array.from({ length: 5_000 }, (_, index) => ({
    schemaVersion: 'lattice.managed_host_run_output.v1',
    sequence: index + 1,
    stream: 'stdout',
    text: `frame-${index + 1}\n`,
    at: now,
  }));
  const output = `${frames.map(frame => JSON.stringify(frame)).join('\n')}\n`;
  writeFileSync(join(runDir, 'live-output.jsonl'), output, 'utf8');
  writeSnapshot({ outputSequence: frames.length, outputRetainedBytes: Buffer.byteLength(output, 'utf8') });

  let bytesRead = 0;
  const first = readManagedHostRunOutput({
    root,
    runId,
    afterSequence: 0,
    journalReadObserver: bytes => { bytesRead += bytes; },
  });
  assert.equal(first.frames.length, 2_048, 'first page retains the established maximum frame page size');
  assert.equal(first.nextSequence, 2_048);
  assert.equal(first.hasMore, true);
  assert.equal(bytesRead, Buffer.byteLength(output, 'utf8'), 'first page parses the bounded retained journal once');

  bytesRead = 0;
  const second = readManagedHostRunOutput({
    root,
    runId,
    afterSequence: first.nextSequence,
    journalReadObserver: bytes => { bytesRead += bytes; },
  });
  assert.deepEqual(second.frames.map(frame => frame.sequence), Array.from({ length: 2_048 }, (_, index) => index + 2_049));
  assert.equal(second.hasMore, true);
  assert.equal(bytesRead, 0, 'second foreground page reuses parsed retained frames without rereading historical journal bytes');

  bytesRead = 0;
  const third = readManagedHostRunOutput({
    root,
    runId,
    afterSequence: second.nextSequence,
    journalReadObserver: bytes => { bytesRead += bytes; },
  });
  assert.equal(third.nextSequence, 5_000);
  assert.equal(third.hasMore, false);
  assert.equal(bytesRead, 0, 'later page remains O(page) after the initial parse rather than rescanning retained history');

  const appended = `${JSON.stringify({ ...frames[0]!, sequence: 5_001, text: 'appended-frame\n' })}\n`;
  appendFileSync(join(runDir, 'live-output.jsonl'), appended, 'utf8');
  writeSnapshot({ outputSequence: 5_001, outputRetainedBytes: Buffer.byteLength(output, 'utf8') + Buffer.byteLength(appended, 'utf8') });
  bytesRead = 0;
  const appendedPage = readManagedHostRunOutput({
    root,
    runId,
    afterSequence: third.nextSequence,
    journalReadObserver: bytes => { bytesRead += bytes; },
  });
  assert.deepEqual(appendedPage.frames.map(frame => frame.sequence), [5_001]);
  assert.equal(bytesRead, Buffer.byteLength(appended, 'utf8'), 'a stable append parses only the new journal suffix');

  const sealedOutput = `${output}${appended}`;
  writeSnapshot({
    state: 'completed',
    generation: 9,
    outputSequence: 5_001,
    outputRetainedBytes: Buffer.byteLength(sealedOutput, 'utf8'),
    replacementSafe: true,
  });
  writeFileSync(join(runDir, 'terminal.json'), `${JSON.stringify({
    schemaVersion: 'lattice.managed_host_run.v1',
    runId,
    state: 'completed',
    reason: 'completed',
    terminalAt: now,
    generation: 9,
    replacementSafe: true,
    resultDigest: null,
    eventJournalDigest: sha256(''),
    liveOutputDigest: sha256(sealedOutput),
    specDigest: sha256(spec),
    evidenceProposalDigest: null,
    processCleanup: { termSent: false, killSent: false, reaped: true, residualProcessGroup: false },
  })}\n`, 'utf8');
  assert.equal(readManagedHostRunOutput({ root, runId, afterSequence: 5_000 }).frames[0]?.sequence, 5_001,
    'terminal cache identity accepts the same sealed output only after the terminal digest verifies');
  appendFileSync(join(runDir, 'live-output.jsonl'), 'forged-after-seal\n', 'utf8');
  assert.throws(
    () => readManagedHostRunOutput({ root, runId, afterSequence: 5_000 }),
    /sealed artifact digest mismatch \(live-output\)/,
    'cached frames never bypass the before/after terminal live-output seal verification',
  );

  console.log('managed-host-run-output-reader-smoke PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}

#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [join(repo, 'scripts/ensure-dist.mjs')], { cwd: repo, stdio: 'inherit' });

const { StoryStore } = await import(join(repo, 'packages/main/dist/core/store.js'));
const { readOwnerLease } = await import(join(repo, 'packages/main/dist/core/story-owner-lease.js'));
const cli = join(repo, 'packages/main/dist/cli.js');
const root = mkdtempSync(join(tmpdir(), 'managed-worker-owner-lease-'));
const storyId = 'B-worker-owner-lease';

try {
  const store = new StoryStore(root);
  const now = new Date().toISOString();
  store.writeStory(storyId, {
    storyId,
    name: 'managed-worker-owner-lease',
    title: 'Preserve the Story owner across a detached managed worker',
    description: 'A short-lived runtime continuation must not replace the durable Story owner lease.',
    type: 'bug',
    priority: 'high',
    phase: 'DEV',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [],
  });

  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const fakeCodex = join(bin, 'codex');
  writeFileSync(fakeCodex, `#!/bin/sh
sleep 1
printf '%s\\n' '{"type":"turn.completed","usage":{}}'
`);
  chmodSync(fakeCodex, 0o700);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    PROOF_OR_STOP_USAGE_LEDGER: '0',
    PROOF_OR_STOP_SESSION_ID: 'managed-worker-owner-lease-owner',
    PROOF_OR_STOP_AGENT: 'proof-or-stop-implementer',
  };
  const submitted = spawnSync(process.execPath, [
    cli,
    '--root', root,
    'host_run',
    JSON.stringify({
      host: 'codex',
      storyId,
      agentType: 'managed-worker-owner-lease-smoke',
      phase: 'DEV',
      prompt: 'complete and preserve the submitting Story owner lease',
      detach: true,
      deadlineMs: 5_000,
      json: true,
    }),
  ], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(submitted.status, 0, submitted.stderr);
  const run = JSON.parse(submitted.stdout);
  assert.ok(Number.isSafeInteger(run.run.workerPid), 'detached submission exposes its worker pid');

  const foreign = spawnSync(process.execPath, [
    cli,
    '--root', root,
    'host_run_worker',
    JSON.stringify({ runId: run.run.runId }),
  ], {
    cwd: root,
    env: { ...env, PROOF_OR_STOP_SESSION_ID: 'managed-worker-owner-lease-foreign' },
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.notEqual(foreign.status, 0, 'a foreign session cannot reuse a live worker runId');
  assert.match(
    foreign.stderr,
    /owned by another session|owner lease/i,
    `foreign live-run reuse is rejected by the Story owner gate: ${foreign.stderr}`,
  );

  const deadline = Date.now() + 5_000;
  let projection = run;
  let state = run.run.state;
  while (Date.now() < deadline && state !== 'completed') {
    const status = spawnSync(process.execPath, [
      cli,
      '--root', root,
      'host_run_status',
      JSON.stringify({ runId: run.run.runId, json: true }),
    ], { cwd: root, env, encoding: 'utf8', timeout: 5_000 });
    assert.equal(status.status, 0, status.stderr);
    projection = JSON.parse(status.stdout);
    state = projection.run.state;
    if (state !== 'completed') await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  assert.equal(state, 'completed', `managed worker reaches a successful terminal: ${JSON.stringify(projection.run.terminal)}`);

  const lease = readOwnerLease(store.storyDirPath(storyId));
  assert.ok(lease, 'the submitting owner lease remains after the runtime continuation completes');
  assert.equal(lease.command, 'host_run', 'the owner lease keeps the submitting command');
  assert.notEqual(
    lease.pid,
    run.run.workerPid,
    'MANAGED_WORKER_OWNER_LEASE_RED: detached runtime continuation replaced the Story owner pid',
  );
  console.log('MANAGED_WORKER_OWNER_LEASE_GREEN');
} finally {
  rmSync(root, { recursive: true, force: true });
}

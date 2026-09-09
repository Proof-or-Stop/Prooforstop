import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submitManagedHostRun, runManagedHostRunWorker } from '../packages/main/dist/core/managed-host-run.js';
import { storyIdFromArgs } from '../packages/main/dist/cli/ownership-gate.js';
import { createHostRunHandlers } from '../packages/main/dist/handlers/host-run.js';
const root = mkdtempSync(join(tmpdir(), 'managed-aggregate-wait-'));
const workers = [], releases = [], outputs = [];
const handlers = createHostRunHandlers({ root });
try {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const gate = new Promise(resolve => releases.push(resolve));
    runs.push(await submitManagedHostRun({ root, cwd: root, host: 'codex',
      storyId: 'B-aggregate', phase: 'REVIEW', agentType: 'lattice-review-quality', promptText: `Aggregate ${i}`,
      deadlineMs: 10000, projectRootHash: 'sha256:test-root' }, {
      launchWorker: request => {
        workers.push(runManagedHostRunWorker(request, { heartbeatMs: 10, cancelPollMs: 10,
          env: { PROOF_OR_STOP_USAGE_LEDGER: '0' }, runner: async plan => {
            outputs[i] = () => plan.onChunk?.({ stream: 'stdout', text: `progress ${i}\n` });
            await gate;
            return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
          } }));
        return { pid: process.pid };
      }, claimTimeoutMs: 1000, claimPollMs: 5,
    }));
  }
  assert.equal(storyIdFromArgs({ targets: runs.map(run => ({ runId: run.runId })) }, null,
    { command: 'host_run_status', projectRoot: root }), 'B-aggregate', 'aggregate retains immutable owner admission');
  let snapshot;
  await assert.doesNotReject(async () => { snapshot = await handlers.host_run_status({
    targets: runs.map(run => ({ runId: run.runId })), json: true });
  }, 'U02 aggregate wait must accept durable run targets');
  const cursors = result => result.runs.map(({ run }) => ({ runId: run.runId, afterGeneration: run.generation }));
  const quiet = await handlers.host_run_status({ targets: cursors(snapshot), waitMs: 150, json: true });
  assert.equal(quiet.changed, false, 'heartbeats across all runs do not wake the owner');
  const timer = setTimeout(() => outputs[1](), 80);
  const progress = await handlers.host_run_status({ targets: cursors(quiet), waitMs: 500, json: true });
  clearTimeout(timer);
  assert.deepEqual(progress.runs.filter(item => item.changed).map(item => item.run.runId), [runs[1].runId]);
  releases[0](); await workers[0];
  const terminal = await handlers.host_run_status({ targets: cursors(progress), waitMs: 500, json: true });
  assert.ok(terminal.runs[0].receipt, 'aggregate terminal retains signed authoritative receipt');
  const resumed = await handlers.host_run_status({ targets: cursors(terminal), waitMs: 150, json: true });
  assert.equal(resumed.changed, false, 'an acknowledged terminal does not repeatedly wake a resumed owner');
  await assert.rejects(() => handlers.host_run_status({ targets: [cursors(resumed)[0], cursors(resumed)[0]], json: true }), /duplicate/i);
  releases[1](); await workers[1];
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../packages/main/dist/cli.js', import.meta.url)),
    'host_run_status', JSON.stringify({ targets: cursors(resumed), json: true })], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(cli.status, 0, cli.stderr);
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.runs.length, 2, 'actual CLI schema accepts aggregate targets');
  assert.ok(cliResult.runs.every(item => item.receipt));
  const foreign = await submitManagedHostRun({ root, cwd: root, host: 'codex', storyId: 'B-other',
    phase: 'REVIEW', agentType: 'lattice-review-quality', promptText: 'Different owner',
    deadlineMs: 10000, projectRootHash: 'sha256:test-root' }, {
    launchWorker: request => {
      workers.push(runManagedHostRunWorker(request, { env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
        runner: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' }) }));
      return { pid: process.pid };
    }, claimTimeoutMs: 1000, claimPollMs: 5,
  });
  await workers.at(-1);
  assert.throws(() => storyIdFromArgs({ targets: [{ runId: runs[0].runId }, { runId: foreign.runId }] }, null,
    { command: 'host_run_status', projectRoot: root }), /share one immutable Story/);
  console.log('PASS U02 aggregate semantic wait and terminal resume');
} finally {
  releases.forEach(release => release());
  await Promise.allSettled(workers);
  rmSync(root, { recursive: true, force: true });
}

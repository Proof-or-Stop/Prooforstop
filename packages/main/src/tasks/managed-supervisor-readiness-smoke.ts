#!/usr/bin/env node
/**
 * Detection A/B pilot (C0-r1, D2-r1, docs lane): under host load (2-CPU
 * container, 4 managed lanes launched back to back, other containers) a lane
 * launch failed with `worker_launch_failed: managed supervisor readiness
 * timeout`. The recovery supervisor must report ready within
 * MANAGED_SUPERVISOR_RUNTIME_POLICY.readyTimeoutMs (was 5 s) after loading the
 * CLI module graph without a compile cache and taking the run's terminal
 * authority lock (deadline 30 s). The failure was published replacementSafe
 * false like an ambiguous post-spawn launcher error, so `next` handed the
 * relaunch to the owner as an agent step.
 *
 * Contract:
 *  - the readiness window is at least the terminal-lock deadline it may wait on;
 *  - a supervisor that never became ready (worker never spawned, supervisor
 *    reaped) is a replacement-safe failure with a reaped cleanup; any other
 *    launcher error stays replacement-unsafe (managed-host-run-smoke);
 *  - such a failure is auto-replaceable (next relaunches it as a framework
 *    step, bounded), a provider failure is not.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFixtureMachineEnvironment } from './helpers/fixture-machine-environment.js';

const SELF = fileURLToPath(import.meta.url);

function submitArgs(caseRoot: string, promptText: string) {
  return {
    root: caseRoot, cwd: caseRoot, host: 'codex' as const, storyId: 'B-managed', phase: 'REVIEW',
    agentType: 'lattice-review-quality', reviewRunId: 'B-managed:RR-001', lane: 'lattice-review-quality',
    promptText, deadlineMs: 2_000, projectRootHash: 'sha256:test-root', profile: 'managed_reviewer',
    reviewBinding: { headHash: 'head-managed', materialHash: 'material-managed', storyFilesHash: 'story-managed',
      promptHash: 'prompt-managed', envelopeId: null,
      managedPromptDigest: `sha256:${createHash('sha256').update(promptText, 'utf8').digest('hex')}` },
  };
}

async function child(): Promise<void> {
  // Dynamic: the RED build has no typed readiness error yet.
  const core = await import('../core/managed-host-run.js') as Record<string, any>;
  const facts = await import('../core/runtime-fact-registry.js') as Record<string, any>;
  assert.ok(facts.MANAGED_SUPERVISOR_RUNTIME_POLICY.readyTimeoutMs >= 30_000,
    `supervisor readiness window ${facts.MANAGED_SUPERVISOR_RUNTIME_POLICY.readyTimeoutMs} ms is shorter than the 30 s terminal-lock deadline the supervisor may wait on before ready`);
  assert.equal(typeof core.ManagedSupervisorNotReadyError, 'function', 'a supervisor readiness failure has its own typed launcher error');
  assert.equal(typeof core.isAutoReplaceableManagedLaunchFailure, 'function', 'next can tell a supervisor-not-ready failure from other failures');
  const root = mkdtempSync(join(tmpdir(), 'supervisor-readiness-'));
  try {
    const notReady = await core.submitManagedHostRun(submitArgs(join(root, 'not-ready'), 'supervisor never ready'), {
      launchWorker: async () => { throw new core.ManagedSupervisorNotReadyError('managed supervisor readiness timeout', { directKillSent: true, reaped: true }); },
    });
    assert.equal(notReady.state, 'failed');
    assert.equal(notReady.terminal?.reason, 'worker_launch_failed:managed supervisor readiness timeout', 'the terminal names the cause (never a silent pass)');
    assert.equal(notReady.replacementSafe, true, 'no worker was spawned and the supervisor was reaped: replacement-safe');
    assert.deepEqual(notReady.terminal?.processCleanup, { termSent: false, killSent: true, reaped: true, residualProcessGroup: false });
    assert.equal(core.isAutoReplaceableManagedLaunchFailure({ state: notReady.state, replacementSafe: notReady.replacementSafe, terminalReason: notReady.terminal?.reason }), true);

    const unreaped = await core.submitManagedHostRun(submitArgs(join(root, 'unreaped'), 'supervisor not reaped'), {
      launchWorker: async () => { throw new core.ManagedSupervisorNotReadyError('managed supervisor readiness timeout', { directKillSent: true, reaped: false }); },
    });
    assert.equal(unreaped.replacementSafe, false, 'a supervisor that could not be reaped stays replacement-unsafe');

    const other = await core.submitManagedHostRun(submitArgs(join(root, 'other'), 'other launcher error'), {
      launchWorker: async () => { throw new Error('post-spawn fixture failure'); },
    });
    assert.equal(other.replacementSafe, false, 'any other launcher error stays replacement-unsafe');
    assert.equal(core.isAutoReplaceableManagedLaunchFailure({ state: 'failed', replacementSafe: true, terminalReason: 'provider_exit_nonzero' }), false,
      'a replacement-safe provider failure is still the agent\'s call');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log('managed-supervisor-readiness-smoke: PASS');
}

if (process.env.MANAGED_SUPERVISOR_READINESS_SMOKE_CHILD === '1') await child();
else {
  const machine = createFixtureMachineEnvironment();
  try {
    const run = spawnSync(process.execPath, [SELF], { env: { ...machine.env, MANAGED_SUPERVISOR_READINESS_SMOKE_CHILD: '1' }, stdio: 'inherit' });
    process.exitCode = run.status ?? 1;
  } finally { machine.cleanup(); }
}

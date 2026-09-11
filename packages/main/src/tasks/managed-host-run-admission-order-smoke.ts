#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  managedHostRunDirectory,
  runManagedHostRunWorker,
  submitManagedHostRun,
  type ManagedHostRunWorkerLauncher,
} from '../core/managed-host-run.js';
import { providerProcessSlotsDir } from '../core/provider-process-registry.js';
import type { HostRunProcessIdentity, HostRunRunner } from '../core/host-run.js';

interface SnapshotProbe {
  providerLaunchState: string;
  providerIdentity: HostRunProcessIdentity | null;
  generation: number;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'managed-host-run-admission-order-'));
  try {
    const providerIdentity: HostRunProcessIdentity = {
      pid: 730_001,
      pgid: 730_001,
      spawnedAt: '2026-08-24T00:00:00.000Z',
      startFingerprint: 'injected-provider-start',
      processGroupIsolated: true,
    };
    let observedSnapshot: SnapshotProbe | null = null;
    let observedSlot: Record<string, unknown> | null = null;
    let observedEventTypes: string[] = [];
    let worker: Promise<unknown> | null = null;
    const runner: HostRunRunner = plan => {
      plan.onSpawn?.(providerIdentity);
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        terminalReason: 'completed',
        replacementSafe: true,
        residualProcessGroup: false,
        processCleanup: { termSent: false, killSent: false, reaped: true, residualProcessGroup: false },
      };
    };
    const launchWorker: ManagedHostRunWorkerLauncher = async request => {
      worker = runManagedHostRunWorker(request, {
        runner,
        env: { PROOF_OR_STOP_USAGE_LEDGER: '0', LATTICE_PROVIDER_MAX_CONCURRENT: '1' },
        afterProviderIdentityPersisted: identity => {
          assert.deepEqual(identity, providerIdentity);
          observedSnapshot = JSON.parse(readFileSync(
            join(managedHostRunDirectory(root, request.runId), 'snapshot.json'),
            'utf8',
          )) as SnapshotProbe;
          observedEventTypes = readFileSync(
            join(managedHostRunDirectory(root, request.runId), 'events.jsonl'),
            'utf8',
          ).trim().split('\n').map(line => (JSON.parse(line) as { type: string }).type);
          const slots = readdirSync(providerProcessSlotsDir(root)).filter(name => name.endsWith('.json'));
          assert.deepEqual(slots, ['slot-0.json'], 'the worker admission slot exists at durable identity publication');
          observedSlot = JSON.parse(readFileSync(join(providerProcessSlotsDir(root), slots[0]!), 'utf8')) as Record<string, unknown>;
        },
      });
      return { pid: process.pid };
    };

    const submitted = await submitManagedHostRun({
      root,
      cwd: root,
      host: 'codex',
      storyId: null,
      phase: 'REVIEW',
      agentType: 'lattice-review-quality',
      promptText: 'injected admission ordering probe',
      deadlineMs: 10_000,
      projectRootHash: 'sha256:injected-admission-order',
    }, { launchWorker, claimTimeoutMs: 1_000, claimPollMs: 5 });
    await worker;

    const durableSnapshot = observedSnapshot as SnapshotProbe | null;
    const transferredSlot = observedSlot as Record<string, unknown> | null;
    assert.equal(durableSnapshot?.providerLaunchState, 'spawned',
      'provider identity is durably published after provider-owned admission is established');
    assert.deepEqual(durableSnapshot?.providerIdentity, providerIdentity,
      'the durable snapshot contains the exact PID/PGID/start-fingerprint reconciliation identity');
    assert.equal(durableSnapshot?.generation, 3,
      'provider publication advances the durable snapshot generation after submission and worker claim');
    assert.deepEqual(observedEventTypes, ['submitted', 'worker_claimed', 'provider_spawned'],
      'provider-spawn journal evidence is durable before the identity hand-off may continue');
    assert.equal(transferredSlot?.providerPid, providerIdentity.pid,
      'the registry slot is provider-owned when durable identity publication is observed');
    assert.equal(transferredSlot?.providerPgid, providerIdentity.pgid,
      'the isolated provider PGID is retained across a supervisor hand-off window');
    assert.equal(transferredSlot?.providerProcessGroupIsolated, true,
      'provider-group ownership is explicit before the worker can continue');
    assert.equal(submitted.runId.length > 0, true);

    console.log('managed-host-run-admission-order-smoke PASS');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

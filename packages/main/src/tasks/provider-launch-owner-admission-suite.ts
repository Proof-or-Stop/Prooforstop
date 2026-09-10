#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { childSmokeEnv } from './reviewer-dispatch-authority.js';

const tasksDir = dirname(fileURLToPath(import.meta.url));
const suitePath = fileURLToPath(import.meta.url);

export const PROVIDER_LAUNCH_OWNER_ADMISSION_CHILD_FLAG = '--provider-launch-owner-admission-child';

const ownerSmokes = [
  { child: 'provider-process-registry-smoke.js', owners: ['core/host-run.ts'] },
  { child: 'managed-host-run-smoke.js', owners: ['core/managed-host-run.ts'] },
  { child: 'host-run-usage-smoke.js', owners: ['core/codex-review-leaf.ts', 'core/autopilot-executor.ts'] },
  { child: 'dispatch-run-smoke.js', owners: ['core/proof-or-stop-dispatch.ts'] },
  { child: 'provider-claude-smoke.js', owners: ['core/planned-steps-executor.ts'] },
] as const;

function assertAdmissionChildrenDropReviewerDispatchAuthority(): void {
  const env = childSmokeEnv({
    ...process.env,
    PROOF_OR_STOP_AGENT: 'lattice-review-test-coverage',
    PROOF_OR_STOP_ACTIVITY_ROLE: 'lattice-review-test-coverage',
  });
  const observed = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify({agent: process.env.PROOF_OR_STOP_AGENT ?? null, role: process.env.PROOF_OR_STOP_ACTIVITY_ROLE ?? null}))'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(observed) as { agent: string | null; role: string | null };
  if (parsed.agent !== null || parsed.role !== null) {
    throw new Error(`admission child process inherited reviewer dispatch authority: ${observed}`);
  }
}

export function runProviderLaunchOwnerAdmissionSuite(options: {
  /** The direct registry verifier has already executed its own host-run proof. */
  skipProcessRegistrySelf?: boolean;
} = {}): void {
  assertAdmissionChildrenDropReviewerDispatchAuthority();
  const env = childSmokeEnv(process.env);
  for (const proof of ownerSmokes) {
    if (options.skipProcessRegistrySelf && proof.child === 'provider-process-registry-smoke.js') continue;
    const args = [join(tasksDir, proof.child)];
    if (proof.child === 'provider-process-registry-smoke.js') {
      args.push(PROVIDER_LAUNCH_OWNER_ADMISSION_CHILD_FLAG);
    }
    try {
      execFileSync(process.execPath, args, {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.log(`${proof.child} admission PASS (${proof.owners.join(', ')})`);
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error
        ? String(error.status)
        : 'unknown';
      const stdout = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout ?? '') : '';
      const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr ?? '') : '';
      const tail = `${stdout}\n${stderr}`.slice(-4_000);
      throw new Error(
        `provider launch-owner admission proof failed: ${proof.child} for ${proof.owners.join(', ')} (exit ${status})\n${tail}`,
        { cause: error },
      );
    }
  }
  console.log('provider-launch-owner-admission-suite PASS');
}

if (process.argv[1] && resolve(process.argv[1]) === suitePath) {
  runProviderLaunchOwnerAdmissionSuite();
}

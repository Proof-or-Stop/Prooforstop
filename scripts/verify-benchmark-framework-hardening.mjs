#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBuildBinding } from './full-suite-build-binding.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv.slice(2).some(arg => arg !== '--prebuilt')) throw new Error('Unknown benchmark hardening verifier option');
if (process.argv.includes('--prebuilt')) {
  // The canonical runner already builds before scheduling. Refuse drift here;
  // rebuilding under its shared repository-read claim would mutate peer inputs.
  verifyBuildBinding(root);
} else {
  const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) {
    process.stdout.write(build.stdout || '');
    process.stderr.write(build.stderr || '');
    process.exit(build.status ?? 1);
  }
}
const smoke = spawnSync(process.execPath, ['packages/main/dist/tasks/benchmark-framework-hardening-smoke.js'], { cwd: root, encoding: 'utf8' });
process.stdout.write(smoke.stdout || '');
process.stderr.write(smoke.stderr || '');
if (smoke.status !== 0) process.exit(smoke.status ?? 1);
// Keep the recovery operation budget in the existing full-suite member.
const recovery = spawnSync(process.execPath, ['scripts/verify-done-recovery-scan.mjs'], { cwd: root, encoding: 'utf8' });
process.stdout.write(recovery.stdout || '');
process.stderr.write(recovery.stderr || '');
process.exit(recovery.status ?? 1);

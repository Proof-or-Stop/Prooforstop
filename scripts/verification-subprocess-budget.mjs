import { spawnSync as spawn } from 'node:child_process';
import { join } from 'node:path';

// The prerequisite owns a separate budget. A slow successful build cannot spend
// the subsequent proof body's allowance. Setup timeout is unavailable evidence,
// not an assertion RED. No automatic retry is started here.
export function prepareVerification(root, { buildTimeoutMs = 180000, bodyBudgetMs = 240000 } = {}) {
  for (const value of [buildTimeoutMs, bodyBudgetMs]) {
    if (!Number.isInteger(value) || value <= 0) throw new Error('Invalid verification budget: positive integer milliseconds required');
  }
  const result = spawn(process.execPath, [join(root, 'scripts/ensure-dist.mjs')], { cwd: root, encoding: 'utf8', timeout: buildTimeoutMs });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`SETUP_BUILD_TIMEOUT: ensure-dist exceeded ${buildTimeoutMs} ms. No proof assertions ran; complete the prerequisite separately, then retry.`);
  }
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`SETUP_BUILD_FAILED: ${result.error?.message ?? ''} ${result.stdout ?? ''} ${result.stderr ?? ''}`);
  }
  return verificationSpawner(bodyBudgetMs);
}

// One monotonic body budget covers child commands after setup. Individual
// timeouts are maxima, not additive allowances; callers reserve fixture IO time.
export function verificationSpawner(totalMs = 240000) {
  const deadline = performance.now() + totalMs;
  return (command, args, options = {}) => {
    const remaining = Math.floor(deadline - performance.now());
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('VERIFICATION_BUDGET_EXHAUSTED: no further subprocess was started');
    const timeout = Math.min(remaining, options.timeout > 0 ? options.timeout : remaining);
    const result = spawn(command, args, { ...options, timeout });
    if (result.error?.code === 'ETIMEDOUT') {
      throw new Error(`VERIFICATION_SUBPROCESS_TIMEOUT: ${command} exceeded ${timeout} ms within the shared ${totalMs} ms budget`);
    }
    return result;
  };
}

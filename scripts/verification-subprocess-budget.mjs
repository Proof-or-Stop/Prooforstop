import { spawnSync as spawn } from 'node:child_process';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { verifyBuildBinding, verifyUtilsBuildBinding } from './full-suite-build-binding.mjs';

// Evidence can be unavailable without a product assertion being false. Both
// outcomes remain non-PASS; retain child output so a caller can diagnose/retry.
export function verificationFailureMessage(label, error) {
  const detail = [error?.message ?? String(error), error?.stdout, error?.stderr]
    .filter(value => value !== undefined && value !== null).map(String).join('\n');
  const marker = '(?:SETUP_BUILD_TIMEOUT|SETUP_BUILD_FAILED|SETUP_BUILD_STALE|VERIFICATION_BUDGET_EXHAUSTED|VERIFICATION_SUBPROCESS_TIMEOUT)';
  const unavailable = error?.code === 'ETIMEDOUT'
    || new RegExp(`^(?:Error: )?${marker}:`, 'm').test(detail)
    || new RegExp(`"error"\\s*:\\s*"${marker}:`).test(detail);
  return `${unavailable ? 'PROOF_UNAVAILABLE' : 'PROOF_ASSERTION_FAILED'}: ${label}\n${detail}`;
}

// The prerequisite owns a separate budget. A slow successful build cannot spend
// the subsequent proof body's allowance. Setup timeout is unavailable evidence,
// not an assertion RED. No automatic retry is started here.
export function prepareVerification(root, { buildTimeoutMs = 180000, bodyBudgetMs = 240000, shareBuild = false } = {}) {
  for (const value of [buildTimeoutMs, bodyBudgetMs]) {
    if (!Number.isInteger(value) || value <= 0) throw new Error('Invalid verification budget: positive integer milliseconds required');
  }
  const canonicalRoot = realpathSync(root);
  const sharingKey = 'PROOF_OR_STOP_VERIFICATION_DIST_READY';
  const verifyCurrent = () => {
    try { verifyBuildBinding(root); verifyUtilsBuildBinding(root); }
    catch (error) { throw new Error(`SETUP_BUILD_STALE: shared prerequisite is no longer current: ${error.message}`); }
  };
  if (process.env[sharingKey] === canonicalRoot) {
    // The environment only requests reuse. Current source AND dist bindings
    // still have to verify; a forged/stale sentinel cannot approve old output.
    verifyCurrent();
    return verificationSpawner(bodyBudgetMs);
  }
  const result = spawn(process.execPath, [join(root, 'scripts/ensure-dist.mjs')], { cwd: root, encoding: 'utf8', timeout: buildTimeoutMs });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`SETUP_BUILD_TIMEOUT: ensure-dist exceeded ${buildTimeoutMs} ms. No proof assertions ran; complete the prerequisite separately, then retry.`);
  }
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`SETUP_BUILD_FAILED: ${result.error?.message ?? ''} ${result.stdout ?? ''} ${result.stderr ?? ''}`);
  }
  if (shareBuild) { verifyCurrent(); process.env[sharingKey] = canonicalRoot; }
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
      const error = new Error(`VERIFICATION_SUBPROCESS_TIMEOUT: ${command} exceeded ${timeout} ms within the shared ${totalMs} ms budget`);
      Object.assign(error, { code: result.error.code, signal: result.signal, status: result.status });
      // Retain bounded spawn buffers without duplicating them in an uncaught
      // Error inspection after the caller explicitly renders the diagnostics.
      Object.defineProperties(error, {
        stdout: { value: result.stdout, writable: true, configurable: true },
        stderr: { value: result.stderr, writable: true, configurable: true },
      });
      throw error;
    }
    return result;
  };
}

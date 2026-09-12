import { spawnSync as spawn } from 'node:child_process';

// One monotonic budget covers build AND all child commands. Individual timeouts
// are maxima, not additive allowances. Parent checks reserve 30s for fixture IO.
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

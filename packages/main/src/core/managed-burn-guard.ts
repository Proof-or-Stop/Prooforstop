/** Burn is a cost guard, never a substitute for verified convergence or process deadlines. */
import { StoryStore } from './store.js';
import { assessConvergenceProgressGate } from './convergence-progress-gate.js';
import { MANAGED_BURN_RUNTIME_POLICY } from './runtime-fact-registry.js';

export function managedBurnTokenLimit(env: NodeJS.ProcessEnv): number {
  const raw = env[MANAGED_BURN_RUNTIME_POLICY.tokenLimitEnvironment];
  if (raw === undefined) return MANAGED_BURN_RUNTIME_POLICY.defaultTokenLimit;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('managed burn token limit must be a positive safe integer');
  }
  return Number(raw);
}

export function assessManagedBurn(root: string, storyId: string | null, observedTokens: number, limit: number): {
  action: 'continue' | 'advisory' | 'stop'; reason: string;
} {
  if (!Number.isSafeInteger(observedTokens) || observedTokens < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
    return { action: 'advisory', reason: 'burn_usage_unavailable' };
  }
  if (observedTokens <= limit) return { action: 'continue', reason: 'burn_within_limit' };
  if (!storyId) return { action: 'advisory', reason: 'burn_progress_unavailable' };
  try {
    const progress = assessConvergenceProgressGate(new StoryStore(root), storyId);
    if (progress.code === 'effective_progress_stalled') {
      return { action: 'stop', reason: MANAGED_BURN_RUNTIME_POLICY.terminalReason };
    }
    return { action: 'advisory', reason: progress.blocked ? 'burn_progress_unavailable' : 'burn_without_verified_stagnation' };
  } catch {
    // Missing/corrupt progress is not a license to terminate a progressing reviewer.
    return { action: 'advisory', reason: 'burn_progress_unavailable' };
  }
}

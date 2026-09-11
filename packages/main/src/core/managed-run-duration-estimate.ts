import { MANAGED_DURATION_ESTIMATE_RUNTIME_POLICY } from './runtime-fact-registry.js';
/** Descriptive local history, never a deadline, progress signal or completion credential. */
export interface ManagedRunDurationSample { runId: string; durationMs: number; terminalAt: string }
export type ManagedRunDurationEstimate = {
  kind: 'unavailable'; source: 'bounded-local-completed-runs'; sampleCount: number;
  reason: 'insufficient-comparable-history' | 'legacy-run-without-estimate';
} | {
  kind: 'historical_estimate'; source: 'bounded-local-completed-runs'; sampleCount: number;
  medianDurationMs: number; p90DurationMs: number; estimatedTerminalAt: string;
  sampledAt: string; sampleRunIds: string[];
};

export const MANAGED_DURATION_ESTIMATE_POLICY = MANAGED_DURATION_ESTIMATE_RUNTIME_POLICY;

export function estimateManagedRunDuration(samples: ManagedRunDurationSample[], createdAt: string): ManagedRunDurationEstimate {
  const created = Date.parse(createdAt);
  const valid = samples.filter(sample => Number.isFinite(sample.durationMs) && sample.durationMs > 0 && sample.durationMs <= MANAGED_DURATION_ESTIMATE_POLICY.maxAgeMs
    && Number.isFinite(Date.parse(sample.terminalAt)) && Date.parse(sample.terminalAt) <= created
    && created - Date.parse(sample.terminalAt) <= MANAGED_DURATION_ESTIMATE_POLICY.maxAgeMs)
    .sort((a,b)=>Date.parse(b.terminalAt)-Date.parse(a.terminalAt) || a.runId.localeCompare(b.runId))
    .filter((sample,index,all)=>all.findIndex(other=>other.runId===sample.runId)===index)
    .slice(0,MANAGED_DURATION_ESTIMATE_POLICY.maxSamples);
  if (valid.length < MANAGED_DURATION_ESTIMATE_POLICY.minSamples) return {
    kind:'unavailable',source:'bounded-local-completed-runs',sampleCount:valid.length,
    reason:'insufficient-comparable-history',
  };
  const durations = valid.map(sample=>sample.durationMs).sort((a,b)=>a-b);
  const middle = Math.floor(durations.length/2);
  const median = durations.length%2 ? durations[middle]! : (durations[middle-1]!+durations[middle]!)/2;
  return {kind:'historical_estimate',source:'bounded-local-completed-runs',sampleCount:valid.length,
    medianDurationMs:median,p90DurationMs:durations[Math.ceil(durations.length*0.9)-1]!,
    estimatedTerminalAt:new Date(created+median).toISOString(),sampledAt:createdAt,
    sampleRunIds:valid.map(sample=>sample.runId)};
}

export function renderManagedRunDurationEstimate(estimate: ManagedRunDurationEstimate): string {
  return estimate.kind === 'unavailable' ? `eta=unavailable:${estimate.reason} historySamples=${estimate.sampleCount}`
    : `eta=historical_estimate:${estimate.estimatedTerminalAt} historySamples=${estimate.sampleCount} historicalP50Ms=${estimate.medianDurationMs} historicalP90Ms=${estimate.p90DurationMs}`;
}

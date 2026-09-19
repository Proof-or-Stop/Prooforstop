import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { alwaysWake, createMonitor } from './policy.mjs';

const [historyPath, outputPath] = process.argv.slice(2);
if (!historyPath || !outputPath) throw new Error('Usage: node compare.mjs HISTORY.json OUTPUT.json');
const bytes = readFileSync(historyPath);
const history = JSON.parse(bytes);
const rows = history.observations;
assert.ok(rows.length > 1);
function replay(factory, warm) {
  const monitor = factory();
  if (warm) monitor.observe(rows[0].facts);
  return rows.map(row => monitor.observe(row.facts).wake);
}
const baseline = () => ({ observe: alwaysWake });
const before = replay(baseline, false);
const cold = replay(createMonitor, false);
const warm = replay(createMonitor, true);
const count = results => results.filter(Boolean).length;
assert.equal(count(before), rows.length);
assert.equal(count(cold), 1, 'Selected historical projection must be constant');
assert.equal(count(warm), 0);
const threshold = 0.95;
assert.ok(1 - count(cold) / count(before) >= threshold, 'At least 95% fewer dispatch intents on this unchanged trace');

// Microbenchmark only: same in-memory trace, cold initialization for both arms.
// Excludes CLI polling, extraction, model latency, and output writes.
const repeats = 1000;
const samples = { before: [], after: [] };
let consumed = 0;
function measure(factory) {
  const start = performance.now();
  for (let i = 0; i < repeats; i++) consumed += count(replay(factory, false));
  return performance.now() - start;
}
measure(baseline); measure(createMonitor); // JIT warm-up excluded
for (let round = 0; round < 7; round++) {
  for (const key of round % 2 ? ['after', 'before'] : ['before', 'after']) {
    samples[key].push(measure(key === 'before' ? baseline : createMonitor));
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const linkedUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 };
rows.forEach((row, i) => {
  if (!cold[i]) for (const key of Object.keys(linkedUsage)) linkedUsage[key] += row.usage[key];
});
const result = {
  generated_at: new Date().toISOString(), candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version, platform: process.platform, arch: process.arch,
  history_sha256: createHash('sha256').update(bytes).digest('hex'),
  historical_observations: rows.length, excluded_turns: history.excluded.length,
  historical_usage: history.accepted_usage,
  policy_replay: { before_dispatch_intents: count(before), after_cold_dispatch_intents: count(cold),
    after_warm_dispatch_intents: count(warm), cold_reduction_percent: (1 - count(cold) / count(before)) * 100,
    minimum_reduction_percent: threshold * 100 },
  local_timing: { scope: 'Decision microbenchmark only, not end-to-end runtime', repeats, rounds: 7,
    observations_per_sample: rows.length * repeats, samples_ms: samples,
    median_ms: { before: median(samples.before), after: median(samples.after) }, consumed },
  provider_calls: { before: 0, after: 0 },
  newly_measured_provider_tokens: { before: 0, after: 0 },
  actual_live_token_savings: null,
  historical_tokens_attached_to_suppressed_turns: linkedUsage,
  limitations: [
    'Baseline reproduces periodic wake policy; this does not patch the Codex scheduler.',
    'Historical replay covers recorded scope, phases and revision, not complete execution or runtime observations.',
    'Dispatch intents are decisions, not actual delivered model calls.',
    'Historical tokens on suppressed turns are counterfactual opportunity, not measured token savings.',
    'Filter is in memory. Production adoption needs complete validated observations, durable delivery/ack and conflict handling.',
    'No formal Story evidence, review approval, integration or live automation change.'
  ],
};
writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ policy_replay: result.policy_replay, local_median_ms: result.local_timing.median_ms,
  actual_live_token_savings: result.actual_live_token_savings, historical_usage: result.historical_usage }));

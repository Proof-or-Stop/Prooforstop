import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createController as before } from './baseline.mjs';
import { createController as after } from './controller.mjs';
import { createMonitor } from '../benchmark-monitor-change-filter/policy.mjs';
import { options, event, request, receipt } from './fixtures.mjs';

const [historyPath, outputPath] = process.argv.slice(2);
if (!historyPath || !outputPath) throw new Error('Usage: node compare.mjs HISTORY.json OUTPUT.json');
const bytes = readFileSync(historyPath); const history = JSON.parse(bytes);
const results = {};
async function profile(factory) {
  const c = factory(options()); c.observe(event());
  let repeatedWakes = 0;
  for (let i = 1; i <= 1000; i++) repeatedWakes += Number(c.observe(event({
    observedAt: i, execution: { id: 'run-A', status: 'running', progress: i },
  })).wake);
  let relevantWakes = 0;
  for (const changed of [event({ policy: 'policy-B' }), event({ candidate: 'commit-B' }),
    event({ blocker: null }), event({ execution: { id: 'run-A', status: 'completed' } }),
    event({ execution: { id: 'run-B', status: 'failed' } })]) relevantWakes += Number(c.observe(changed).wake);

  const budgets = factory(options()); let launches = 0; let repairLaunches = 0;
  let release; const wait = new Promise(r => { release = r; });
  const pending = ['repair', 'repair', 'repair', 'product', 'product', 'product'].map((part, i) =>
    budgets.run(request(String(i), part), async () => {
      launches++; repairLaunches += Number(part === 'repair'); await wait; return receipt(`r-${i}`);
    }));
  release(); await Promise.all(pending);

  const unknown = factory(options()); let unknownLaunches = 0;
  for (let i = 0; i < 2; i++) await unknown.run(request(String(i)), async () => {
    unknownLaunches++; return { responseId: `unknown-${i}`, usage: null };
  });

  const state = { task: 'benchmark', phase: 'REVIEW', blocker: 'approval pending',
    decision: 'wait for binding change', logRefs: ['local://run-A'] };
  const contexts = factory(options());
  return { unchangedBlockerDispatchIntents: repeatedWakes, relevantChangesDelivered: relevantWakes,
    launchesAgainstTotalBudget4: launches, repairLaunchesAgainstBudget2: repairLaunches,
    launchesWhenFirstUsageUnknown: unknownLaunches,
    contextBytes: { noHistory: Buffer.byteLength(contexts.context(state, [])),
      tenThousandHistoryEntries: Buffer.byteLength(contexts.context(state, Array(10000).fill('x'.repeat(128)))) } };
}
results.before = await profile(before); results.after = await profile(after);
assert.equal(results.before.unchangedBlockerDispatchIntents, 1000);
assert.equal(results.after.unchangedBlockerDispatchIntents, 0);
assert.equal(results.after.relevantChangesDelivered, 5);
assert.equal(results.after.launchesAgainstTotalBudget4, 4);
assert.equal(results.after.repairLaunchesAgainstBudget2, 2);
assert.equal(results.after.launchesWhenFirstUsageUnknown, 1);
assert.equal(results.after.contextBytes.noHistory, results.after.contextBytes.tenThousandHistoryEntries);

// Actual local child execution measured in alternating order. Each request waits
// for the child's exit event; no sleep/poll loop asks a model whether it finished.
async function processSample(factory) {
  const c = factory(options()); let processes = 0;
  const start = performance.now();
  for (let i = 0; i < 10; i++) await c.run(request('same-local-execution'), () => new Promise((resolve, reject) => {
    processes++;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 15)'], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(receipt(`child-${processes}`)) : reject(new Error(`child exited ${code}`)));
  }));
  return { elapsedMs: performance.now() - start, childProcesses: processes };
}
const samples = { before: [], after: [] };
for (let round = 0; round < 3; round++) for (const arm of round % 2 ? ['after', 'before'] : ['before', 'after']) {
  const value = await processSample(arm === 'before' ? before : after);
  assert.equal(value.childProcesses, arm === 'before' ? 10 : 1);
  samples[arm].push(value);
}
const median = rows => rows.map(r => r.elapsedMs).sort((a, b) => a - b)[1];

// The recorded historical projection lacks a complete execution observation.
// Reuse the already delivered filter for this separate historical experiment;
// do not manufacture verified observations for the new controller.
const monitor = createMonitor();
const coldWakes = history.observations.reduce((n, row) => n + Number(monitor.observe(row.facts).wake), 0);
assert.equal(coldWakes, 1);
const warm = createMonitor(); warm.observe(history.observations[0].facts);
const warmWakes = history.observations.reduce((n, row) => n + Number(warm.observe(row.facts).wake), 0);
assert.equal(warmWakes, 0);

const output = {
  generatedAt: new Date().toISOString(), candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version, platform: process.platform, arch: process.arch,
  comparison: results,
  localProcessExperiment: { requestsPerSample: 10, rounds: 3, samples,
    medianMs: { before: median(samples.before), after: median(samples.after) },
    scope: 'Sequential repeated requests to a 15ms local child, including Node startup; not model latency' },
  historicalReplay: { historySha256: createHash('sha256').update(bytes).digest('hex'),
    sourcePrefixSha256: history.source_prefix_sha256, originalTurns: history.original_turns,
    includedTurns: history.observations.length, excludedTurns: history.excluded,
    originalUsage: history.original_usage, includedUsage: history.accepted_usage,
    periodicDispatchIntents: history.observations.length, filteredColdDispatchIntents: coldWakes,
    filteredWarmDispatchIntents: warmWakes,
    scope: 'Existing 0.3.425 projection filter; counterfactual replay, not live token savings' },
  realProviderCallsByExperiment: 0, actualLiveTokenSavings: null,
  implementationAgentTokenUsage: null,
  limitations: [
    'Lab prototype only: no live scheduler, Story lifecycle, approval or production provider boundary was changed.',
    'Only observation baseline uses existing filter code; uncontrolled dispatch/context are explicit synthetic comparison fixtures.',
    'Reservations are atomic within one JavaScript controller, not across processes or restarts.',
    'Unknown usage holds its ceiling and stops new dispatch; external provider overruns are recorded, not retroactively prevented.',
    'Production deployment still requires durable reservations, dispatch acknowledgement, complete witness binding and provider limits.',
    'Historical extraction excluded one turn without a fresh completed observation. No missing observation was guessed.',
    'Token receipts in executable fixtures are synthetic. Context is measured in bytes, not estimated tokens.',
    'Zero experiment provider calls excludes the assistant work implementing this Lab; its token cost is unknown here.'
  ]
};
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ comparison: results, localProcessMedianMs: output.localProcessExperiment.medianMs,
  historicalReplay: { included: history.observations.length, before: history.observations.length, cold: coldWakes, warm: warmWakes },
  actualLiveTokenSavings: null }));

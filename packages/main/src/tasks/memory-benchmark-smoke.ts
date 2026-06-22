#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';
import { getCommandLifecyclePolicy } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS, resetConfigCache } from '../core/config.js';
import {
  MEMORY_BENCHMARK_BASELINE_CANDIDATE_COUNT,
  MEMORY_BENCHMARK_CONSTANTS,
  compareMemoryBenchmarks,
  renderMemoryBenchmarkComparisonText,
  renderMemoryBenchmarkRunText,
  runMemoryBenchmark,
} from '../core/memory-benchmark.js';
import type { MemoryBenchmarkOverride } from '../core/memory-benchmark.js';
import { getProcessFactLevelEntry } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMemoryBenchmarkHandlers } from '../handlers/memory-benchmark.js';
import { createMainRegistry } from '../registry.js';

function errorText(error: unknown): string {
  const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return [record.stdout, record.stderr, record.message]
    .filter((part) => part !== undefined)
    .map((part) => String(part))
    .join('\n');
}

function assertUnsupportedFixedTierCount(action: () => unknown, label: 'candidateCount' | 'candidateCounts'): void {
  assert.throws(
    action,
    (error) => {
      const text = errorText(error);
      assert.match(text, new RegExp(`unsupported ${label}=50000`));
      assert.match(text, /supported fixed-tier candidate counts are 10000, 100000, 1000000/);
      assert.doesNotMatch(text, /\bT3\b/);
      return true;
    },
  );
}

function assertMetricContractFail(overrides: MemoryBenchmarkOverride, label: string): void {
  const result = runMemoryBenchmark({
    tier: 'T1',
    baselineQualityScore: 90,
    overrides,
  });
  assert.equal(result.verdict, 'FAIL', label);
  assert.equal(result.thresholdPassed, false, label);
  assert.equal(result.hardChecks.authorityLeakCount, 0, label);
  assert.equal(result.hardChecks.scopeLeakCount, 0, label);
  assert.equal(result.hardChecks.staleTruthHitCount, 0, label);
  assert.equal(result.hardChecks.evidenceLinkageRateLifecycleGate, 1, label);
  assert.equal(
    result.scores.memoryScore !== null && result.threshold !== null && result.scores.memoryScore >= result.threshold,
    true,
    `${label} keeps MemoryScore above the tier threshold`,
  );
}

const singleRun = runMemoryBenchmark({ tier: 'T1' });
const singleRunRepeat = runMemoryBenchmark({ tier: 'T1' });

assert.equal(MEMORY_BENCHMARK_CONSTANTS.schemaVersion, 'lattice.memory_benchmark.v1');
assert.deepEqual(
  MEMORY_BENCHMARK_CONSTANTS.scoreableLayers,
  ['raw_event_memory', 'lifecycle_state_memory', 'checklist_evidence_memory', 'summary_memory'],
);
assert.deepEqual(
  MEMORY_BENCHMARK_CONSTANTS.boundaryOnlyLayers,
  ['advisory_memory', 'host_transcript_memory'],
);

assert.equal(singleRun.verdict, 'PASS');
assert.equal(singleRun.scores.scaleStabilityScore, null);
assert.equal(singleRun.scores.memoryScore, null);
assert.equal(singleRun.thresholdPassed, null);
assert.equal(singleRun.scores.exactRecallAt1, 1);
assert.equal(singleRun.scores.recallAt10, 1);
assert.equal(singleRun.scores.mrrAt10, 1);
assert.equal(singleRun.scores.precisionAt10, 1);
assert.equal(singleRun.scores.qualityScore, 90);
assert.equal(singleRun.hardChecks.authorityLeakCount, 0);
assert.equal(singleRun.hardChecks.scopeLeakCount, 0);
assert.equal(singleRun.hardChecks.staleTruthHitCount, 0);
assert.equal(singleRun.hardChecks.evidenceLinkageRateLifecycleGate, 1);
assert.equal(singleRun.deterministicSignature, singleRunRepeat.deterministicSignature);
assert.deepEqual(singleRun.resources, singleRunRepeat.resources);
assert.match(renderMemoryBenchmarkRunText(singleRun), /Memory Benchmark T1/);
assert.match(renderMemoryBenchmarkRunText(singleRun), /scaleStabilityScore=n\/a/);

const comparison = compareMemoryBenchmarks({ candidateCounts: '10000,100000,1000000' });
assert.equal(comparison.baselineCandidateCount, MEMORY_BENCHMARK_BASELINE_CANDIDATE_COUNT);
assert.equal(comparison.comparison.baselineQualityScore, singleRun.scores.qualityScore);
assert.equal(comparison.runs.length, 3);
assert.equal(comparison.runs.every((run) => run.scores.scaleStabilityScore !== null), true);
assert.equal(comparison.runs.every((run) => run.scores.memoryScore !== null), true);
assert.equal(comparison.runs.every((run) => run.scores.memoryScore === 100), true);
assert.equal(comparison.runs.every((run) => run.scores.exactRecallAt1 === 1), true);
assert.equal(comparison.runs.every((run) => run.verdict === 'PASS'), true);
const comparisonText = renderMemoryBenchmarkComparisonText(comparison);
assert.match(comparisonText, /baselineQualityScore:/);
assert.match(comparisonText, /exactRecall@1=1\.000/);
assert.match(comparisonText, /recall@10=1\.000/);
assert.match(comparisonText, /MRR@10=1\.000/);
assert.match(comparisonText, /precision@10=1\.000/);
assert.match(comparisonText, /hardFails=0/);

const authorityHardFail = runMemoryBenchmark({
  tier: 'T1',
  baselineQualityScore: 90,
  overrides: { authorityLeakCount: 1 },
});
assert.equal(authorityHardFail.verdict, 'HARD_FAIL');
assert.equal(authorityHardFail.scores.memoryScore, 100);
assert.equal(authorityHardFail.thresholdPassed, false);

const boundaryLeak = runMemoryBenchmark({
  tier: 'T1',
  baselineQualityScore: 90,
  overrides: { forceBoundaryLayerIntoRetrieval: true },
});
assert.equal(boundaryLeak.verdict, 'HARD_FAIL');
assert.equal(boundaryLeak.hardChecks.authorityLeakCount, 1);
assert.equal(boundaryLeak.hardChecks.scopeLeakCount, 1);
assert.deepEqual(boundaryLeak.routing.excludedFromRetrievalLayers, ['advisory_memory', 'host_transcript_memory']);

const staleTruthHit = runMemoryBenchmark({
  tier: 'T1',
  baselineQualityScore: 90,
  overrides: { staleTruthHitCount: 1 },
});
assert.equal(staleTruthHit.verdict, 'HARD_FAIL');

const lifecycleGateEvidenceLinkageHardFail = runMemoryBenchmark({
  tier: 'T1',
  baselineQualityScore: 90,
  overrides: { lifecycleGateEvidenceLinkageRate: 0.999 },
});
assert.equal(lifecycleGateEvidenceLinkageHardFail.hardChecks.evidenceLinkageRateLifecycleGate < 1, true);
assert.equal(lifecycleGateEvidenceLinkageHardFail.verdict, 'HARD_FAIL');
assert.equal(lifecycleGateEvidenceLinkageHardFail.thresholdPassed, false);
assert.equal(lifecycleGateEvidenceLinkageHardFail.scores.memoryScore, 100);

assertMetricContractFail({ exactRecallAt1: 0.9 }, 'exactRecallAt1 below 1.0 fails despite high MemoryScore');
assertMetricContractFail({ recallAt10: 0.89 }, 'recallAt10 below 0.90 fails despite high MemoryScore');
assertMetricContractFail({ mrrAt10: 0.74 }, 'mrrAt10 below 0.75 fails despite high MemoryScore');
assertMetricContractFail({ precisionAt10: 0.69 }, 'precisionAt10 below 0.70 fails despite high MemoryScore');

const scoreFail = runMemoryBenchmark({
  tier: 'T1',
  baselineQualityScore: 90,
  overrides: {
    exactRecallAt1: 0.1,
    recallAt10: 0.1,
    mrrAt10: 0.1,
    precisionAt10: 0.1,
    exactAnswerHit: 0.1,
    evidenceLinkageRate: 0.1,
    layerRoutingAccuracy: 0.1,
  },
});
assert.equal(scoreFail.verdict, 'FAIL');
assert.equal(scoreFail.hardChecks.authorityLeakCount, 0);

assert.throws(
  () => runMemoryBenchmark({ tier: 'T2', candidateCount: 10000 }),
  /tier T2 requires candidateCount=100000, got 10000/,
);
assertUnsupportedFixedTierCount(() => runMemoryBenchmark({ candidateCount: 50000 }), 'candidateCount');
assertUnsupportedFixedTierCount(() => compareMemoryBenchmarks({ candidateCounts: '50000' }), 'candidateCounts');

{
  const handlers = createMemoryBenchmarkHandlers({} as HandlerContext);
  const compareJson = handlers.memory_benchmark_compare({ candidateCounts: '10000,100000', format: 'json' }) as typeof comparison;
  assert.deepEqual(compareJson.candidateCounts, [10000, 100000]);
  assert.throws(
    () => handlers.memory_benchmark_run({ tier: 'T3', candidateCount: '100000', format: 'json' }),
    /tier T3 requires candidateCount=1000000, got 100000/,
  );
  assertUnsupportedFixedTierCount(
    () => handlers.memory_benchmark_compare({ candidateCounts: '50000', format: 'json' }),
    'candidateCounts',
  );
}

assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'memory_benchmark_run'));
assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'memory_benchmark_compare'));
for (const command of ['memory_benchmark_run', 'memory_benchmark_compare']) {
  const policy = getCommandLifecyclePolicy(command);
  assert.equal(policy?.ownershipClass, 'readOnly', `${command} is read-only`);
  assert.equal(policy?.allowedPhases, 'all', `${command} is allowed in all phases`);
  assert.equal(policy?.gateEvidence, undefined, `${command} is not gate evidence`);
  assert.equal(policy?.destructiveRisk, 'none', `${command} is non-destructive`);
  assert.equal(getProcessFactLevelEntry(command)?.level, 'L0', `${command} process fact level is L0`);
}
assert.ok(DEFAULT_PHASE_TOOLS['*']?.includes('memory_benchmark_*'), 'phase tools allow memory benchmark read-only commands');

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-memory-benchmark-registry-'));
  try {
    writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
    resetConfigCache();
    const store = new StoryStore(root);
    const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
    const registry = createMainRegistry(ctx);
    assert.equal(registry.has('memory_benchmark_run'), true);
    assert.equal(registry.has('memory_benchmark_compare'), true);
    const run = registry.get('memory_benchmark_run')!({ tier: 'T1', format: 'json' }) as typeof singleRun;
    assert.equal(run.scores.memoryScore, null);
    const compare = registry.get('memory_benchmark_compare')!({ candidateCounts: '10000,100000', format: 'json' }) as typeof comparison;
    assert.deepEqual(compare.candidateCounts, [10000, 100000]);
    assertUnsupportedFixedTierCount(
      () => registry.get('memory_benchmark_compare')!({ candidateCounts: '50000', format: 'json' }),
      'candidateCounts',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-memory-benchmark-cli-'));
  try {
    writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
    const here = dirname(fileURLToPath(import.meta.url));
    const cliPath = join(here, '..', 'cli.js');

    const runStdout = execFileSync(process.execPath, [cliPath, '--root', root, 'memory_benchmark_run', '--tier=T1', '--format=json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsedRun = JSON.parse(runStdout) as typeof singleRun;
    assert.equal(parsedRun.scores.memoryScore, null);
    assert.equal(parsedRun.note.includes('not Lattice lifecycle gate authority'), true);

    const compareStdout = execFileSync(process.execPath, [cliPath, '--root', root, 'memory_benchmark_compare', '--candidateCounts=10000,100000', '--format=json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsedCompare = JSON.parse(compareStdout) as typeof comparison;
    assert.deepEqual(parsedCompare.candidateCounts, [10000, 100000]);
    assert.equal(parsedCompare.runs.every((run) => run.scores.memoryScore !== null), true);
    assert.equal(parsedCompare.runs.every((run) => run.scores.exactRecallAt1 === 1), true);
    assertUnsupportedFixedTierCount(
      () => execFileSync(process.execPath, [cliPath, '--root', root, 'memory_benchmark_compare', '--candidateCounts=50000', '--format=json'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      'candidateCounts',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('✓ memory benchmark smoke passed');

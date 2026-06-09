#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';
import { resetConfigCache } from '../core/config.js';
import {
  MEMORY_BENCHMARK_BASELINE_CANDIDATE_COUNT,
  MEMORY_BENCHMARK_CONSTANTS,
  compareMemoryBenchmarks,
  renderMemoryBenchmarkComparisonText,
  renderMemoryBenchmarkRunText,
  runMemoryBenchmark,
} from '../core/memory-benchmark.js';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMemoryBenchmarkHandlers } from '../handlers/memory-benchmark.js';
import { createMainRegistry } from '../registry.js';

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
assert.equal(comparison.runs.every((run) => run.verdict === 'PASS'), true);
assert.match(renderMemoryBenchmarkComparisonText(comparison), /baselineQualityScore:/);

assert.throws(
  () => runMemoryBenchmark({ tier: 'T2', candidateCount: 10000 }),
  /tier T2 requires candidateCount=100000, got 10000/,
);

{
  const handlers = createMemoryBenchmarkHandlers({} as HandlerContext);
  const compareJson = handlers.memory_benchmark_compare({ candidateCounts: '10000,100000', format: 'json' }) as typeof comparison;
  assert.deepEqual(compareJson.candidateCounts, [10000, 100000]);
  assert.throws(
    () => handlers.memory_benchmark_run({ tier: 'T3', candidateCount: '100000', format: 'json' }),
    /tier T3 requires candidateCount=1000000, got 100000/,
  );
}

assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'memory_benchmark_run'));
assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'memory_benchmark_compare'));

{
  const root = mkdtempSync(join(tmpdir(), 'koala-memory-benchmark-registry-'));
  try {
    writeFileSync(join(root, 'koala.config.json'), JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'koala-memory-benchmark-cli-'));
  try {
    writeFileSync(join(root, 'koala.config.json'), JSON.stringify({ scanRoot: 'packages/main', rootDir: 'src' }));
    const here = dirname(fileURLToPath(import.meta.url));
    const cliPath = join(here, '..', 'cli.js');

    const runStdout = execFileSync(process.execPath, [cliPath, '--root', root, 'memory_benchmark_run', '--tier=T1', '--format=json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsedRun = JSON.parse(runStdout) as typeof singleRun;
    assert.equal(parsedRun.scores.memoryScore, null);
    assert.equal(parsedRun.note.includes('not Koala lifecycle gate authority'), true);

    const compareStdout = execFileSync(process.execPath, [cliPath, '--root', root, 'memory_benchmark_compare', '--candidateCounts=10000,100000', '--format=json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsedCompare = JSON.parse(compareStdout) as typeof comparison;
    assert.deepEqual(parsedCompare.candidateCounts, [10000, 100000]);
    assert.equal(parsedCompare.runs.every((run) => run.scores.memoryScore !== null), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('✓ memory benchmark smoke passed');

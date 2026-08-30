#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';
import { getCommandLifecyclePolicy } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS, resetConfigCache } from '../core/config.js';
import {
  MEMORY_BENCHMARK_REAL_DATA_NOTE,
  runMemoryBenchmarkRealData,
} from '../core/memory-benchmark-real-data.js';
import { getProcessFactLevelEntry } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMemoryBenchmarkHandlers } from '../handlers/memory-benchmark.js';
import { createMainRegistry } from '../registry.js';

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function writeJsonl(filePath: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8');
}

function lineCount(filePath: string): number {
  return readFileSync(filePath, 'utf-8').split('\n').filter((line) => line.trim()).length;
}

function seedRealLifecycleData(root: string, options: { storyDir?: string } = {}): string {
  const storyDirRel = options.storyDir ?? '.proof-or-stop/story/actives';
  writeJson(join(root, 'proof-or-stop.config.json'), {
    scanRoot: 'packages/main',
    rootDir: 'src',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: storyDirRel,
  });

  const activityPath = join(root, '.proof-or-stop', 'activity.jsonl');
  writeJsonl(activityPath, [
    {
      source: 'cli',
      entrypoint: 'cli',
      tool: 'story_advance',
      detail: 'story_advance',
      args: { storyId: 'B-real', phase: 'DEV' },
      startTime: '2026-06-09T00:00:00.000Z',
      endTime: '2026-06-09T00:00:01.000Z',
      status: 'ok',
      result: null,
      error: null,
      storyId: 'B-real',
      phase: 'INIT_CHECK',
    },
    {
      source: 'cli',
      entrypoint: 'cli',
      tool: 'checklist_update',
      detail: 'checklist_update',
      args: { storyId: 'B-real', itemId: 'CHK-001', status: 'done' },
      startTime: '2026-06-09T00:01:00.000Z',
      endTime: '2026-06-09T00:01:01.000Z',
      status: 'ok',
      result: null,
      error: null,
      storyId: 'B-real',
      phase: 'DEV',
    },
  ]);

  const storyDir = join(root, storyDirRel, 'B-real');
  writeJson(join(storyDir, 'index.json'), {
    storyId: 'B-real',
    name: 'real-data-baseline',
    title: 'Real lifecycle data baseline',
    description: 'Exports real lifecycle artifacts as benchmark corpus.',
    type: 'feature',
    phase: 'DONE',
    priority: 'high',
    createdAt: '2026-06-09T00:00:00.000Z',
    startedAt: '2026-06-09T00:00:00.000Z',
    endedAt: '2026-06-09T00:10:00.000Z',
    events: [
      { phase: 'INIT', action: 'create', timestamp: '2026-06-09T00:00:00.000Z', agent: 'main' },
      { phase: 'DONE', action: 'advance', timestamp: '2026-06-09T00:10:00.000Z', agent: 'main' },
    ],
  });
  writeJson(join(storyDir, 'checklist.json'), {
    items: [
      {
        id: 'CHK-001',
        title: 'User can export real lifecycle baseline',
        context: 'Use real JSONL/story artifacts only.',
        status: 'done',
        startTime: '2026-06-09T00:01:00.000Z',
        endTime: '2026-06-09T00:09:00.000Z',
        verificationIntent: {
          happy: [{ desc: 'CLI writes corpus/gold/query/result files', type: 'cli', priority: 'must' }],
          edge: [{ desc: 'Missing real data fails with reasons', type: 'cli', priority: 'must' }],
          adversarial: [{ desc: 'Dev-memory is excluded from scoring', type: 'cli', priority: 'must' }],
        },
        verificationEvidence: [
          {
            intentRef: 'CHK-001:happy:0',
            kind: 'cli',
            command: 'node bin/proofOrStop.js memory_benchmark_real_data --outputDir=.tmp/real',
            result: 'pass',
            note: 'Command produced real baseline files.',
          },
        ],
      },
    ],
    auditLog: [
      {
        timestamp: '2026-06-09T00:09:00.000Z',
        phase: 'DEV',
        itemId: 'CHK-001',
        action: 'update',
        from: 'in_progress',
        to: 'done',
        reason: 'Implemented real data export.',
      },
    ],
  });
  writeJson(join(storyDir, 'summary.json'), {
    storyId: 'B-real',
    changes: 'Added memory_benchmark_real_data export.',
    usage: 'Run memory_benchmark_real_data with optional outputDir.',
    expectedOutcome: 'User sees PASS and output paths.',
    actualTranscript: 'Real Memory Benchmark Data: PASS',
    outcomeDiff: 'Actual matches expected.',
    acceptanceVerdict: 'accepted',
    realMachineCoverage: { ran: [], skipped: [] },
    limitations: 'Artifact baseline only.',
    pitfalls: 'Dev-memory remains boundary-only.',
  });
  writeJsonl(join(storyDir, 'process-events.jsonl'), [
    { type: 'validation_evidence', timestamp: '2026-06-09T00:09:10.000Z', storyId: 'B-real', result: 'pass' },
  ]);
  writeJson(join(storyDir, 'review-passes.json'), {
    passes: [
      {
        lane: 'proof-or-stop-review-quality',
        reviewRunId: 'B-real:RR-001',
        storyId: 'B-real',
        note: 'Reviewer pass evidence uses the current plural artifact filename.',
        timestamp: '2026-06-09T00:09:20.000Z',
      },
    ],
  });
  writeJsonl(join(root, '.proof-or-stop', 'dev-memory', 'experience.jsonl'), [
    {
      id: 'devreal1',
      createdAt: '2026-06-09T00:05:00.000Z',
      sourceAgent: 'proof-or-stop-implementer',
      category: 'workflow',
      scope: 'project',
      summary: 'Keep real-data benchmark advisory boundaries explicit.',
      trigger: 'Benchmark design',
      lesson: 'Do not score dev-memory as lifecycle truth.',
      reusePrompt: 'Check authority boundary.',
      sourceStoryId: 'B-real',
      gateEvidence: false,
      authority: 'non_authoritative',
    },
  ]);
  return activityPath;
}

function assertTraceFields(row: { recordId?: unknown; layer?: unknown; sourcePath?: unknown; sourceHash?: unknown }, label: string): void {
  assert.equal(typeof row.recordId, 'string', `${label} has recordId`);
  assert.equal(typeof row.layer, 'string', `${label} has layer`);
  assert.equal(typeof row.sourcePath, 'string', `${label} has sourcePath`);
  assert.equal(typeof row.sourceHash, 'string', `${label} has sourceHash`);
}

function assertConfiguredStoryDirWorks(storyDir: string): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-memory-real-data-configured-'));
  try {
    seedRealLifecycleData(root, { storyDir });
    resetConfigCache();
    const result = runMemoryBenchmarkRealData({ root });
    assert.equal(result.verdict, 'PASS', `${storyDir} configured storyDir should pass with real lifecycle data`);
    assert.equal(
      result.sources.some((source) => source.sourcePath === storyDir && source.exists),
      true,
      `${storyDir} source root should be registered as existing`,
    );
    assert.equal(
      result.corpus.some((row) => row.sourcePath.startsWith(`${storyDir}/B-real/`)),
      true,
      `${storyDir} story artifacts should be exported`,
    );
    assert.equal(
      result.reasons.some((reason) => reason.includes('missing real story source root')),
      false,
      `${storyDir} should not fail because another default story root is absent`,
    );
    assert.throws(
      () => runMemoryBenchmarkRealData({ root, outputDir: join(root, storyDir, 'B-real', 'benchmark-output') }),
      /refuses to write outputDir under/,
      `${storyDir} outputDir should be refused as configured story-managed state`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-memory-real-data-'));
  try {
    const activityPath = seedRealLifecycleData(root);
    resetConfigCache();
    const result = runMemoryBenchmarkRealData({ root });

    assert.equal(result.schemaVersion, 'lattice.memory_benchmark_real_data.v1');
    assert.equal(result.note, MEMORY_BENCHMARK_REAL_DATA_NOTE);
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.pass, true);
    assert.equal(result.stats.activityScoreableRecords > 0, true);
    assert.equal(result.stats.storyScoreableRecords > 0, true);
    assert.equal(result.stats.checklistScoreableRecords > 0, true);
    assert.equal(result.stats.summaryScoreableRecords > 0, true);
    assert.equal(result.stats.evidenceScoreableRecords > 0, true);
    assert.equal(result.stats.devMemoryBoundaryRecords, 1);
    assert.equal(result.stats.boundaryGoldRecords, 0);
    assert.equal(result.stats.boundaryQueryRecords, 0);
    assert.equal(result.gold.some((row) => row.sourcePath.includes('dev-memory')), false);
    assert.equal(result.queries.some((row) => row.sourcePath.includes('dev-memory')), false);
    const activityRecord = result.corpus.find((row) => row.sourceType === 'activity' && row.fact.command === 'story_advance');
    assert.ok(activityRecord, 'current-schema activity exports the real tool name');
    assert.equal(activityRecord.fact.status, 'ok', 'current-schema activity exports the real status/outcome');
    assert.doesNotMatch(activityRecord.text, /command=unknown/, 'activity text should not lose current-schema tool');
    assert.doesNotMatch(activityRecord.text, /outcome=n\/a/, 'activity text should not lose current-schema status');
    assert.equal(
      result.corpus.some((row) => row.sourcePath.endsWith('/review-passes.json') && row.factType === 'story_evidence_artifact'),
      true,
      'current plural review-passes.json artifact should be exported',
    );
    assertTraceFields(result.corpus[0], 'corpus row');
    assertTraceFields(result.gold[0], 'gold row');
    assertTraceFields(result.queries[0], 'query row');
    assertTraceFields(result.results[0], 'result row');

    const outputDir = join(root, 'out');
    const outputResult = runMemoryBenchmarkRealData({ root, outputDir });
    assert.equal(outputResult.verdict, 'PASS');
    assert.ok(outputResult.outputFiles);
    assert.equal(existsSync(outputResult.outputFiles!.corpus), true);
    assert.equal(existsSync(outputResult.outputFiles!.gold), true);
    assert.equal(existsSync(outputResult.outputFiles!.queries), true);
    assert.equal(existsSync(outputResult.outputFiles!.result), true);
    assert.equal(lineCount(outputResult.outputFiles!.corpus), outputResult.stats.corpusRecords);
    assert.equal(lineCount(outputResult.outputFiles!.gold), outputResult.stats.goldRecords);
    assert.equal(lineCount(outputResult.outputFiles!.queries), outputResult.stats.queryRecords);
    assert.throws(
      () => runMemoryBenchmarkRealData({ root, outputDir }),
      /refuses to overwrite output files/,
      'outputDir writes refuse to overwrite existing benchmark artifacts',
    );
    assert.throws(
      () => runMemoryBenchmarkRealData({ root, outputDir: join(root, 'docs/story/memory-real-baseline') }),
      /refuses to write outputDir under docs\/story/,
      'outputDir writes refuse to target story state',
    );
    assert.throws(
      () => runMemoryBenchmarkRealData({ root, outputDir: join(root, 'Docs/story/memory-real-baseline') }),
      /refuses to write outputDir under docs\/story/,
      'outputDir writes refuse mixed-case story state paths',
    );
    assert.throws(
      () => runMemoryBenchmarkRealData({ root, outputDir: join(root, 'packages/main/tests/fixtures/memory-real-baseline') }),
      /refuses to write outputDir under packages\/main\/tests\/fixtures/,
      'outputDir writes refuse to target fixture state',
    );
    assert.throws(
      () => runMemoryBenchmarkRealData({ root, outputDir: join(root, 'packages/main/tests/Fixtures/memory-real-baseline') }),
      /refuses to write outputDir under packages\/main\/tests\/fixtures/,
      'outputDir writes refuse mixed-case fixture state paths',
    );
    assert.throws(
      () => runMemoryBenchmarkRealData({ root, outputDir: join(root, '.proof-or-stop/story/actives/B-real/memory-real-baseline') }),
      /refuses to write outputDir under \.proof-or-stop\/story/,
      'outputDir writes refuse to target Proof-or-Stop story state',
    );

    const handlers = createMemoryBenchmarkHandlers({
      root,
      scanRoot: join(root, 'packages/main'),
      store: new StoryStore(root),
    } as HandlerContext);
    const handlerResult = handlers.memory_benchmark_real_data({ format: 'json' }) as typeof result;
    assert.equal(handlerResult.verdict, 'PASS');

    const registry = createMainRegistry({
      root,
      scanRoot: join(root, 'packages/main'),
      store: new StoryStore(root),
    });
    assert.equal(registry.has('memory_benchmark_real_data'), true);
    const registryResult = registry.get('memory_benchmark_real_data')!({ format: 'json' }) as typeof result;
    assert.equal(registryResult.stats.devMemoryBoundaryRecords, 1);

    const command = 'memory_benchmark_real_data';
    assert.ok(MAIN_TOOLS.some((tool) => tool.name === command));
    const policy = getCommandLifecyclePolicy(command);
    assert.equal(policy?.ownershipClass, 'readOnly');
    assert.equal(policy?.allowedPhases, 'all');
    assert.equal(policy?.gateEvidence, undefined);
    assert.equal(policy?.destructiveRisk, 'none');
    assert.equal(getProcessFactLevelEntry(command)?.level, 'L0');
    assert.ok(DEFAULT_PHASE_TOOLS['*']?.includes('memory_benchmark_*'));

    const beforeCliActivityLines = lineCount(activityPath);
    const here = dirname(fileURLToPath(import.meta.url));
    const cliPath = join(here, '..', 'cli.js');
    const cliStdout = execFileSync(process.execPath, [cliPath, '--root', root, command, '--format=json'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const cliResult = JSON.parse(cliStdout) as typeof result;
    assert.equal(cliResult.verdict, 'PASS');
    assert.equal(cliResult.stats.devMemoryBoundaryRecords, 1);
    assert.equal(lineCount(activityPath), beforeCliActivityLines, 'read-only command does not append activity');

    const cliText = execFileSync(process.execPath, [cliPath, '--root', root, command, `--outputDir=${join(root, 'cli-out')}`, '--format=text'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.match(cliText, /Real Memory Benchmark Data: PASS/);
    assert.match(cliText, /corpusRecords=/);
    assert.match(cliText, /goldRecords=/);
    assert.match(cliText, /devMemoryExcludedFromScoring=true/);
    assert.match(cliText, /corpus\.jsonl/);
    assert.match(cliText, /result\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertConfiguredStoryDirWorks('.proof-or-stop/custom-actives');
assertConfiguredStoryDirWorks('docs/story/actives');

{
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-memory-real-data-empty-'));
  try {
    writeJson(join(root, 'proof-or-stop.config.json'), {
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
    });
    writeJsonl(join(root, '.proof-or-stop', 'dev-memory', 'experience.jsonl'), [
      {
        id: 'devonly1',
        createdAt: '2026-06-09T00:05:00.000Z',
        sourceAgent: 'proof-or-stop-implementer',
        category: 'workflow',
        scope: 'project',
        summary: 'Advisory memory cannot make a benchmark pass.',
        trigger: 'Empty lifecycle data',
        lesson: 'Boundary-only records stay out of scoreable gold.',
        reusePrompt: 'Check missing lifecycle sources.',
        gateEvidence: false,
        authority: 'non_authoritative',
      },
    ]);
    resetConfigCache();
    const result = runMemoryBenchmarkRealData({ root });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.pass, false);
    assert.match(result.reasons.join('\n'), /missing real activity source/);
    assert.match(result.reasons.join('\n'), /missing real story source root/);
    assert.equal(result.stats.devMemoryBoundaryRecords, 1);
    assert.equal(result.stats.goldRecords, 0);
    assert.equal(result.stats.queryRecords, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('✓ memory real-data benchmark smoke passed');

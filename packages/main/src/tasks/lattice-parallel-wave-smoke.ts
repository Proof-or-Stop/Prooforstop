#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { getAllowedPatterns, isCommandAllowed, resetConfigCache } from '../core/config.js';
import {
  buildParallelPlan,
  createParallelWave,
  inspectParallelWave,
  type LatticeParallelPlan,
  type LatticeParallelWave,
  type LatticeParallelWaveInspection,
} from '../core/lattice-parallel-wave.js';
import { getProcessFactLevelEntry } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo, VerificationEvidence } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';

const PARALLEL_WAVE_COMMANDS = ['parallel_wave_create', 'parallel_wave_inspect', 'parallel_plan'] as const;
const DEFAULT_POLICY_PHASES = ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'] as const;
const WAVE_STORY_IDS = ['B-main', 'B-independent', 'B-dependent', 'B-hotspot', 'B-idea-adjacent'] as const;

function writeConfig(root: string): void {
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
  }, null, 2));
}

function story(id: string, patch: Partial<StoryInfo>): StoryInfo {
  const now = '2026-06-02T00:00:00.000Z';
  return {
    storyId: id,
    name: id.toLowerCase(),
    title: `${id} parallel wave smoke`,
    description: `${id} seeded for Lattice Parallel Wave smoke coverage.`,
    type: 'feature',
    phase: 'DEV',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    ...patch,
  };
}

function checklist(intentRef: string, receiptRef?: string): ChecklistData {
  const now = '2026-06-02T00:00:00.000Z';
  const evidence: VerificationEvidence & { receiptRef?: string } = {
    intentRef,
    kind: 'logic_test',
    command: 'npm --prefix packages/main run test:lattice-parallel-wave-smoke',
    result: 'pass',
    note: 'Seed evidence for Lattice Parallel Wave smoke coverage.',
    timestamp: now,
    ...(receiptRef ? { receiptRef } : {}),
  };
  return {
    items: [{
      id: 'CHK-001',
      title: 'Seed evidence',
      status: 'done',
      startTime: now,
      endTime: now,
      verificationEvidence: [evidence],
    }],
  };
}

function seedStories(store: StoryStore): void {
  store.writeStory('B-main', story('B-main', {
    priority: 'high',
    lane: 'mainline',
    sharedHotspots: ['packages/main/src/core/command-policy.ts'],
  }));
  store.writeChecklist('B-main', checklist('B-main:happy:0'));

  store.writeStory('B-independent', story('B-independent', {
    priority: 'medium',
    lane: 'supporting',
    parallelSafe: 'yes',
  }));
  store.writeChecklist('B-independent', checklist('B-independent:happy:0', 'local-unverified-wave-receipt'));

  store.writeStory('B-dependent', story('B-dependent', {
    priority: 'medium',
    lane: 'supporting',
    parallelSafe: 'yes',
    depends: ['B-main'],
  }));
  store.writeChecklist('B-dependent', checklist('B-dependent:happy:0'));

  store.writeStory('B-hotspot', story('B-hotspot', {
    priority: 'low',
    lane: 'exploratory',
    parallelSafe: 'yes',
    sharedHotspots: ['packages/main/src/core/command-policy.ts'],
  }));
  store.writeChecklist('B-hotspot', checklist('B-hotspot:happy:0'));

  store.writeStory('B-idea-peer', story('B-idea-peer', {
    phase: 'IDEA',
    priority: 'medium',
    lane: 'supporting',
    sharedHotspots: ['packages/main/src/core/idea-only.ts'],
  }));

  store.writeStory('B-idea-adjacent', story('B-idea-adjacent', {
    priority: 'medium',
    lane: 'supporting',
    parallelSafe: 'yes',
    depends: ['B-idea-peer'],
    sharedHotspots: ['packages/main/src/core/idea-only.ts'],
  }));
  store.writeChecklist('B-idea-adjacent', checklist('B-idea-adjacent:happy:0'));
}

function ref(wave: LatticeParallelWave, storyId: string) {
  const found = wave.storyRefs.find(candidate => candidate.storyId === storyId);
  assert.ok(found, `${storyId} should be present in wave`);
  return found;
}

function assertAuthorityBoundary(value: LatticeParallelWave | LatticeParallelWaveInspection | LatticeParallelPlan): void {
  assert.equal(value.authority.productionDone, false, 'Parallel Wave output cannot claim productionDone');
  assert.equal(value.authority.authorityChanged, false, 'Parallel Wave output cannot change authority');
  assert.deepEqual(value.authority.receiptRefs, [], 'Parallel Wave top-level receiptRefs must stay empty');
}

function assertWave(wave: LatticeParallelWave): void {
  assert.equal(wave.schemaVersion, 'koala.parallel_wave.v1');
  assert.equal(wave.waveId, 'wave-smoke');
  assert.equal(wave.storyRefs.length, WAVE_STORY_IDS.length);
  assert.ok(wave.evidenceRefs.includes('B-independent:happy:0'), 'top-level evidence refs preserve story evidence lineage');
  assert.ok(wave.mergeOrder.some(entry => entry.storyId === 'B-dependent' && entry.after.includes('B-main')), 'merge order carries dependency order');
  assertAuthorityBoundary(wave);

  const host = wave.hostCandidates.find(candidate => candidate.host === 'codex');
  assert.ok(host, 'codex host candidate exists');
  assert.equal(host.capability.receiptVerifyStatus, 'conditional', 'codex receipt verification is conditional');
  assert.equal(host.capability.productionDoneBlocked, true, 'conditional receipt verification blocks productionDone');
  assert.ok(host.degradationSummary.blocksProductionDone > 0, 'host degradation summary exposes receipt production block');

  const independent = ref(wave, 'B-independent');
  assert.equal(independent.lane, 'supporting');
  assert.equal(independent.safety, 'yes');
  assert.equal(independent.recommendation, 'parallel_dev');
  assert.equal(independent.parallelDevRecommended, true);
  assert.deepEqual(independent.recommendedHostIds, ['codex']);

  const dependent = ref(wave, 'B-dependent');
  assert.equal(dependent.declaredParallelSafe, 'yes');
  assert.equal(dependent.safety, 'no', 'active dependency overrides explicit parallelSafe=yes');
  assert.equal(dependent.recommendation, 'blocked');
  assert.equal(dependent.parallelDevRecommended, false);
  assert.deepEqual(dependent.dependencies.active, ['B-main']);
  assert.ok(dependent.degradations.some(degradation => degradation.severity === 'block' && /parallelSafe=yes/.test(degradation.reason)), 'dependency degradation names explicit override');

  const hotspot = ref(wave, 'B-hotspot');
  assert.equal(hotspot.declaredParallelSafe, 'yes');
  assert.equal(hotspot.safety, 'plan_only', 'shared hotspot degrades explicit parallelSafe=yes');
  assert.equal(hotspot.recommendation, 'plan_only');
  assert.equal(hotspot.parallelDevRecommended, false);
  assert.deepEqual(hotspot.hotspots, ['packages/main/src/core/command-policy.ts']);
  assert.ok(hotspot.sharedHotspots.some(conflict => conflict.storyIds.includes('B-main')), 'hotspot conflict names active story');
  assert.ok(hotspot.degradations.some(degradation => degradation.severity === 'warn' && /parallelSafe=yes/.test(degradation.reason)), 'hotspot degradation names explicit override');

  const ideaAdjacent = ref(wave, 'B-idea-adjacent');
  assert.equal(ideaAdjacent.declaredParallelSafe, 'yes');
  assert.equal(ideaAdjacent.safety, 'yes', 'IDEA dependencies and hotspots are not active scheduling peers');
  assert.equal(ideaAdjacent.recommendation, 'parallel_dev');
  assert.equal(ideaAdjacent.parallelDevRecommended, true);
  assert.deepEqual(ideaAdjacent.dependencies.declared, ['B-idea-peer']);
  assert.deepEqual(ideaAdjacent.dependencies.active, [], 'IDEA dependency is declared but not active');
  assert.deepEqual(ideaAdjacent.sharedHotspots, [], 'IDEA hotspot peer does not create an active conflict');
  assert.deepEqual(ideaAdjacent.degradations, [], 'IDEA peer should not block or degrade scheduling');
}

function assertInspection(inspection: LatticeParallelWaveInspection): void {
  assert.equal(inspection.schemaVersion, 'koala.parallel_wave_inspect.v1');
  assert.equal(inspection.waveSchemaVersion, 'koala.parallel_wave.v1');
  assert.equal(inspection.waveId, 'wave-smoke');
  assert.equal(inspection.inspection.parallelDevCandidateCount, 2);
  assert.ok(inspection.inspection.blockingDegradationCount > 0);
  assertAuthorityBoundary(inspection);
}

function assertPlan(plan: LatticeParallelPlan): void {
  assert.equal(plan.schemaVersion, 'koala.parallel_plan.v1');
  assert.equal(plan.waveSchemaVersion, 'koala.parallel_wave.v1');
  assert.equal(plan.waveId, 'wave-smoke');
  assert.deepEqual(plan.parallelDevCandidates, ['B-idea-adjacent', 'B-independent']);
  assert.ok(plan.planOnlyStories.includes('B-hotspot'));
  assert.ok(plan.blockedStories.includes('B-dependent'));
  assert.ok(plan.recoveryGuidance.some(line => /verified receipts/.test(line)), 'plan keeps authority guidance visible');
  assertAuthorityBoundary(plan);
}

function assertDefaultPhaseToolPolicy(): void {
  for (const command of PARALLEL_WAVE_COMMANDS) {
    for (const phase of DEFAULT_POLICY_PHASES) {
      assert.equal(isCommandAllowed(command, phase), true, `${command} should be allowed by default phase tools in ${phase}`);
      assert.equal(getAllowedPatterns(phase).includes(command), true, `${command} should appear in default allowed patterns for ${phase}`);
    }
  }
}

function assertCommandRegistration(registry: ReturnType<typeof createMainRegistry>): void {
  for (const command of PARALLEL_WAVE_COMMANDS) {
    assert.ok(MAIN_TOOLS.some(tool => tool.name === command), `MAIN_TOOLS exposes ${command}`);
    assert.equal(registry.has(command), true, `registry exposes ${command}`);

    const policy = getCommandPolicy(command);
    assert.ok(policy, `${command} has command policy`);
    assert.equal(policy!.status, 'supported', `${command} is supported`);
    assert.equal(policy!.ownershipClass, 'readOnly', `${command} is readOnly`);
    assert.equal(policy!.destructiveRisk, 'none', `${command} has no destructive risk`);
    assert.equal(Boolean(policy!.gateEvidence), false, `${command} is not gate evidence`);

    const fact = getProcessFactLevelEntry(command);
    assert.ok(fact, `${command} has process fact registration`);
    assert.equal(fact!.level, 'L0', `${command} is L0`);
    assert.equal(fact!.gateConsumer, undefined, `${command} is not consumed by a gate`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'koala-lattice-parallel-wave-'));
try {
  writeConfig(root);
  resetConfigCache();
  const store = new StoryStore(root);
  seedStories(store);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  assertDefaultPhaseToolPolicy();
  assertCommandRegistration(registry);

  const wave = createParallelWave(store, root, {
    storyIds: [...WAVE_STORY_IDS],
    hosts: ['codex'],
    waveId: 'wave-smoke',
  });
  assertWave(wave);
  assertInspection(inspectParallelWave(wave));
  assertPlan(buildParallelPlan(wave));

  assertWave(registry.get('parallel_wave_create')!({
    storyIds: [...WAVE_STORY_IDS],
    hosts: ['codex'],
    waveId: 'wave-smoke',
    format: 'json',
  }) as LatticeParallelWave);

  const wavePath = join(root, 'parallel-wave.json');
  registry.get('parallel_wave_create')!({
    storyIds: [...WAVE_STORY_IDS],
    hosts: ['codex'],
    waveId: 'wave-smoke',
    output: wavePath,
  });
  assertWave(JSON.parse(readFileSync(wavePath, 'utf8')) as LatticeParallelWave);
  assert.throws(
    () => registry.get('parallel_wave_create')!({
      storyIds: [...WAVE_STORY_IDS],
      hosts: ['codex'],
      waveId: 'wave-smoke',
      output: wavePath,
    }),
    /refusing to overwrite existing file/,
    'parallel_wave_create output must be no-overwrite',
  );

  const inspectPath = join(root, 'parallel-wave-inspect.json');
  registry.get('parallel_wave_inspect')!({ file: wavePath, output: inspectPath });
  assertInspection(JSON.parse(readFileSync(inspectPath, 'utf8')) as LatticeParallelWaveInspection);
  assert.throws(
    () => registry.get('parallel_wave_inspect')!({ file: wavePath, output: inspectPath }),
    /refusing to overwrite existing file/,
    'parallel_wave_inspect output must be no-overwrite',
  );

  const planPath = join(root, 'parallel-plan.json');
  registry.get('parallel_plan')!({ file: wavePath, output: planPath });
  assertPlan(JSON.parse(readFileSync(planPath, 'utf8')) as LatticeParallelPlan);
  assert.throws(
    () => registry.get('parallel_plan')!({ file: wavePath, output: planPath }),
    /refusing to overwrite existing file/,
    'parallel_plan output must be no-overwrite',
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, '..', 'cli.js');
  const cliWaveStdout = execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'parallel_wave_create',
    `--storyIds=${JSON.stringify([...WAVE_STORY_IDS])}`,
    '--hosts=["codex"]',
    '--waveId=wave-smoke',
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertWave(JSON.parse(cliWaveStdout) as LatticeParallelWave);

  const cliInspectStdout = execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'parallel_wave_inspect',
    `--file=${wavePath}`,
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertInspection(JSON.parse(cliInspectStdout) as LatticeParallelWaveInspection);

  const cliPlanStdout = execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'parallel_plan',
    `--storyIds=${JSON.stringify([...WAVE_STORY_IDS])}`,
    '--hosts=["codex"]',
    '--waveId=wave-smoke',
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertPlan(JSON.parse(cliPlanStdout) as LatticeParallelPlan);
} finally {
  rmSync(root, { recursive: true, force: true });
  resetConfigCache();
}

console.log('✓ lattice parallel wave smoke passed');

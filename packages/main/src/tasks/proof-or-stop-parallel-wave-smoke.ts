#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_TOOLS } from '../cli-engine.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { getAllowedPatterns, isCommandAllowed, resetConfigCache } from '../core/config.js';
import {
  resolveGlobalMemoryPath,
  resolveProjectMemoryPath,
  type DevMemoryEntry,
} from '../core/dev-memory.js';
import {
  buildParallelDispatch,
  buildParallelMergeQueue,
  buildParallelPlan,
  buildParallelReport,
  buildParallelStatus,
  createParallelWave,
  inspectParallelWave,
  type ProofOrStopParallelDispatch,
  type ProofOrStopParallelMergeQueue,
  type ProofOrStopParallelPlan,
  type ProofOrStopParallelReport,
  type ProofOrStopParallelStatus,
  type ProofOrStopParallelWave,
  type ProofOrStopParallelWaveInspection,
} from '../core/proof-or-stop-parallel-wave.js';
import { getProcessFactLevelEntry } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo, VerificationEvidence } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';

const PARALLEL_WAVE_COMMANDS = [
  'parallel_wave_create',
  'parallel_wave_inspect',
  'parallel_plan',
  'parallel_dispatch',
  'parallel_status',
  'parallel_merge_queue',
  'parallel_report',
] as const;
const DEFAULT_POLICY_PHASES = ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'] as const;
const WAVE_STORY_IDS = ['B-main', 'B-independent', 'B-dependent', 'B-hotspot', 'B-idea-adjacent'] as const;
const OVERLAP_STORY_IDS = ['B-overlap-a', 'B-overlap-b', 'B-metadata-only', 'B-clean'] as const;
const MISSING_WORKTREE_STORY_ID = 'B-missing-worktree';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
  }, null, 2));
}

function story(id: string, patch: Partial<StoryInfo>): StoryInfo {
  const now = '2026-06-02T00:00:00.000Z';
  return {
    storyId: id,
    name: id.toLowerCase(),
    title: `${id} parallel wave smoke`,
    description: `${id} seeded for Proof-or-Stop Parallel Wave smoke coverage.`,
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
    command: 'npm --prefix packages/main run test:proof-or-stop-parallel-wave-smoke',
    result: 'pass',
    note: 'Seed evidence for Proof-or-Stop Parallel Wave smoke coverage.',
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

function memoryEntry(patch: Partial<DevMemoryEntry> & Pick<DevMemoryEntry, 'id' | 'summary' | 'sourceAgent'>): DevMemoryEntry {
  return {
    createdAt: '2026-06-02T00:00:00.000Z',
    category: 'workflow',
    scope: 'project',
    trigger: 'parallel dispatch smoke',
    lesson: 'Keep parallel dispatch memory non-authoritative and bounded.',
    reusePrompt: 'Use this only as advisory parallel dispatch context.',
    gateEvidence: false,
    authority: 'non_authoritative',
    ...patch,
  };
}

function writeMemoryFile(file: string, entries: DevMemoryEntry[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

function seedDevMemory(root: string): void {
  writeMemoryFile(resolveProjectMemoryPath(root), [
    memoryEntry({
      id: 'memproj1',
      createdAt: '2026-06-02T00:00:03.000Z',
      summary: 'Parallel dispatch should keep runner confirmation explicit.',
      sourceAgent: 'proof-or-stop-smoke-project',
      tags: ['parallel'],
    }),
    memoryEntry({
      id: 'memproj2',
      createdAt: '2026-06-02T00:00:02.000Z',
      category: 'tool-quirk',
      summary: 'Parallel report memory refs are advisory context only.',
      sourceAgent: 'proof-or-stop-smoke-project',
      tags: ['parallel'],
    }),
  ]);
  writeMemoryFile(resolveGlobalMemoryPath(), [
    memoryEntry({
      id: 'memglob1',
      createdAt: '2026-06-02T00:00:04.000Z',
      scope: 'global',
      summary: 'Global parallel dispatch memory must remain non-authoritative.',
      sourceAgent: 'proof-or-stop-smoke-global',
      tags: ['parallel'],
    }),
  ]);
}

function seedStories(store: StoryStore, root: string): void {
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

function ref(wave: ProofOrStopParallelWave, storyId: string) {
  const found = wave.storyRefs.find(candidate => candidate.storyId === storyId);
  assert.ok(found, `${storyId} should be present in wave`);
  return found;
}

function assertAuthorityBoundary(value: {
  authority: {
    productionDone: false;
    authorityChanged: false;
    receiptRefs: [];
  };
}): void {
  assert.equal(value.authority.productionDone, false, 'Parallel Wave output cannot claim productionDone');
  assert.equal(value.authority.authorityChanged, false, 'Parallel Wave output cannot change authority');
  assert.deepEqual(value.authority.receiptRefs, [], 'Parallel Wave top-level receiptRefs must stay empty');
}

function assertWave(wave: ProofOrStopParallelWave, root: string): void {
  assert.equal(wave.schemaVersion, 'proof-or-stop.parallel_wave.v1');
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
  assert.equal(independent.changedFiles!.status, 'not_configured');
  assert.deepEqual(independent.changedFiles!.materialChangedFiles, []);
  assert.deepEqual(independent.actualFileOverlaps ?? [], []);

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
  assert.ok(ideaAdjacent.degradations.every(degradation => degradation.severity === 'info'), 'IDEA peer should not create blocking or warn scheduling degradation');
}

function assertInspection(inspection: ProofOrStopParallelWaveInspection): void {
  assert.equal(inspection.schemaVersion, 'proof-or-stop.parallel_wave_inspect.v1');
  assert.equal(inspection.waveSchemaVersion, 'proof-or-stop.parallel_wave.v1');
  assert.equal(inspection.waveId, 'wave-smoke');
  assert.equal(inspection.inspection.parallelDevCandidateCount, 2);
  assert.ok(inspection.inspection.blockingDegradationCount > 0);
  assertAuthorityBoundary(inspection);
}

function assertPlan(plan: ProofOrStopParallelPlan): void {
  assert.equal(plan.schemaVersion, 'proof-or-stop.parallel_plan.v1');
  assert.equal(plan.waveSchemaVersion, 'proof-or-stop.parallel_wave.v1');
  assert.equal(plan.waveId, 'wave-smoke');
  assert.deepEqual(plan.parallelDevCandidates, ['B-idea-adjacent', 'B-independent']);
  assert.ok(plan.planOnlyStories.includes('B-hotspot'));
  assert.ok(plan.blockedStories.includes('B-dependent'));
  assert.ok(plan.recoveryGuidance.some(line => /verified receipts/.test(line)), 'plan keeps authority guidance visible');
  assertAuthorityBoundary(plan);
}

function dispatchRef(dispatch: ProofOrStopParallelDispatch, storyId: string) {
  const found = dispatch.dispatchEntries.find(entry => entry.storyId === storyId);
  assert.ok(found, `${storyId} should be present in dispatch`);
  return found;
}

function assertExperienceRefs(refs: ProofOrStopParallelDispatch['dispatchEntries'][number]['experienceRefs'], expectedCount: number): void {
  assert.equal(refs.length, expectedCount);
  for (const ref of refs) {
    assert.equal(typeof ref.id, 'string');
    assert.equal(typeof ref.category, 'string');
    assert.equal(typeof ref.summary, 'string');
    assert.equal(typeof ref.source, 'string');
    assert.ok(['project', 'global', 'story-candidate'].includes(ref.scope));
    assert.equal(ref.gateEvidence, false);
    assert.equal(ref.authority, 'non_authoritative');
    assert.equal('evidenceRefs' in ref, false, 'dev-memory refs must not look like gate evidence');
  }
}

function assertDispatch(dispatch: ProofOrStopParallelDispatch, root: string, expectedExperienceRefs = 0): void {
  assert.equal(dispatch.schemaVersion, 'proof-or-stop.parallel_dispatch.v1');
  assert.equal(dispatch.waveSchemaVersion, 'proof-or-stop.parallel_wave.v1');
  assert.equal(dispatch.waveId, 'wave-smoke');
  assert.equal(dispatch.summary.storyCount, WAVE_STORY_IDS.length);
  assert.equal(dispatch.summary.candidateCount, 2);
  assert.equal(dispatch.summary.planOnlyCount, 2);
  assert.equal(dispatch.summary.blockedCount, 1);
  assertAuthorityBoundary(dispatch);

  const independent = dispatchRef(dispatch, 'B-independent');
  assert.equal(independent.recommendation, 'parallel_dev');
  assert.equal(independent.dispatchable, true);
  assert.equal(independent.agentRole, 'implementer');
  assert.equal(independent.spawned, false);
  assert.equal(independent.requiresRunnerConfirmation, true);
  assert.deepEqual(independent.recommendedHostIds, ['codex']);
  assert.match(independent.nextCommand, /proof-or-stop dispatch/);
  assert.deepEqual(independent.blockers, []);
  assert.ok(independent.evidenceRefs.includes('B-independent:happy:0'));
  assertExperienceRefs(independent.experienceRefs, expectedExperienceRefs);

  const hotspot = dispatchRef(dispatch, 'B-hotspot');
  assert.equal(hotspot.recommendation, 'plan_only');
  assert.equal(hotspot.dispatchable, true);
  assert.equal(hotspot.agentRole, 'planner');
  assert.match(hotspot.nextCommand, /parallel_plan/);
  assert.ok(hotspot.degradations.some(degradation => degradation.severity === 'warn'));
  assertExperienceRefs(hotspot.experienceRefs, expectedExperienceRefs);

  const dependent = dispatchRef(dispatch, 'B-dependent');
  assert.equal(dependent.recommendation, 'blocked');
  assert.equal(dependent.dispatchable, false);
  assert.equal(dependent.agentRole, 'blocked');
  assert.match(dependent.nextCommand, /parallel_status/);
  assert.ok(dependent.blockers.some(blocker => /B-main/.test(blocker)));
  assertExperienceRefs(dependent.experienceRefs, expectedExperienceRefs);
}

function assertStatus(status: ProofOrStopParallelStatus): void {
  assert.equal(status.schemaVersion, 'proof-or-stop.parallel_status.v1');
  assert.equal(status.waveSchemaVersion, 'proof-or-stop.parallel_wave.v1');
  assert.equal(status.waveId, 'wave-smoke');
  assert.equal(status.summary.candidateCount, 2);
  assert.deepEqual(status.candidates, ['B-idea-adjacent', 'B-independent']);
  assert.deepEqual(status.planOnly, ['B-hotspot', 'B-main']);
  assert.deepEqual(status.blocked.map(entry => entry.storyId), ['B-dependent']);
  assert.ok(status.mergeGuidance.ready.length > 0, 'status includes ready guidance');
  assert.ok(status.mergeGuidance.blocked.length > 0, 'status includes blocked guidance');
  assertAuthorityBoundary(status);
}

function assertMergeQueue(queue: ProofOrStopParallelMergeQueue): void {
  assert.equal(queue.schemaVersion, 'proof-or-stop.parallel_merge_queue.v1');
  assert.equal(queue.waveSchemaVersion, 'proof-or-stop.parallel_wave.v1');
  assert.equal(queue.waveId, 'wave-smoke');
  assert.equal(queue.summary.storyCount, WAVE_STORY_IDS.length);
  assert.ok(queue.ready.some(entry => entry.storyId === 'B-independent'));
  assert.ok(queue.ready.some(entry => entry.storyId === 'B-hotspot' && /planning/.test(entry.guidance)));
  assert.deepEqual(queue.blocked.map(entry => entry.storyId), ['B-dependent']);
  assert.ok(queue.blocked[0]?.blockers.some(blocker => /B-main/.test(blocker)));
  assert.ok(queue.mergeGuidance.ready.length > 0);
  assert.ok(queue.mergeGuidance.blocked.length > 0);
  assertAuthorityBoundary(queue);
}

function assertReport(report: ProofOrStopParallelReport, root: string, expectedExperienceRefs = 0): void {
  assert.equal(report.schemaVersion, 'proof-or-stop.parallel_report.v1');
  assert.equal(report.waveSchemaVersion, 'proof-or-stop.parallel_wave.v1');
  assert.equal(report.waveId, 'wave-smoke');
  assert.equal(report.summary.candidateCount, 2);
  assert.deepEqual(report.candidates, ['B-idea-adjacent', 'B-independent']);
  assert.deepEqual(report.planOnly, ['B-hotspot', 'B-main']);
  assert.deepEqual(report.blocked, ['B-dependent']);
  assert.equal(report.dispatchEntries.length, WAVE_STORY_IDS.length);
  assert.equal(report.evidenceSummary.byStory.length, WAVE_STORY_IDS.length);
  assert.ok(report.evidenceSummary.topLevelRefs.includes('B-independent:happy:0'));
  assertExperienceRefs(report.experienceRefs, expectedExperienceRefs);
  assertDispatch({ ...report, schemaVersion: 'proof-or-stop.parallel_dispatch.v1', dispatchedAt: report.reportedAt, hostCandidates: [], evidenceRefs: report.evidenceSummary.topLevelRefs, mergeOrder: [] }, root, expectedExperienceRefs);
  assertAuthorityBoundary(report);
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

function writeOverlapStory(store: StoryStore, storyId: string): void {
  const now = '2026-06-02T00:00:00.000Z';
  store.writeStory(storyId, story(storyId, {
    priority: 'medium',
    lane: 'supporting',
    parallelSafe: 'yes',
    worktree: {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: now,
    },
  }));
  store.writeChecklist(storyId, checklist(`${storyId}:happy:0`));
}

function seedOverlapWorktreeRepo(root: string, store: StoryStore): void {
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/shared.ts'), 'export const shared = "base";\n', 'utf8');
  writeConfig(root);
  for (const storyId of OVERLAP_STORY_IDS) writeOverlapStory(store, storyId);

  git(root, ['init']);
  git(root, ['config', 'user.email', 'parallel-wave-smoke@example.invalid']);
  git(root, ['config', 'user.name', 'Parallel Wave Smoke']);
  git(root, ['checkout', '-B', 'main']);
  commitAll(root, 'seed parallel wave overlap repo');

  for (const storyId of OVERLAP_STORY_IDS) {
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', join(root, '.worktrees', storyId), `story/${storyId}`]);
  }

  const overlapA = join(root, '.worktrees', 'B-overlap-a');
  writeFileSync(join(overlapA, 'packages/main/src/shared.ts'), 'export const shared = "overlap-a";\n', 'utf8');
  git(overlapA, ['add', 'packages/main/src/shared.ts']);
  git(overlapA, ['commit', '-m', 'change shared file in overlap a']);

  const overlapB = join(root, '.worktrees', 'B-overlap-b');
  writeFileSync(join(overlapB, 'packages/main/src/shared.ts'), 'export const shared = "overlap-b";\n', 'utf8');

  const metadataOnly = join(root, '.worktrees', 'B-metadata-only');
  mkdirSync(join(metadataOnly, '.proof-or-stop/runtime'), { recursive: true });
  writeFileSync(join(metadataOnly, '.proof-or-stop/runtime/cache.json'), '{}\n', 'utf8');
  mkdirSync(join(metadataOnly, '.proof-or-stop/story/actives/B-metadata-only'), { recursive: true });
  writeFileSync(join(metadataOnly, '.proof-or-stop/story/actives/B-metadata-only/process-events.jsonl'), '{"event":"metadata-only"}\n', 'utf8');

  const clean = join(root, '.worktrees', 'B-clean');
  writeFileSync(join(clean, 'packages/main/src/clean.ts'), 'export const clean = true;\n', 'utf8');
  writeFileSync(join(clean, 'packages/main/src/process-events.jsonl'), '{"event":"material-source"}\n', 'utf8');
}

function addMissingWorktreeStory(store: StoryStore): void {
  writeOverlapStory(store, MISSING_WORKTREE_STORY_ID);
}

function assertActiveWorktreeOverlapProjection(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-parallel-wave-overlap-'));
  try {
    writeConfig(root);
    resetConfigCache();
    const store = new StoryStore(root);
    seedOverlapWorktreeRepo(root, store);
    resetConfigCache();

    const wave = createParallelWave(store, root, {
      storyIds: [...OVERLAP_STORY_IDS],
      hosts: ['codex'],
      waveId: 'wave-overlap-smoke',
    });
    assertAuthorityBoundary(wave);

    const overlapA = ref(wave, 'B-overlap-a');
    const overlapB = ref(wave, 'B-overlap-b');
    for (const overlapRef of [overlapA, overlapB]) {
      assert.equal(overlapRef.changedFiles!.status, 'ok');
      assert.deepEqual(overlapRef.changedFiles!.materialChangedFiles, ['packages/main/src/shared.ts']);
      assert.deepEqual(overlapRef.sharedHotspots, [], 'actual overlap is detected without sharedHotspots metadata');
      assert.equal(overlapRef.safety, 'plan_only');
      assert.equal(overlapRef.recommendation, 'plan_only');
      assert.equal(overlapRef.parallelDevRecommended, false);
      assert.ok((overlapRef.actualFileOverlaps ?? []).some(overlap => overlap.path === 'packages/main/src/shared.ts'), 'overlap path is recorded');
      assert.ok(overlapRef.degradations.some(degradation => /packages\/main\/src\/shared\.ts/.test(degradation.reason)), 'overlap degradation names the file');
    }
    assert.ok((overlapA.actualFileOverlaps ?? []).some(overlap => overlap.peerStoryId === 'B-overlap-b'), 'overlap A names peer story');
    assert.ok((overlapB.actualFileOverlaps ?? []).some(overlap => overlap.peerStoryId === 'B-overlap-a'), 'overlap B names peer story');

    const metadataOnly = ref(wave, 'B-metadata-only');
    assert.equal(metadataOnly.changedFiles!.status, 'ok');
    assert.deepEqual(metadataOnly.changedFiles!.materialChangedFiles, []);
    assert.ok(metadataOnly.changedFiles!.ignoredChangedFiles.some(path => path.startsWith('.proof-or-stop/')), 'metadata-only Proof-or-Stop changes are visible as ignored');
    assert.ok(metadataOnly.changedFiles!.ignoredChangedFiles.some(path => path.startsWith('.proof-or-stop/runtime/')), 'registered runtime changes are visible as ignored');
    assert.deepEqual(metadataOnly.actualFileOverlaps ?? [], []);
    assert.equal(metadataOnly.recommendation, 'parallel_dev', 'metadata-only changes do not create overlap noise');

    const clean = ref(wave, 'B-clean');
    assert.equal(clean.changedFiles!.status, 'ok');
    assert.deepEqual(clean.changedFiles!.materialChangedFiles, ['packages/main/src/clean.ts', 'packages/main/src/process-events.jsonl']);
    assert.deepEqual(clean.actualFileOverlaps ?? [], []);
    assert.equal(clean.recommendation, 'parallel_dev', 'non-overlapping material changes stay parallel candidates');
    assert.equal(clean.worktreePath, '.worktrees/B-clean', 'smoke stories persist relative worktree paths');

    const plan = buildParallelPlan(wave);
    assert.deepEqual(plan.parallelDevCandidates, ['B-clean', 'B-metadata-only']);
    assert.deepEqual(plan.planOnlyStories, ['B-overlap-a', 'B-overlap-b']);
    assertAuthorityBoundary(plan);

    const status = buildParallelStatus(wave);
    assert.deepEqual(status.candidates, ['B-clean', 'B-metadata-only']);
    assert.deepEqual(status.planOnly, ['B-overlap-a', 'B-overlap-b']);
    assert.ok(status.mergeGuidance.ready.some(entry =>
      entry.storyId === 'B-overlap-a' &&
      /packages\/main\/src\/shared\.ts/.test(entry.guidance) &&
      /B-overlap-b/.test(entry.guidance)
    ), 'status guidance includes overlapping file and peer story');
    assertAuthorityBoundary(status);

    const queue = buildParallelMergeQueue(wave);
    const queueOverlapA = queue.ready.find(entry => entry.storyId === 'B-overlap-a');
    assert.ok(queueOverlapA, 'plan-only overlap story remains visible in merge queue');
    assert.ok(queueOverlapA!.blockers.some(blocker =>
      /packages\/main\/src\/shared\.ts/.test(blocker) && /B-overlap-b/.test(blocker)
    ), 'merge queue blockers include overlapping file and peer story');
    assert.match(queueOverlapA!.guidance, /packages\/main\/src\/shared\.ts/);
    assert.match(queueOverlapA!.guidance, /B-overlap-b/);
    assertAuthorityBoundary(queue);

    const waveFromStoryWorktree = createParallelWave(store, join(root, '.worktrees', 'B-overlap-a'), {
      storyIds: [...OVERLAP_STORY_IDS],
      hosts: ['codex'],
      waveId: 'wave-overlap-story-worktree-smoke',
    });
    assertAuthorityBoundary(waveFromStoryWorktree);
    const overlapAFromStoryWorktree = ref(waveFromStoryWorktree, 'B-overlap-a');
    assert.equal(overlapAFromStoryWorktree.changedFiles!.status, 'ok');
    assert.deepEqual(overlapAFromStoryWorktree.changedFiles!.materialChangedFiles, ['packages/main/src/shared.ts']);
    assert.ok((overlapAFromStoryWorktree.actualFileOverlaps ?? []).some(overlap =>
      overlap.path === 'packages/main/src/shared.ts' && overlap.peerStoryId === 'B-overlap-b'
    ), 'relative worktree paths resolve from git common root when command runs inside a story worktree');
    assert.ok(!overlapAFromStoryWorktree.degradations.some(degradation =>
      /Registered worktree path does not exist/.test(degradation.reason)
    ), 'story-worktree execution must not resolve relative worktree paths under the current worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

function assertBrokenWorktreeProbeRisk(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-parallel-wave-broken-worktree-'));
  try {
    writeConfig(root);
    resetConfigCache();
    const store = new StoryStore(root);
    seedOverlapWorktreeRepo(root, store);
    addMissingWorktreeStory(store);
    resetConfigCache();

    const missingOnlyWave = createParallelWave(store, root, {
      storyIds: [MISSING_WORKTREE_STORY_ID],
      hosts: ['codex'],
      waveId: 'wave-missing-worktree-smoke',
    });
    assertAuthorityBoundary(missingOnlyWave);
    const missing = ref(missingOnlyWave, MISSING_WORKTREE_STORY_ID);
    assert.equal(missing.changedFiles!.status, 'failed');
    assert.match(missing.changedFiles!.reason ?? '', /Registered worktree path does not exist/);
    assert.equal(missing.safety, 'plan_only');
    assert.equal(missing.recommendation, 'plan_only');
    assert.equal(missing.parallelDevRecommended, false);
    assert.ok(missing.degradations.some(degradation =>
      degradation.severity === 'warn' &&
      /Registered worktree path does not exist/.test(degradation.reason)
    ), 'selected missing worktree gets a visible changed-file probe degradation');

    const cleanOnlyWave = createParallelWave(store, root, {
      storyIds: ['B-clean'],
      hosts: ['codex'],
      waveId: 'wave-unselected-missing-worktree-smoke',
    });
    assertAuthorityBoundary(cleanOnlyWave);
    const clean = ref(cleanOnlyWave, 'B-clean');
    assert.equal(clean.changedFiles!.status, 'ok');
    assert.deepEqual(clean.changedFiles!.materialChangedFiles, ['packages/main/src/clean.ts', 'packages/main/src/process-events.jsonl']);
    assert.equal(clean.safety, 'plan_only', 'failed active-story probes degrade selected stories with incomplete projections');
    assert.equal(clean.recommendation, 'plan_only');
    assert.equal(clean.parallelDevRecommended, false);
    assert.ok(clean.degradations.some(degradation =>
      degradation.severity === 'warn' &&
      degradation.reason.includes(MISSING_WORKTREE_STORY_ID) &&
      /changed-file projection failed/.test(degradation.reason)
    ), 'selected output exposes the unselected active story whose probe failed');

    const plan = buildParallelPlan(cleanOnlyWave);
    assert.deepEqual(plan.parallelDevCandidates, []);
    assert.deepEqual(plan.planOnlyStories, ['B-clean']);
    assertAuthorityBoundary(plan);

    const status = buildParallelStatus(cleanOnlyWave);
    assert.deepEqual(status.candidates, []);
    assert.deepEqual(status.planOnly, ['B-clean']);
    assert.ok(status.mergeGuidance.ready.some(entry =>
      entry.storyId === 'B-clean' &&
      entry.guidance.includes(MISSING_WORKTREE_STORY_ID)
    ), 'status guidance surfaces the collection-level failed probe risk');
    assertAuthorityBoundary(status);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

assertActiveWorktreeOverlapProjection();
assertBrokenWorktreeProbeRisk();

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-parallel-wave-'));
const originalGlobalMemoryDir = process.env.PROOF_OR_STOP_GLOBAL_MEMORY_DIR;
try {
  process.env.PROOF_OR_STOP_GLOBAL_MEMORY_DIR = join(root, 'global-memory');
  writeConfig(root);
  resetConfigCache();
  const store = new StoryStore(root);
  seedStories(store, root);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  assertDefaultPhaseToolPolicy();
  assertCommandRegistration(registry);

  const wave = createParallelWave(store, root, {
    storyIds: [...WAVE_STORY_IDS],
    hosts: ['codex'],
    waveId: 'wave-smoke',
  });
  assertWave(wave, root);
  assertInspection(inspectParallelWave(wave));
  assertPlan(buildParallelPlan(wave));
  assertDispatch(buildParallelDispatch(wave), root);
  assertDispatch(buildParallelDispatch(wave, {
    projectRoot: root,
    includeExperience: true,
    experienceQuery: 'parallel',
    maxExperienceRefs: 2,
  }), root, 0);
  assertStatus(buildParallelStatus(wave));
  assertMergeQueue(buildParallelMergeQueue(wave));
  assertReport(buildParallelReport(wave, {
    projectRoot: root,
    includeExperience: true,
    experienceQuery: 'parallel',
    maxExperienceRefs: 2,
  }), root, 0);

  seedDevMemory(root);
  const seededDispatch = buildParallelDispatch(wave, {
    projectRoot: root,
    includeExperience: true,
    experienceQuery: 'parallel',
    maxExperienceRefs: 2,
  });
  assertDispatch(seededDispatch, root, 2);
  assertExperienceRefs(dispatchRef(buildParallelDispatch(wave, {
    projectRoot: root,
    includeExperience: true,
    experienceQuery: 'parallel',
    maxExperienceRefs: 1,
  }), 'B-independent').experienceRefs, 1);
  assertReport(buildParallelReport(wave, {
    projectRoot: root,
    includeExperience: true,
    experienceQuery: 'parallel',
    maxExperienceRefs: 2,
  }), root, 2);

  assertWave(registry.get('parallel_wave_create')!({
    storyIds: [...WAVE_STORY_IDS],
    hosts: ['codex'],
    waveId: 'wave-smoke',
    format: 'json',
  }) as ProofOrStopParallelWave, root);

  const wavePath = join(root, 'parallel-wave.json');
  registry.get('parallel_wave_create')!({
    storyIds: [...WAVE_STORY_IDS],
    hosts: ['codex'],
    waveId: 'wave-smoke',
    output: wavePath,
  });
  assertWave(JSON.parse(readFileSync(wavePath, 'utf8')) as ProofOrStopParallelWave, root);
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
  assertInspection(JSON.parse(readFileSync(inspectPath, 'utf8')) as ProofOrStopParallelWaveInspection);
  assert.throws(
    () => registry.get('parallel_wave_inspect')!({ file: wavePath, output: inspectPath }),
    /refusing to overwrite existing file/,
    'parallel_wave_inspect output must be no-overwrite',
  );

  const planPath = join(root, 'parallel-plan.json');
  registry.get('parallel_plan')!({ file: wavePath, output: planPath });
  assertPlan(JSON.parse(readFileSync(planPath, 'utf8')) as ProofOrStopParallelPlan);
  assert.throws(
    () => registry.get('parallel_plan')!({ file: wavePath, output: planPath }),
    /refusing to overwrite existing file/,
    'parallel_plan output must be no-overwrite',
  );

  const dispatchPath = join(root, 'parallel-dispatch.json');
  registry.get('parallel_dispatch')!({
    file: wavePath,
    includeExperience: true,
    experienceQuery: 'parallel',
    maxExperienceRefs: 2,
    output: dispatchPath,
  });
  assertDispatch(JSON.parse(readFileSync(dispatchPath, 'utf8')) as ProofOrStopParallelDispatch, root, 2);
  assert.throws(
    () => registry.get('parallel_dispatch')!({
      file: wavePath,
      output: dispatchPath,
    }),
    /refusing to overwrite existing file/,
    'parallel_dispatch output must be no-overwrite',
  );

  const statusPath = join(root, 'parallel-status.json');
  registry.get('parallel_status')!({ file: wavePath, output: statusPath });
  assertStatus(JSON.parse(readFileSync(statusPath, 'utf8')) as ProofOrStopParallelStatus);
  assert.throws(
    () => registry.get('parallel_status')!({ file: wavePath, output: statusPath }),
    /refusing to overwrite existing file/,
    'parallel_status output must be no-overwrite',
  );

  const mergeQueuePath = join(root, 'parallel-merge-queue.json');
  registry.get('parallel_merge_queue')!({ file: wavePath, output: mergeQueuePath });
  assertMergeQueue(JSON.parse(readFileSync(mergeQueuePath, 'utf8')) as ProofOrStopParallelMergeQueue);
  assert.throws(
    () => registry.get('parallel_merge_queue')!({ file: wavePath, output: mergeQueuePath }),
    /refusing to overwrite existing file/,
    'parallel_merge_queue output must be no-overwrite',
  );

  const reportPath = join(root, 'parallel-report.json');
  registry.get('parallel_report')!({
    file: wavePath,
    includeExperience: true,
    experienceQuery: 'parallel',
    maxExperienceRefs: 2,
    output: reportPath,
  });
  assertReport(JSON.parse(readFileSync(reportPath, 'utf8')) as ProofOrStopParallelReport, root, 2);
  assert.throws(
    () => registry.get('parallel_report')!({
      file: wavePath,
      output: reportPath,
    }),
    /refusing to overwrite existing file/,
    'parallel_report output must be no-overwrite',
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
  assertWave(JSON.parse(cliWaveStdout) as ProofOrStopParallelWave, root);

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
  assertInspection(JSON.parse(cliInspectStdout) as ProofOrStopParallelWaveInspection);

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
  assertPlan(JSON.parse(cliPlanStdout) as ProofOrStopParallelPlan);

  const cliDispatchStdout = execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'parallel_dispatch',
    `--storyIds=${JSON.stringify([...WAVE_STORY_IDS])}`,
    '--hosts=["codex"]',
    '--waveId=wave-smoke',
    '--includeExperience=true',
    '--experienceQuery=parallel',
    '--maxExperienceRefs=2',
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertDispatch(JSON.parse(cliDispatchStdout) as ProofOrStopParallelDispatch, root, 2);

  const cliStatusStdout = execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'parallel_status',
    `--storyIds=${JSON.stringify([...WAVE_STORY_IDS])}`,
    '--hosts=["codex"]',
    '--waveId=wave-smoke',
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertStatus(JSON.parse(cliStatusStdout) as ProofOrStopParallelStatus);

  const cliMergeQueueStdout = execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'parallel_merge_queue',
    `--storyIds=${JSON.stringify([...WAVE_STORY_IDS])}`,
    '--hosts=["codex"]',
    '--waveId=wave-smoke',
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertMergeQueue(JSON.parse(cliMergeQueueStdout) as ProofOrStopParallelMergeQueue);

  const cliReportStdout = execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    'parallel_report',
    `--storyIds=${JSON.stringify([...WAVE_STORY_IDS])}`,
    '--hosts=["codex"]',
    '--waveId=wave-smoke',
    '--includeExperience=true',
    '--experienceQuery=parallel',
    '--maxExperienceRefs=2',
    '--format=json',
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assertReport(JSON.parse(cliReportStdout) as ProofOrStopParallelReport, root, 2);
} finally {
  if (originalGlobalMemoryDir === undefined) {
    delete process.env.PROOF_OR_STOP_GLOBAL_MEMORY_DIR;
  } else {
    process.env.PROOF_OR_STOP_GLOBAL_MEMORY_DIR = originalGlobalMemoryDir;
  }
  rmSync(root, { recursive: true, force: true });
  resetConfigCache();
}

console.log('✓ proof-or-stop parallel wave smoke passed');

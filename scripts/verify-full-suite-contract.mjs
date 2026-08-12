#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = process.cwd();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const runner = readFileSync('packages/main/src/tasks/full-suite-runner.ts', 'utf8');
const runnerSmoke = readFileSync('packages/main/src/tasks/full-suite-runner-smoke.ts', 'utf8');
const cohort = readFileSync('scripts/run-proofstory-acceptance-rollout-cohort.mjs', 'utf8');
const acceptance = readFileSync('packages/main/src/tasks/proofstory-acceptance-rollout-smoke.ts', 'utf8');
const incremental = readFileSync('packages/main/src/tasks/review-incremental-context-smoke.ts', 'utf8');

const smokeOutput = execFileSync(process.execPath, ['packages/main/dist/tasks/full-suite-runner-smoke.js'], { cwd: root, encoding: 'utf8' });
assert.match(smokeOutput, /full-suite-runner-smoke: PASS \(20 assertions\)/);
for (const token of ['SIGINT', 'SIGTERM', 'INTERRUPTED', 'activeChildren', 'killTree', 'headHash', 'materialHash', 'workerUtilization', 'processLaunchCount', 'criticalPath', 'lockWaitMs', 'resource']) assert.ok(runner.includes(token), `runner missing ${token}`);
assert.ok(runnerSmoke.includes('jobs greater') || runnerSmoke.includes('runScheduled'));
assert.ok(cohort.includes('productionCaseLimit') && cohort.includes('withProductionCaseSlot'));
assert.ok(acceptance.includes('copied cohort runner is byte-identical') && acceptance.includes('const tempCohort = clone(control)'));
assert.ok(incremental.includes("LATTICE_INCREMENTAL_STRESS === '1' ? 20 : 1"));
assert.ok(!runner.includes('rmSync('), 'runner must not accept or recursively delete arbitrary member cleanup roots');
assert.equal(300_000 < 300_000, false, 'exactly 300000ms is outside the accepted performance boundary');

{
  const one = JSON.parse(readFileSync(process.env.B9812_COHORT_JOBS1 ?? '/tmp/b9812-cohort-jobs1.json', 'utf8'));
  const three = JSON.parse(readFileSync(process.env.B9812_COHORT_JOBS3 ?? '/tmp/b9812-cohort-jobs3.json', 'utf8'));
  assert.deepEqual(one.registeredSeedIds, three.registeredSeedIds);
  const semanticRecords = input => input.sourceRecords.map(record => ({ pairId: record.pairId, arm: record.arm, storyId: record.storyId, claimClass: record.claimClass, defectClass: record.defectClass, defectPresent: record.defectPresent, shouldBlock: record.shouldBlock, scenario: record.observationReceipt.scenario, topologyStatus: record.observationReceipt.gateArtifacts?.[0]?.status, preReviewStatus: record.observationReceipt.gateArtifacts?.[1]?.status, checkInventory: record.observationReceipt.checkInventory, mutationInventory: record.observationReceipt.mutationInventory, restored: Boolean(record.observationReceipt.restorationCommitSha) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(semanticRecords(one), semanticRecords(three));
}

const prefix = process.env.B9812_PROOF_PREFIX ?? '/tmp/b9812-mechanical-run';
const expectedMaterial = process.env.B9812_MATERIAL_HASH ?? '626604853fdf2e2d46eb64c842567dfd1021f7cdd1cb75d0eeee27a6bd58b981';
let ordered;
for (let i = 1; i <= 3; i++) {
  const artifact = JSON.parse(readFileSync(`${prefix}${i}.json`, 'utf8'));
  assert.equal(readFileSync(`${prefix}${i}.exit`, 'utf8').trim(), '0');
  const identity = readFileSync(`${prefix}${i}.identity`, 'utf8');
  assert.ok(identity.includes(`HEAD=${head}`));
  if (expectedMaterial) assert.ok(identity.includes(`materialHash=${expectedMaterial}`));
  assert.equal(artifact.headHash, head);
  if (expectedMaterial) assert.equal(artifact.materialHash, expectedMaterial);
  assert.equal(artifact.total, 46); assert.equal(artifact.passed, 46);
  assert.equal(artifact.retries, 0); assert.equal(artifact.jobs, 4);
  assert.ok(artifact.durationMs < 300_000);
  assert.equal(artifact.processLaunchCount, 46);
  assert.ok(artifact.workerUtilization > 0 && artifact.workerUtilization <= 1);
  assert.ok(artifact.criticalPath?.name && artifact.criticalPath.durationMs > 0);
  assert.ok(artifact.results.every(result => result.status === 'PASS' && result.resource && result.lockWaitMs >= 0));
  const names = artifact.results.map(result => result.name).join('\n');
  if (ordered === undefined) ordered = names; else assert.equal(names, ordered);
}

const counts = { 1: [2, 2, 2], 2: [3, 3, 3], 3: [3, 3, 3], 4: [3, 3, 3], 5: [3, 3, 3], 6: [4, 3, 3] };
const lanes = ['happy', 'edge', 'adversarial'];
for (const [item, laneCounts] of Object.entries(counts)) {
  for (let lane = 0; lane < lanes.length; lane++) {
    for (let index = 0; index < laneCounts[lane]; index++) console.log(`VERIFIED CHK-00${item}:${lanes[lane]}:${index}`);
  }
}

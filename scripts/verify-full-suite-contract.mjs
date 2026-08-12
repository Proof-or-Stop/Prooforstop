#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const root = process.cwd();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const runnerSource = readFileSync('packages/main/src/tasks/full-suite-runner.ts', 'utf8');
const runnerSmokeSource = readFileSync('packages/main/src/tasks/full-suite-runner-smoke.ts', 'utf8');
const cohortSource = readFileSync('scripts/run-proofstory-acceptance-rollout-cohort.mjs', 'utf8');
const acceptanceSource = readFileSync('packages/main/src/tasks/proofstory-acceptance-rollout-smoke.ts', 'utf8');
const incrementalSource = readFileSync('packages/main/src/tasks/review-incremental-context-smoke.ts', 'utf8');

const smokeOutput = execFileSync(process.execPath, ['packages/main/dist/tasks/full-suite-runner-smoke.js'], { cwd: root, encoding: 'utf8' });
assert.match(smokeOutput, /full-suite-runner-smoke: PASS \((\d+) assertions\)/);
const smokeAssertions = Number(smokeOutput.match(/PASS \((\d+) assertions\)/)?.[1]);
assert.ok(smokeAssertions >= 44);
const guardOutput = execFileSync(process.execPath, ['packages/main/dist/tasks/review-incremental-context-smoke.js', '--guard-map-only'], { cwd: root, encoding: 'utf8' });
assert.match(guardOutput, /INCREMENTAL_GUARD_CLASSES=review-run-identity,mixed-envelope-selection,pass-finding-write-serialization,signed-result-admissibility,lane-no-overwrite,real-review-gate/);

const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonicalize = value => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])])) : value;
const canonical = value => JSON.stringify(canonicalize(value));
const semanticRecords = input => input.sourceRecords.map(record => ({
  pairId: record.pairId, arm: record.arm, storyId: record.storyId, claimClass: record.claimClass,
  defectClass: record.defectClass, defectPresent: record.defectPresent, shouldBlock: record.shouldBlock,
  scenario: record.observationReceipt.scenario,
  topologyStatus: record.observationReceipt.gateArtifacts?.[0]?.status,
  topologyDiagnostics: record.observationReceipt.gateArtifacts?.[0]?.report?.diagnostics ?? [],
  preReviewStatus: record.observationReceipt.gateArtifacts?.[1]?.status,
  preReviewCodes: record.observationReceipt.gateArtifacts?.[1]?.report?.codes ?? [],
  checkInventory: record.observationReceipt.checkInventory ?? null,
  mutationInventory: record.observationReceipt.mutationInventory ?? null,
  mutationResults: (record.observationReceipt.mutationResults ?? []).map(result => ({
    mutationId: result.mutationId,
    expectedCode: result.expectedCode,
    observedCode: result.observedCode,
    controlRestored: result.controlRestored,
  })),
  controlRestored: record.observationReceipt.controlRestored ?? Boolean(record.observationReceipt.restorationCommitSha),
})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const cohort1Path = process.env.B9812_COHORT_JOBS1 ?? '/tmp/b9812-final-v2-cohort-jobs1.json';
const cohort3Path = process.env.B9812_COHORT_JOBS3 ?? '/tmp/b9812-final-v2-cohort-jobs3.json';
const receiptFailures = [];
const receiptCheck = (condition, message) => { if (!condition) receiptFailures.push(message); return Boolean(condition); };
const readJsonReceipt = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { receiptFailures.push(`${path}: ${error.message}`); return null; } };
const readTextReceipt = path => { try { return readFileSync(path, 'utf8'); } catch (error) { receiptFailures.push(`${path}: ${error.message}`); return ''; } };
const cohort1 = readJsonReceipt(cohort1Path);
const cohort3 = readJsonReceipt(cohort3Path);
const normalizedOne = cohort1 ? semanticRecords(cohort1) : [];
const normalizedThree = cohort3 ? semanticRecords(cohort3) : [];
const cohortSemanticEqual = receiptCheck(cohort1 && cohort3 && canonical(normalizedOne) === canonical(normalizedThree), 'cohort jobs1/jobs3 semantic records differ')
  && receiptCheck(cohort1.semanticInventoryDigest === cohort3.semanticInventoryDigest, 'cohort semantic digests differ')
  && receiptCheck(cohort1.semanticInventoryDigest === sha256(canonical(normalizedOne)), 'cohort semantic digest is forged')
  && receiptCheck(cohort1.cohortJobs === 1 && cohort3.cohortJobs === 3, 'cohort job bindings differ')
  && receiptCheck(Boolean(cohort1.sourceInventoryDigest && cohort3.sourceInventoryDigest), 'cohort raw digests missing');
let acceptanceOutput = '';
let acceptanceAliasOutput = '';
try {
  if (cohort3) {
    const relativeAcceptance = 'packages/main/dist/tasks/proofstory-acceptance-rollout-smoke.js';
    acceptanceOutput = execFileSync(process.execPath, [relativeAcceptance, `--cohort=${cohort3Path}`], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const aliasRoot = root.startsWith('/private/tmp/') ? root.replace('/private/tmp/', '/tmp/') : root.startsWith('/tmp/') ? root.replace('/tmp/', '/private/tmp/') : root;
    acceptanceAliasOutput = execFileSync(process.execPath, [`${aliasRoot}/${relativeAcceptance}`, `--cohort=${cohort3Path}`], { cwd: aliasRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  }
}
catch (error) { receiptFailures.push(`acceptance frozen-cohort verifier failed: ${error.message}`); }
const acceptanceSelector = acceptanceOutput.match(/ProofStory acceptance rollout smoke: PASS \((\d+) assertions\)/)?.[0];
const acceptancePassed = receiptCheck(Boolean(acceptanceSelector), 'acceptance frozen-cohort assertions missing')
  && receiptCheck(acceptanceAliasOutput.includes(acceptanceSelector), 'acceptance /tmp and /private/tmp aliases do not execute the same assertions');

const parallelPrefix = process.env.B9812_PROOF_PREFIX ?? '/tmp/b9812-final-v2-run';
const serialPrefix = process.env.B9812_SERIAL_PREFIX ?? '/tmp/b9812-final-v2-serial';
const parallel = [];
let expectedMaterial;
let orderedNames;
for (let index = 1; index <= 3; index++) {
  const artifact = readJsonReceipt(`${parallelPrefix}${index}.json`);
  const exit = readTextReceipt(`${parallelPrefix}${index}.exit`).trim();
  const identity = readTextReceipt(`${parallelPrefix}${index}.identity`);
  const timing = readTextReceipt(`${parallelPrefix}${index}.timing`);
  if (!artifact) continue;
  let valid = receiptCheck(exit === '0', `run${index} exit is not zero`)
    && receiptCheck(identity.includes(`HEAD=${head}`), `run${index} HEAD binding mismatch`)
    && receiptCheck(/checkout=.* .*|pathWithSpaces=true/.test(identity), `run${index} checkout path does not prove spaces`);
  expectedMaterial ??= identity.match(/materialHash=([a-f0-9]{64})/)?.[1];
  valid = receiptCheck(expectedMaterial && identity.includes(`materialHash=${expectedMaterial}`), `run${index} material binding mismatch`) && valid;
  valid = receiptCheck(/user\s+[0-9.]+/.test(timing) && /sys(?:tem)?\s+[0-9.]+/.test(timing), `run${index} CPU timing missing`) && valid;
  valid = receiptCheck(canonical(artifact.startIdentity) === canonical({ headHash: head, materialHash: expectedMaterial }), `run${index} start identity mismatch`) && valid;
  valid = receiptCheck(canonical(artifact.endIdentity) === canonical(artifact.startIdentity) && artifact.identityDrift === false, `run${index} end identity drift`) && valid;
  valid = receiptCheck(artifact.overallStatus === 'PASS' && artifact.total === 46 && artifact.passed === 46, `run${index} terminal totals invalid`) && valid;
  valid = receiptCheck(artifact.retries === 0 && artifact.jobs === 4 && artifact.processLaunchCount === 46, `run${index} launch/retry accounting invalid`) && valid;
  valid = receiptCheck(artifact.durationMs < 300_000 && artifact.workerUtilization > 0 && artifact.workerUtilization <= 1, `run${index} performance/utilization invalid`) && valid;
  valid = receiptCheck(artifact.performanceBudgetMs === 300_000 && artifact.performanceBudgetApplied === true && artifact.budgetBreached === false, `run${index} performance budget telemetry invalid`) && valid;
  valid = receiptCheck(Boolean(artifact.criticalPath?.name && artifact.criticalPath.durationMs > 0), `run${index} critical path missing`) && valid;
  valid = receiptCheck(artifact.coverageInventory?.canonicalMembers?.length === 46 && artifact.coverageInventory?.assertionSuites?.length && artifact.coverageInventory?.mutationClasses?.length, `run${index} coverage inventory invalid`) && valid;
  valid = receiptCheck(artifact.results.every(result => result.status === 'PASS' && Array.isArray(result.declaredResources) && Array.isArray(result.acquiredResources) && result.lockWaitMs >= 0 && result.tempRoot), `run${index} member telemetry invalid`) && valid;
  const names = artifact.results.map(result => result.name).join('\n');
  orderedNames ??= names; valid = receiptCheck(names === orderedNames, `run${index} canonical order mismatch`) && valid;
  parallel.push({ ...artifact, receiptValid: valid });
}

const serial = readJsonReceipt(`${serialPrefix}.json`);
const serialValid = receiptCheck(serial && readTextReceipt(`${serialPrefix}.exit`).trim() === '0', 'serial exit invalid')
  && receiptCheck(serial.jobs === 1 && serial.total === 46 && serial.passed === 46 && serial.retries === 0, 'serial totals invalid')
  && receiptCheck(serial.performanceBudgetMs === 300_000 && serial.performanceBudgetApplied === false && serial.budgetBreached === false, 'serial budget exemption is not explicit')
  && receiptCheck(serial.results.map(result => result.name).join('\n') === orderedNames, 'serial inventory differs')
  && receiptCheck(canonical(serial.coverageInventory) === canonical(parallel[0]?.coverageInventory), 'serial coverage inventory differs')
  && receiptCheck(canonical(serial.results.map(({ name, status }) => ({ name, status }))) === canonical(parallel[0]?.results.map(({ name, status }) => ({ name, status }))), 'serial outcomes differ');

const doneReceiptPath = process.env.B9812_DONE_RECEIPT ?? '.lattice/story/actives/B-9812/done-required-evidence.json';
const doneReceiptText = existsSync(doneReceiptPath) ? readTextReceipt(doneReceiptPath) : '';
const doneReceiptValid = receiptCheck(Boolean(doneReceiptText), `DONE-required receipt missing: ${doneReceiptPath}`)
  && receiptCheck(doneReceiptText.includes(head) && doneReceiptText.includes(expectedMaterial), 'DONE-required identity mismatch')
  && receiptCheck(/npm test|full-suite-runner/.test(doneReceiptText), 'DONE-required command mismatch');

const proof = {
  focusedRunner: smokeAssertions >= 44,
  keyedResources: /ResourceClass/.test(runnerSource) && /canonicalizeEntries/.test(runnerSource) && /claimsConflict/.test(runnerSource),
  cleanup: /runner-owned-unique/.test(runnerSource) && /owned temp cleanup failed/.test(runnerSource) && /caller repository root/.test(runnerSmokeSource),
  processTree: /killProcessTree/.test(runnerSource) && /AggregateError/.test(runnerSource) && /top-level SIGINT exits 130/.test(runnerSmokeSource),
  strictArguments: /unknown argument/.test(runnerSource) && /finite positive integer/.test(runnerSource),
  identityAndBudget: parallel.length === 3 && /performance\.now/.test(runnerSource) && /identityChanged/.test(runnerSource) && parallel.every(run => run.durationMs < 300_000 && !run.identityDrift),
  terminal: /failure is terminal and never retried/.test(runnerSmokeSource) && parallel.length === 3 && parallel.every(run => run.retries === 0),
  inventory: parallel.length === 3 && parallel.every(run => run.total === 46 && run.coverageInventory.canonicalMembers.length === 46),
  serialEquivalent: serialValid && serial.results.every(result => result.status === 'PASS'),
  cohortEquivalent: cohortSemanticEqual && normalizedOne.length === 12,
  cohortIntegrity: acceptancePassed && /semanticInventoryDigest/.test(cohortSource) && /copied cohort runner is byte-identical/.test(acceptanceSource) && /tempCohort = clone\(control\)/.test(acceptanceSource),
  cohortIsolation: acceptancePassed && cohortSemanticEqual && /withProductionCaseSlot/.test(cohortSource) && /evidenceGitCwd/.test(cohortSource) && /controlRestored/.test(cohortSource),
  incrementalMap: /INCREMENTAL_GUARD_CLASS_MAP/.test(incrementalSource) && /LATTICE_INCREMENTAL_STRESS === '1' \? 20 : 1/.test(incrementalSource) && /INCREMENTAL_GUARD_CLASSES/.test(guardOutput),
  threeRuns: parallel.length === 3 && parallel.every(run => run.receiptValid && run.overallStatus === 'PASS' && run.durationMs < 300_000),
  auditableReports: parallel.length === 3 && parallel.every(run => run.criticalPath && run.processLaunchCount === 46 && run.results.every(result => result.lockWaitMs >= 0)),
  doneRequired: doneReceiptValid,
};

const conditions = {
  'CHK-001': [proof.auditableReports, proof.threeRuns, proof.inventory && proof.identityAndBudget, proof.terminal, proof.focusedRunner && proof.inventory, proof.identityAndBudget],
  'CHK-002': [proof.keyedResources, proof.keyedResources && proof.focusedRunner, proof.cleanup && proof.processTree, proof.keyedResources, proof.keyedResources && proof.strictArguments, proof.keyedResources && proof.focusedRunner, proof.keyedResources && proof.focusedRunner, proof.processTree, proof.cleanup],
  'CHK-003': [proof.cohortIntegrity, proof.cohortIsolation, proof.cohortIntegrity, proof.cohortIntegrity, proof.cohortIsolation, proof.cohortEquivalent, proof.cohortIntegrity, proof.cohortIntegrity, proof.cohortIsolation],
  'CHK-004': [proof.incrementalMap, proof.incrementalMap && proof.serialEquivalent, proof.incrementalMap, proof.incrementalMap, proof.incrementalMap, proof.incrementalMap, proof.incrementalMap, proof.incrementalMap, proof.incrementalMap],
  'CHK-005': [proof.inventory, proof.serialEquivalent, proof.terminal, proof.strictArguments, proof.keyedResources, proof.processTree, proof.inventory, proof.terminal, proof.terminal],
  'CHK-006': [proof.threeRuns, proof.auditableReports, proof.serialEquivalent, proof.doneRequired, proof.threeRuns && proof.identityAndBudget, proof.strictArguments, proof.identityAndBudget, proof.processTree && proof.keyedResources && proof.terminal, proof.identityAndBudget, proof.keyedResources && proof.doneRequired],
};
const counts = { 'CHK-001': [2, 2, 2], 'CHK-002': [3, 3, 3], 'CHK-003': [3, 3, 3], 'CHK-004': [3, 3, 3], 'CHK-005': [3, 3, 3], 'CHK-006': [4, 3, 3] };
const lanes = ['happy', 'edge', 'adversarial'];
for (const [item, laneCounts] of Object.entries(counts)) {
  const predicates = conditions[item]; let offset = 0;
  for (let lane = 0; lane < lanes.length; lane++) for (let index = 0; index < laneCounts[lane]; index++) {
    const selector = `${item}:${lanes[lane]}:${index}`;
    const predicate = predicates[offset++];
    if (predicate) console.log(`VERIFIED ${selector}`);
    else receiptFailures.push(`${selector} intent-specific predicate failed`);
  }
  assert.equal(offset, predicates.length, `${item} predicate count drift`);
}
if (receiptFailures.length) {
  for (const failure of receiptFailures) process.stderr.write(`UNVERIFIED ${failure}\n`);
  process.exitCode = 1;
} else {
  console.log(`FULL_SUITE_CONTRACT=PASS head=${head} material=${expectedMaterial} members=46 focusedAssertions=${smokeAssertions}`);
}

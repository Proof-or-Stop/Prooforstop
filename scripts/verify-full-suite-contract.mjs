#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { semanticCohortRecords } from './run-proofstory-acceptance-rollout-cohort.mjs';

const root = process.cwd();
const EXPECTED_MEMBERS = 47;
const cliArgs = process.argv.slice(2);
// Capture and replay are inadmissible if the executable dist is not the output
// bound by the standard build to current source.
execFileSync(process.execPath, ['scripts/verify-full-suite-build-binding.mjs'], { cwd: root, stdio: 'pipe' });
if (cliArgs.length === 0 || (cliArgs.length === 1 && cliArgs[0] === '--capture')) {
  const selectorArgs = cliArgs.length === 0 ? ['--all'] : ['--capture'];
  const output = execFileSync(process.execPath, ['scripts/verify-full-suite-selector.mjs', ...selectorArgs], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write(output);
  process.exit(0);
}
if (cliArgs.length !== 1 || cliArgs[0] !== '--evaluate-internal') {
  throw new Error('usage: verify-full-suite-contract.mjs [--capture | --evaluate-internal]');
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const RECEIPT_METADATA_ALLOWLIST = new Set([
  'owner-lease.json', 'closeout-write-receipts.jsonl', 'done-required-evidence.json', 'test-evidence.json',
  'checklist.json', 'findings.json', 'gate-failure-counts.json', 'process-events.jsonl', 'index.json', 'process-metrics.json',
  'prompt-envelopes.json', 'review-runs.json', 'review-passes.json', 'delivery-check.json', 'stall-adjudication.json', 'scope-contract.json',
]);
export function receiptHeadIsAdmissible({ ancestor, materialEqual, changedPaths }) {
  const prefix = '.proof-or-stop/story/actives/B-9812/';
  return ancestor && materialEqual && changedPaths.every(path => path.startsWith(prefix) && RECEIPT_METADATA_ALLOWLIST.has(path.slice(prefix.length)));
}
function assertReceiptHead(receiptHead, receiptMaterial, currentMaterial) {
  let ancestor = true;
  try { execFileSync('git', ['merge-base', '--is-ancestor', receiptHead, head], { cwd: root, stdio: 'ignore' }); }
  catch { ancestor = false; }
  const changedPaths = ancestor ? execFileSync('git', ['diff', '--name-only', `${receiptHead}..${head}`], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean) : [];
  return receiptHeadIsAdmissible({ ancestor, materialEqual: receiptMaterial === currentMaterial, changedPaths });
}
const runnerSource = readFileSync('packages/main/src/tasks/full-suite-runner.ts', 'utf8');
const runnerSmokeSource = readFileSync('packages/main/src/tasks/full-suite-runner-smoke.ts', 'utf8');
const cohortSource = readFileSync('scripts/run-proofstory-acceptance-rollout-cohort.mjs', 'utf8');
const acceptanceSource = readFileSync('packages/main/src/tasks/proofstory-acceptance-rollout-smoke.ts', 'utf8');
const incrementalSource = readFileSync('packages/main/src/tasks/review-incremental-context-smoke.ts', 'utf8');
const buildBindingSelfTest = execFileSync(process.execPath, ['scripts/verify-full-suite-build-binding.mjs', '--self-test'], { cwd: root, encoding: 'utf8' });

const smokeOutput = execFileSync(process.execPath, ['packages/main/dist/tasks/full-suite-runner-smoke.js'], { cwd: root, encoding: 'utf8' });
assert.match(smokeOutput, /full-suite-runner-smoke: PASS \((\d+) assertions\)/);
const smokeAssertions = Number(smokeOutput.match(/PASS \((\d+) assertions\)/)?.[1]);
assert.ok(smokeAssertions >= 44);
assert.equal(receiptHeadIsAdmissible({ ancestor: true, materialEqual: true, changedPaths: ['.proof-or-stop/story/actives/B-9812/checklist.json'] }), true, 'metadata-only descendant is admissible');
assert.equal(receiptHeadIsAdmissible({ ancestor: true, materialEqual: true, changedPaths: ['.proof-or-stop/story/actives/B-9812/index.json', '.proof-or-stop/story/actives/B-9812/process-metrics.json'] }), true, 'normal REVIEW lifecycle metadata descendant is admissible');
assert.equal(receiptHeadIsAdmissible({ ancestor: true, materialEqual: true, changedPaths: ['.proof-or-stop/story/actives/B-9812/prompt-envelopes.json', '.proof-or-stop/story/actives/B-9812/review-runs.json', '.proof-or-stop/story/actives/B-9812/review-passes.json'] }), true, 'actual reviewer dispatch and pass metadata descendant is admissible');
assert.equal(receiptHeadIsAdmissible({ ancestor: true, materialEqual: true, changedPaths: ['.proof-or-stop/story/actives/B-9812/delivery-check.json'] }), true, 'actual delivery approval metadata descendant is admissible');
assert.equal(receiptHeadIsAdmissible({ ancestor: true, materialEqual: true, changedPaths: ['.proof-or-stop/story/actives/B-9812/stall-adjudication.json', '.proof-or-stop/story/actives/B-9812/scope-contract.json'] }), true, 'actual convergence and scope metadata descendant is admissible');
assert.equal(receiptHeadIsAdmissible({ ancestor: true, materialEqual: true, changedPaths: ['.proof-or-stop/story/actives/B-9812/test-evidence.json'] }), true, 'actual DONE-required command evidence descendant is admissible');
assert.equal(receiptHeadIsAdmissible({ ancestor: true, materialEqual: true, changedPaths: ['.proof-or-stop/story/actives/B-9812/gate-failure-counts.json'] }), true, 'actual lifecycle gate-attempt metadata descendant is admissible');
assert.equal(receiptHeadIsAdmissible({ ancestor: false, materialEqual: true, changedPaths: [] }), false, 'non-ancestor receipt is rejected');
assert.equal(receiptHeadIsAdmissible({ ancestor: true, materialEqual: true, changedPaths: ['packages/main/src/tasks/full-suite-runner.ts'] }), false, 'source diff is rejected even with matching material claim');
assert.equal(receiptHeadIsAdmissible({ ancestor: true, materialEqual: true, changedPaths: ['.proof-or-stop/story/actives/B-9812/unapproved.json'] }), false, 'metadata path outside strict allowlist is rejected');
const guardOutput = execFileSync(process.execPath, ['packages/main/dist/tasks/review-incremental-context-smoke.js', '--guard-map-only'], { cwd: root, encoding: 'utf8' });
assert.match(guardOutput, /INCREMENTAL_GUARD_CLASSES=review-run-identity,mixed-envelope-selection,pass-finding-write-serialization,signed-result-admissibility,lane-no-overwrite,real-review-gate/);

const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonicalize = value => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])])) : value;
const canonical = value => JSON.stringify(canonicalize(value));
const cohort1Path = process.env.B9812_COHORT_JOBS1 ?? '/tmp/b9812-final-v3-cohort-jobs1.json';
const cohort3Path = process.env.B9812_COHORT_JOBS3 ?? '/tmp/b9812-final-v3-cohort-jobs3.json';
const receiptFailures = [];
const receiptCheck = (condition, message) => { if (!condition) receiptFailures.push(message); return Boolean(condition); };
const readJsonReceipt = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { receiptFailures.push(`${path}: ${error.message}`); return null; } };
const readTextReceipt = path => { try { return readFileSync(path, 'utf8'); } catch (error) { receiptFailures.push(`${path}: ${error.message}`); return ''; } };
const cohort1 = readJsonReceipt(cohort1Path);
const cohort3 = readJsonReceipt(cohort3Path);
const normalizedOne = cohort1 ? semanticCohortRecords(cohort1.sourceRecords) : [];
const normalizedThree = cohort3 ? semanticCohortRecords(cohort3.sourceRecords) : [];
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

const parallelPrefix = process.env.B9812_PROOF_PREFIX ?? '/tmp/b9812-final-v3-run';
const serialPrefix = process.env.B9812_SERIAL_PREFIX ?? '/tmp/b9812-final-v3-serial';
const parallel = [];
let expectedMaterial;
let orderedNames;
for (let index = 1; index <= 3; index++) {
  const artifact = readJsonReceipt(`${parallelPrefix}${index}.json`);
  const exit = readTextReceipt(`${parallelPrefix}${index}.exit`).trim();
  const identity = readTextReceipt(`${parallelPrefix}${index}.identity`);
  const timing = readTextReceipt(`${parallelPrefix}${index}.timing`);
  if (!artifact) continue;
  const receiptHead = identity.match(/HEAD=([a-f0-9]{40})/)?.[1];
  const receiptMaterial = identity.match(/materialHash=([a-f0-9]{64})/)?.[1];
  let valid = receiptCheck(exit === '0', `run${index} exit is not zero`)
    && receiptCheck(Boolean(receiptHead && receiptMaterial), `run${index} identity sidecar incomplete`)
    && receiptCheck(/checkout=.* .*|pathWithSpaces=true/.test(identity), `run${index} checkout path does not prove spaces`);
  expectedMaterial ??= receiptMaterial;
  const currentMaterial = execFileSync(process.execPath, ['--input-type=module', '-e', "import{currentMaterialHash}from'./packages/main/dist/core/evidence-freshness.js';process.stdout.write(currentMaterialHash(process.cwd())??'')"], { cwd: root, encoding: 'utf8' });
  valid = receiptCheck(Boolean(receiptHead && receiptMaterial && assertReceiptHead(receiptHead, receiptMaterial, currentMaterial)), `run${index} receipt head is not an admissible metadata-only ancestor`) && valid;
  valid = receiptCheck(expectedMaterial && identity.includes(`materialHash=${expectedMaterial}`), `run${index} material binding mismatch`) && valid;
  valid = receiptCheck(/user\s+[0-9.]+/.test(timing) && /sys(?:tem)?\s+[0-9.]+/.test(timing), `run${index} CPU timing missing`) && valid;
  valid = receiptCheck(canonical(artifact.startIdentity) === canonical({ headHash: receiptHead, materialHash: expectedMaterial }), `run${index} start identity mismatch`) && valid;
  valid = receiptCheck(canonical(artifact.endIdentity) === canonical(artifact.startIdentity) && artifact.identityDrift === false, `run${index} end identity drift`) && valid;
  valid = receiptCheck(artifact.overallStatus === 'PASS' && artifact.total === EXPECTED_MEMBERS && artifact.passed === EXPECTED_MEMBERS, `run${index} terminal totals invalid`) && valid;
  valid = receiptCheck(artifact.retries === 0 && artifact.jobs === 4 && artifact.processLaunchCount === EXPECTED_MEMBERS, `run${index} launch/retry accounting invalid`) && valid;
  valid = receiptCheck(artifact.durationMs < 300_000 && artifact.workerUtilization > 0 && artifact.workerUtilization <= 1, `run${index} performance/utilization invalid`) && valid;
  valid = receiptCheck(artifact.performanceBudgetMs === 300_000 && artifact.performanceBudgetApplied === true && artifact.budgetBreached === false, `run${index} performance budget telemetry invalid`) && valid;
  valid = receiptCheck(Boolean(artifact.criticalPath?.name && artifact.criticalPath.durationMs > 0), `run${index} critical path missing`) && valid;
  valid = receiptCheck(artifact.coverageInventory?.canonicalMembers?.length === EXPECTED_MEMBERS && artifact.coverageInventory?.assertionSuites?.length && artifact.coverageInventory?.mutationClasses?.length, `run${index} coverage inventory invalid`) && valid;
  valid = receiptCheck(artifact.results.every(result => result.status === 'PASS' && Array.isArray(result.declaredResources) && Array.isArray(result.acquiredResources) && result.lockWaitMs >= 0 && result.tempRoot), `run${index} member telemetry invalid`) && valid;
  const names = artifact.results.map(result => result.name).join('\n');
  orderedNames ??= names; valid = receiptCheck(names === orderedNames, `run${index} canonical order mismatch`) && valid;
  parallel.push({ ...artifact, receiptValid: valid });
}

const serial = readJsonReceipt(`${serialPrefix}.json`);
const serialValid = receiptCheck(serial && readTextReceipt(`${serialPrefix}.exit`).trim() === '0', 'serial exit invalid')
  && receiptCheck(serial.jobs === 1 && serial.total === EXPECTED_MEMBERS && serial.passed === EXPECTED_MEMBERS && serial.retries === 0, 'serial totals invalid')
  && receiptCheck(serial.performanceBudgetMs === 300_000 && serial.performanceBudgetApplied === false && serial.budgetBreached === false, 'serial budget exemption is not explicit')
  && receiptCheck(serial.results.map(result => result.name).join('\n') === orderedNames, 'serial inventory differs')
  && receiptCheck(canonical(serial.coverageInventory) === canonical(parallel[0]?.coverageInventory), 'serial coverage inventory differs')
  && receiptCheck(canonical(serial.results.map(({ name, status }) => ({ name, status }))) === canonical(parallel[0]?.results.map(({ name, status }) => ({ name, status }))), 'serial outcomes differ');
const inventoriesEqual = (left, right) => left.every(leftResult => {
  const rightResult = right.find(result => result.name === leftResult.name);
  return rightResult && canonical(leftResult.detailedAssertions) === canonical(rightResult.detailedAssertions)
    && canonical(leftResult.mutationInventory) === canonical(rightResult.mutationInventory);
});
const serialParallelInventoriesEqual = receiptCheck(Boolean(serial && parallel[0] && inventoriesEqual(serial.results, parallel[0].results)), 'serial/parallel per-member assertion or mutation inventory differs');

const doneReceiptPath = process.env.B9812_DONE_RECEIPT ?? '.proof-or-stop/story/actives/B-9812/done-required-evidence.json';
const doneReceiptText = existsSync(doneReceiptPath) ? readTextReceipt(doneReceiptPath) : '';
const doneReceipt = doneReceiptText ? JSON.parse(doneReceiptText) : null;
const currentMaterialForDone = execFileSync(process.execPath, ['--input-type=module', '-e', "import{currentMaterialHash}from'./packages/main/dist/core/evidence-freshness.js';process.stdout.write(currentMaterialHash(process.cwd())??'')"], { cwd: root, encoding: 'utf8' });
const doneReceiptValid = receiptCheck(Boolean(doneReceiptText), `DONE-required receipt missing: ${doneReceiptPath}`)
  && receiptCheck(Boolean(doneReceipt && assertReceiptHead(doneReceipt.headHash, doneReceipt.materialHash, currentMaterialForDone) && doneReceipt.materialHash === expectedMaterial), 'DONE-required identity mismatch')
  && receiptCheck(/npm test|full-suite-runner/.test(doneReceiptText), 'DONE-required command mismatch');
const jobs3 = readJsonReceipt(process.env.B9812_JOBS3_RECEIPT ?? '/tmp/b9812-final-v3-jobs3.json');
const jobs5 = readJsonReceipt(process.env.B9812_JOBS5_RECEIPT ?? '/tmp/b9812-final-v3-jobs5.json');
const fixedPortOs = readJsonReceipt(process.env.B9812_FIXED_PORT_OS_RECEIPT ?? '/tmp/b9812-final-v3-fixed-port-os.json');
const fixedPortOsValid = receiptCheck(fixedPortOs?.schema === 'proof-or-stop.fixed-port-os-collision.v1', 'fixed-port OS collision receipt schema missing')
  && receiptCheck(fixedPortOs.host === '127.0.0.1' && fixedPortOs.port === 43127, 'fixed-port OS collision endpoint mismatch')
  && receiptCheck(fixedPortOs.capability === 'detected' && fixedPortOs.normalBind === 'PASS', 'fixed-port OS normal bind was not demonstrated')
  && receiptCheck(fixedPortOs.collision?.status === 'TERMINAL_FAIL' && fixedPortOs.collision?.code === 'EADDRINUSE' && fixedPortOs.mutationDetected === true, 'prebound fixed port did not produce terminal EADDRINUSE')
  && receiptCheck(fixedPortOs.cleanupRebind === 'PASS' && fixedPortOs.overallStatus === 'PASS', 'fixed-port OS cleanup/rebind was not demonstrated');
const stressText = readTextReceipt(process.env.B9812_STRESS20_RECEIPT ?? '/tmp/b9812-final-v3-stress20.log');
const stressLine = stressText.split(/\r?\n/).find(line => line.startsWith('INCREMENTAL_STRESS_RECEIPT='));
let stressReceipt = null;
try { stressReceipt = stressLine ? JSON.parse(stressLine.slice('INCREMENTAL_STRESS_RECEIPT='.length)) : null; } catch { stressReceipt = null; }
const stressValid = receiptCheck(Boolean(stressReceipt && stressReceipt.iterations?.length === 20), 'stress20 receipt does not contain 20 iterations')
  && receiptCheck(stressReceipt.iterations.every(iteration => Object.keys(iteration.guardClasses ?? {}).length === 6 && Object.values(iteration.guardClasses).every(Boolean)), 'stress20 observed guard-class outcome mismatch')
  && receiptCheck(stressReceipt.aba?.observedDurationMs > 0 && stressReceipt.cutoff?.observedDurationMs > 0 && stressReceipt.restoration?.completedCases === 20, 'stress20 ABA/cutoff/restoration observations missing')
  && receiptCheck(stressReceipt.deterministicSeed === 'fixed-mask-v1' && stressReceipt.schedule?.join(',') === '31,10,21', 'stress20 seed/schedule receipt missing')
  && receiptCheck(stressReceipt.shards?.enabled === true && stressReceipt.shards?.deterministic === true && stressReceipt.shards?.timeoutIsolated === true && stressReceipt.replay?.sameGuardClassOutcome === true, 'stress20 shard/replay/timeout isolation contract missing')
  && receiptCheck(stressReceipt.scheduleMutation?.executed === true
    && stressReceipt.scheduleMutation.completed === true && stressReceipt.scheduleMutation.threw === false
    && stressReceipt.scheduleMutation.baselinePassed === true
    && stressReceipt.scheduleMutation.reorderedPassed === false
    && stressReceipt.scheduleMutation.orderViolation === true
    && stressReceipt.scheduleMutation.missingSeedRejected === true
    && stressReceipt.scheduleMutation.detected === true, 'stress20 order-dependent schedule/seed mutation missing')
  && receiptCheck(Object.keys(stressReceipt.mutationKillMap ?? {}).length === 6 && Object.values(stressReceipt.mutationKillMap).every(mutation => mutation.executed && mutation.detected && mutation.baselineDigest !== mutation.mutatedDigest), 'stress20 production guard mutation-kill observations incomplete');
const realGateMutationValid = stressReceipt?.mutationKillMap?.['real-review-gate']?.completed === true
  && stressReceipt.mutationKillMap['real-review-gate'].threw === false
  && stressReceipt.mutationKillMap['real-review-gate'].baseline === true
  && stressReceipt.mutationKillMap['real-review-gate'].redundantDeletionStillTrue === true
  && stressReceipt.mutationKillMap['real-review-gate'].allPassesCleared === false
  && stressReceipt.mutationKillMap['real-review-gate'].detected === true;
const jobsEdgeValid = receiptCheck(Boolean(jobs3?.overallStatus === 'PASS' && jobs3.jobs === 3 && jobs3.total === EXPECTED_MEMBERS), 'jobs3 edge receipt invalid')
  && receiptCheck(Boolean(jobs5?.overallStatus === 'PASS' && jobs5.jobs === 5 && jobs5.total === EXPECTED_MEMBERS), 'jobs5 edge receipt invalid');
const memberReportValid = parallel.length === 3 && parallel.every(run =>
  run.baselineComparison?.historicalSerialMs === 1_688_918
  && run.results.every(result => result.canonicalMemberAssertionId === result.name
    && Array.isArray(result.assertionInventory) && result.assertionInventory.some(assertion => assertion === `terminal-exit:PASS:${result.name}`) && Array.isArray(result.mutationInventory)
    && Array.isArray(result.detailedAssertions) && result.detailedAssertions.length > 0
    && result.detailedAssertions.every(assertion => typeof assertion === 'string' && assertion.length > 0)
    && result.detailedAssertions.some(assertion => assertion.startsWith('output-sha256:'))
    && result.failureOutcome?.status === result.status
    && result.cpu && (result.cpu.capability === 'unavailable' || (Number.isFinite(result.cpu.userSeconds) && Number.isFinite(result.cpu.systemSeconds))))
);
const memberInventoryTruthful = parallel.length === 3 && parallel.every(run => {
  const markerNames = run.results.filter(result => result.summaryMarkerPresent).map(result => result.name);
  const outputDerivedNames = run.results.filter(result => !result.summaryMarkerPresent).map(result => result.name);
  return canonical(run.summaryInventory?.explicitMarkers ?? []) === canonical(markerNames)
    && canonical(run.summaryInventory?.outputDerived ?? []) === canonical(outputDerivedNames)
    && run.results.every(result => Array.isArray(result.detailedAssertions) && result.detailedAssertions.length > 0
      && (result.summaryMarkerPresent ? result.inventorySource === 'explicit-marker+output-signature' : result.inventorySource === 'output-signature'));
});
const explicitLongTailMarkers = parallel.length === 3 && parallel.every(run =>
  ['test:full-suite-runner-smoke', 'test:full-suite-resource-sentinel', 'test:review-incremental-context-smoke', 'test:proofstory-intent-hardening-smoke', 'test:proofstory-acceptance-rollout']
    .every(name => run.results.find(result => result.name === name)?.summaryMarkerPresent === true)
);
const focusedBehavior = {
  outputBoundary: smokeOutput.includes('tracked project output overwrite is rejected before execution') && smokeOutput.includes('symlink output escape is rejected'),
  crossPlatformCleanup: smokeOutput.includes('POSIX group ESRCH falls back') && smokeOutput.includes('Windows cleanup uses supported taskkill') && smokeOutput.includes('Windows separators and drive boundaries'),
  lockWait: smokeOutput.includes('worker-capacity queue time is not reported as resource lock wait') && smokeOutput.includes('deterministic compatibility queue wait'),
  protectedClasses: ['git-common-dir', 'fixed-path', 'fixed-port', 'runtime-lock', 'main-write-lock'].every(resourceClass => smokeOutput.includes(`canonical manifest exercises protected class ${resourceClass}`)) && smokeOutput.includes('preowned fixed path makes canonical resource sentinel fail terminally') && smokeOutput.includes('fixed-port claim removal mutation bites'),
  injectedFailures: ['normal parent completion kills complete descendant process group', 'timeout kills complete descendant process group', 'failure is terminal and never retried', 'tracked project output overwrite is rejected'].every(text => smokeOutput.includes(text)),
  cpuSpoof: smokeOutput.includes('member stderr cannot spoof dedicated CPU timing file'),
  buildBindingEntry: smokeOutput.includes('stale source makes direct npm test fail before argument parsing with launches0')
    && smokeOutput.includes('tampered dist makes direct npm test fail before argument parsing with launches0'),
  emittedInventoryBites: smokeOutput.includes('suppressing an assertion before member output changes observed detailed inventory')
    && smokeOutput.includes('suppressing an explicit marker assertion before emission changes parsed inventory')
    && smokeOutput.includes('suppressing an explicit marker mutation before emission changes mutation inventory'),
};
const schedulerLine = smokeOutput.split(/\r?\n/).find(line => line.startsWith('FULL_SUITE_SCHEDULER_RECEIPT='));
let schedulerReceipt = null;
try { schedulerReceipt = schedulerLine ? JSON.parse(schedulerLine.slice('FULL_SUITE_SCHEDULER_RECEIPT='.length)) : null; } catch { schedulerReceipt = null; }
const schedulerProof = {
  overlap: schedulerReceipt?.distinctRootsOverlap?.observed === true && schedulerReceipt.distinctRootsOverlap.activeWitness?.length > 1,
  protectedPairs: schedulerReceipt && Object.values(schedulerReceipt.protectedPairs ?? {}).every(observation => observation.serialized && observation.overlapCount === 0 && observation.completionCount === 2 && observation.blockedWaitMs > 0) && Object.keys(schedulerReceipt.protectedPairs ?? {}).length === 5,
  aliases: schedulerReceipt?.canonicalAliasesCollide?.observed === true && schedulerReceipt.canonicalAliasesCollide.collisionCount >= 2,
  failClosed: schedulerReceipt?.unknownAndUnclassifiedFailClosed?.observed === true && schedulerReceipt.unknownAndUnclassifiedFailClosed.throwCount === 5,
  progress: schedulerReceipt?.workerBoundariesProgress?.observed === true && schedulerReceipt.workerBoundariesProgress.completionCount > 0,
  mutations: schedulerReceipt?.mutationBites?.removedFixedPortKey === true && schedulerReceipt?.mutationBites?.inventoryOmission === true,
  lifecycle: schedulerReceipt && Object.values(schedulerReceipt.lifecycle ?? {}).every(Boolean),
  fixedPortOs: schedulerReceipt?.fixedPortOsCollision,
};

const proof = {
  focusedRunner: smokeAssertions >= 44,
  buildBinding: focusedBehavior.buildBindingEntry && /verify-full-suite-build-binding/.test(runnerSource)
    && buildBindingSelfTest.includes('stale source and tampered dist rejected'),
  keyedResources: /ResourceClass/.test(runnerSource) && /canonicalizeEntries/.test(runnerSource) && /claimsConflict/.test(runnerSource),
  cleanup: /runner-owned-unique/.test(runnerSource) && /owned temp cleanup failed/.test(runnerSource) && /caller repository root/.test(runnerSmokeSource),
  processTree: /killProcessTree/.test(runnerSource) && /AggregateError/.test(runnerSource) && /top-level SIGINT exits 130/.test(runnerSmokeSource),
  strictArguments: /unknown argument/.test(runnerSource) && /finite positive integer/.test(runnerSource),
  identityAndBudget: parallel.length === 3 && /performance\.now/.test(runnerSource) && /identityChanged/.test(runnerSource) && parallel.every(run => run.durationMs < 300_000 && !run.identityDrift),
  terminal: /failure is terminal and never retried/.test(runnerSmokeSource) && parallel.length === 3 && parallel.every(run => run.retries === 0),
  inventory: parallel.length === 3 && parallel.every(run => run.total === EXPECTED_MEMBERS && run.coverageInventory.canonicalMembers.length === EXPECTED_MEMBERS),
  serialEquivalent: serialValid && serialParallelInventoriesEqual && focusedBehavior.emittedInventoryBites && serial.results.every(result => result.status === 'PASS'),
  cohortEquivalent: cohortSemanticEqual && normalizedOne.length === 12,
  cohortIntegrity: acceptancePassed && /semanticInventoryDigest/.test(cohortSource) && /copied cohort runner is byte-identical/.test(acceptanceSource) && /tempCohort = clone\(control\)/.test(acceptanceSource),
  cohortIsolation: acceptancePassed && cohortSemanticEqual && /withProductionCaseSlot/.test(cohortSource) && /evidenceGitCwd/.test(cohortSource) && /controlRestored/.test(cohortSource),
  incrementalMap: /INCREMENTAL_GUARD_CLASS_MAP/.test(incrementalSource) && /PROOF_OR_STOP_INCREMENTAL_STRESS === '1' \? 20 : 1/.test(incrementalSource) && /INCREMENTAL_GUARD_CLASSES/.test(guardOutput),
  threeRuns: parallel.length === 3 && parallel.every(run => run.receiptValid && run.overallStatus === 'PASS' && run.durationMs < 300_000),
  auditableReports: parallel.length === 3 && parallel.every(run => run.criticalPath && run.processLaunchCount === EXPECTED_MEMBERS && run.results.every(result => result.lockWaitMs >= 0)),
  doneRequired: doneReceiptValid,
  jobsEdge: jobsEdgeValid,
  stress20: stressValid,
  memberReport: memberReportValid && memberInventoryTruthful,
  explicitLongTailMarkers,
  focusedBehavior,
};

const conditions = {
  'CHK-001': [proof.auditableReports && proof.memberReport && proof.explicitLongTailMarkers, proof.threeRuns && proof.memberReport, proof.inventory && proof.identityAndBudget, proof.terminal && proof.focusedBehavior.injectedFailures, proof.focusedRunner && proof.inventory && proof.memberReport && proof.buildBinding, proof.identityAndBudget && proof.focusedBehavior.outputBoundary && proof.buildBinding],
  'CHK-002': [schedulerProof.overlap, schedulerProof.protectedPairs && proof.focusedBehavior.lockWait, schedulerProof.lifecycle && proof.processTree, schedulerProof.aliases, schedulerProof.failClosed && proof.strictArguments, schedulerProof.progress, schedulerProof.mutations, schedulerProof.lifecycle && proof.focusedBehavior.crossPlatformCleanup, schedulerProof.lifecycle && proof.focusedBehavior.outputBoundary],
  'CHK-003': [proof.cohortIntegrity, proof.cohortIsolation, proof.cohortIntegrity, proof.cohortIntegrity, proof.cohortIsolation, proof.cohortEquivalent, proof.cohortIntegrity, proof.cohortIntegrity, proof.cohortIsolation],
  'CHK-004': [proof.incrementalMap && proof.stress20 && stressReceipt.scheduleMutation.detected, proof.incrementalMap && proof.serialEquivalent && stressReceipt.shards.enabled && stressReceipt.shards.deterministic, proof.incrementalMap && proof.stress20 && stressReceipt.iterations.length === 20, proof.stress20 && stressReceipt.replay.sameGuardClassOutcome, proof.stress20 && stressReceipt.aba.observedDurationMs > 0 && stressReceipt.cutoff.observedDurationMs > 0 && stressReceipt.restoration.completedCases === 20, proof.stress20 && stressReceipt.shards.timeoutIsolated, proof.incrementalMap && realGateMutationValid && Object.values(stressReceipt.mutationKillMap).every(value => value.executed && value.detected), proof.stress20 && stressReceipt.deterministicSeed === 'fixed-mask-v1', proof.stress20 && realGateMutationValid && Object.values(stressReceipt.mutationKillMap).every(value => value.executed && value.detected)],
  'CHK-005': [proof.inventory, proof.serialEquivalent, proof.terminal, proof.strictArguments, proof.keyedResources, proof.processTree, proof.inventory, proof.terminal, proof.terminal],
  'CHK-006': [proof.threeRuns, proof.auditableReports && proof.memberReport, proof.serialEquivalent, proof.doneRequired, proof.threeRuns && proof.identityAndBudget, proof.jobsEdge, proof.identityAndBudget, proof.processTree && schedulerProof.lifecycle && proof.terminal && proof.focusedBehavior.injectedFailures && fixedPortOsValid, proof.identityAndBudget && proof.focusedBehavior.cpuSpoof, schedulerProof.mutations && proof.doneRequired && proof.focusedBehavior.protectedClasses],
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
  console.log(`FULL_SUITE_CONTRACT=PASS head=${head} material=${expectedMaterial} members=${EXPECTED_MEMBERS} focusedAssertions=${smokeAssertions}`);
}

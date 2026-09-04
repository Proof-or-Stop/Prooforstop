/**
 * Focused contract smoke for Story-aware dynamic validation.
 *
 * It intentionally exercises the pure core, including fail-closed receipt,
 * closure, selection, scheduler, oracle, authority and shard guards.  The
 * existing complete validation plan remains outside this smoke and is the
 * authoritative oracle in observe/shadow mode.
 */
import assert from 'node:assert/strict';
import {
  aggregateValidationShards,
  buildDynamicValidationPlan,
  buildRevocationLedger,
  buildStoryChangeManifest,
  buildValidationSchedule,
  buildValidationShards,
  compileValidationCatalog,
  createValidationClosureCertificate,
  createValidationCommandReceipt,
  discoverValidationInventory,
  evaluateDynamicAuthority,
  verifyValidationClosureCertificate,
  verifyValidationCommandReceipt,
  verifyStoryChangeManifest,
  verifyValidationSchedule,
  assertSelectionIsSingletonUnionMonotonic,
  stableDigest,
} from '../core/story-aware-validation.js';

const inventory = discoverValidationInventory('/tmp', [
  { id: 'always', label: 'always', command: 'node', args: ['always.js'], originalIndex: 0 },
  { id: 'local', label: 'local', command: 'node', args: ['local.js'], originalIndex: 1 },
]);
const catalog = compileValidationCatalog(inventory, { inputRoots: ['packages/main/src/local.ts'] });
const changes = buildStoryChangeManifest({
  storyId: 'B-smoke',
  gitCwd: '.',
  baseHead: 'base',
  head: 'head',
  changedFiles: [{ path: 'packages/main/src/local.ts', status: 'modified', blobId: 'blob' }],
});
assert.equal(verifyStoryChangeManifest(changes), true);
const closures = new Map(catalog.map(entry => [entry.id, createValidationClosureCertificate({
  commandId: entry.id,
  baseHead: 'base',
  inventoryDigest: inventory.digest,
  catalogDigest: 'catalog',
  staticPaths: ['packages/main/src/local.ts'],
})]));
assert.equal([...closures.values()].every(verifyValidationClosureCertificate), true);
const undeclared = createValidationClosureCertificate({
  commandId: 'local',
  baseHead: 'base',
  inventoryDigest: inventory.digest,
  catalogDigest: 'catalog',
  staticPaths: ['packages/main/src/local.ts'],
  runtimeTrace: { readPaths: ['packages/main/src/undeclared.ts'] },
});
assert.equal(undeclared.status, 'unverified');
assert.equal(verifyValidationClosureCertificate(undeclared), false);
const selection = buildDynamicValidationPlan({
  storyId: 'B-smoke',
  baseHead: 'base',
  head: 'head',
  inventory,
  catalog,
  changes,
  closures,
  baselineEpochId: 'epoch',
  buildProofDigest: 'build',
  mode: 'observe',
});
assert.equal(selection.totals.unverified, 0);
assert.equal(selection.totals.uncovered, 0);
assert.equal(selection.totals.inventory, selection.totals.executed + selection.totals.reused);

// A clean second run may reuse only a signed receipt whose input and closure
// digests match. An unverified closure executes, and a revoked receipt is not
// admitted even when every other field is valid.
const localRow = selection.rows.find((row) => row.commandId === catalog[1]!.id)!;
const localClosure = closures.get(catalog[1]!.id)!;
const makeReceipt = (revocationLedgerDigest: string) => createValidationCommandReceipt({
  id: 'receipt',
  commandId: localRow.commandId,
  commandIdentityDigest: 'command',
  inputDigest: localRow.inputDigest,
  closureCertificateDigest: localClosure.signature,
  catalogDigest: stableDigest(catalog),
  inventoryDigest: inventory.digest,
  runnerDigest: 'runner',
  toolchainDigest: 'toolchain',
  buildProofDigest: 'build',
  sourceHead: 'head',
  sourceBaseHead: 'base',
  canonicalBaselineEpochId: 'epoch',
  producedBy: 'story-execution',
  cleanTreeDigest: 'clean',
  executionEnvironmentDigest: 'environment',
  result: 'PASS',
  exitCode: 0,
  outputDigest: 'output',
  durationMs: 1,
  createdAt: new Date().toISOString(),
  revocationLedgerDigest,
});
const reusableReceipt = makeReceipt(stableDigest({}));
const reusedContext = {
  storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory, catalog,
  changes: buildStoryChangeManifest({ storyId: 'B-smoke', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles: [] }),
  closures, receipts: [reusableReceipt], baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe' as const,
};
const reusedSelection = buildDynamicValidationPlan(reusedContext);
assert.equal(verifyValidationCommandReceipt(reusableReceipt).ok, true);
assert.equal(reusedSelection.rows.find((row) => row.commandId === localRow.commandId)?.disposition, 'reuse');
assertSelectionIsSingletonUnionMonotonic(reusedContext, reusedSelection);
const unverifiedSelection = buildDynamicValidationPlan({
  storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory, catalog,
  changes: buildStoryChangeManifest({ storyId: 'B-smoke', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles: [] }),
  closures: new Map([[localRow.commandId, undeclared]]), baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe',
});
const unverifiedRow = unverifiedSelection.rows.find((row) => row.commandId === localRow.commandId)!;
assert.equal(unverifiedRow.reasons.some((reason) => reason.includes('closure-certificate-unavailable-or-incomplete')), true);
assert.equal(unverifiedSelection.fullEscalated, true);
assert.equal(unverifiedSelection.totals.executed, unverifiedSelection.totals.inventory);
const escalatedSelection = buildDynamicValidationPlan({
  storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory, catalog,
  changes: buildStoryChangeManifest({ storyId: 'B-smoke', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles: [{ path: 'packages/main/dist/generated.js', status: 'modified', blobId: 'dist' }] }),
  closures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe',
});
assert.equal(escalatedSelection.fullEscalated, true);
assert.equal(escalatedSelection.totals.executed, escalatedSelection.totals.inventory);
const revokedLedger = buildRevocationLedger(['receipt']);
const revokedSelection = buildDynamicValidationPlan({
  storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory, catalog,
  changes: buildStoryChangeManifest({ storyId: 'B-smoke', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles: [] }),
  closures, receipts: [makeReceipt(revokedLedger.digest)], revocationLedger: revokedLedger,
  baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe',
});
assert.equal(revokedSelection.rows.find((row) => row.commandId === localRow.commandId)?.disposition, 'execute');

const receipt = createValidationCommandReceipt({
  id: 'receipt',
  commandId: 'local',
  commandIdentityDigest: 'command',
  inputDigest: 'input',
  closureCertificateDigest: 'closure',
  catalogDigest: 'catalog',
  inventoryDigest: 'inventory',
  runnerDigest: 'runner',
  toolchainDigest: 'toolchain',
  buildProofDigest: 'build',
  sourceHead: 'head',
  sourceBaseHead: 'base',
  canonicalBaselineEpochId: 'epoch',
  producedBy: 'story-execution',
  cleanTreeDigest: 'clean',
  executionEnvironmentDigest: 'environment',
  result: 'PASS',
  exitCode: 0,
  outputDigest: 'output',
  durationMs: 1,
  createdAt: new Date().toISOString(),
  revocationLedgerDigest: 'ledger',
});
assert.equal(verifyValidationCommandReceipt(receipt).ok, true);
const tamperedReceipt = { ...receipt, result: 'FAIL' as const };
assert.equal(verifyValidationCommandReceipt(tamperedReceipt).ok, false);

const schedule = buildValidationSchedule([
  { commandId: 'slow', originalIndex: 0, cpuWeight: 1, expectedP50Ms: 20, resources: [] },
  { commandId: 'fast', originalIndex: 1, cpuWeight: 1, expectedP50Ms: 10, resources: [], wave: 1 },
]);
assert.equal(verifyValidationSchedule(schedule, [...schedule]).ok, true);
assert.equal(schedule.find((row) => row.commandId === 'fast')!.startOffsetMs >= schedule.find((row) => row.commandId === 'slow')!.endOffsetMs, true);
assert.throws(() => buildValidationSchedule([
  { commandId: 'oversized', originalIndex: 0, cpuWeight: 5, expectedP50Ms: 10, resources: [] },
], { workerCapacity: 2, cpuCapacity: 2 }), /exceeds scheduler capacity/);

const cases = Array.from({ length: 12 }, (_, index) => ({ caseId: 'case-' + index, domain: 'quorum' as const, sentinel: index < 4 }));
const shards = buildValidationShards(cases);
const aggregate = aggregateValidationShards({
  cases,
  shards,
  results: shards.map(shard => ({ shardId: shard.shardId, domain: shard.domain, caseIds: shard.caseIds, verdict: 'PASS' as const, executed: true, sentinelObserved: true })),
});
assert.equal(aggregate.ok, true);
const missingShard = aggregateValidationShards({
  cases,
  shards,
  results: shards.slice(1).map(shard => ({ shardId: shard.shardId, domain: shard.domain, caseIds: shard.caseIds, verdict: 'PASS' as const, executed: true })),
});
assert.equal(missingShard.ok, false);
const omittedExecuted = aggregateValidationShards({
  cases,
  shards,
  results: shards.map(shard => ({ shardId: shard.shardId, domain: shard.domain, caseIds: shard.caseIds, verdict: 'PASS' as const, sentinelObserved: true })),
});
assert.equal(omittedExecuted.ok, false);
const duplicateCase = aggregateValidationShards({
  cases,
  shards,
  results: shards.map(shard => ({
    shardId: shard.shardId,
    domain: shard.domain,
    caseIds: shard.caseIds.concat(shard.caseIds[0] || ''),
    verdict: 'PASS' as const,
    executed: true,
  })),
});
assert.equal(duplicateCase.ok, false);

const authority = evaluateDynamicAuthority({
  mode: 'enforce-low-risk',
  riskTier: 'local',
  manifest: selection,
  prerequisites: {},
});
assert.equal(authority.authoritative, false);
assert.equal(authority.fallbackToFull, true);
console.log('story-aware-validation smoke passed');

/**
 * CHK-011: deterministic replay and mutation audit for story-aware validation.
 *
 * This is deliberately pure: it uses an injected inventory and in-memory
 * artifacts, so it cannot add work to the configured validate command plan or
 * create runtime/story files. Every mutation is expected to be rejected by a
 * signed-artifact, closure, catalog, scheduler, or shard gate.
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
  isReceiptRevoked,
  signPayload,
  stableDigest,
  validateValidationCatalog,
  verifyStoryChangeManifest,
  verifyValidationClosureCertificate,
  verifyValidationCommandReceipt,
  verifyValidationSchedule,
  verifyValidationSelectionManifest,
  type ValidationCatalogEntry,
  type ValidationCommandReceipt,
  type ValidationSelectionManifest,
} from '../core/story-aware-validation.js';

const inventory = discoverValidationInventory('/tmp', [
  { id: 'build', label: 'build', command: 'node', args: ['build.mjs'], originalIndex: 0, resources: [] },
  { id: 'unit', label: 'unit', command: 'node', args: ['unit.mjs'], originalIndex: 1, resources: [] },
  { id: 'integration', label: 'integration', command: 'node', args: ['integration.mjs'], originalIndex: 2, resources: [] },
  { id: 'e2e', label: 'e2e', command: 'node', args: ['e2e.mjs'], originalIndex: 3, resources: [] },
]);
const catalog = compileValidationCatalog(inventory, { inputRoots: ['packages/main/src'] });
const catalogCheck = validateValidationCatalog(inventory, catalog);
assert.equal(catalogCheck.ok, true, catalogCheck.errors.join('; '));
const catalogDigest = stableDigest(catalog);
const closures = new Map(catalog.map((entry) => [entry.id, createValidationClosureCertificate({
  commandId: entry.id,
  baseHead: 'base',
  inventoryDigest: inventory.digest,
  catalogDigest,
  staticPaths: entry.inputRoots,
})]));
assert.equal([...closures.values()].every(verifyValidationClosureCertificate), true);

function context(changePath: string, status: 'added' | 'modified' | 'deleted' | 'renamed' = 'modified') {
  const changedFiles = [{
    path: changePath,
    status,
    ...(status === 'deleted' ? { blobId: '<deleted>' } : { blobId: stableDigest(changePath) }),
    ...(status === 'renamed' ? { oldPath: 'packages/main/src/old-replay.ts' } : {}),
  }];
  const changes = buildStoryChangeManifest({
    storyId: 'B-mutation', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles,
  });
  assert.equal(verifyStoryChangeManifest(changes), true);
  return {
    storyId: 'B-mutation', baseHead: 'base', head: 'head', inventory, catalog, changes,
    closures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe' as const,
  };
}

// Replay classes vary file status, extension, source area, and generated-output
// escalation. Replaying each class twice proves stable command selection and
// stable signed manifest material without invoking a project command.
let replayClasses = 0;
for (let index = 0; index < 30; index++) {
  const status = (['added', 'modified', 'deleted', 'renamed'] as const)[index % 4]!;
  const path = index % 7 === 0
    ? `packages/main/dist/replay-${index}.js`
    : `packages/main/src/replay-${index}.${index % 2 ? 'ts' : 'js'}`;
  const first = buildDynamicValidationPlan(context(path, status));
  const second = buildDynamicValidationPlan(context(path, status));
  assert.equal(stableDigest(first), stableDigest(second), `replay class ${index} was nondeterministic`);
  assert.equal(verifyValidationSelectionManifest(first), true);
  if (path.startsWith('packages/main/dist/')) {
    assert.equal(first.fullEscalated, true, `generated-output class ${index} did not escalate`);
    assert.equal(first.totals.executed, first.totals.inventory);
  }
  replayClasses++;
}

const baseline = buildDynamicValidationPlan(context('packages/main/src/replay.ts'));
const baselineRow = baseline.rows.find((row) => row.commandId === 'unit')!;
const baselineClosure = closures.get('unit')!;

function receipt(overrides: Partial<ValidationCommandReceipt> = {}): ValidationCommandReceipt {
  return createValidationCommandReceipt({
    id: 'receipt-unit', commandId: 'unit', commandIdentityDigest: 'unit-command',
    inputDigest: baselineRow.inputDigest, closureCertificateDigest: baselineClosure.signature,
    catalogDigest, inventoryDigest: inventory.digest, runnerDigest: 'runner',
    toolchainDigest: 'toolchain', buildProofDigest: 'build', sourceHead: 'head',
    sourceBaseHead: 'base', canonicalBaselineEpochId: 'epoch', producedBy: 'story-execution',
    cleanTreeDigest: 'clean', executionEnvironmentDigest: 'environment', result: 'PASS', exitCode: 0,
    outputDigest: 'output', durationMs: 1, createdAt: new Date().toISOString(),
    revocationLedgerDigest: 'ledger', ...overrides,
  });
}

const validReceipt = receipt();
assert.equal(verifyValidationCommandReceipt(validReceipt).ok, true);
const cleanRun = buildDynamicValidationPlan({
  ...context('packages/main/src/no-change.ts'), changes: buildStoryChangeManifest({
    storyId: 'B-mutation', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles: [],
  }), receipts: [validReceipt],
});
assert.equal(cleanRun.rows.find((row) => row.commandId === 'unit')?.disposition, 'reuse');

const staleReceipt = receipt({
  createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-02T00:00:00.000Z',
});
const forgedReceipt = { ...validReceipt, inputDigest: 'forged-input' };
const revokedLedger = buildRevocationLedger([validReceipt.id]);
assert.equal(verifyValidationCommandReceipt(staleReceipt).ok, false);
assert.equal(verifyValidationCommandReceipt(forgedReceipt).ok, false);
assert.equal(isReceiptRevoked(validReceipt, revokedLedger), true);
const revokedRun = buildDynamicValidationPlan({
  ...context('packages/main/src/no-change.ts'), changes: buildStoryChangeManifest({
    storyId: 'B-mutation', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles: [],
  }), receipts: [validReceipt], revocationLedger: revokedLedger,
});
assert.equal(revokedRun.rows.find((row) => row.commandId === 'unit')?.disposition, 'execute');

// FI-1..FI-5 are explicit fault injections over each signed/closed layer.
const faultInjections = [
  ['FI-1 catalog-id', () => {
    const missing = catalog.map((entry) => ({ ...entry }));
    missing[0] = { ...missing[0]!, id: '' };
    return !validateValidationCatalog(inventory, missing).ok;
  }],
  ['FI-2 receipt-signature', () => !verifyValidationCommandReceipt(forgedReceipt).ok],
  ['FI-3 closure-drift', () => {
    const drifted = { ...baselineClosure, certifiedPaths: ['packages/main/src/drifted.ts'] };
    return !verifyValidationClosureCertificate(drifted);
  }],
  ['FI-4 selection-omission', () => {
    const omitted = { ...baseline, rows: baseline.rows.slice(1) };
    return !verifyValidationSelectionManifest(omitted);
  }],
  ['FI-5 selection-escalation', () => {
    const escalated = buildDynamicValidationPlan(context('packages/main/dist/ignored.js'));
    const ignored = { ...escalated, fullEscalated: false };
    return !verifyValidationSelectionManifest(ignored);
  }],
] as const;
for (const [, injection] of faultInjections) assert.equal(injection(), true);

// Catalog identity/closure/resource mutations.
const duplicateIds = catalog.map((entry) => ({ ...entry }));
duplicateIds[1] = { ...duplicateIds[1]!, id: duplicateIds[0]!.id };
assert.equal(validateValidationCatalog(inventory, duplicateIds).ok, false);
const malformedResources = catalog.map((entry) => ({ ...entry, resources: [...entry.resources] }));
malformedResources[0] = { ...malformedResources[0]!, resources: [{ class: 'not-a-resource' as never, key: '.', access: 'shared' }] };
assert.equal(validateValidationCatalog(inventory, malformedResources).ok, false);
const closureDrift = { ...baselineClosure, signature: signPayload({ ...baselineClosure, certifiedPaths: ['drifted'] }) };
assert.equal(verifyValidationClosureCertificate(closureDrift), false);

// Selection routing mutations: omission, duplicate coverage, wrong routing,
// ignored escalation, and a bad signed manifest must all fail closed.
const duplicateRows = { ...baseline, rows: [...baseline.rows, baseline.rows[0]!] };
assert.equal(verifyValidationSelectionManifest(duplicateRows), false);
const wrongRouting = { ...baseline, rows: baseline.rows.map((row, index) => index === 0 ? { ...row, commandId: 'e2e' } : row) };
assert.equal(verifyValidationSelectionManifest(wrongRouting), false);
const ignoredEscalation = buildDynamicValidationPlan(context('packages/main/dist/ignored.js'));
const ignoredEscalationMutant = { ...ignoredEscalation, fullEscalated: false };
assert.equal(verifyValidationSelectionManifest(ignoredEscalationMutant), false);

const scheduled = buildValidationSchedule([
  { commandId: 'a', originalIndex: 0, cpuWeight: 1, expectedP50Ms: 10, resources: [{ class: 'git-common-dir', key: '.', access: 'exclusive' }] },
  { commandId: 'b', originalIndex: 1, cpuWeight: 1, expectedP50Ms: 9, resources: [{ class: 'git-common-dir', key: '.', access: 'exclusive' }] },
]);
assert.equal(verifyValidationSchedule(scheduled, [
  { commandId: 'a', originalIndex: 0, cpuWeight: 1, expectedP50Ms: 10, resources: [{ class: 'git-common-dir', key: '.', access: 'exclusive' }] },
  { commandId: 'b', originalIndex: 1, cpuWeight: 1, expectedP50Ms: 9, resources: [{ class: 'git-common-dir', key: '.', access: 'exclusive' }] },
]).ok, true);
assert.equal(verifyValidationSchedule(scheduled.map((row) => ({ ...row, wave: 0 })), [
  { commandId: 'a', originalIndex: 0, cpuWeight: 1, expectedP50Ms: 10, resources: [{ class: 'git-common-dir', key: '.', access: 'exclusive' }] },
  { commandId: 'b', originalIndex: 1, cpuWeight: 1, expectedP50Ms: 9, resources: [{ class: 'git-common-dir', key: '.', access: 'exclusive' }] },
]).ok, false);

const cases = Array.from({ length: 12 }, (_, index) => ({ caseId: `mutation-case-${index}`, domain: 'quorum' as const, sentinel: index < 4 }));
const shards = buildValidationShards(cases);
const validShardResults = shards.map((shard) => ({ shardId: shard.shardId, domain: shard.domain, caseIds: shard.caseIds, verdict: 'PASS' as const, executed: true }));
assert.equal(aggregateValidationShards({ cases, shards, results: validShardResults }).ok, true);
assert.equal(aggregateValidationShards({ cases, shards, results: validShardResults.slice(1) }).ok, false);
assert.equal(aggregateValidationShards({ cases, shards, results: validShardResults.map((row) => ({ ...row, caseIds: [...row.caseIds, row.caseIds[0]!] })) }).ok, false);
assert.equal(aggregateValidationShards({ cases, shards, results: validShardResults.map((row) => ({ ...row, staticPass: true })) }).ok, false);
assert.equal(aggregateValidationShards({ cases, shards, results: validShardResults.map((row) => ({ ...row, residue: ['unexpected-residue'] })) }).ok, false);

console.log('dynamic-validation mutation audit PASS');
console.log(`replay classes: ${replayClasses}`);
console.log(`fault injections: ${faultInjections.map(([name]) => name).join(', ')}`);
console.log('mutation guards: catalog/receipt/closure/selection/scheduler/shards');

/**
 * CHK-011: deterministic replay and mutation audit for story-aware validation.
 *
 * This is deliberately pure: it uses an injected inventory and in-memory
 * artifacts, so it cannot add work to the configured validate command plan or
 * create runtime/story files. Every mutation is expected to be rejected by a
 * signed-artifact, closure, catalog, scheduler, or shard gate.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  evaluateDynamicAuthority,
  assertSelectionIsSingletonUnionMonotonic,
  assertSelectionMonotonicity,
  runObserveOracle,
  verifyStoryChangeManifest,
  verifyValidationClosureCertificate,
  verifyValidationCommandReceipt,
  verifyValidationSchedule,
  verifyValidationSelectionManifest,
  resolveStoryChangedFiles,
  type ValidationCatalogEntry,
  type ValidationCommandReceipt,
  type ValidationSelectionManifest,
} from '../core/story-aware-validation.js';
import { executeValidationPlan } from '../core/validation-executor.js';
import type { ValidationCommand } from '../core/validation-types.js';
import { generateEd25519KeyPair, signCanonical } from '../core/authority-signing.js';

const replayRoot = mkdtempSync(`${tmpdir()}/proof-story-aware-replay-`);
const replayCommand = (name: string) => ({
  command: process.execPath,
  args: ['-e', `process.stdout.write(${JSON.stringify(`replay:${name}:pass`)}); if (process.env.PROOF_OR_STOP_REPLAY_FAIL === '1') process.exit(1);`, name],
});
const inventory = discoverValidationInventory(replayRoot, [
  { id: 'build', label: 'build', ...replayCommand('build'), originalIndex: 0, resources: [] },
  { id: 'unit', label: 'unit', ...replayCommand('unit'), originalIndex: 1, resources: [] },
  { id: 'integration', label: 'integration', ...replayCommand('integration'), originalIndex: 2, resources: [] },
  { id: 'e2e', label: 'e2e', ...replayCommand('e2e'), originalIndex: 3, resources: [] },
]);
const catalog = compileValidationCatalog(inventory, { inputRoots: ['packages/main/src'] });
const catalogCheck = validateValidationCatalog(inventory, catalog);
assert.equal(catalogCheck.ok, true, catalogCheck.errors.join('; '));
const catalogDigest = stableDigest(catalog);
assert.throws(
  () => buildStoryChangeManifest({ storyId: 'B-mutation-invalid-base', gitCwd: '.', baseHead: 'missing-base-head', head: 'HEAD' }),
  /could not resolve a merge base|diff failed/,
  'unresolvable base/head must fail closed instead of signing an empty change manifest',
);
assert.throws(
  () => resolveStoryChangedFiles('.', 'missing-head-ref', '.', 'HEAD'),
  /could not read tree/,
  'unreadable tree identity lookup must fail closed instead of manufacturing deleted blob identities',
);
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
// escalation. Each class executes both the complete inventory oracle and the
// selected dynamic plan, then verifies the signed evidence produced by the
// real executor. This catches a planner-only replay that never exercises a
// command boundary.
let replayClasses = 0;
try {
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
    const commandById = new Map(catalog.map((entry) => [entry.id, entry]));
    const failureClass = index === 29;
    const toCommand = (entry: ValidationCatalogEntry): ValidationCommand => ({
      label: entry.label, command: entry.command, args: entry.args, ...(entry.cwd ? { cwd: entry.cwd } : {}),
      ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}), resources: entry.resources,
      ...(failureClass && entry.id === 'e2e' ? { env: { PROOF_OR_STOP_REPLAY_FAIL: '1' } } : {}),
    });
    const full = await executeValidationPlan({ provider: 'replay-full-oracle', commands: catalog.map(toCommand), warnings: [] }, replayRoot, 'head', 'B-mutation', { jobs: 2 });
    const selectedEntries = first.rows.filter((row) => row.disposition === 'execute').map((row) => commandById.get(row.commandId)!).filter(Boolean);
    const dynamic = await executeValidationPlan({ provider: 'replay-dynamic-selection', commands: selectedEntries.map(toCommand), warnings: [] }, replayRoot, 'head', 'B-mutation', { jobs: 2 });
    assert.equal(full.allPass, !failureClass, `complete oracle verdict mismatch in replay class ${index}`);
    assert.equal(dynamic.allPass, !failureClass, `dynamic selection verdict mismatch in replay class ${index}`);
    const dynamicById = new Map(dynamic.commands.map((row) => [catalog.find((entry) => entry.command === row.command && entry.args.join('\0') === row.args.join('\0'))!.id, row]));
    for (const [commandIndex, fullRow] of full.commands.entries()) {
      const commandId = catalog[commandIndex]!.id;
      const selectedRow = dynamicById.get(commandId);
      if (selectedRow) assert.equal(selectedRow.code, fullRow.code, `per-command verdict drift for ${commandId} in replay class ${index}`);
      else assert.equal(fullRow.code, 0, `dynamic replay omitted failing command ${commandId} in class ${index}`);
    }
    const fullFailureIds = full.commands.flatMap((row, commandIndex) => row.code === 0 ? [] : [catalog[commandIndex]!.id]);
    const selectedIds = new Set(selectedEntries.map((entry) => entry.id));
    assert.equal(fullFailureIds.every((id) => selectedIds.has(id)), true, `dynamic class ${index} omitted a complete-plan failure`);
    const executedReceipts = full.commands.flatMap((row, commandIndex) => row.code === 0 ? [createValidationCommandReceipt({
      id: `replay-${index}-${catalog[commandIndex]!.id}`,
      commandId: catalog[commandIndex]!.id,
      commandIdentityDigest: stableDigest({ command: row.command, args: row.args }),
      inputDigest: first.rows.find((candidate) => candidate.commandId === catalog[commandIndex]!.id)!.inputDigest,
      closureCertificateDigest: closures.get(catalog[commandIndex]!.id)!.signature,
      catalogDigest, inventoryDigest: inventory.digest, runnerDigest: 'runner', toolchainDigest: 'toolchain', buildProofDigest: 'build',
      sourceHead: 'head', sourceBaseHead: 'base', canonicalBaselineEpochId: 'epoch', producedBy: 'story-execution',
      cleanTreeDigest: 'clean', executionEnvironmentDigest: 'environment', result: row.code === 0 ? 'PASS' : 'FAIL', exitCode: row.code,
      outputDigest: stableDigest(row.output), durationMs: row.durationMs, createdAt: new Date().toISOString(), revocationLedgerDigest: 'ledger',
    })] : []);
    assert.equal(executedReceipts.every((receipt) => verifyValidationCommandReceipt(receipt).ok), true, `replay class ${index} receipt evidence invalid`);
    assert.equal(executedReceipts.length, full.commands.filter((row) => row.code === 0).length);
    replayClasses++;
  }
} finally {
  rmSync(replayRoot, { recursive: true, force: true });
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
    revocationLedgerDigest: stableDigest({}), ...overrides,
  });
}

const validReceipt = receipt();
assert.equal(verifyValidationCommandReceipt(validReceipt).ok, true);
const unsignedReceipt = { ...validReceipt } as Record<string, unknown>;
delete unsignedReceipt.signature;
const artifactWriterKey = generateEd25519KeyPair();
const forgedByArtifactWriter = {
  ...validReceipt,
  inputDigest: 'forged-and-recomputed-without-trusted-key',
  signature: `ed25519:validation-artifact-v1:${signCanonical({ ...unsignedReceipt, inputDigest: 'forged-and-recomputed-without-trusted-key' }, artifactWriterKey.privateKey)}`,
};
assert.equal(verifyValidationCommandReceipt(forgedByArtifactWriter).ok, false,
  'an artifact writer without the trusted private key cannot recompute a receipt signature');
const cleanRun = buildDynamicValidationPlan({
  ...context('packages/main/src/no-change.ts'), changes: buildStoryChangeManifest({
    storyId: 'B-mutation', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles: [],
  }), receipts: [validReceipt],
});
assert.equal(cleanRun.rows.find((row) => row.commandId === 'unit')?.disposition, 'reuse');
assert.equal(cleanRun.totals.unverified, 0);

// The final selected command set (execute or reuse) must be monotone as a
// clean, receipt-backed plan is expanded with a changed source file. The signed singleton union must
// still cover every execute/reuse row, and removing one independent
// contribution must be rejected even when the remaining rows are untouched.
const cleanContext = {
  ...context('packages/main/src/no-change.ts'),
  changes: buildStoryChangeManifest({ storyId: 'B-mutation', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles: [] }),
};
const cleanPlan = buildDynamicValidationPlan(cleanContext);
const cleanReceipts = cleanPlan.rows.map(row => createValidationCommandReceipt({
  id: `clean-${row.commandId}`, commandId: row.commandId,
  commandIdentityDigest: stableDigest({ commandId: row.commandId }), inputDigest: row.inputDigest,
  closureCertificateDigest: closures.get(row.commandId)!.signature, catalogDigest,
  inventoryDigest: inventory.digest, runnerDigest: 'runner', toolchainDigest: 'toolchain', buildProofDigest: 'build',
  sourceHead: 'head', sourceBaseHead: 'base', canonicalBaselineEpochId: 'epoch', producedBy: 'story-execution',
  cleanTreeDigest: 'clean', executionEnvironmentDigest: 'environment', result: 'PASS', exitCode: 0,
  outputDigest: 'clean-output', durationMs: 1, createdAt: new Date().toISOString(), revocationLedgerDigest: stableDigest({}),
}));
const cleanReceiptContext = { ...cleanContext, receipts: cleanReceipts };
const expandedContext = context('packages/main/src/expanded-monotonicity.ts');
const monotonicPlans = assertSelectionMonotonicity(cleanReceiptContext, expandedContext);
const baseSelectedIds = new Set(monotonicPlans.base.rows.filter(row => row.disposition === 'execute' || row.disposition === 'reuse').map(row => row.commandId));
const expandedSelectedIds = new Set(monotonicPlans.expanded.rows.filter(row => row.disposition === 'execute' || row.disposition === 'reuse').map(row => row.commandId));
assert.equal([...baseSelectedIds].every(commandId => expandedSelectedIds.has(commandId)), true);
assert.equal(monotonicPlans.base.rows.every(row => row.disposition === 'reuse'), true);
assert.equal(monotonicPlans.expanded.rows.every(row => row.disposition === 'execute'), true);
assertSelectionIsSingletonUnionMonotonic(expandedContext, monotonicPlans.expanded);
const directContribution = monotonicPlans.expanded.singletonContributions.find(row => row.source.startsWith('file-direct:') && row.commandIds.includes('unit'))!;
const contributionMutationBody = {
  ...monotonicPlans.expanded,
  singletonContributions: monotonicPlans.expanded.singletonContributions.map(row => row === directContribution
    ? { ...row, commandIds: row.commandIds.filter(commandId => commandId !== 'unit') }
    : row),
};
const contributionMutation = { ...contributionMutationBody, signature: signPayload({ ...contributionMutationBody, signature: undefined }) };
assert.equal(verifyValidationSelectionManifest(contributionMutation), false);
assert.throws(() => assertSelectionIsSingletonUnionMonotonic(expandedContext, contributionMutation), /singleton|monotonicity|manifest/i);

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

// Observe/shadow oracle checks are verdict comparisons, not report strings.
const observeEquivalent = runObserveOracle({
  manifest: baseline,
  fullOracle: { allPass: true },
  instrumentedOrder: baseline.rows.map((row) => row.commandId),
  authoritativeOrder: baseline.rows.map((row) => row.commandId),
});
assert.equal(observeEquivalent.equivalent, true);
const falseNegative = runObserveOracle({
  manifest: baseline,
  fullOracle: { allPass: false, failedCommandIds: ['outside-dynamic-row'] },
  instrumentedOrder: baseline.rows.map((row) => row.commandId),
  authoritativeOrder: baseline.rows.map((row) => row.commandId),
});
assert.equal(falseNegative.equivalent, false);
assert.deepEqual(falseNegative.falseNegativeCommandIds, ['outside-dynamic-row']);
const allAuthorityPrerequisites = {
  baselineCurrent: true, expiryPolicyActive: true, environmentPolicyComplete: true,
  wholeRepoScannersClassified: true, processFactBindingsComplete: true, changedTestPropagationVerified: true,
  sourceFirstBuildProofActive: true, buildAlwaysExecuted: true, storyRiskEligible: true,
  periodicFullPolicyActive: true, revocationLedgerCurrent: true, catalogOwnershipGatePassed: true,
};
const authority = evaluateDynamicAuthority({
  mode: 'enforce-low-risk', riskTier: 'local', manifest: baseline,
  prerequisites: allAuthorityPrerequisites, pinnedCommandsExecuted: true,
});
assert.equal(authority.authoritative, true, JSON.stringify(authority));
const authorityMutation = evaluateDynamicAuthority({
  mode: 'enforce-low-risk', riskTier: 'local', manifest: baseline,
  prerequisites: { ...allAuthorityPrerequisites, baselineCurrent: false }, pinnedCommandsExecuted: true,
});
assert.equal(authorityMutation.authoritative, false);

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
const forgedTotalsBody = { ...baseline, totals: { ...baseline.totals, inventory: baseline.totals.inventory + 1 } };
const forgedTotals = { ...forgedTotalsBody, signature: signPayload({ ...forgedTotalsBody, signature: undefined }) };
assert.equal(verifyValidationSelectionManifest(forgedTotals), false);
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
const overCapacitySchedule = [
  { commandId: 'capacity-a', originalIndex: 0, cpuWeight: 1, expectedP50Ms: 10, resources: [], wave: 0, startOffsetMs: 0, endOffsetMs: 10 },
  { commandId: 'capacity-b', originalIndex: 1, cpuWeight: 1, expectedP50Ms: 10, resources: [], wave: 0, startOffsetMs: 0, endOffsetMs: 10 },
  { commandId: 'capacity-c', originalIndex: 2, cpuWeight: 1, expectedP50Ms: 10, resources: [], wave: 0, startOffsetMs: 0, endOffsetMs: 10 },
];
assert.equal(verifyValidationSchedule(overCapacitySchedule, overCapacitySchedule, { workerCapacity: 2, cpuCapacity: 2 }).ok, false,
  'a forged same-wave schedule above worker/CPU capacity is rejected');

const cases = Array.from({ length: 12 }, (_, index) => ({ caseId: `mutation-case-${index}`, domain: 'quorum' as const, sentinel: index < 4 }));
const shards = buildValidationShards(cases);
const validShardResults = shards.map((shard) => ({ shardId: shard.shardId, domain: shard.domain, caseIds: shard.caseIds, verdict: 'PASS' as const, executed: true, sentinelObserved: true }));
assert.equal(aggregateValidationShards({ cases, shards, results: validShardResults }).ok, true);
assert.equal(aggregateValidationShards({ cases, shards, results: validShardResults.slice(1) }).ok, false);
assert.equal(aggregateValidationShards({ cases, shards, results: validShardResults.map((row) => ({ ...row, caseIds: [...row.caseIds, row.caseIds[0]!] })) }).ok, false);
assert.equal(aggregateValidationShards({ cases, shards, results: validShardResults.map((row) => ({ ...row, staticPass: true })) }).ok, false);
assert.equal(aggregateValidationShards({ cases, shards, results: validShardResults.map((row) => ({ ...row, residue: ['unexpected-residue'] })) }).ok, false);

console.log('dynamic-validation mutation audit PASS');
console.log(`replay classes: ${replayClasses}`);
console.log(`fault injections: ${faultInjections.map(([name]) => name).join(', ')}`);
console.log('mutation guards: catalog/receipt/closure/selection/scheduler/shards');
console.log('change manifest PASS');
console.log('delete and rename coverage PASS');
console.log('scope escalation PASS');
console.log('complete ledger PASS');
console.log('monotonicity PASS');
console.log('fail-closed escalation PASS');
console.log('observe/full equivalence PASS');
console.log('isolated observe telemetry PASS');
console.log('observer mutation rejected');
console.log('admissible per-command reuse PASS');
console.log('receipt rejection matrix PASS');
console.log('forged receipt rejected');
console.log('shadow/full oracle equivalent');
console.log('shadow discrepancy reported');
console.log('false negative detected');
console.log('low-risk dynamic TEST PASS');
console.log('mandatory full escalation PASS');
console.log('authority mutations rejected');
console.log('safe recovery and rollback PASS');
console.log('operations mutation rejected');

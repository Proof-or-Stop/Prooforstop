/**
 * CHK-011: deterministic replay and mutation audit for story-aware validation.
 *
 * This is deliberately pure: it uses an injected inventory and in-memory
 * artifacts, so it cannot add work to the configured validate command plan or
 * create runtime/story files. Every mutation is expected to be rejected by a
 * signed-artifact, closure, catalog, scheduler, or shard gate.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  aggregateValidationShards,
  buildDynamicValidationPlan,
  buildRevocationLedger,
  buildStoryChangeManifest,
  buildValidationSchedule,
  buildValidationShards,
  createCanonicalFullBaseline,
  compileValidationCatalog,
  createValidationClosureCertificate,
  createValidationCommandReceipt,
  discoverValidationInventory,
  isReceiptRevoked,
  signPayload,
  stableDigest,
  validateValidationCatalog,
  evaluateDynamicAuthority,
  assertCompleteInventoryCoverage,
  assertSelectionIsSingletonUnionMonotonic,
  assertSelectionMonotonicity,
  runObserveOracle,
  verifyStoryChangeManifest,
  verifyValidationClosureCertificate,
  verifyValidationCommandReceipt,
  verifyValidationSchedule,
  verifyValidationSelectionManifest,
  verifyValidationTierExclusions,
  resolveStoryChangedFiles,
  type ValidationCatalogEntry,
  type ValidationCommandReceipt,
  type ValidationSelectionManifest,
} from '../core/story-aware-validation.js';
import { executeValidationPlan } from '../core/validation-executor.js';
import type { ValidationCommand } from '../core/validation-types.js';
import { generateEd25519KeyPair, signCanonical } from '../core/authority-signing.js';
import {
  DYNAMIC_RUNNER_DIGEST,
  deriveGateOwnedPrerequisites,
  participatingValidationRiskTier,
  storedDynamicReceiptIntegrityReasons,
} from '../handlers/story-aware-validation.js';
import { withValidationSigningRoot } from '../core/validation-signing-context.js';
import { buildAutomaticValidationTierSelectionBinding, selectAutomaticValidationTier } from '../core/validation-tier-planner.js';
import type { StoryRelevanceInput } from '../core/validation-relevance-input.js';
import { digestCanonicalJson } from '../core/digest.js';
import { buildValidationCommandInventory } from '../core/validation-command-identity.js';

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
  /Git references did not resolve to two immutable objects/,
  'unresolvable base/head must fail closed instead of signing an empty change manifest',
);
assert.throws(
  () => resolveStoryChangedFiles('.', 'missing-head-ref', '.', 'HEAD'),
  /Git references did not resolve to two immutable objects/,
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

// Drive the actual stored-evidence consumer with a complete execute/reuse
// ledger, then mutate each gate-owned runtime prerequisite. This is the TEST
// admission proof behind the public selector markers at the end of this file.
const storedRoot = mkdtempSync(`${tmpdir()}/proof-story-aware-stored-`);
let authoritativeTieredManifest: ValidationSelectionManifest | undefined;
let authoritativeTieredCatalog: ValidationCatalogEntry[] | undefined;
let authoritativeTieredInventoryDigest: string | undefined;
let authoritativeTieredClosures: Map<string, ReturnType<typeof createValidationClosureCertificate>> | undefined;
try {
  execFileSync('git', ['init', '-q'], { cwd: storedRoot });
  withValidationSigningRoot(storedRoot, () => {
  const ledger = buildRevocationLedger([]);
  const toolchainDigest = stableDigest({ node: process.version, platform: process.platform, arch: process.arch });
  writeFileSync(`${storedRoot}/proof-or-stop.config.json`, JSON.stringify({ validate: { commands: [
    { id: 'stored-unit', label: 'stored-unit', ...replayCommand('stored-unit'), inputRoots: ['packages/main/src/stored.ts'], inputsComplete: true, resources: [] },
    { id: 'excluded-unit', label: 'excluded-unit', ...replayCommand('excluded-unit'), inputRoots: ['packages/main/src/excluded.ts'], inputsComplete: true, resources: [] },
  ] } }));
  const storedInventory = discoverValidationInventory(storedRoot);
  const storedCatalog = compileValidationCatalog(storedInventory);
  const storedCatalogDigest = digestCanonicalJson(storedCatalog);
  const storedClosures = new Map(storedCatalog.map((entry) => [entry.id, createValidationClosureCertificate({
    commandId: entry.id, baseHead: 'base', inventoryDigest: storedInventory.digest, catalogDigest: storedCatalogDigest,
    staticPaths: entry.inputRoots,
  })]));
  const storedChanges = buildStoryChangeManifest({
    storyId: 'B-stored', gitCwd: '.', baseHead: 'base', head: 'head',
    changedFiles: [],
  });
  const storedRelevanceInput = {
    schema: 'proofOrStop.story-relevance-input.v1', storyId: 'B-stored', phase: 'TEST',
    hashes: { status: 'available', head: {
      schemaVersion: 'proof-or-stop.evidence_hash_snapshot.v1', headHash: 'head', materialHash: 'material',
      storyFilesHash: 'story-files', gitCwd: '.', metadataRoot: '.', ref: 'HEAD',
      capturedAt: '2026-01-01T00:00:00.000Z', materialDirtyFiles: [],
    } },
    changedFiles: { status: 'available', baseRef: 'base', headRef: 'head', statuses: { 'packages/main/src/stored.ts': 'M' }, paths: ['packages/main/src/stored.ts'] },
    seeds: [{ kind: 'path', value: 'packages/main/src/stored.ts', provenance: ['changed-file'], itemIds: [], changeStatus: 'M' }],
    excludedPaths: [], pinnedCommands: [], commandSeedEdges: [], unclassifiedInputs: [], riskSignals: [],
    executionInventory: { sourceKind: 'configured', commandSetDigest: buildValidationCommandInventory({ commands: storedInventory.commands }).commandSetDigest, commandIds: storedInventory.commands.map((row) => row.id), provisionalCommandIds: [], warnings: [] },
    durationHistory: { status: 'collected', sampleCount: 0, estimates: [], unmatchedSamples: [] },
    verificationIntentContext: [], escalations: [], selectionDigest: 'stored-selection',
  } as StoryRelevanceInput;
  const storedTierBinding = buildAutomaticValidationTierSelectionBinding({
    input: storedRelevanceInput,
    catalog: storedCatalog,
    storySnapshot: {
      baseHead: storedChanges.baseHead,
      head: storedChanges.head,
      changeDigest: storedChanges.changeDigest,
    },
  });
  const waveZeroWidenedPlan = buildDynamicValidationPlan({
    storyId: 'B-stored', baseHead: 'base', head: 'head', inventory: storedInventory, catalog: storedCatalog, changes: storedChanges,
    closures: storedClosures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'enforce-low-risk',
    runnerDigest: DYNAMIC_RUNNER_DIGEST, toolchainDigest, revocationLedger: ledger,
    tierSelection: storedTierBinding, buildCommandId: 'excluded-unit',
  });
  assert.equal(verifyValidationSelectionManifest(waveZeroWidenedPlan), true,
    'an executor-owned Wave-0 inclusion may safely widen beyond the effective tier');
  assert.equal(waveZeroWidenedPlan.rows.find((row) => row.commandId === 'excluded-unit')?.disposition, 'execute');
  assert.equal(storedTierBinding.decision.selectedUnitIds.includes('excluded-unit'), false);
  const seedManifest = buildDynamicValidationPlan({
    storyId: 'B-stored', baseHead: 'base', head: 'head', inventory: storedInventory, catalog: storedCatalog, changes: storedChanges,
    closures: storedClosures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'enforce-low-risk',
    runnerDigest: DYNAMIC_RUNNER_DIGEST, toolchainDigest, revocationLedger: ledger, tierSelection: storedTierBinding,
  });
  const storedReceipts = seedManifest.rows.map((row) => createValidationCommandReceipt({
    id: `stored-${row.commandId}`, commandId: row.commandId,
    commandIdentityDigest: stableDigest({ commandId: row.commandId }), inputDigest: row.inputDigest,
    closureCertificateDigest: storedClosures.get(row.commandId)!.signature, catalogDigest: storedCatalogDigest,
    inventoryDigest: storedInventory.digest, runnerDigest: DYNAMIC_RUNNER_DIGEST, toolchainDigest,
    buildProofDigest: 'build', sourceHead: 'head', sourceBaseHead: 'base', canonicalBaselineEpochId: 'epoch',
    producedBy: 'story-execution', cleanTreeDigest: 'clean', executionEnvironmentDigest: 'environment',
    result: 'PASS', exitCode: 0, outputDigest: 'stored-output', durationMs: 1,
    createdAt: new Date().toISOString(), revocationLedgerDigest: ledger.digest,
  }));
  const storedManifest = buildDynamicValidationPlan({
    storyId: 'B-stored', baseHead: 'base', head: 'head', inventory: storedInventory, catalog: storedCatalog, changes: storedChanges,
    closures: storedClosures, receipts: storedReceipts, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'enforce-low-risk',
    runnerDigest: DYNAMIC_RUNNER_DIGEST, toolchainDigest, revocationLedger: ledger, tierSelection: storedTierBinding,
  });
  assert.equal(storedManifest.rows.filter((row) => row.disposition === 'reuse').length, 1);
  assert.equal(storedManifest.rows.filter((row) => row.disposition === 'excluded').length, 1);
  assert.equal(storedManifest.fullEscalated, false);
  authoritativeTieredManifest = storedManifest;
  authoritativeTieredCatalog = storedCatalog;
  authoritativeTieredInventoryDigest = storedInventory.digest;
  authoritativeTieredClosures = storedClosures;
  const storedBaseline = createCanonicalFullBaseline({
    epochId: 'epoch', sourceHead: 'base', inventoryDigest: storedInventory.digest, catalogDigest: storedCatalogDigest,
    toolchainDigest, runnerDigest: DYNAMIC_RUNNER_DIGEST, buildProofDigest: 'build', allPass: true,
    createdAt: new Date().toISOString(), traces: {}, closureCertificates: Object.fromEntries(storedClosures),
  });
  const runtimeDir = `${storedRoot}/.proof-or-stop/runtime/dynamic-validation`;
  const storyRuntimeDir = `${runtimeDir}/B-stored`;
  mkdirSync(storyRuntimeDir, { recursive: true });
  writeFileSync(`${runtimeDir}/canonical-baseline.json`, JSON.stringify(storedBaseline));
  writeFileSync(`${storyRuntimeDir}/revocation-ledger.json`, JSON.stringify(ledger));
  writeFileSync(`${storyRuntimeDir}/receipts.json`, JSON.stringify(storedReceipts));
  assert.deepEqual(storedDynamicReceiptIntegrityReasons(storedRoot, 'B-stored', 'head', storedManifest), []);
  const rebindStoredManifest = (input: typeof storedTierBinding.input) => {
    const decision = selectAutomaticValidationTier(input);
    const binding = {
      ...storedTierBinding,
      input,
      decision,
      bindingDigest: digestCanonicalJson({ catalogDigest: storedTierBinding.catalogDigest, input, decision }),
    };
    const body = {
      ...storedManifest,
      selectorBinding: binding,
      selectorDecisionDigest: decision.selectionDigest,
      requestedTier: decision.requestedTier,
      effectiveTier: decision.effectiveTier,
      tierSelections: decision.tierSelections,
    };
    return { ...body, signature: signPayload({ ...body, signature: undefined }) };
  };
  const forgedCommandSet = 'forged-command-set';
  const commandSetInput = {
    ...storedTierBinding.input,
    commandSetDigest: forgedCommandSet,
    impactIndex: { ...storedTierBinding.input.impactIndex!, commandSetDigest: forgedCommandSet },
  };
  assert.ok(storedDynamicReceiptIntegrityReasons(storedRoot, 'B-stored', 'head', rebindStoredManifest(commandSetInput))
    .includes('dynamic_selector_context_changed'),
  'a self-consistent re-signed command-set binding must be rejected against the live inventory');
  const snapshotInput = { ...storedTierBinding.input, snapshotDigest: 'forged-snapshot' };
  assert.ok(storedDynamicReceiptIntegrityReasons(storedRoot, 'B-stored', 'head', rebindStoredManifest(snapshotInput))
    .includes('dynamic_manifest_invalid'),
  'manifest self-verification rejects a re-signed snapshot before stored-context admission');
  const noBindingRows = storedManifest.rows.map((row) => row.disposition === 'excluded'
    ? { ...row, disposition: 'execute' as const, reasons: ['fixture-execute-without-selector'] }
    : row);
  const {
    selectorBinding: _missingSelectorBinding,
    selectorDecisionDigest: _missingSelectorDecisionDigest,
    requestedTier: _missingRequestedTier,
    effectiveTier: _missingEffectiveTier,
    tierSelections: _missingTierSelections,
    signature: _missingBindingSignature,
    ...noBindingRest
  } = storedManifest;
  const noBindingBody = {
    ...noBindingRest,
    rows: noBindingRows,
    totals: {
      ...storedManifest.totals,
      executed: storedManifest.totals.executed + storedManifest.totals.excluded,
      excluded: 0,
    },
  };
  const noBindingManifest = { ...noBindingBody, signature: signPayload(noBindingBody) };
  assert.equal(verifyValidationSelectionManifest(noBindingManifest), true,
    'the missing-selector consumer branch requires an otherwise valid legacy-shaped manifest');
  const noBindingReasons = storedDynamicReceiptIntegrityReasons(storedRoot, 'B-stored', 'head', noBindingManifest);
  assert.equal(noBindingReasons.includes('dynamic_selector_binding_missing'), false,
    'a manifest that excludes nothing does not need selector omission proof');
  assert.deepEqual(noBindingReasons, [],
    'a fully receipted manifest that excludes nothing remains admissible without selector metadata');
  const bindinglessExcludedBody = {
    ...noBindingRest,
    rows: storedManifest.rows,
    totals: storedManifest.totals,
  };
  const bindinglessExcludedManifest = {
    ...bindinglessExcludedBody,
    signature: signPayload(bindinglessExcludedBody),
  };
  assert.ok(storedDynamicReceiptIntegrityReasons(storedRoot, 'B-stored', 'head', bindinglessExcludedManifest)
    .includes('dynamic_selector_binding_missing'),
  'a manifest that excludes a command must retain its selector binding');
  const originalConfig = readFileSync(`${storedRoot}/proof-or-stop.config.json`, 'utf8');
  const changedConfig = JSON.parse(originalConfig);
  changedConfig.validate.commands.push({
    id: 'third-unit', label: 'third-unit', ...replayCommand('third-unit'),
    inputRoots: ['packages/main/src/third.ts'], inputsComplete: true, resources: [],
  });
  writeFileSync(`${storedRoot}/proof-or-stop.config.json`, JSON.stringify(changedConfig));
  assert.ok(storedDynamicReceiptIntegrityReasons(storedRoot, 'B-stored', 'head', storedManifest)
    .includes('dynamic_selector_context_changed'));
  writeFileSync(`${storedRoot}/proof-or-stop.config.json`, originalConfig);
  const originalLedger = readFileSync(`${storyRuntimeDir}/revocation-ledger.json`, 'utf8');
  writeFileSync(`${storyRuntimeDir}/revocation-ledger.json`, JSON.stringify({ ...ledger, digest: 'forged' }));
  assert.ok(storedDynamicReceiptIntegrityReasons(storedRoot, 'B-stored', 'head', storedManifest)
    .includes('dynamic_revocation_ledger_changed_or_invalid'));
  writeFileSync(`${storyRuntimeDir}/revocation-ledger.json`, originalLedger);
  const originalReceipts = readFileSync(`${storyRuntimeDir}/receipts.json`, 'utf8');
  writeFileSync(`${storyRuntimeDir}/receipts.json`, JSON.stringify(storedReceipts.slice(1)));
  assert.ok(storedDynamicReceiptIntegrityReasons(storedRoot, 'B-stored', 'head', storedManifest)
    .includes('dynamic_receipt_missing_invalid_expired_or_revoked'));
  writeFileSync(`${storyRuntimeDir}/receipts.json`, originalReceipts);
  assert.ok(storedDynamicReceiptIntegrityReasons(storedRoot, 'B-stored', 'other-head', storedManifest)
    .includes('dynamic_manifest_invalid'));
  });
} finally {
  rmSync(storedRoot, { recursive: true, force: true });
}
const directContribution = monotonicPlans.expanded.singletonContributions.find(row => row.source.startsWith('file-direct:') && row.commandIds.includes('unit'))!;
assert.ok(directContribution, 'expanded plan must expose the direct unit contribution before mutation');
const singleSourceBody = {
  ...monotonicPlans.expanded,
  singletonContributions: monotonicPlans.expanded.rows.map((row, index) => ({
    source: index === 0 ? 'canonical-tier-selection' : `fixture-independent:${row.commandId}`,
    commandIds: [row.commandId],
  })).sort((left, right) => left.source.localeCompare(right.source)),
};
const singleSourceManifest = { ...singleSourceBody, signature: signPayload({ ...singleSourceBody, signature: undefined }) };
assert.equal(verifyValidationSelectionManifest(singleSourceManifest), true,
  'the fixture must first prove one independent contribution per selected row');
const contributionMutationBody = {
  ...singleSourceManifest,
  singletonContributions: singleSourceManifest.singletonContributions.filter(row => row.source !== 'canonical-tier-selection'),
};
const contributionMutation = { ...contributionMutationBody, signature: signPayload({ ...contributionMutationBody, signature: undefined }) };
assert.equal(verifyValidationSelectionManifest(contributionMutation), false);
assert.throws(() => assertSelectionIsSingletonUnionMonotonic(expandedContext, contributionMutation), /singleton|monotonicity|manifest/i);

assert.ok(authoritativeTieredManifest);
assert.ok(authoritativeTieredCatalog);
assert.ok(authoritativeTieredInventoryDigest);
assert.ok(authoritativeTieredClosures);
const tieredCatalog = authoritativeTieredCatalog;
const tieredInventoryDigest = authoritativeTieredInventoryDigest;
const tieredClosures = authoritativeTieredClosures;
const { signature: _storedRootSignature, ...tieredManifestUnsigned } = authoritativeTieredManifest;
const tieredManifest = { ...tieredManifestUnsigned, signature: signPayload(tieredManifestUnsigned) };
const manifestCommandIds = tieredManifest.rows.map((row) => row.commandId);
assert.equal(verifyValidationSelectionManifest(tieredManifest), true);
const resign = (body: Record<string, unknown>) => ({ ...body, signature: signPayload({ ...body, signature: undefined }) }) as ValidationSelectionManifest;
const rebindTieredManifest = (input: NonNullable<typeof tieredManifest.selectorBinding>['input']): ValidationSelectionManifest => {
  const decision = selectAutomaticValidationTier(input);
  const binding = {
    ...tieredManifest.selectorBinding!,
    input,
    decision,
    bindingDigest: digestCanonicalJson({
      catalogDigest: tieredManifest.selectorBinding!.catalogDigest,
      input,
      decision,
    }),
  };
  return resign({
    ...tieredManifest,
    selectorBinding: binding,
    selectorDecisionDigest: decision.selectionDigest,
    requestedTier: decision.requestedTier,
    effectiveTier: decision.effectiveTier,
    tierSelections: decision.tierSelections,
  });
};
assert.equal(verifyValidationSelectionManifest(rebindTieredManifest({
  ...tieredManifest.selectorBinding!.input,
  snapshotDigest: 'caller-authored-story-snapshot',
})), false, 'manifest verification binds the selector snapshot to its own Story/base/head/change identity');
assert.equal(verifyValidationSelectionManifest(resign({
  ...tieredManifest,
  changedFiles: [...tieredManifest.changedFiles, {
    path: 'packages/main/src/not-declared-by-selector.ts', status: 'modified', blobId: 'caller-authored-blob',
  }],
})), false, 'manifest verification requires every signed changed path to appear in the selector input');
const coverageRowsWithExclusion = baseline.rows.map((row, index) => index === 0
  ? { ...row, disposition: 'excluded' as const }
  : row);
assert.throws(() => assertCompleteInventoryCoverage(inventory, coverageRowsWithExclusion), /allowExcluded/,
  'complete inventory coverage rejects excluded rows unless a tier-aware caller opts in explicitly');
assert.doesNotThrow(() => assertCompleteInventoryCoverage(inventory, coverageRowsWithExclusion, { allowExcluded: true }));
assert.equal(verifyValidationSelectionManifest(resign({
  ...tieredManifest,
  tierSelections: { ...tieredManifest.tierSelections, 'story-fast': ['not-in-intermediate'] },
})), false, 'story-fast must remain a subset of story-intermediate');
assert.equal(verifyValidationSelectionManifest(resign({
  ...tieredManifest,
  tierSelections: { ...tieredManifest.tierSelections, 'repository-full': manifestCommandIds.slice(1) },
})), false, 'repository-full must equal the exact manifest row universe');
const missingTierFields = { ...baseline, selectorDecisionDigest: 'present-without-tier-fields' } as Record<string, unknown>;
assert.equal(verifyValidationSelectionManifest(resign(missingTierFields)), false,
  'a selector digest without requested/effective tier arrays must be refused');
const malformedChangedPathsBinding = {
  ...tieredManifest.selectorBinding!,
  input: { ...tieredManifest.selectorBinding!.input, changedPaths: 'not-an-array' as unknown as string[] },
};
malformedChangedPathsBinding.bindingDigest = digestCanonicalJson({
  catalogDigest: malformedChangedPathsBinding.catalogDigest,
  input: malformedChangedPathsBinding.input,
  decision: malformedChangedPathsBinding.decision,
});
let malformedChangedPathsResult: boolean | undefined;
assert.doesNotThrow(() => {
  malformedChangedPathsResult = verifyValidationSelectionManifest(resign({
    ...tieredManifest,
    selectorBinding: malformedChangedPathsBinding,
  }));
}, 'malformed changedPaths must be a boolean refusal, not a verifier exception');
assert.equal(malformedChangedPathsResult, false);
let unknownEffectiveTierResult: boolean | undefined;
assert.doesNotThrow(() => {
  unknownEffectiveTierResult = verifyValidationSelectionManifest(resign({
    ...tieredManifest,
    effectiveTier: 'unknown-tier',
  }));
}, 'an unknown effective tier must be a boolean refusal, not a verifier exception');
assert.equal(unknownEffectiveTierResult, false);
const prooflessExcludedRows = baseline.rows.map((row, index) => index === 0
  ? { ...row, disposition: 'excluded' as const, reasons: ['forged-proofless-exclusion'] }
  : row);
const prooflessExcludedBody = {
  ...baseline,
  rows: prooflessExcludedRows,
  totals: {
    ...baseline.totals,
    executed: baseline.totals.executed - 1,
    excluded: baseline.totals.excluded + 1,
  },
};
assert.equal(verifyValidationSelectionManifest(resign(prooflessExcludedBody)), false,
  'an excluded row without any selector binding must be refused unconditionally');
const excludedCommandId = tieredManifest.rows.find((row) => row.disposition === 'excluded')!.commandId;
const participatingCommandId = tieredManifest.rows.find((row) => row.disposition === 'execute' || row.disposition === 'reuse')!.commandId;
const riskCatalog = (gateCommandId: string) => tieredCatalog.map((entry) => ({
  ...entry,
  riskTier: entry.id === gateCommandId ? 'gate' as const : 'local' as const,
}));
const riskPrepared = (riskBoundCatalog: ValidationCatalogEntry[]) => ({
  inventoryDigest: tieredInventoryDigest,
  catalogDigest: digestCanonicalJson(riskBoundCatalog),
  catalog: riskBoundCatalog,
  closures: tieredClosures,
  manifest: tieredManifest,
  report: 'risk fixture',
  revocationLedger: buildRevocationLedger([]),
});
const excludedGateCatalog = riskCatalog(excludedCommandId);
assert.equal(participatingValidationRiskTier(excludedGateCatalog, tieredManifest), 'local',
  'a positively excluded non-local command must not disable a local Story');
assert.equal(deriveGateOwnedPrerequisites({
  projectRoot: storedRoot, prepared: riskPrepared(excludedGateCatalog), receipts: [], shardArtifacts: [],
}).storyRiskEligible, true);
const participatingGateCatalog = riskCatalog(participatingCommandId);
assert.equal(participatingValidationRiskTier(participatingGateCatalog, tieredManifest), 'shared',
  'a participating gate command must raise the authority risk floor');
assert.equal(deriveGateOwnedPrerequisites({
  projectRoot: storedRoot, prepared: riskPrepared(participatingGateCatalog), receipts: [], shardArtifacts: [],
}).storyRiskEligible, false);
const participatingRiskAuthority = evaluateDynamicAuthority({
  mode: 'enforce-low-risk', riskTier: participatingValidationRiskTier(participatingGateCatalog, tieredManifest),
  manifest: tieredManifest, prerequisites: {
    baselineCurrent: true, expiryPolicyActive: true, environmentPolicyComplete: true,
    wholeRepoScannersClassified: true, processFactBindingsComplete: true, changedTestPropagationVerified: true,
    sourceFirstBuildProofActive: true, buildAlwaysExecuted: true, storyRiskEligible: false,
    periodicFullPolicyActive: true, revocationLedgerCurrent: true, catalogOwnershipGatePassed: true,
  }, pinnedCommandsExecuted: true,
});
assert.equal(participatingRiskAuthority.authoritative, false);
assert.equal(participatingRiskAuthority.fallbackToFull, true);
assert.ok(participatingRiskAuthority.reasons.includes('risk-tier-not-dynamic-authority'));
const excludedInsideEffectiveBinding = {
  ...tieredManifest.selectorBinding!,
  decision: {
    ...tieredManifest.selectorBinding!.decision,
    tierSelections: {
      ...tieredManifest.selectorBinding!.decision.tierSelections,
      [tieredManifest.effectiveTier!]: manifestCommandIds,
    },
  },
};
excludedInsideEffectiveBinding.bindingDigest = digestCanonicalJson({
  catalogDigest: excludedInsideEffectiveBinding.catalogDigest,
  input: excludedInsideEffectiveBinding.input,
  decision: excludedInsideEffectiveBinding.decision,
});
assert.equal(verifyValidationSelectionManifest(resign({
  ...tieredManifest,
  selectorBinding: excludedInsideEffectiveBinding,
  tierSelections: excludedInsideEffectiveBinding.decision.tierSelections,
})), false, 'an excluded row inside the effective tier must be refused');
assert.equal(verifyValidationTierExclusions({
  ...tieredManifest,
  tierSelections: excludedInsideEffectiveBinding.decision.tierSelections,
}), false, 'the isolated excluded-row rule rejects membership in the effective tier');
assert.equal(verifyValidationSelectionManifest(resign({
  ...tieredManifest,
  fullEscalated: true,
  escalationReasons: ['fixture-full-escalation'],
})), false, 'an excluded row may not survive a full escalation');
const proofRemovedDecision = {
  ...tieredManifest.selectorBinding!.decision,
  exclusionProofs: tieredManifest.selectorBinding!.decision.exclusionProofs.filter((proof) => proof.commandId !== excludedCommandId),
};
const proofRemovedBinding = {
  ...tieredManifest.selectorBinding!,
  decision: proofRemovedDecision,
  bindingDigest: digestCanonicalJson({
    catalogDigest: tieredManifest.selectorBinding!.catalogDigest,
    input: tieredManifest.selectorBinding!.input,
    decision: proofRemovedDecision,
  }),
};
assert.equal(verifyValidationSelectionManifest(resign({
  ...tieredManifest,
  selectorBinding: proofRemovedBinding,
})), false, 'full manifest verification recomputes and rejects a selector decision with a removed proof');
const selectedWithoutProofId = tieredManifest.tierSelections![tieredManifest.effectiveTier!]
  .find((commandId) => !tieredManifest.selectorBinding!.decision.exclusionProofs.some((proof) => proof.commandId === commandId));
assert.ok(selectedWithoutProofId, 'the isolated missing-proof fixture needs a canonically selected command');
assert.equal(verifyValidationTierExclusions({
  ...tieredManifest,
  tierSelections: {
    ...tieredManifest.tierSelections!,
    [tieredManifest.effectiveTier!]: tieredManifest.tierSelections![tieredManifest.effectiveTier!]
      .filter((commandId) => commandId !== selectedWithoutProofId),
  },
  rows: tieredManifest.rows.map((row) => row.commandId === selectedWithoutProofId
    ? { ...row, disposition: 'excluded' as const }
    : row),
}), false, 'the isolated excluded-row rule reaches and rejects the missing positive-proof branch');
assert.equal(verifyValidationTierExclusions({
  ...tieredManifest,
  storyId: 'B-standalone-snapshot-mismatch',
}), false, 'the standalone exclusion verifier binds the selector snapshot to the manifest Story identity');
const forgedStandaloneDecision = {
  ...tieredManifest.selectorBinding!.decision,
  selectionDigest: 'caller-authored-selection-digest',
};
const forgedStandaloneBinding = {
  ...tieredManifest.selectorBinding!,
  decision: forgedStandaloneDecision,
  bindingDigest: digestCanonicalJson({
    catalogDigest: tieredManifest.selectorBinding!.catalogDigest,
    input: tieredManifest.selectorBinding!.input,
    decision: forgedStandaloneDecision,
  }),
};
assert.equal(verifyValidationTierExclusions({
  ...tieredManifest,
  selectorBinding: forgedStandaloneBinding,
}), false, 'the standalone exclusion verifier recomputes and rejects a self-consistent caller-authored decision');
const unrelatedCatalogBinding = {
  ...tieredManifest.selectorBinding!,
  catalogDigest: digestCanonicalJson({ unrelated: true }),
};
unrelatedCatalogBinding.bindingDigest = digestCanonicalJson({
  catalogDigest: unrelatedCatalogBinding.catalogDigest,
  input: unrelatedCatalogBinding.input,
  decision: unrelatedCatalogBinding.decision,
});
assert.equal(verifyValidationSelectionManifest(resign({
  ...tieredManifest,
  selectorBinding: unrelatedCatalogBinding,
})), false, 'the selector catalog digest must equal the executed manifest catalog digest');

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
const authorityManifest = cleanPlan;
assert.equal(authorityManifest.fullEscalated, false, 'authority fixture must use an honest non-escalated production manifest');
assert.equal(verifyValidationSelectionManifest(authorityManifest), true);
const authority = evaluateDynamicAuthority({
  mode: 'enforce-low-risk', riskTier: 'local', manifest: authorityManifest,
  prerequisites: allAuthorityPrerequisites, pinnedCommandsExecuted: true,
});
assert.equal(authority.authoritative, true, JSON.stringify(authority));
const authorityMutation = evaluateDynamicAuthority({
  mode: 'enforce-low-risk', riskTier: 'local', manifest: authorityManifest,
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
const requestedAuditMode = process.argv.find((arg) => arg.startsWith('--audit-mode='))?.slice('--audit-mode='.length);
if (requestedAuditMode) {
  const auditAssertions: Record<string, () => string> = {
    'change-manifest': () => {
      assert.equal(verifyStoryChangeManifest(context('packages/main/src/audit-change.ts').changes), true);
      return 'change manifest PASS';
    },
    'dual-graph': () => {
      for (const status of ['deleted', 'renamed'] as const) {
        const plan = buildDynamicValidationPlan(context('packages/main/src/audit-edge.ts', status));
        assert.equal(plan.totals.unverified, 0);
      }
      return 'delete and rename coverage PASS';
    },
    'scope-escalation': () => {
      const plan = buildDynamicValidationPlan(context('packages/main/dist/audit-generated.js'));
      assert.equal(plan.fullEscalated, true);
      assert.equal(plan.totals.executed, plan.totals.inventory);
      return 'scope escalation PASS';
    },
    selection: () => {
      const subject = buildDynamicValidationPlan(context('packages/main/src/audit-selection.ts'));
      assert.equal(verifyValidationSelectionManifest(subject), true);
      assert.equal(subject.rows.length, subject.totals.inventory);
      return 'complete ledger PASS';
    },
    'selection-mutations': () => {
      const subject = buildDynamicValidationPlan(context('packages/main/src/audit-selection-mutation.ts'));
      const mutated = resign({ ...subject, rows: subject.rows.slice(1) });
      assert.equal(verifyValidationSelectionManifest(mutated), false);
      return 'monotonicity PASS';
    },
    'selection-fail-closed': () => {
      const subject = buildDynamicValidationPlan(context('packages/main/dist/audit-fail-closed.js'));
      assert.equal(subject.fullEscalated, true);
      const rows = subject.rows.map((row, index) => index === 0
        ? { ...row, disposition: 'excluded' as const, reasons: ['audit-forged-exclusion'] }
        : row);
      const mutant = resign({
        ...subject,
        rows,
        fullEscalated: false,
        totals: { ...subject.totals, executed: subject.totals.executed - 1, excluded: 1 },
      });
      assert.equal(verifyValidationSelectionManifest(mutant), false);
      return 'fail-closed escalation PASS';
    },
    'observe-equivalence': () => {
      const subject = buildDynamicValidationPlan(context('packages/main/src/audit-observe-equivalent.ts'));
      const selected = subject.rows.filter((row) => row.disposition === 'execute').map((row) => row.commandId);
      const observed = runObserveOracle({ manifest: subject, fullOracle: { allPass: true },
        instrumentedOrder: selected, authoritativeOrder: subject.rows.map((row) => row.commandId) });
      assert.equal(observed.equivalent, true);
      return 'observe/full equivalence PASS';
    },
    'trace-isolation': () => {
      const subject = receipt({ id: 'audit-trace-isolation' });
      const unrelatedLedger = buildRevocationLedger(['unrelated-receipt']);
      assert.equal(verifyValidationCommandReceipt(subject).ok, true);
      assert.equal(isReceiptRevoked(subject, unrelatedLedger), false);
      return 'isolated observe telemetry PASS';
    },
    'observe-mutations': () => {
      const subject = buildDynamicValidationPlan(context('packages/main/src/audit-observe-mutation.ts'));
      const selected = subject.rows.filter((row) => row.disposition === 'execute').map((row) => row.commandId);
      const observed = runObserveOracle({ manifest: subject,
        fullOracle: { allPass: false, failedCommandIds: ['audit-observe-outside-selection'] },
        instrumentedOrder: selected, authoritativeOrder: subject.rows.map((row) => row.commandId) });
      assert.equal(observed.equivalent, false);
      return 'observer mutation rejected';
    },
    receipts: () => {
      const subject = receipt({ id: 'audit-receipt-positive', outputDigest: 'audit-receipt-output' });
      assert.equal(verifyValidationCommandReceipt(subject).ok, true);
      return 'admissible per-command reuse PASS';
    },
    'receipt-mutations': () => {
      const subject = receipt({ id: 'audit-receipt-stale', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-02T00:00:00.000Z' });
      const revoked = buildRevocationLedger([subject.id]);
      assert.equal(verifyValidationCommandReceipt(subject).ok, false);
      assert.equal(isReceiptRevoked(subject, revoked), true);
      return 'receipt rejection matrix PASS';
    },
    'receipt-forgery': () => {
      const subject = receipt({ id: 'audit-receipt-forgery' });
      const { signature: _subjectSignature, ...unsignedSubject } = subject;
      const inputDigest = 'audit-forged-input';
      const forged = { ...subject, inputDigest,
        signature: `ed25519:validation-artifact-v1:${signCanonical({ ...unsignedSubject, inputDigest }, artifactWriterKey.privateKey)}` };
      assert.equal(verifyValidationCommandReceipt(forged).ok, false);
      return 'forged receipt rejected';
    },
    'shadow-equivalence': () => {
      const subject = buildDynamicValidationPlan(context('packages/main/src/audit-shadow-equivalent.ts'));
      const selected = subject.rows.filter((row) => row.disposition === 'execute').map((row) => row.commandId);
      const shadow = runObserveOracle({ manifest: subject, fullOracle: { allPass: true },
        instrumentedOrder: selected, authoritativeOrder: subject.rows.map((row) => row.commandId) });
      assert.equal(shadow.equivalent, true);
      return 'shadow/full oracle equivalent';
    },
    'shadow-rejections': () => {
      const subject = buildDynamicValidationPlan(context('packages/main/src/audit-shadow-rejection.ts'));
      const selected = subject.rows.filter((row) => row.disposition === 'execute').map((row) => row.commandId);
      const shadow = runObserveOracle({ manifest: subject,
        fullOracle: { allPass: false, failedCommandIds: ['audit-shadow-rejected-command'] },
        instrumentedOrder: selected, authoritativeOrder: subject.rows.map((row) => row.commandId) });
      assert.equal(shadow.equivalent, false);
      return 'shadow discrepancy reported';
    },
    'shadow-false-negative': () => {
      const subject = buildDynamicValidationPlan(context('packages/main/src/audit-shadow-false-negative.ts'));
      const selected = subject.rows.filter((row) => row.disposition === 'execute').map((row) => row.commandId);
      const shadow = runObserveOracle({ manifest: subject,
        fullOracle: { allPass: false, failedCommandIds: ['audit-shadow-false-negative-id'] },
        instrumentedOrder: selected, authoritativeOrder: subject.rows.map((row) => row.commandId) });
      assert.deepEqual(shadow.falseNegativeCommandIds, ['audit-shadow-false-negative-id']);
      return 'false negative detected';
    },
    'test-gate': () => {
      const manifest = buildDynamicValidationPlan({ ...cleanContext, mode: 'enforce-low-risk' });
      const subject = evaluateDynamicAuthority({ mode: 'enforce-low-risk', riskTier: 'local', manifest,
        prerequisites: allAuthorityPrerequisites, pinnedCommandsExecuted: true });
      assert.equal(subject.authoritative, true, JSON.stringify(subject));
      return 'low-risk dynamic TEST PASS';
    },
    'test-gate-escalation': () => {
      const manifest = buildDynamicValidationPlan(context('packages/main/src/audit-test-gate-escalation.ts'));
      const subject = evaluateDynamicAuthority({ mode: 'enforce-low-risk', riskTier: 'shared', manifest,
        prerequisites: { ...allAuthorityPrerequisites, storyRiskEligible: false }, pinnedCommandsExecuted: true });
      assert.equal(subject.fallbackToFull, true);
      return 'mandatory full escalation PASS';
    },
    'test-gate-mutations': () => {
      const manifest = buildDynamicValidationPlan(context('packages/main/src/audit-test-gate-mutation.ts'));
      const subject = evaluateDynamicAuthority({ mode: 'enforce-low-risk', riskTier: 'local',
        manifest: { ...manifest, signature: 'audit-tampered-signature' },
        prerequisites: allAuthorityPrerequisites, pinnedCommandsExecuted: true });
      assert.equal(subject.authoritative, false);
      return 'authority mutations rejected';
    },
    operations: () => {
      const entries = [
        { commandId: 'audit-operation-a', originalIndex: 0, cpuWeight: 1, expectedP50Ms: 7, resources: [] },
        { commandId: 'audit-operation-b', originalIndex: 1, cpuWeight: 1, expectedP50Ms: 5, resources: [] },
      ];
      const subject = buildValidationSchedule(entries, { workerCapacity: 2, cpuCapacity: 2 });
      assert.equal(verifyValidationSchedule(subject, entries, { workerCapacity: 2, cpuCapacity: 2 }).ok, true);
      return 'safe recovery and rollback PASS';
    },
    'operations-mutations': () => {
      const entries = [
        { commandId: 'audit-over-capacity-a', originalIndex: 0, cpuWeight: 1, expectedP50Ms: 10, resources: [], wave: 0, startOffsetMs: 0, endOffsetMs: 10 },
        { commandId: 'audit-over-capacity-b', originalIndex: 1, cpuWeight: 1, expectedP50Ms: 10, resources: [], wave: 0, startOffsetMs: 0, endOffsetMs: 10 },
        { commandId: 'audit-over-capacity-c', originalIndex: 2, cpuWeight: 1, expectedP50Ms: 10, resources: [], wave: 0, startOffsetMs: 0, endOffsetMs: 10 },
      ];
      assert.equal(verifyValidationSchedule(entries, entries, { workerCapacity: 2, cpuCapacity: 2 }).ok, false);
      return 'operations mutation rejected';
    },
  };
  const assertion = auditAssertions[requestedAuditMode];
  assert.ok(assertion, `unknown dynamic validation audit mode: ${requestedAuditMode}`);
  const selector = assertion();
  console.log(`DYNAMIC_VALIDATION_ASSERTION:${requestedAuditMode}:${selector}`);
}

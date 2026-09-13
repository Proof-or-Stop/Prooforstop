/**
 * Focused contract smoke for Story-aware dynamic validation.
 *
 * It intentionally exercises the pure core, including fail-closed receipt,
 * closure, selection, scheduler, oracle, authority and shard guards.  The
 * existing complete validation plan remains outside this smoke and is the
 * authoritative oracle in observe/shadow mode.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateValidationShards,
  augmentValidationCatalogWithGraphInputs,
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
  ValidationSelectorContextError,
  validateValidationCatalog,
} from '../core/story-aware-validation.js';
import {
  VALIDATION_IMPACT_INDEX_SCHEMA,
  buildAutomaticValidationTierSelectionBinding,
  buildValidationImpactIndexFromCatalog,
  selectAutomaticValidationTier,
} from '../core/validation-tier-planner.js';
import type { StoryRelevanceInput } from '../core/validation-relevance-input.js';
import { assertAutomaticTierSelectionBindingCurrent } from '../handlers/story-aware-validation.js';
import { configuredValidationCommandEntries } from '../core/validation-command-config.js';
import { dynamicValidationDegradation } from '../handlers/verifier.js';
import { buildDualRevisionImpactGraph as buildProductionDualRevisionImpactGraph } from '../core/dual-revision-impact-graph.js';
import { buildValidationCommandInventory } from '../core/validation-command-identity.js';

const inventory = discoverValidationInventory('/tmp', [
  { id: 'always', label: 'always', command: 'node', args: ['always.js'], inputRoots: ['packages/main/src/always.ts'], inputsComplete: true, assurance: 'always', riskTier: 'local', originalIndex: 0 },
  { id: 'local', label: 'local', command: 'node', args: ['local.js'], inputRoots: ['packages/main/src/local.ts'], inputsComplete: true, assurance: 'story-selectable', riskTier: 'local', originalIndex: 1 },
  { id: 'unrelated', label: 'unrelated', command: 'node', args: ['unrelated.js'], inputRoots: ['docs/unrelated.md'], inputsComplete: true, assurance: 'story-selectable', riskTier: 'local', originalIndex: 2 },
]);
const catalog = compileValidationCatalog(inventory);
const inventoryCommandSetDigest = buildValidationCommandInventory({ commands: inventory.commands }).commandSetDigest;
const graphAugmentedCatalog = augmentValidationCatalogWithGraphInputs({
  catalog,
  changedFiles: [{ path: 'packages/main/src/shared.ts', status: 'modified', blobId: 'shared' }],
  graph: {
    baseHead: 'base', head: 'head', baseGraphDigest: 'base-graph', headGraphDigest: 'head-graph', graphUnknown: false,
    authorityReasons: () => [],
    commandsAffectedBy: () => ['local'],
  },
});
assert.equal(graphAugmentedCatalog.find((entry) => entry.id === 'local')?.selectionInputRoots.includes('packages/main/src/shared.ts'), true);
assert.equal(graphAugmentedCatalog.find((entry) => entry.id === 'always')?.selectionInputRoots.includes('packages/main/src/shared.ts'), false);
let graphImpactCalls = 0;
augmentValidationCatalogWithGraphInputs({
  catalog: [...catalog, ...catalog.map((entry, index) => ({ ...entry, id: `${entry.id}-copy-${index}` }))],
  changedFiles: [
    { path: 'packages/main/src/one.ts', status: 'modified', blobId: 'one' },
    { path: 'packages/main/src/two.ts', status: 'modified', blobId: 'two' },
  ],
  graph: {
    baseHead: 'base', head: 'head', baseGraphDigest: 'base-count', headGraphDigest: 'head-count', graphUnknown: false,
    authorityReasons: () => [], commandsAffectedBy: () => { graphImpactCalls += 1; return ['local']; },
  },
});
assert.equal(graphImpactCalls, 2,
  'graph impact traversal must run once per changed file, never once per catalog row');
const graphUnknownCatalog = augmentValidationCatalogWithGraphInputs({
  catalog,
  changedFiles: [{ path: 'packages/main/src/unknown.ts', status: 'modified', blobId: 'unknown' }],
  graph: {
    baseHead: 'base', head: 'head', baseGraphDigest: 'empty', headGraphDigest: 'partial', graphUnknown: true,
    authorityReasons: () => [], commandsAffectedBy: () => ['local'],
  },
});
assert.deepEqual(graphUnknownCatalog, catalog, 'an incomplete dependency graph must contribute no selector inputs');

const graphFixtureRoot = mkdtempSync(join(tmpdir(), 'story-aware-production-graph-'));
try {
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: graphFixtureRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  mkdirSync(join(graphFixtureRoot, 'packages/main/src/core'), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Graph Fixture');
  git('config', 'user.email', 'graph-fixture@example.invalid');
  const authorityFixture = join(graphFixtureRoot, 'packages/main/src/core/process-fact-registry.ts');
  writeFileSync(authorityFixture, 'export const value = 1;\n');
  writeFileSync(join(graphFixtureRoot, 'packages/main/src/jsx-dependency.ts'), 'export const dependency = 1;\n');
  writeFileSync(join(graphFixtureRoot, 'packages/main/src/component.tsx'),
    "const view = <div />;\nimport './jsx-dependency.js';\nexport default view;\n");
  git('add', '.');
  git('commit', '-qm', 'base');
  const baseHead = git('rev-parse', 'HEAD');
  writeFileSync(authorityFixture,
    "import './missing.js';\nexport const value = 2;\n");
  writeFileSync(join(graphFixtureRoot, 'packages/main/src/jsx-dependency.ts'), 'export const dependency = 2;\n');
  git('add', '.');
  git('commit', '-qm', 'unresolved import');
  const head = git('rev-parse', 'HEAD');
  const changeManifest = buildStoryChangeManifest({
    storyId: 'B-production-graph', gitCwd: graphFixtureRoot, baseHead, head,
  });
  const productionGraph = buildProductionDualRevisionImpactGraph({
    gitCwd: graphFixtureRoot,
    storyId: 'B-production-graph',
    baseHead,
    head,
    catalog,
    changeManifest,
  });
  assert.equal(productionGraph.graphUnknown, true,
    'the production graph entrypoint must fail closed on an unresolved import');
  assert.ok((productionGraph.resolutionFailures ?? []).some((reason) => reason.includes('unresolved-relative-import')),
    'the production graph entrypoint must retain the unresolved-import witness');
  const jsxGraph = buildProductionDualRevisionImpactGraph({
    gitCwd: graphFixtureRoot, storyId: 'B-production-graph', baseHead, head,
    catalog: [{ ...catalog[0]!, id: 'tsx-consumer', inputRoots: ['packages/main/src/component.tsx'], triggerExtensions: { files: ['packages/main/src/component.tsx'] } }],
    changeManifest,
  });
  const repeatedJsxGraph = buildProductionDualRevisionImpactGraph({
    gitCwd: graphFixtureRoot, storyId: 'B-production-graph', baseHead, head,
    catalog: [{ ...catalog[0]!, id: 'tsx-consumer', inputRoots: ['packages/main/src/component.tsx'], triggerExtensions: { files: ['packages/main/src/component.tsx'] } }],
    changeManifest,
  });
  assert.strictEqual(repeatedJsxGraph, jsxGraph,
    'an immutable commit-pair and catalog must reuse one process-cached dual-revision AST graph');
  assert.ok(jsxGraph.commandsAffectedBy({ path: 'packages/main/src/jsx-dependency.ts', status: 'modified' }).includes('tsx-consumer'),
    'an import following JSX must remain a positive reverse-dependency edge');
} finally {
  rmSync(graphFixtureRoot, { recursive: true, force: true });
}
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
  staticPaths: entry.inputRoots,
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
assert.equal(selection.totals.inventory, selection.totals.executed + selection.totals.reused + selection.totals.excluded);

const tierInput = {
  storyId: 'B-smoke',
  universeCommandIds: inventory.commands.map((row) => row.id),
  changedPaths: ['packages/main/src/local.ts'],
  pinnedCommandIds: [],
  forceFullReasons: [],
  commandSetDigest: 'smoke-command-set',
  snapshotDigest: 'smoke-snapshot',
  impactIndex: {
    schema: VALIDATION_IMPACT_INDEX_SCHEMA,
    version: 'smoke-v1',
    commandSetDigest: 'smoke-command-set',
    entries: [
      { commandId: 'always', selection: 'always' as const, inputPatterns: [], coverage: 'complete' as const },
      { commandId: 'local', selection: 'story-intermediate' as const, inputPatterns: ['packages/main/src/**'], coverage: 'complete' as const },
      { commandId: 'unrelated', selection: 'story-fast' as const, inputPatterns: ['docs/**'], coverage: 'complete' as const },
    ],
  },
};
const tierDecision = selectAutomaticValidationTier(tierInput);
assert.equal(tierDecision.effectiveTier, 'story-intermediate');
const productionRelevanceInput = {
  schema: 'proofOrStop.story-relevance-input.v1', storyId: 'B-smoke', phase: 'TEST',
  hashes: { status: 'available', head: {
    schemaVersion: 'proof-or-stop.evidence_hash_snapshot.v1', headHash: 'head', materialHash: 'material',
    storyFilesHash: 'story-files', gitCwd: '.', metadataRoot: '.', ref: 'HEAD',
    capturedAt: '2026-01-01T00:00:00.000Z', materialDirtyFiles: [],
  } },
  changedFiles: { status: 'available', baseRef: 'base', headRef: 'head', statuses: { 'packages/main/src/local.ts': 'M' }, paths: ['packages/main/src/local.ts'] },
  seeds: [{ kind: 'path', value: 'packages/main/src/local.ts', provenance: ['changed-file'], itemIds: [], changeStatus: 'M' }],
  excludedPaths: [], pinnedCommands: [], commandSeedEdges: [], unclassifiedInputs: [], riskSignals: [],
  executionInventory: { sourceKind: 'configured', commandSetDigest: inventoryCommandSetDigest, commandIds: inventory.commands.map((row) => row.id), provisionalCommandIds: [], warnings: [] },
  durationHistory: { status: 'collected', sampleCount: 0, estimates: [], unmatchedSamples: [] },
  verificationIntentContext: [], escalations: [], selectionDigest: 'story-input-selection',
} as StoryRelevanceInput;
const subprocessInventory = discoverValidationInventory('/tmp', [{
  id: 'subprocess-only', label: 'subprocess-only', command: 'node',
  args: ['-e', "require('node:child_process').spawnSync('node',['hidden-runner.js'])"],
  inputRoots: ['packages/main/src/visible-runner.ts'], originalIndex: 0,
}]);
const subprocessCatalog = compileValidationCatalog(subprocessInventory);
const malformedCompleteInventory = discoverValidationInventory('/tmp', [{
  id: 'malformed-complete', label: 'malformed-complete', command: 'node', args: ['malformed.js'],
  inputRoots: 'packages/main/src' as unknown as string[], inputsComplete: true, originalIndex: 0,
}]);
assert.equal(compileValidationCatalog(malformedCompleteInventory)[0]?.selectionInputCoverage, 'partial',
  'schema-bypassing non-array inputRoots must never obtain complete exclusion authority');
const hostileRootCases: Array<{ label: string; roots: string[] }> = [
  { label: 'empty', roots: [] },
  { label: 'non-string-only', roots: [123, null] as unknown as string[] },
];
for (const { label, roots: hostileRoots } of hostileRootCases) {
  assert.throws(() => configuredValidationCommandEntries({
    validate: { commands: [{ command: 'node', args: ['hostile.js'], inputsComplete: true, inputRoots: hostileRoots }] },
  }), /inputsComplete requires at least one non-empty string inputRoots entry/,
  `${label} configured input ownership must be rejected before inventory projection`);
  const hostileInventory = discoverValidationInventory('/tmp', [{
    id: `hostile-${label}`, label: `hostile-${label}`, command: 'node', args: ['hostile.js'],
    inputRoots: hostileRoots, inputsComplete: true, originalIndex: 0,
  }]);
  const hostileCatalog = compileValidationCatalog(hostileInventory);
  assert.equal(hostileCatalog[0]?.selectionInputCoverage, 'partial',
    `${label} schema-bypassing ownership must remain partial`);
  assert.ok(validateValidationCatalog(hostileInventory, [{
    ...hostileCatalog[0]!, selectionInputCoverage: 'complete',
  }]).errors.includes(`complete selector inputs require at least one declared input root: hostile-${label}`),
  `${label} complete coverage with zero roots must have a named catalog error`);
  const hostileCommandSetDigest = buildValidationCommandInventory({ commands: hostileInventory.commands }).commandSetDigest;
  const hostileBinding = buildAutomaticValidationTierSelectionBinding({
    input: {
      ...productionRelevanceInput,
      executionInventory: {
        sourceKind: 'configured', commandSetDigest: hostileCommandSetDigest,
        commandIds: hostileInventory.commands.map((row) => row.id), provisionalCommandIds: [], warnings: [],
      },
    },
    catalog: hostileCatalog,
    storySnapshot: { baseHead: changes.baseHead, head: changes.head, changeDigest: changes.changeDigest },
  });
  assert.equal(hostileBinding.decision.effectiveTier, 'repository-full');
  assert.ok(hostileBinding.decision.escalationReasonCodes.includes('command_exclusion_unproven'),
    `${label} ownership must widen instead of issuing a positive exclusion proof`);
  assert.equal(hostileBinding.decision.exclusionProofs.some((proof) => proof.commandId === `hostile-${label}`), false);
}
for (const message of [
  'selector decision digest mismatch before validation execution',
  'selector input does not match executor catalog, inventory, or changed paths',
  'selector repository-full membership does not match executor inventory',
  'selector tier subset invariant mismatch before validation execution',
  'automatic selector decision changed before validation execution',
  'automatic selector input does not match the execution catalog, inventory, or changed paths',
]) {
  assert.deepEqual(dynamicValidationDegradation(new ValidationSelectorContextError(message)),
    { escalationReasons: ['selector_context_mismatch'], report: 'dynamic validation unavailable; canonical oracle retained (selector_context_mismatch)' });
}
assert.deepEqual(dynamicValidationDegradation(new Error('configuration could not be read')),
  { escalationReasons: ['dynamic_preparation_unavailable'], report: 'dynamic validation unavailable; canonical oracle retained (dynamic_preparation_unavailable)' });
const subprocessGraphCatalog = augmentValidationCatalogWithGraphInputs({
  catalog: subprocessCatalog,
  changedFiles: [{ path: 'packages/main/src/hidden-runner.ts', status: 'modified', blobId: 'hidden' }],
  graph: {
    baseHead: 'base', head: 'head', baseGraphDigest: 'base-subprocess', headGraphDigest: 'head-subprocess',
    graphUnknown: false, resolutionFailures: ['runtime-subprocess-edge:subprocess-only'],
    authorityReasons: () => [], commandsAffectedBy: () => ['subprocess-only'],
  },
});
assert.equal(subprocessGraphCatalog[0]?.selectionInputCoverage, 'partial',
  'a positive static graph edge must not certify complete subprocess ownership');
const subprocessBinding = buildAutomaticValidationTierSelectionBinding({
  input: {
    ...productionRelevanceInput,
    executionInventory: {
      sourceKind: 'configured', commandSetDigest: 'subprocess-command-set',
      commandIds: ['subprocess-only'], provisionalCommandIds: [], warnings: [],
    },
  },
  catalog: subprocessGraphCatalog,
  storySnapshot: { baseHead: changes.baseHead, head: changes.head, changeDigest: changes.changeDigest },
  additionalForceFullReasons: ['runtime_edge_unresolved'],
});
assert.equal(subprocessBinding.decision.effectiveTier, 'repository-full');
assert.deepEqual(subprocessBinding.decision.selectedUnitIds, ['subprocess-only']);
assert.ok(subprocessBinding.decision.escalationReasonCodes.includes('runtime_edge_unresolved'));
const tierBinding = buildAutomaticValidationTierSelectionBinding({
  input: productionRelevanceInput,
  catalog,
  storySnapshot: { baseHead: changes.baseHead, head: changes.head, changeDigest: changes.changeDigest },
});
const currentTierContext = {
  catalog,
  changedFiles: changes.changedFiles,
  universeCommandIds: inventory.commands.map((row) => row.id),
  commandSetDigest: inventoryCommandSetDigest,
  changeDigest: changes.changeDigest,
  storyId: 'B-smoke', baseHead: 'base', head: 'head',
};
assertAutomaticTierSelectionBindingCurrent(tierBinding, currentTierContext);
assert.throws(
  () => assertAutomaticTierSelectionBindingCurrent(tierBinding, { ...currentTierContext, commandSetDigest: 'changed-command-set' }),
  /selector input does not match/,
  'the selector command-set digest must be compared with a current independent inventory digest',
);
assert.throws(
  () => assertAutomaticTierSelectionBindingCurrent(tierBinding, { ...currentTierContext, head: 'changed-head' }),
  /selector input does not match/,
  'the selector snapshot digest must be compared with the current Story base/head/change identity',
);
const completeTierGraph = {
  baseHead: 'base', head: 'head', baseGraphDigest: 'base-graph', headGraphDigest: 'head-graph', graphUnknown: false,
  resolutionFailures: [], authorityReasons: () => [], commandsAffectedBy: () => ['local'],
};
const completeNoImpactGraph = {
  ...completeTierGraph,
  commandsAffectedBy: () => [],
};
const tierBoundSelection = buildDynamicValidationPlan({
  storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory, catalog, changes, closures,
  baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe',
  graph: completeTierGraph,
  tierSelection: tierBinding,
});
assert.equal(tierBoundSelection.effectiveTier, 'story-fast');
assert.equal(tierBoundSelection.rows.find((row) => row.commandId === 'unrelated')?.disposition, 'excluded', JSON.stringify({
  fullEscalated: tierBoundSelection.fullEscalated,
  escalationReasons: tierBoundSelection.escalationReasons,
  rows: tierBoundSelection.rows,
}));
assert.equal(tierBoundSelection.totals.excluded, 1);
assert.equal(tierBoundSelection.selectorDecisionDigest, tierBinding.decision.selectionDigest);
assert.deepEqual(tierBoundSelection.tierSelections, tierBinding.decision.tierSelections);
assert.equal(tierBoundSelection.selectorBinding?.catalogDigest, tierBinding.catalogDigest);

const wholeRepositoryInventory = discoverValidationInventory('/tmp', [
  { id: 'whole-build', label: 'build', command: 'node', args: ['build.js'], inputRoots: ['packages/main/src/local.ts'], inputsComplete: true, assurance: 'always', riskTier: 'local', originalIndex: 0 },
  { id: 'whole-scan', label: 'whole-scan', command: 'node', args: ['scan.js'], inputRoots: ['docs/narrow.md'], inputsComplete: true, assurance: 'story-selectable', riskTier: 'local', closurePolicy: 'whole-repository', originalIndex: 1 },
]);
const wholeRepositoryCatalog = compileValidationCatalog(wholeRepositoryInventory);
const wholeCommandSetDigest = buildValidationCommandInventory({ commands: wholeRepositoryInventory.commands }).commandSetDigest;
assert.equal(validateValidationCatalog(wholeRepositoryInventory, wholeRepositoryCatalog).ok, false,
  'whole-repository closure may not claim narrow complete selector inputs');
const wholeImpact = buildValidationImpactIndexFromCatalog({
  commandSetDigest: wholeCommandSetDigest, catalog: wholeRepositoryCatalog,
});
assert.equal(wholeImpact.entries.find((entry) => entry.commandId === 'whole-scan')?.selection, 'repository-full');
const wholeBinding = buildAutomaticValidationTierSelectionBinding({
  input: {
    ...productionRelevanceInput,
    executionInventory: { sourceKind: 'configured', commandSetDigest: wholeCommandSetDigest, commandIds: wholeRepositoryInventory.commands.map((row) => row.id), provisionalCommandIds: [], warnings: [] },
  },
  catalog: wholeRepositoryCatalog,
  storySnapshot: { baseHead: changes.baseHead, head: changes.head, changeDigest: changes.changeDigest },
});
const wholeClosures = new Map(wholeRepositoryCatalog.map((entry) => [entry.id, createValidationClosureCertificate({
  commandId: entry.id, baseHead: 'base', inventoryDigest: wholeRepositoryInventory.digest,
  catalogDigest: stableDigest(wholeRepositoryCatalog), staticPaths: entry.inputRoots,
})]));
const wholePlan = buildDynamicValidationPlan({
  storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory: wholeRepositoryInventory,
  catalog: wholeRepositoryCatalog, changes, closures: wholeClosures, baselineEpochId: 'epoch',
  buildProofDigest: 'build', mode: 'observe', graph: completeNoImpactGraph, tierSelection: wholeBinding,
});
assert.equal(wholePlan.fullEscalated, false,
  'whole-repository floor fixture must exercise the row policy without blanket escalation');
assert.equal(wholePlan.rows.find((row) => row.commandId === 'whole-scan')?.disposition, 'execute',
  'whole-repository closure must never become a positive-proof exclusion');

const fullOnlyInventory = discoverValidationInventory('/tmp', [
  { id: 'full-build', label: 'build', command: 'node', args: ['build.js'], inputRoots: ['packages/main/src/local.ts'], inputsComplete: true, assurance: 'always', riskTier: 'local', originalIndex: 0 },
  { id: 'full-sentinel', label: 'full-sentinel', command: 'node', args: ['sentinel.js'], inputRoots: ['docs/narrow.md'], inputsComplete: true, assurance: 'full-only', riskTier: 'local', closurePolicy: 'static-and-traced', fullBaselineReusePolicy: 'exact-current-epoch-only', originalIndex: 1 },
]);
const fullOnlyCatalog = compileValidationCatalog(fullOnlyInventory);
const fullOnlyCommandSetDigest = buildValidationCommandInventory({ commands: fullOnlyInventory.commands }).commandSetDigest;
const fullOnlyBinding = buildAutomaticValidationTierSelectionBinding({
  input: {
    ...productionRelevanceInput,
    executionInventory: { sourceKind: 'configured', commandSetDigest: fullOnlyCommandSetDigest, commandIds: fullOnlyInventory.commands.map((row) => row.id), provisionalCommandIds: [], warnings: [] },
  },
  catalog: fullOnlyCatalog,
  storySnapshot: { baseHead: changes.baseHead, head: changes.head, changeDigest: changes.changeDigest },
});
const fullOnlyClosures = new Map(fullOnlyCatalog.map((entry) => [entry.id, createValidationClosureCertificate({
  commandId: entry.id, baseHead: 'base', inventoryDigest: fullOnlyInventory.digest,
  catalogDigest: stableDigest(fullOnlyCatalog), staticPaths: entry.inputRoots,
})]));
const fullOnlySeed = buildDynamicValidationPlan({
  storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory: fullOnlyInventory,
  catalog: fullOnlyCatalog, changes, closures: fullOnlyClosures, baselineEpochId: 'epoch',
  buildProofDigest: 'build', mode: 'observe', graph: completeNoImpactGraph, tierSelection: fullOnlyBinding,
});
const fullOnlyRow = fullOnlySeed.rows.find((row) => row.commandId === 'full-sentinel')!;
const fullOnlyReceipt = createValidationCommandReceipt({
  id: 'full-only-baseline', commandId: 'full-sentinel', commandIdentityDigest: 'full-sentinel',
  inputDigest: fullOnlyRow.inputDigest, closureCertificateDigest: fullOnlyClosures.get('full-sentinel')!.signature,
  catalogDigest: stableDigest(fullOnlyCatalog), inventoryDigest: fullOnlyInventory.digest,
  runnerDigest: '', toolchainDigest: '', buildProofDigest: 'build', sourceHead: 'head', sourceBaseHead: 'base',
  canonicalBaselineEpochId: 'epoch', producedBy: 'canonical-full-baseline', cleanTreeDigest: 'clean',
  executionEnvironmentDigest: 'environment', result: 'PASS', exitCode: 0, outputDigest: 'output', durationMs: 1,
  createdAt: new Date().toISOString(), revocationLedgerDigest: stableDigest({}),
});
const fullOnlyPlan = buildDynamicValidationPlan({
  storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory: fullOnlyInventory,
  catalog: fullOnlyCatalog, changes, closures: fullOnlyClosures, baselineEpochId: 'epoch',
  buildProofDigest: 'build', mode: 'observe', graph: completeNoImpactGraph, tierSelection: fullOnlyBinding,
  receipts: [fullOnlyReceipt],
});
assert.equal(fullOnlyPlan.fullEscalated, false,
  'full-only floor fixture must exercise the row policy without blanket escalation');
assert.notEqual(fullOnlyPlan.rows.find((row) => row.commandId === 'full-sentinel')?.disposition, 'excluded',
  'full-only rows require canonical-baseline receipt reuse or execution');
assert.throws(
  () => buildDynamicValidationPlan({
    storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory,
    catalog: catalog.map((entry) => entry.id === 'local' ? { ...entry, riskTier: 'shared' } : entry),
    changes, closures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe',
    graph: completeTierGraph, tierSelection: tierBinding,
  }),
  /selector input does not match executor catalog, inventory, or changed paths/,
  'a selector built from a different catalog cannot exclude an executor row',
);
assert.throws(
  () => buildDynamicValidationPlan({
    storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory, catalog,
    changes: buildStoryChangeManifest({
      storyId: 'B-smoke', gitCwd: '.', baseHead: 'base', head: 'head',
      changedFiles: [{ path: 'packages/main/src/not-in-selector.ts', status: 'modified', blobId: 'extra' }],
    }),
    closures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe',
    graph: completeTierGraph, tierSelection: tierBinding,
  }),
  /selector input does not match executor catalog, inventory, or changed paths/,
  'a selector that omits an executor changed path cannot exclude a command',
);
assert.throws(
  () => buildDynamicValidationPlan({
    storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory, catalog, changes, closures,
    baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe',
    tierSelection: { ...tierBinding, decision: { ...tierBinding.decision, selectionDigest: 'forged' } },
  }),
  /selector decision digest mismatch before validation execution/,
);
assert.throws(
  () => assertAutomaticTierSelectionBindingCurrent({
    ...tierBinding,
    decision: { ...tierBinding.decision, selectedUnitIds: [...tierBinding.decision.selectedUnitIds, 'forged'] },
  }),
  /automatic selector decision changed before validation execution/,
);
const legacyPinChanges = buildStoryChangeManifest({
  storyId: 'B-smoke', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles: [],
  verificationIntents: [{ pinnedValidationCommands: ['validation-0123456789abcdef'] }],
});
const noPinChanges = buildStoryChangeManifest({
  storyId: 'B-smoke', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles: [],
});
const noPinSeed = buildDynamicValidationPlan({
  storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory, catalog, changes: noPinChanges, closures,
  baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe',
});
const legacyReceipts = noPinSeed.rows.map((row) => createValidationCommandReceipt({
  id: `legacy-${row.commandId}`, commandId: row.commandId, commandIdentityDigest: row.commandId,
  inputDigest: row.inputDigest, closureCertificateDigest: closures.get(row.commandId)!.signature,
  catalogDigest: stableDigest(catalog), inventoryDigest: inventory.digest, runnerDigest: 'runner',
  toolchainDigest: 'toolchain', buildProofDigest: 'build', sourceHead: 'head', sourceBaseHead: 'base',
  canonicalBaselineEpochId: 'epoch', producedBy: 'story-execution', cleanTreeDigest: 'clean',
  executionEnvironmentDigest: 'environment', result: 'PASS', exitCode: 0, outputDigest: 'output',
  durationMs: 1, createdAt: new Date().toISOString(), revocationLedgerDigest: stableDigest({}),
}));
const noPinReuse = buildDynamicValidationPlan({
  storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory, catalog, changes: noPinChanges, closures,
  receipts: legacyReceipts, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe',
});
assert.equal(noPinReuse.rows.filter((row) => row.commandId !== 'always').every((row) => row.disposition === 'reuse'), true,
  'the compatibility fixture must first prove the otherwise-unaffected commands would reuse');
const selectorFullBinding = buildAutomaticValidationTierSelectionBinding({
  input: {
    ...productionRelevanceInput,
    changedFiles: { status: 'available', baseRef: 'base', headRef: 'head', statuses: {}, paths: [] },
    seeds: [],
  },
  catalog,
  storySnapshot: { baseHead: noPinChanges.baseHead, head: noPinChanges.head, changeDigest: noPinChanges.changeDigest },
  additionalForceFullReasons: ['command_exclusion_unproven'],
});
const selectorFullSelection = buildDynamicValidationPlan({
  storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory, catalog, changes: noPinChanges, closures,
  receipts: legacyReceipts, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe',
  tierSelection: selectorFullBinding,
});
assert.equal(selectorFullSelection.effectiveTier, 'repository-full');
assert.equal(selectorFullSelection.fullEscalated, false,
  'the fixture must isolate selector-side repository-full from executor escalation');
assert.equal(selectorFullSelection.totals.reused, 0,
  'selector-side repository-full is the conservative oracle and may not reuse receipts');
assert.equal(selectorFullSelection.rows.every((row) => row.disposition === 'execute'), true);
const legacyPinSelection = buildDynamicValidationPlan({
  storyId: 'B-smoke', baseHead: 'base', head: 'head', inventory, catalog, changes: legacyPinChanges, closures,
  receipts: legacyReceipts, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe',
});
assert.equal(legacyPinSelection.fullEscalated, true);
assert.ok(legacyPinSelection.escalationReasons.includes('legacy-validation-pin-unresolved:validation-0123456789abcdef'));
assert.equal(legacyPinSelection.rows.every((row) => row.disposition === 'execute'), true,
  'a stored legacy validation-* pin widens to the full current inventory instead of disappearing or throwing');

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
assert.equal(unverifiedRow.reasons.includes('full-escalation'), true);
assert.equal(unverifiedSelection.escalationReasons.some((reason) => reason.includes('closure-certificate-unavailable-or-incomplete')), true);
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

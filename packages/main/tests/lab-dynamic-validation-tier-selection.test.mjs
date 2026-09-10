import assert from 'node:assert/strict';

const RED = 'DYNAMIC_VALIDATION_TIER_SELECTION_RED: story-fast still expands to repository-full';
const GREEN = 'DYNAMIC_VALIDATION_TIER_SELECTION_GREEN';

try {
  const planner = await import('../dist/core/validation-tier-planner.js');
  const planHandler = await import('../dist/handlers/validation-plan.js');
  assert.equal(typeof planner.selectValidationTiers, 'function', 'selectValidationTiers must be exported');

  const universeCommandIds = [
    'build',
    'docs-links',
    'docs-contract',
    'module-a-unit',
    'module-a-integration',
    'repo-sentinel',
  ];
  const commandSetDigest = 'fixture-command-set-v1';
  const impactIndex = {
    schema: 'proofOrStop.validation-impact-index.v1',
    version: 'fixture-index-v1',
    commandSetDigest,
    entries: [
      { commandId: 'build', selection: 'always', inputPatterns: [], coverage: 'complete' },
      { commandId: 'docs-links', selection: 'story-fast', inputPatterns: ['docs/**'], coverage: 'complete' },
      {
        commandId: 'docs-contract',
        selection: 'story-intermediate',
        inputPatterns: ['docs/**'],
        coverage: 'complete',
      },
      {
        commandId: 'module-a-unit',
        selection: 'story-fast',
        inputPatterns: ['packages/module-a/**'],
        coverage: 'complete',
      },
      {
        commandId: 'module-a-integration',
        selection: 'story-intermediate',
        inputPatterns: ['packages/module-a/**'],
        coverage: 'complete',
      },
      {
        commandId: 'repo-sentinel',
        selection: 'repository-full',
        inputPatterns: ['proof-or-stop.config.json'],
        coverage: 'complete',
      },
    ],
  };

  const base = {
    storyId: 'B-lab1',
    universeCommandIds,
    pinnedCommandIds: [],
    forceFullReasons: [],
    commandSetDigest,
    snapshotDigest: 'fixture-snapshot-v1',
    impactIndex,
  };

  const docs = planner.selectValidationTiers({
    ...base,
    requestedTier: 'story-fast',
    changedPaths: ['docs/guide.md'],
  });
  assert.equal(docs.effectiveTier, 'story-fast');
  assert.equal(docs.reductionApplied, true);
  assert.deepEqual(docs.tierSelections['story-fast'], ['build', 'docs-links']);
  assert.deepEqual(docs.tierSelections['story-intermediate'], ['build', 'docs-links', 'docs-contract']);
  assert.deepEqual(docs.tierSelections['repository-full'], universeCommandIds);
  assert.deepEqual(
    docs.exclusionProofs.map((proof) => proof.commandId),
    ['docs-contract', 'module-a-unit', 'module-a-integration', 'repo-sentinel'],
  );
  assert.equal(docs.exclusionProofs[0].reason, 'selected-tier-excludes-wider-tier-command');
  assert.ok(
    docs.exclusionProofs.slice(1).every(
      (proof) => proof.reason === 'complete-input-set-does-not-intersect-story-change',
    ),
  );

  const wiredInput = {
      schema: 'proofOrStop.story-relevance-input.v1',
      storyId: 'B-lab1',
      phase: 'DEV',
      hashes: {
        status: 'available',
        head: {
          schemaVersion: 'evidence-hash-snapshot.v1',
          headHash: 'head-v1',
          materialHash: 'material-v1',
          storyFilesHash: 'story-v1',
          gitCwd: '/fixture',
          metadataRoot: '/fixture',
          ref: 'HEAD',
          capturedAt: '2026-09-10T00:00:00.000Z',
          materialDirtyFiles: [],
        },
      },
      changedFiles: {
        status: 'available',
        baseRef: 'main',
        headRef: 'HEAD',
        statuses: { 'docs/guide.md': 'M' },
        paths: ['docs/guide.md'],
      },
      seeds: [{
        kind: 'path',
        value: 'docs/guide.md',
        provenance: ['changed-file'],
        itemIds: [],
        changeStatus: 'M',
      }],
      excludedPaths: [],
      pinnedCommands: [],
      commandSeedEdges: [],
      unclassifiedInputs: [],
      riskSignals: [],
      executionInventory: {
        sourceKind: 'configured',
        commandSetDigest,
        commandIds: universeCommandIds,
        provisionalCommandIds: [],
        warnings: [],
      },
      durationHistory: { status: 'collected', sampleCount: 0, estimates: [], unmatchedSamples: [] },
      verificationIntentContext: [],
      escalations: [],
      selectionDigest: 'collector-selection-v1',
  };
  const wiredPlan = planner.resolveValidationTierPlan({
    requestedTier: 'story-fast',
    impactIndex,
    input: wiredInput,
  });
  assert.equal(wiredPlan.status, 'plan');
  assert.equal(wiredPlan.effectiveTier, 'story-fast');
  assert.deepEqual(wiredPlan.selectedUnitIds, ['build', 'docs-links']);
  assert.equal(wiredPlan.finalAuthority, false);
  assert.ok(wiredPlan.selectorDecisionDigest, 'wired plans expose the selector decision digest');
  const wiredReport = planHandler.buildValidationPlanReport({
    request: {
      storyId: 'B-lab1',
      tierInput: 'fast',
      requestedTier: 'story-fast',
      explain: true,
      json: false,
    },
    storyPhase: 'DEV',
    input: wiredInput,
    result: wiredPlan,
  });
  assert.equal(wiredReport.selectionDigest, 'collector-selection-v1');
  assert.equal(wiredReport.selectorDecisionDigest, wiredPlan.selectorDecisionDigest);
  assert.equal(wiredReport.exclusionProofs.length, 4);
  assert.ok(wiredReport.units.every((unit) => unit.inclusionReasons.length > 0));
  const wiredText = planHandler.renderValidationPlanText(wiredReport, true);
  assert.match(wiredText, /exclusion proofs \(4\):/);
  assert.match(wiredText, /selectorDecisionDigest:/);

  const intermediate = planner.selectValidationTiers({
    ...base,
    requestedTier: 'story-intermediate',
    changedPaths: ['packages/module-a/src/index.ts'],
  });
  assert.equal(intermediate.effectiveTier, 'story-intermediate');
  assert.deepEqual(intermediate.selectedUnitIds, ['build', 'module-a-unit', 'module-a-integration']);

  const fullWithoutMaterialSeeds = planner.selectValidationTiers({
    ...base,
    requestedTier: 'repository-full',
    changedPaths: [],
  });
  assert.equal(fullWithoutMaterialSeeds.effectiveTier, 'repository-full');
  assert.deepEqual(fullWithoutMaterialSeeds.selectedUnitIds, universeCommandIds);
  assert.deepEqual(fullWithoutMaterialSeeds.escalationReasonCodes, []);

  const mappedStop = planner.resolveValidationTierPlan({
    requestedTier: 'story-fast',
    impactIndex: {
      schema: 'proofOrStop.validation-impact-index.v1',
      version: 'stop-index-v1',
      commandSetDigest: 'stop-command-set',
      entries: [{
        commandId: 'docs-contract',
        selection: 'story-intermediate',
        inputPatterns: ['docs/**'],
        coverage: 'complete',
      }],
    },
    input: {
      ...wiredInput,
      executionInventory: {
        ...wiredInput.executionInventory,
        commandSetDigest: 'stop-command-set',
        commandIds: ['docs-contract'],
      },
    },
  });
  assert.equal(mappedStop.status, 'stop');
  assert.equal(mappedStop.reason.code, 'empty_selection_unclassified');
  assert.deepEqual(mappedStop.unclassifiedInputs, [], 'the configured index mapped the Story path');

  const unknown = planner.selectValidationTiers({
    ...base,
    requestedTier: 'story-fast',
    changedPaths: ['unknown/new-format.xyz'],
  });
  assert.equal(unknown.effectiveTier, 'repository-full');
  assert.equal(unknown.reductionApplied, false);
  assert.ok(unknown.escalationReasonCodes.includes('unclassified_material_input'));

  const incomplete = planner.selectValidationTiers({
    ...base,
    requestedTier: 'story-fast',
    changedPaths: ['docs/guide.md'],
    impactIndex: { ...impactIndex, entries: impactIndex.entries.slice(0, -1) },
  });
  assert.equal(incomplete.effectiveTier, 'repository-full');
  assert.ok(incomplete.escalationReasonCodes.includes('command_exclusion_unproven'));

  const stale = planner.selectValidationTiers({
    ...base,
    requestedTier: 'story-fast',
    changedPaths: ['docs/guide.md'],
    impactIndex: { ...impactIndex, commandSetDigest: 'stale-command-set' },
  });
  assert.equal(stale.effectiveTier, 'repository-full');
  assert.ok(stale.escalationReasonCodes.includes('selection_policy_changed'));

  const sensitive = planner.selectValidationTiers({
    ...base,
    requestedTier: 'story-fast',
    changedPaths: ['packages/main/src/core/validation-tier-planner.ts'],
    forceFullReasons: ['validation_framework_sensitive_change'],
  });
  assert.equal(sensitive.effectiveTier, 'repository-full');
  assert.ok(sensitive.escalationReasonCodes.includes('validation_framework_sensitive_change'));

  for (const sensitivePath of [
    'packages/main/src/core/validation-tier-planner.ts',
    'packages/main/src/core/shared-validation-execution.ts',
    'packages/main/src/handlers/story-aware-validation.ts',
    'packages/main/src/handlers/validate-lint.ts',
    'packages/main/src/core/guard-utils.ts',
    '.githooks/pre-push',
  ]) {
    const maliciouslyNarrowSensitiveIndex = {
      ...impactIndex,
      entries: impactIndex.entries.map((entry) => entry.commandId === 'docs-links'
        ? { ...entry, inputPatterns: [...entry.inputPatterns, sensitivePath] }
        : entry),
    };
    const wiredSensitive = planner.resolveValidationTierPlan({
      requestedTier: 'story-fast',
      impactIndex: maliciouslyNarrowSensitiveIndex,
      input: {
        ...wiredInput,
        changedFiles: {
          ...wiredInput.changedFiles,
          statuses: { [sensitivePath]: 'M' },
          paths: [sensitivePath],
        },
        seeds: [{
          kind: 'path',
          value: sensitivePath,
          provenance: ['changed-file'],
          itemIds: [],
          changeStatus: 'M',
        }],
      },
    });
    assert.equal(wiredSensitive.status, 'plan', sensitivePath);
    assert.equal(wiredSensitive.effectiveTier, 'repository-full', sensitivePath);
    assert.ok(wiredSensitive.escalationReasons.some(
      (reason) => reason.code === 'validation_framework_sensitive_change',
    ), sensitivePath);
    assert.deepEqual(wiredSensitive.unclassifiedInputs, [], `${sensitivePath} was mapped by the index`);
  }

  const checklistSeed = planner.resolveValidationTierPlan({
    requestedTier: 'story-fast',
    impactIndex,
    input: {
      ...wiredInput,
      seeds: [
        ...wiredInput.seeds,
        {
          kind: 'path',
          value: 'packages/module-a/src/index.ts',
          provenance: ['checklist-modify'],
          itemIds: ['CHK-001'],
        },
      ],
    },
  });
  assert.equal(checklistSeed.status, 'plan');
  assert.deepEqual(checklistSeed.tierSelections['story-fast'], ['build', 'docs-links', 'module-a-unit']);

  console.log(GREEN);
} catch (error) {
  console.error(RED);
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}

import assert from 'node:assert/strict';

const RED = 'DYNAMIC_VALIDATION_TIER_SELECTION_RED: story-fast still expands to repository-full';
const GREEN = 'DYNAMIC_VALIDATION_TIER_SELECTION_GREEN';

try {
  const planner = await import('../dist/core/validation-tier-planner.js');
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

  const intermediate = planner.selectValidationTiers({
    ...base,
    requestedTier: 'story-intermediate',
    changedPaths: ['packages/module-a/src/index.ts'],
  });
  assert.equal(intermediate.effectiveTier, 'story-intermediate');
  assert.deepEqual(intermediate.selectedUnitIds, ['build', 'module-a-unit', 'module-a-integration']);

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

  console.log(GREEN);
} catch (error) {
  console.error(RED);
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}

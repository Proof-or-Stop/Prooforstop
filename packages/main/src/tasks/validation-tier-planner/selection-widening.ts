import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import ts from 'typescript';


import { type StoryRelevanceInput } from '../../core/validation-relevance-input.js';
import { type EvidenceHashSnapshot } from '../../core/evidence-freshness.js';
import type { ChecklistItem } from '../../core/types.js';

import { dynamicRoutineCoverageAllowed, dynamicValidationDegradation, resolveValidationDynamicMode, sharedValidationExecutionEnabled } from '../../handlers/verifier.js';
import { REPOSITORY_FULL_TIER, VALIDATION_IMPACT_INDEX_SCHEMA, VALIDATION_STOP_REASON_CODES, VALIDATION_TIERS, VALIDATION_WIDENING_OUTCOMES, VALIDATION_WIDENING_REASONS, VALIDATION_WIDENING_REASON_CODES, assertValidationTier, assertValidationTierSelectionSubsetInvariant, buildValidationImpactIndexFromCatalog, isValidationStopReasonCode, resolveValidationTierPlan, classifySensitiveStoryPaths, pathIsLegacyValidationSensitive, selectAutomaticValidationTier, selectValidationTiers, validationTierIsSubsetOf, validationTierRank, validationWideningReason, validationWideningReasonGloss, type ValidationTier, type ValidationImpactIndex, type SelectValidationTiersInput, type ValidationWideningReasonCode } from '../../core/validation-tier-planner.js';






import {
  collectRepositoryFullProcessFactPaths,
  declareProcessFactMapping,
  getProcessFactRegistryEntry,
  PROCESS_FACT_DYNAMIC_FINDING_POLICY,
  VALIDATION_TIER_FLOOR,
} from '../../core/process-fact-registry.js';



import { buildDynamicValidationPlan, buildStoryChangeManifest, compileValidationCatalog, discoverValidationInventory, verifyValidationSelectionManifest } from '../../core/story-aware-validation.js';
import { dynamicValidationCoverageAdmission } from '../../handlers/validation-pass-admissibility.js';
import { assertAutomaticTierSelectionBindingCurrent, hasStoryAwareValidationArtifacts } from '../../handlers/story-aware-validation.js';
import { withValidationSigningRoot } from '../../core/validation-signing-context.js';
import { digestCanonicalJson } from '../../core/digest.js';
import { beginSection, testCase, resolvePin, command, repositorySourceRoot, planFor, statusReader, fixtureHashSnapshot, projectRootWithConfig, planInput, reasonCodes, RELEVANCE_COMMANDS, FIXTURE_HEAD_SNAPSHOT, checklistItem, SOURCE_KINDS, throwingStatusReader } from "./support.js";
export function runSelectionWidening(): void {



// ---------------------------------------------------------------------------
// CHK-004 — language-neutral planner types and the fail-closed widening matrix
// (`core/validation-tier-planner.ts`). Spec sections "Terminology and
// invariants", "Selection algorithm" steps 1/2/5, and "Fail-closed widening
// matrix".
//
// The defining constraint of this Story: the resolver returns
// `effectiveTier: 'repository-full'` or a CLASSIFIED STOP. There is no code path
// that returns a reduced tier, no pruning, no impact index, no exclusion proof,
// and an empty selection is never a pass.
// ---------------------------------------------------------------------------

beginSection('CHK-004 tier planner and widening matrix cases');


// ---------------------------------------------------------------------------
// (25) TIER VOCABULARY AND THE SUBSET INVARIANT.
//      The vocabulary is exactly the spec's three names, and the invariant
//      story-fast ⊆ story-intermediate ⊆ repository-full is ENCODED, not
//      described in a comment: a selection that violates it is rejected.
// ---------------------------------------------------------------------------
testCase('the tier vocabulary is exactly the three spec names, ordered by containment', () => {
  assert.deepEqual([...VALIDATION_TIERS], ['story-fast', 'story-intermediate', 'repository-full']);
  assert.equal(REPOSITORY_FULL_TIER, 'repository-full');
  assert.ok(validationTierRank('story-fast') < validationTierRank('story-intermediate'));
  assert.ok(validationTierRank('story-intermediate') < validationTierRank('repository-full'));
  assert.equal(validationTierIsSubsetOf('story-fast', 'repository-full'), true);
  assert.equal(validationTierIsSubsetOf('repository-full', 'story-fast'), false);
});


testCase('a tier selection that breaks the subset invariant is rejected', () => {
  assertValidationTierSelectionSubsetInvariant({
    'story-fast': ['a'],
    'story-intermediate': ['a', 'b'],
    'repository-full': ['a', 'b', 'c'],
  });
  assert.throws(
    () =>
      assertValidationTierSelectionSubsetInvariant({
        'story-fast': ['a', 'z'],
        'story-intermediate': ['a'],
        'repository-full': ['a'],
      }),
    /story-fast/,
    'a fast unit absent from the intermediate set must be rejected',
  );
  assert.throws(
    () =>
      assertValidationTierSelectionSubsetInvariant({
        'story-fast': ['a'],
        'story-intermediate': ['a', 'q'],
        'repository-full': ['a'],
      }),
    /story-intermediate/,
    'an intermediate unit absent from the repository-full set must be rejected',
  );
});


// ---------------------------------------------------------------------------
// (26) GLOSS COMPLETENESS BY ENUMERATION (load-bearing).
//      Asserted by walking the reason-code table itself, never a hand-copied
//      list of codes: a list would rot the moment someone adds a code, which is
//      exactly the silent omission this case exists to prevent. A bare code like
//      `impact_index_unusable` is unusable to an operator who has not read the
//      spec, so a code without a plain-language gloss must not be able to exist.
// ---------------------------------------------------------------------------
testCase('every reason code carries a non-empty plain-language gloss, asserted by enumeration', () => {
  const codes = Object.keys(VALIDATION_WIDENING_REASONS) as ValidationWideningReasonCode[];
  assert.ok(codes.length > 0, 'the widening matrix must not be empty');
  assert.deepEqual([...VALIDATION_WIDENING_REASON_CODES].sort(), [...codes].sort());
  for (const code of codes) {
    const definition = VALIDATION_WIDENING_REASONS[code];
    assert.equal(typeof definition.gloss, 'string', `${code}: gloss must be a string`);
    assert.ok(definition.gloss.trim().length >= 20, `${code}: gloss must be a real sentence, got ${JSON.stringify(definition.gloss)}`);
    assert.ok(definition.condition.trim().length > 0, `${code}: the matrix condition must be recorded`);
    assert.ok(VALIDATION_WIDENING_OUTCOMES.includes(definition.outcome), `${code}: unknown outcome ${definition.outcome}`);
    assert.equal(validationWideningReasonGloss(code), definition.gloss);
    const reason = validationWideningReason(code, 'fixture detail');
    assert.equal(reason.code, code);
    assert.equal(reason.gloss, definition.gloss);
    assert.equal(reason.outcome, definition.outcome);
    assert.equal(reason.detail, 'fixture detail');
  }
});


// ---------------------------------------------------------------------------
// (26b) B-a745 F-004 — A GLOSS MUST DESCRIBE THE SITUATION IT ACTUALLY FIRES IN.
//       `pinned_command_missing` used to read "points at a validation command
//       that no longer exists in this project ... until the evidence is
//       re-recorded". In the circumstance this Story reproduced, the command DID
//       exist and DID run: it was simply absent from `validate.commands`, the
//       separate registry the pin resolver consults. Following that advice sends
//       an operator to re-record evidence against a command that is not stale,
//       which is not a fix and cannot become one. A gloss that is confidently
//       worded and factually wrong is worse than a bare code.
// ---------------------------------------------------------------------------
testCase('the pin-related glosses name the registry boundary and a remedy that exists', () => {
  const FALSE_CLAIMS = [/no longer exists/i, /has been removed from this project/i, /is stale/i];
  for (const code of VALIDATION_WIDENING_REASON_CODES) {
    const gloss = validationWideningReasonGloss(code);
    for (const claim of FALSE_CLAIMS) {
      assert.ok(
        !claim.test(gloss),
        `${code} gloss asserts a disappearance it cannot know about: ${JSON.stringify(gloss)}`,
      );
    }
  }

  for (const code of ['pinned_command_missing', 'pinned_command_non_inventory'] as ValidationWideningReasonCode[]) {
    const gloss = validationWideningReasonGloss(code);
    assert.ok(
      /validation command inventory|registered validation commands/i.test(gloss),
      `${code} gloss must name the registry the resolver actually consults: ${JSON.stringify(gloss)}`,
    );
    assert.ok(
      /declare|register|restore/i.test(gloss),
      `${code} gloss must name a remedy that exists for a command absent from that registry, not merely ` +
      `"re-record the evidence": ${JSON.stringify(gloss)}`,
    );
  }

  // The two codes must not read as paraphrases of each other: they fire on
  // different claims and prescribe different actions.
  assert.notEqual(
    validationWideningReasonGloss('pinned_command_missing'),
    validationWideningReasonGloss('pinned_command_non_inventory'),
  );
  assert.equal(VALIDATION_WIDENING_REASONS.pinned_command_missing.outcome, 'stop');
  assert.equal(VALIDATION_WIDENING_REASONS.pinned_command_non_inventory.outcome, 'repository-full');

  // The resolver MESSAGE an operator actually reads must agree with the gloss.
  const missing = resolvePin(
    [command({ label: 'test', command: 'npm', args: ['test'], id: 'test-suite' })],
    { commandId: 'test-suite-renamed' },
  );
  assert.equal(missing.status, 'stop');
  assert.ok(
    missing.status === 'stop' && !/no longer exists/i.test(missing.message),
    'the stop message may not claim the command disappeared either',
  );
  assert.ok(
    missing.status === 'stop' && /declare|restore/i.test(missing.message),
    'the stop message must offer the remedy that matches the real situation',
  );
});


testCase('an unknown reason code has no gloss and is refused rather than glossed as empty', () => {
  assert.throws(
    () => validationWideningReasonGloss('not_a_matrix_row' as ValidationWideningReasonCode),
    /not_a_matrix_row/,
    'a code outside the table must be refused, never silently glossed as empty',
  );
});


// Parse the operator-facing document itself so its table and the runtime cannot
// drift behind a test-local transcription.
testCase('the operator guide and runtime widening matrices have identical codes, outcomes, and conditions', () => {
  const performanceDoc = readFileSync(join(repositorySourceRoot(), 'docs/validation-performance.md'), 'utf8');
  const authorityDecision = readFileSync(
    join(repositorySourceRoot(), 'docs/requirements/decisions/validation-widening-matrix-authority.md'),
    'utf8',
  );
  assert.match(
    performanceDoc,
    /docs\/requirements\/decisions\/validation-widening-matrix-authority\.md/,
    'the operator guide must cite the canonical authority decision',
  );
  assert.match(
    authorityDecision,
    /docs\/validation-performance\.md/,
    'the canonical authority decision must point back to the executable operator contract',
  );
  assert.match(
    authorityDecision,
    /story-relevance-dynamic-validation-tiers-execution-plan\.md[\s\S]*design history[\s\S]*pointer to this decision/,
    'the authority decision must state how the branch-owned design matrix is superseded when integrated',
  );
  const matrixSection = performanceDoc.match(
    /^## Dynamic-tier fail-closed widening matrix\s*$([\s\S]*?)(?=^##\s)/mu,
  )?.[1];
  assert.ok(matrixSection, 'docs/validation-performance.md must retain the Dynamic-tier fail-closed widening matrix section');
  const documentedRows = [...matrixSection.matchAll(
    /^\|\s*([^|\n]*?)\s*\|\s*([^|\n]*?)\s*\|\s*`([a-z0-9_]+)`\s*\|\s*$/gmu,
  )].map((match) => ({ condition: match[1], result: match[2], code: match[3] }));
  const documentedCodes = documentedRows.map((row) => row.code);
  assert.equal(new Set(documentedCodes).size, documentedCodes.length, 'the documented widening matrix may not repeat a reason code');
  assert.ok(documentedCodes.length > 0, 'the documented widening matrix must contain reason-code rows');
  assert.deepEqual(
    [...documentedCodes].sort(),
    [...VALIDATION_WIDENING_REASON_CODES].sort(),
    'docs/validation-performance.md and the executable widening table must contain the same reason codes',
  );
  const documentedOutcomeMap = {
    'Repository-full': 'repository-full',
    'Replan; repeated movement widens to repository-full': 'replan',
    'Stop; no PASS artifact': 'stop',
    'Atomic repository-full': 'atomic-repository-full',
    'Preserve no-validator compatibility; no validation tier can PASS': 'no-tier-pass',
    'Run that docs policy': 'docs-policy',
    'Report only; never remove a command': 'report-only',
  } as const;
  assert.deepEqual(
    [...new Set(Object.values(documentedOutcomeMap))].sort(),
    [...VALIDATION_WIDENING_OUTCOMES].sort(),
    'the documented-result normalization must cover every runtime widening outcome',
  );
  assert.deepEqual(
    [...new Set(documentedRows.map((row) => row.result))].sort(),
    Object.keys(documentedOutcomeMap).sort(),
    'every documented result label must be used and every used label must be recognized',
  );
  for (const row of documentedRows) {
    assert.ok(row.result in documentedOutcomeMap, `documented result is not normalized: ${row.result}`);
    const code = row.code as ValidationWideningReasonCode;
    assert.equal(
      documentedOutcomeMap[row.result as keyof typeof documentedOutcomeMap],
      VALIDATION_WIDENING_REASONS[code].outcome,
      `documented effective result must match runtime outcome for ${row.code}`,
    );
    assert.equal(
      row.condition,
      VALIDATION_WIDENING_REASONS[code].condition,
      `documented condition must exactly match the runtime condition for ${row.code}`,
    );
  }
});


// ---------------------------------------------------------------------------
// (27) THE NORMAL CONFIGURED STORY.
//      Repository-full, the COMPLETE universe selected, and at least one
//      escalation reason saying why nothing was reduced.
// ---------------------------------------------------------------------------
testCase('a normal configured story plans repository-full over the complete universe', () => {
  const result = planFor('story-fast', {
    readers: { changedFileStatuses: statusReader({ 'src/core/foo.ts': 'M' }), hashSnapshot: fixtureHashSnapshot },
  });
  assert.equal(result.status, 'plan');
  if (result.status !== 'plan') return;
  assert.equal(result.requestedTier, 'story-fast', 'the requested tier is retained in the artifact');
  assert.equal(result.effectiveTier, 'repository-full');
  assert.equal(result.reductionApplied, false);
  assert.equal(result.finalAuthority, false);
  assert.equal(result.executionMode, 'command-set');
  assert.deepEqual(result.selectedUnitIds, ['unit-suite', 'lint-suite']);
  assert.deepEqual(result.universe.map((unit) => unit.id), ['unit-suite', 'lint-suite']);
  assert.ok(result.escalationReasons.length > 0, 'at least one reason must explain why nothing was reduced');
  for (const reason of result.escalationReasons) {
    assert.ok(reason.gloss.trim().length > 0, `${reason.code} reached an operator without a gloss`);
    assert.ok(reason.detail.trim().length > 0, `${reason.code} reached an operator without a detail`);
  }
  // Step 2: a repository-full escalation sets BOTH fast and intermediate to U.
  assert.deepEqual(result.tierSelections['story-fast'], result.selectedUnitIds);
  assert.deepEqual(result.tierSelections['story-intermediate'], result.selectedUnitIds);
  assert.deepEqual(result.tierSelections['repository-full'], result.selectedUnitIds);
});


testCase('a complete current impact index produces nested Story-relevant tiers with positive exclusions', () => {
  const universeCommandIds = ['build', 'docs-links', 'docs-contract', 'module-unit', 'repo-sentinel'];
  const decision = selectValidationTiers({
    storyId: 'B-dynamic',
    requestedTier: 'story-fast',
    universeCommandIds,
    changedPaths: ['docs/guide.md'],
    pinnedCommandIds: [],
    forceFullReasons: [],
    commandSetDigest: 'command-set-v1',
    snapshotDigest: 'snapshot-v1',
    impactIndex: {
      schema: VALIDATION_IMPACT_INDEX_SCHEMA,
      version: 'index-v1',
      commandSetDigest: 'command-set-v1',
      entries: [
        { commandId: 'build', selection: 'always', inputPatterns: [], coverage: 'complete' },
        { commandId: 'docs-links', selection: 'story-fast', inputPatterns: ['docs/**'], coverage: 'complete' },
        { commandId: 'docs-contract', selection: 'story-intermediate', inputPatterns: ['docs/**'], coverage: 'complete' },
        { commandId: 'module-unit', selection: 'story-fast', inputPatterns: ['packages/module/**'], coverage: 'complete' },
        { commandId: 'repo-sentinel', selection: 'repository-full', inputPatterns: ['proof-or-stop.config.json'], coverage: 'complete' },
      ],
    },
  });
  assert.equal(decision.effectiveTier, 'story-fast');
  assert.equal(decision.finalAuthority, false);
  assert.deepEqual(decision.tierSelections['story-fast'], ['build', 'docs-links']);
  assert.deepEqual(decision.tierSelections['story-intermediate'], ['build', 'docs-links', 'docs-contract']);
  assert.deepEqual(decision.tierSelections['repository-full'], universeCommandIds);
  assert.deepEqual(decision.exclusionProofs.map((proof) => proof.commandId), ['docs-contract', 'module-unit', 'repo-sentinel']);
  assert.deepEqual(
    decision.exclusionProofs.map((proof) => proof.reason),
    [
      'selected-tier-excludes-wider-tier-command',
      'complete-input-set-does-not-intersect-story-change',
      'complete-input-set-does-not-intersect-story-change',
    ],
  );
  assert.ok(decision.exclusionProofs.every((proof) => proof.snapshotDigest === 'snapshot-v1'));
});


testCase('the production catalog derives the canonical impact index and automatically promotes a docs Story to intermediate', () => {
  const commandSetDigest = 'command-set-v2';
  const catalog = [
    {
      id: 'build', assurance: 'always', riskTier: 'local', policySource: 'explicit',
      inputRoots: ['packages/main/src/**'], selectionInputRoots: ['packages/main/src/**'], selectionInputCoverage: 'complete', selectionInputCoverageSource: 'declared', triggerExtensions: { files: ['packages/main/src/**'] },
    },
    {
      id: 'docs-links', assurance: 'story-selectable', riskTier: 'local', policySource: 'explicit',
      inputRoots: ['docs/**'], selectionInputRoots: ['docs/**'], selectionInputCoverage: 'complete', selectionInputCoverageSource: 'declared', triggerExtensions: { files: ['docs/**'] },
    },
    {
      id: 'docs-contract', assurance: 'story-selectable', riskTier: 'shared', policySource: 'explicit',
      inputRoots: ['docs/**'], selectionInputRoots: ['docs/**'], selectionInputCoverage: 'complete', selectionInputCoverageSource: 'declared', triggerExtensions: { files: ['docs/**'] },
    },
    {
      id: 'repo-sentinel', assurance: 'full-only', riskTier: 'gate', policySource: 'explicit',
      inputRoots: ['proof-or-stop.config.json'], selectionInputRoots: ['proof-or-stop.config.json'], selectionInputCoverage: 'complete', selectionInputCoverageSource: 'declared', triggerExtensions: { files: ['proof-or-stop.config.json'] },
    },
    {
      id: 'never-reuse', assurance: 'story-selectable', riskTier: 'local', closurePolicy: 'never-reuse', policySource: 'explicit',
      inputRoots: ['scripts/never-reuse.ts'], selectionInputRoots: ['scripts/never-reuse.ts'], selectionInputCoverage: 'complete', selectionInputCoverageSource: 'declared', triggerExtensions: { files: ['scripts/never-reuse.ts'] },
    },
  ] as const;
  const impactIndex = buildValidationImpactIndexFromCatalog({ commandSetDigest, catalog });
  assert.equal(impactIndex.commandSetDigest, commandSetDigest);
  assert.deepEqual(impactIndex.entries.map((entry) => [entry.commandId, entry.selection]), [
    ['build', 'always'],
    ['docs-links', 'story-fast'],
    ['docs-contract', 'story-intermediate'],
    ['repo-sentinel', 'always'],
    ['never-reuse', 'always'],
  ]);

  const decision = selectAutomaticValidationTier({
    storyId: 'B-docs-auto',
    universeCommandIds: catalog.map((entry) => entry.id),
    changedPaths: ['docs/guide.md'],
    pinnedCommandIds: [],
    forceFullReasons: [],
    commandSetDigest,
    snapshotDigest: 'snapshot-v2',
    impactIndex,
  });
  assert.equal(decision.requestedTier, 'story-intermediate');
  assert.equal(decision.effectiveTier, 'story-intermediate');
  assert.deepEqual(decision.selectedUnitIds, ['build', 'docs-links', 'docs-contract', 'repo-sentinel', 'never-reuse']);
  assert.deepEqual(decision.tierSelections['story-fast'], ['build', 'docs-links', 'repo-sentinel', 'never-reuse']);
  assert.deepEqual(decision.tierSelections['story-intermediate'], ['build', 'docs-links', 'docs-contract', 'repo-sentinel', 'never-reuse']);
  assert.deepEqual(decision.tierSelections['repository-full'], catalog.map((entry) => entry.id));
  assert.equal(decision.exclusionProofs.some((proof) => proof.commandId === 'never-reuse'), false,
    'a never-reuse row is a shared participation floor and cannot receive an omission proof');
  assert.ok(decision.inclusionReasonsByCommand['never-reuse']?.includes('declared-always'),
    'validation_plan must report a never-reuse row as included');
  const fastDecision = selectValidationTiers({
    storyId: 'B-docs-proof', requestedTier: 'story-fast', universeCommandIds: catalog.map((entry) => entry.id),
    changedPaths: ['docs/guide.md'], pinnedCommandIds: [], forceFullReasons: [], commandSetDigest,
    snapshotDigest: 'snapshot-v2', impactIndex,
  });
  const originalProof = fastDecision.exclusionProofs.find((proof) => proof.commandId === 'docs-contract');
  assert.ok(originalProof, 'story-fast must carry a positive exclusion proof for the wider docs-contract row');
  const proofChanged = selectValidationTiers({
    storyId: 'B-docs-proof', requestedTier: 'story-fast', universeCommandIds: catalog.map((entry) => entry.id),
    changedPaths: ['docs/other.md'], pinnedCommandIds: [], forceFullReasons: [], commandSetDigest,
    snapshotDigest: 'snapshot-v2', impactIndex,
  });
  const changedProof = proofChanged.exclusionProofs.find((proof) => proof.commandId === 'docs-contract');
  assert.ok(changedProof, 'the second story-fast decision must retain the proof-bearing omitted row');
  assert.equal(proofChanged.impactIndexDigest, fastDecision.impactIndexDigest,
    'the exclusion-proof witness must hold the canonical impact index byte-identical');
  assert.deepEqual(proofChanged.tierSelections, fastDecision.tierSelections,
    'the exclusion-proof witness must not change any tier membership');
  assert.deepEqual(changedProof.commandInputPatterns, originalProof.commandInputPatterns,
    'the exclusion-proof witness must hold the command input declaration constant');
  assert.notDeepEqual(changedProof.changedPaths, originalProof.changedPaths,
    'only the proof-bound Story path must change between the two decisions');
  assert.notEqual(proofChanged.selectionDigest, fastDecision.selectionDigest,
    'changing only a positive exclusion proof path must change the signed selector decision digest');
});


testCase('automatic selection reaches intermediate when fast is empty but a shared boundary matches', () => {
  const commandSetDigest = 'intermediate-only-command-set';
  const impactIndex = {
    schema: VALIDATION_IMPACT_INDEX_SCHEMA,
    version: 'intermediate-only-index',
    commandSetDigest,
    entries: [{
      commandId: 'shared-contract', selection: 'story-intermediate' as const,
      inputPatterns: ['packages/shared/**'], coverage: 'complete' as const,
    }],
  };
  const decision = selectAutomaticValidationTier({
    storyId: 'B-intermediate-only', universeCommandIds: ['shared-contract'],
    changedPaths: ['packages/shared/api.ts'], pinnedCommandIds: [], forceFullReasons: [],
    commandSetDigest, snapshotDigest: 'intermediate-only-snapshot', impactIndex,
  });
  assert.equal(decision.requestedTier, 'story-intermediate');
  assert.equal(decision.effectiveTier, 'story-intermediate');
  assert.deepEqual(decision.selectedUnitIds, ['shared-contract']);
  assert.deepEqual(decision.escalationReasonCodes, []);
});


testCase('A22 malformed promotion inputs retain a stable selector refusal', () => {
  const input = {
    storyId: 'B-promotion-shape', universeCommandIds: ['shared'],
    changedPaths: ['docs/guide.md'], pinnedCommandIds: [], forceFullReasons: [],
    commandSetDigest: 'promotion-commands', snapshotDigest: 'promotion-snapshot',
    impactIndex: {
      schema: VALIDATION_IMPACT_INDEX_SCHEMA, version: 'promotion-index', commandSetDigest: 'promotion-commands',
      entries: [{ commandId: 'shared', selection: 'story-intermediate' as const, inputPatterns: ['docs/**'], coverage: 'complete' as const }],
    },
  };
  const decision = selectAutomaticValidationTier(input);
  assert.equal(decision.effectiveTier, 'story-intermediate');
  const control = { catalogDigest: 'promotion-catalog', input, decision, bindingDigest: '' };
  control.bindingDigest = digestCanonicalJson({ catalogDigest: control.catalogDigest, input, decision });
  assert.doesNotThrow(() => assertAutomaticTierSelectionBindingCurrent(control));
  for (const mutantInput of [
    { ...input, impactIndex: { ...input.impactIndex, entries: [{ ...input.impactIndex.entries[0], inputPatterns: [42] as never }] } },
    { ...input, changedPaths: [42] as never },
  ]) {
    let fallback: ReturnType<typeof selectAutomaticValidationTier> | undefined;
    assert.doesNotThrow(() => { fallback = selectAutomaticValidationTier(mutantInput); },
      'A22 malformed promotion input must not escape as TypeError');
    assert.equal(fallback?.effectiveTier, 'repository-full');
    assert.ok(fallback?.escalationReasonCodes.includes('impact_index_unusable'));
    const binding = { ...control, input: mutantInput };
    binding.bindingDigest = digestCanonicalJson({ catalogDigest: binding.catalogDigest, input: binding.input, decision });
    let error: unknown;
    try { assertAutomaticTierSelectionBindingCurrent(binding); } catch (caught) { error = caught; }
    assert.ok(error, 'malformed input must invalidate the previously valid decision');
    assert.deepEqual(dynamicValidationDegradation(error).escalationReasons, ['selector_context_mismatch']);
  }
});


testCase('A22 foreign signed observe manifests cannot erase current Story dynamic lineage', () => {
  const root = projectRootWithConfig({ id: 'unit', label: 'unit', command: 'node', args: ['-e', '0'] });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
  const storyId = 'B-target-lineage';
  withValidationSigningRoot(root, () => {
    const inventory = discoverValidationInventory(root);
    const catalog = compileValidationCatalog(inventory);
    const makeObserve = (id: string) => buildDynamicValidationPlan({
      storyId: id, baseHead: 'base', head: 'head', inventory, catalog, closures: new Map(), mode: 'observe',
      changes: buildStoryChangeManifest({ storyId: id, gitCwd: root, baseHead: 'base', head: 'head', changedFiles: [] }),
    });
    const dir = join(root, '.proof-or-stop/runtime/dynamic-validation', storyId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'receipts.json'), '[]');
    const own = makeObserve(storyId);
    assert.equal(verifyValidationSelectionManifest(own, { storyId }), true);
    writeFileSync(join(dir, 'selection.json'), JSON.stringify(own));
    assert.equal(hasStoryAwareValidationArtifacts(root, storyId), false, 'authenticated same-Story observe remains non-authoritative');
    const foreign = makeObserve('B-foreign-lineage');
    assert.equal(verifyValidationSelectionManifest(foreign), true, 'the foreign control must have a valid repository signature');
    assert.equal(verifyValidationSelectionManifest(foreign, { storyId }), false);
    writeFileSync(join(dir, 'selection.json'), JSON.stringify(foreign));
    assert.equal(hasStoryAwareValidationArtifacts(root, storyId), true,
      'A22 foreign signed observe manifest must preserve strict receipt-backed routing');
  });
});


testCase('dynamic authority requires explicit configuration and only DEV REVIEW TEST can consume its coverage', () => {
  assert.equal(resolveValidationDynamicMode({ storyPhase: 'TEST' }), 'off');
  assert.equal(resolveValidationDynamicMode({ storyPhase: 'TEST', configuredMode: 'observe' }), 'off');
  assert.equal(resolveValidationDynamicMode({ storyPhase: 'TEST', configuredMode: 'shadow' }), 'off');
  assert.equal(resolveValidationDynamicMode({ storyPhase: 'TEST', configuredMode: 'enforce-low-risk' }), 'enforce-low-risk');
  assert.equal(resolveValidationDynamicMode({ storyPhase: 'REVIEW', configuredMode: 'enforce-low-risk' }), 'enforce-low-risk');
  assert.equal(resolveValidationDynamicMode({ storyPhase: 'INIT', configuredMode: 'enforce-low-risk' }), 'off');
  assert.equal(resolveValidationDynamicMode({ storyPhase: 'TEST', explicitMode: 'off' }), 'off');
  assert.equal(resolveValidationDynamicMode({ storyPhase: 'TEST', configuredMode: 'enforce-low-risk', full: true }), 'off');
  assert.equal(resolveValidationDynamicMode({ storyPhase: 'DONE', configuredMode: 'enforce-low-risk' }), 'off');
  assert.equal(resolveValidationDynamicMode({}), 'off');
  assert.equal(dynamicRoutineCoverageAllowed('enforce-low-risk', 'TEST'), true);
  assert.equal(dynamicRoutineCoverageAllowed('enforce-low-risk', 'REVIEW'), true);
  assert.equal(dynamicRoutineCoverageAllowed('enforce-low-risk', 'INIT'), false);
  assert.equal(dynamicRoutineCoverageAllowed('off', 'TEST'), false);
  assert.equal(dynamicRoutineCoverageAllowed('enforce-low-risk', 'DONE'), false);
  assert.equal(sharedValidationExecutionEnabled('off'), true);
  assert.equal(sharedValidationExecutionEnabled('observe'), false);
  assert.equal(sharedValidationExecutionEnabled('shadow'), false);
  assert.equal(sharedValidationExecutionEnabled('enforce-low-risk'), false);
  assert.equal(sharedValidationExecutionEnabled('observe', true), true);
  assert.equal(sharedValidationExecutionEnabled('shadow', true), true);
  assert.equal(sharedValidationExecutionEnabled('enforce-low-risk', true), true);
  const dynamicOutput = { provider: 'proof-or-stop-verifier-dynamic-authoritative', dynamicValidation: { authority: 'enforce-authority' } };
  assert.deepEqual(dynamicValidationCoverageAdmission(dynamicOutput, true), { dynamicOrigin: true, allowed: true });
  assert.deepEqual(dynamicValidationCoverageAdmission(dynamicOutput, false), {
    dynamicOrigin: true, allowed: false, reasonCode: 'dynamic_requires_canonical_full_plan',
  });
});


testCase('policy defaults and heuristic roots never manufacture complete input ownership', () => {
  const index = buildValidationImpactIndexFromCatalog({
    commandSetDigest: 'defaults-only',
    catalog: [{
      id: 'defaulted', assurance: 'story-selectable', riskTier: 'local', policySource: 'explicit',
      inputRoots: ['packages/main/src'], selectionInputRoots: ['packages/main/src'],
      selectionInputCoverage: 'partial', selectionInputCoverageSource: 'heuristic', triggerExtensions: {},
    }],
  });
  assert.equal(index.entries[0]?.coverage, 'partial');
  const decision = selectAutomaticValidationTier({
    storyId: 'B-defaulted', universeCommandIds: ['defaulted'], changedPaths: ['packages/main/src/a.ts'],
    pinnedCommandIds: [], forceFullReasons: [], commandSetDigest: 'defaults-only', snapshotDigest: 'snapshot', impactIndex: index,
  });
  assert.equal(decision.effectiveTier, 'repository-full');
  assert.ok(decision.escalationReasonCodes.includes('command_exclusion_unproven'));
});


testCase('A21 defaulted policy cannot grant complete selector ownership', () => {
  const root = projectRootWithConfig({
    id: 'defaulted', label: 'defaulted', command: 'node', args: ['task.js'],
    inputRoots: ['src/**'], inputsComplete: true,
  });
  const catalog = compileValidationCatalog(discoverValidationInventory(root));
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].policySource, 'default');
  assert.equal(catalog[0].selectionInputCoverage, 'complete');
  const index = buildValidationImpactIndexFromCatalog({ commandSetDigest: 'A21-defaults', catalog });
  assert.equal(index.entries[0].coverage, 'partial', 'A21 defaulted policy must remain partial despite complete declared roots');
});


testCase('the wired resolver widens every validation and gate machinery surface even when the index marks it fast', () => {
  for (const sensitivePath of [
    'packages/main/src/core/shared-validation-execution.ts',
    'packages/main/src/core/evidence-freshness.ts',
    'packages/main/src/core/material-path-policy.ts',
    'packages/main/src/core/runtime-artifact-registry.ts',
    'packages/main/src/core/digest.ts',
    'packages/main/src/core/config.ts',
    'packages/main/src/handlers/story-aware-validation.ts',
    'packages/main/src/handlers/validate-lint.ts',
    'packages/main/src/core/guard-utils.ts',
    '.githooks/pre-push',
  ]) {
    const input = planInput({
      readers: { changedFileStatuses: statusReader({ [sensitivePath]: 'M' }), hashSnapshot: fixtureHashSnapshot },
    });
    const result = resolveValidationTierPlan({
      input,
      requestedTier: 'story-fast' as const,
      impactIndex: {
        schema: VALIDATION_IMPACT_INDEX_SCHEMA,
        version: 'sensitive-index-v1',
        commandSetDigest: input.executionInventory.commandSetDigest,
        entries: [
          { commandId: 'unit-suite', selection: 'story-fast', inputPatterns: [sensitivePath], coverage: 'complete' },
          { commandId: 'lint-suite', selection: 'always', inputPatterns: [], coverage: 'complete' },
        ],
      },
    });
    assert.equal(result.status, 'plan', sensitivePath);
    if (result.status !== 'plan') continue;
    assert.equal(result.effectiveTier, 'repository-full', sensitivePath);
    assert.ok(reasonCodes(result).includes('validation_framework_sensitive_change'), sensitivePath);
    assert.deepEqual(result.unclassifiedInputs, [], `${sensitivePath} was classified by the configured index`);
  }
});


testCase('Dynamic Finding L4 gate paths force repository-full even when the impact index marks them fast', () => {
  const gateFact = getProcessFactRegistryEntry('runtime:dynamic_finding_applicability_gate');
  const expectedConsumers = [
    'finding_triage',
    'storyMachine.canPassReview',
    'getGuardFailureReason',
    'reviewer_batch',
    'reviewer_status',
    'review_convergence',
    'lifecycle_readiness',
    'certification_window',
    'storyMachine.canFinish',
    'story-aware-validation additive constraints',
  ];
  const expectedFloorPaths = [
    'packages/main/src/core/certification-window.ts',
    'packages/main/src/core/finding-applicability-projection.ts',
    'packages/main/src/core/finding-applicability.ts',
    'packages/main/src/core/guard-utils.ts',
    'packages/main/src/core/lifecycle-readiness.ts',
    'packages/main/src/core/machine.ts',
    'packages/main/src/core/review-convergence.ts',
    'packages/main/src/core/reviewer-status.ts',
    'packages/main/src/core/story-aware-validation.ts',
    'packages/main/src/handlers/finding-applicability-proof.ts',
    'packages/main/src/handlers/finding-applicability.ts',
    'packages/main/src/handlers/finding-deferral-proof.ts',
    'packages/main/src/handlers/finding-material-reattestation.ts',
    'packages/main/src/handlers/reviewer-batch.ts',
    'packages/main/src/handlers/transition-orchestrator.ts',
  ];
  assert.ok(gateFact, 'Dynamic Finding L4 gate process fact must be registered');
  assert.equal(gateFact.level, 'L4');
  assert.equal(gateFact.kind, 'runtime-behavior');
  assert.ok(gateFact.consumerGate?.trim(), 'Dynamic Finding L4 gate process fact must name its consumer gate');
  assert.equal(gateFact.validationTierFloor, 'repository-full');
  assert.deepEqual(
    [...PROCESS_FACT_DYNAMIC_FINDING_POLICY.allowedConsumers].sort(),
    [...expectedConsumers].sort(),
    'Dynamic Finding lifecycle-consumer authority must remain the explicit reviewed list',
  );
  assert.deepEqual(
    [...gateFact.paths].sort(),
    [...expectedFloorPaths].sort(),
    'shrinking or expanding the Dynamic Finding validation floor requires explicit review here',
  );
  assert.ok(gateFact.paths.length > 0, 'Dynamic Finding L4 gate process fact must declare governed paths');
  const declaredSourceRefs = [...new Set([
    ...(gateFact.producerSourceRefs ?? []),
    ...(gateFact.consumerSourceRefs ?? []),
  ])];
  assert.ok(declaredSourceRefs.length > 0, 'Dynamic Finding must declare its producer and consumer source surface');
  for (const sourceRef of declaredSourceRefs) {
    assert.ok(gateFact.paths.includes(sourceRef), `validation floor must include declared source ref: ${sourceRef}`);
    assert.ok(existsSync(join(repositorySourceRoot(), sourceRef)), `declared Dynamic Finding source must exist: ${sourceRef}`);
  }
  assert.ok(
    gateFact.paths.includes('packages/main/src/core/certification-window.ts'),
    'Dynamic Finding coverage must include a non-validation-named path outside the legacy sensitive-path list',
  );
  assert.deepEqual(
    Object.keys(PROCESS_FACT_DYNAMIC_FINDING_POLICY.consumerSourceRefsByConsumer).sort(),
    [...PROCESS_FACT_DYNAMIC_FINDING_POLICY.allowedConsumers].sort(),
    'every declared Dynamic Finding consumer must have a source mapping',
  );
  assert.deepEqual(
    Object.keys(PROCESS_FACT_DYNAMIC_FINDING_POLICY.consumerImplementationTokensByConsumer).sort(),
    [...PROCESS_FACT_DYNAMIC_FINDING_POLICY.allowedConsumers].sort(),
    'every declared Dynamic Finding consumer must have an implementation-presence token',
  );
  const producerPolicy = PROCESS_FACT_DYNAMIC_FINDING_POLICY as typeof PROCESS_FACT_DYNAMIC_FINDING_POLICY & {
    producerCommands?: readonly string[];
    producerSourceRefsByCommand?: Readonly<Record<string, readonly string[]>>;
  };
  assert.deepEqual(
    producerPolicy.producerCommands,
    [
      'finding_applicability_assess',
      'finding_applicability_batch',
      'finding_deferral_record',
      'finding_mandatory_repair_close',
    ],
    'Dynamic Finding producer authority must be an explicit command list',
  );
  assert.deepEqual(
    Object.keys(producerPolicy.producerSourceRefsByCommand ?? {}).sort(),
    [...(producerPolicy.producerCommands ?? [])].sort(),
    'every declared Dynamic Finding producer command must have a source mapping',
  );
  for (const commandName of producerPolicy.producerCommands ?? []) {
    const mappedSources = producerPolicy.producerSourceRefsByCommand?.[commandName] ?? [];
    assert.ok(
      mappedSources.some((sourceRef) => readFileSync(join(repositorySourceRoot(), sourceRef), 'utf8').includes(commandName)),
      `a mapped producer source must contain its exact command registration token: ${commandName}`,
    );
  }
  for (const consumer of PROCESS_FACT_DYNAMIC_FINDING_POLICY.allowedConsumers) {
    const mappedSources = PROCESS_FACT_DYNAMIC_FINDING_POLICY.consumerSourceRefsByConsumer[consumer];
    const implementationTokens = PROCESS_FACT_DYNAMIC_FINDING_POLICY.consumerImplementationTokensByConsumer[consumer];
    assert.ok(implementationTokens.length > 0, `Dynamic Finding consumer must declare at least one implementation-presence token: ${consumer}`);
    assert.ok(
      mappedSources.some((sourceRef) => {
        const source = readFileSync(join(repositorySourceRoot(), sourceRef), 'utf8');
        return implementationTokens.some((token) => source.includes(token));
      }),
      `mapped consumer source must retain its implementation-presence token; this does not prove Dynamic Finding consumption: ${consumer}`,
    );
  }
  const policyAuthorityPaths = [...new Set([
    ...Object.values(producerPolicy.producerSourceRefsByCommand ?? {}).flat(),
    ...PROCESS_FACT_DYNAMIC_FINDING_POLICY.semanticVerifierSourceRefs,
    ...Object.values(PROCESS_FACT_DYNAMIC_FINDING_POLICY.consumerSourceRefsByConsumer).flat(),
  ])];
  for (const policyAuthorityPath of policyAuthorityPaths) {
    assert.ok(
      gateFact.paths.includes(policyAuthorityPath),
      `Dynamic Finding validation floor must cover policy authority: ${policyAuthorityPath}`,
    );
    assert.ok(existsSync(join(repositorySourceRoot(), policyAuthorityPath)), `policy authority source must exist: ${policyAuthorityPath}`);
  }

  for (const sensitivePath of gateFact.paths) {
    const input = planInput({
      readers: { changedFileStatuses: statusReader({ [sensitivePath]: 'M' }), hashSnapshot: fixtureHashSnapshot },
    });
    const result = resolveValidationTierPlan({
      input,
      requestedTier: 'story-fast',
      impactIndex: {
        schema: VALIDATION_IMPACT_INDEX_SCHEMA,
        version: 'dynamic-finding-gate-index-v1',
        commandSetDigest: input.executionInventory.commandSetDigest,
        entries: [
          { commandId: 'unit-suite', selection: 'story-fast', inputPatterns: [sensitivePath], coverage: 'complete' },
          { commandId: 'lint-suite', selection: 'always', inputPatterns: [], coverage: 'complete' },
        ],
      },
    });
    assert.equal(result.status, 'plan', sensitivePath);
    if (result.status !== 'plan') continue;
    assert.equal(
      result.effectiveTier,
      'repository-full',
      `Dynamic Finding L4 gate path must force repository-full: ${sensitivePath}`,
    );
    assert.ok(reasonCodes(result).includes('validation_framework_sensitive_change'), sensitivePath);
  }
});


testCase('explicit repository-full process-fact paths force full without overmatching unrelated L4 code', () => {
  assert.equal(
    VALIDATION_TIER_FLOOR,
    'repository-full',
    'the registry must expose the one floor the selector actually implements, not a plural extension point',
  );
  const collected = collectRepositoryFullProcessFactPaths();
  const gatePatterns = collected.paths;
  assert.equal(collected.rejectedEntryCount, 0);
  assert.ok(gatePatterns.length > 0, 'the process-fact registry must declare at least one repository-full path');
  const liveFloorOwnerId = collected.floorOwnerIds.find(
    (ownerId) => ownerId === 'runtime:dynamic_finding_applicability_gate',
  );
  assert.equal(liveFloorOwnerId, 'runtime:dynamic_finding_applicability_gate');
  const absentDecodedMapping = collectRepositoryFullProcessFactPaths([]);
  assert.deepEqual(absentDecodedMapping, { paths: [], rejectedEntryCount: 0, floorOwnerIds: [] });
  assert.deepEqual(
    classifySensitiveStoryPaths([], { projection: absentDecodedMapping }),
    ['validation_floor_registry_unavailable'],
    'an absent decoded floor mapping stays readable but makes selection widen full',
  );
  const floorContractDoc = readFileSync(join(repositorySourceRoot(), 'docs/validation-performance.md'), 'utf8');
  assert.match(
    floorContractDoc,
    /An absent floor mapping leaves the registry loadable; its empty projection makes\s+the selector widen with `validation_floor_registry_unavailable`/u,
    'the operator guide must distinguish the loadable absent-mapping path',
  );
  assert.match(
    floorContractDoc,
    /A present floor\s+declaration with malformed or empty paths is instead refused while the registry\s+module initializes, before any selector can return a tier decision/u,
    'the operator guide must distinguish declaration refusal from selector widening',
  );
  assert.deepEqual(
    collectRepositoryFullProcessFactPaths([
      null,
      { level: 'not-a-level', paths: 'irrelevant-without-a-floor' },
      { level: 'L4' },
      { factId: 'runtime:fixture-shape', level: 'L4', validationTierFloor: 'repository-full', paths: 'not-an-array' },
      { factId: 'runtime:fixture-empty', level: 'L4', validationTierFloor: 'repository-full', paths: [] },
      { factId: 'runtime:fixture-level', level: 'L3', validationTierFloor: 'repository-full', paths: ['ignored-level.ts'] },
      { factId: 'runtime:fixture-floor', level: 'L4', validationTierFloor: 'story-fast', paths: ['ignored-floor.ts'] },
      {
        factId: 'runtime:fixture-mixed',
        level: 'L4',
        validationTierFloor: 'repository-full',
        paths: [null, '', 'packages/main/src/core/valid-full-path.ts'],
      },
      { factId: 'runtime:fixture-absolute', level: 'L4', validationTierFloor: 'repository-full', paths: ['/absolute.ts'] },
      { factId: 'runtime:fixture-escape', level: 'L4', validationTierFloor: 'repository-full', paths: ['../../escape.ts'] },
      { factId: 'runtime:fixture-backslash', level: 'L4', validationTierFloor: 'repository-full', paths: ['packages\\main\\escape.ts'] },
    ]),
    {
      paths: ['packages/main/src/core/valid-full-path.ts'],
      rejectedEntryCount: 9,
      floorOwnerIds: ['runtime:fixture-mixed'],
    },
    'malformed independently decoded registry entries must be reported while valid authority survives',
  );
  const completeTwoFloorProjection = collectRepositoryFullProcessFactPaths([
    {
      factId: liveFloorOwnerId,
      level: 'L4',
      validationTierFloor: 'repository-full',
      paths: ['packages/main/src/core/finding-applicability.ts'],
    },
    {
      factId: 'runtime:secondary-validation-floor',
      level: 'L4',
      validationTierFloor: 'repository-full',
      paths: ['packages/main/src/core/secondary-floor.ts'],
    },
  ]);
  assert.deepEqual(completeTwoFloorProjection.floorOwnerIds, [
    liveFloorOwnerId,
    'runtime:secondary-validation-floor',
  ].sort());
  const strippedTwoFloorProjection = collectRepositoryFullProcessFactPaths([
    {
      factId: liveFloorOwnerId,
      level: 'L4',
      paths: ['packages/main/src/core/finding-applicability.ts'],
    },
    {
      factId: 'runtime:secondary-validation-floor',
      level: 'L4',
      validationTierFloor: 'repository-full',
      paths: ['packages/main/src/core/secondary-floor.ts'],
    },
  ]);
  assert.deepEqual(strippedTwoFloorProjection.floorOwnerIds, ['runtime:secondary-validation-floor']);
  assert.deepEqual(
    classifySensitiveStoryPaths([], { projection: strippedTwoFloorProjection }),
    ['validation_floor_registry_unavailable'],
    'a decoded multi-floor projection missing the live floor owner must widen rather than silently narrow',
  );
  const declaration = {
    name: 'runtime:test-validation-floor',
    kind: 'runtime-behavior' as const,
    semantics: ['runtime-behavior' as const],
    producer: 'validation-tier-planner-smoke',
    rationale: 'Fixture declaration used to prove invalid validation tier floors fail loudly.',
    validationTierFloor: 'repository-full' as const,
  };
  assert.throws(
    () => declareProcessFactMapping({ ...declaration, level: 'L3', paths: ['packages/main/src/core/example.ts'] }),
    /runtime:test-validation-floor validationTierFloor requires level L4/,
  );
  assert.throws(
    () => declareProcessFactMapping({ ...declaration, level: 'L4' }),
    /runtime:test-validation-floor validationTierFloor requires explicitly authored paths/,
  );
  assert.throws(
    () => declareProcessFactMapping({
      name: 'runtime:dynamic_finding_applicability_gate',
      kind: 'runtime-behavior',
      semantics: ['runtime-behavior'],
      level: 'L4',
      producer: 'fixture',
      rationale: 'A missing Dynamic Finding source mapping must fail at registry declaration time.',
    }),
    /runtime:dynamic_finding_applicability_gate requires explicit validation floor paths/,
  );
  assert.throws(
    () => declareProcessFactMapping({
      ...declaration,
      level: 'L4',
      paths: ['packages/main/src/core/example.ts'],
      validationTierFloor: 'full' as never,
    }),
    /runtime:test-validation-floor has unknown validationTierFloor: full/,
  );

  const planForPath = (changedPath: string) => {
    const input = planInput({
      readers: { changedFileStatuses: statusReader({ [changedPath]: 'M' }), hashSnapshot: fixtureHashSnapshot },
    });
    return resolveValidationTierPlan({
      input,
      requestedTier: 'story-fast',
      impactIndex: {
        schema: VALIDATION_IMPACT_INDEX_SCHEMA,
        version: 'repository-full-process-facts-v1',
        commandSetDigest: input.executionInventory.commandSetDigest,
        entries: [
          { commandId: 'unit-suite', selection: 'story-fast', inputPatterns: [changedPath], coverage: 'complete' },
          { commandId: 'lint-suite', selection: 'always', inputPatterns: [], coverage: 'complete' },
        ],
      },
    });
  };

  assert.deepEqual(
    classifySensitiveStoryPaths([], undefined),
    classifySensitiveStoryPaths([]),
    'an explicitly undefined optional override must have the same meaning as omission',
  );

  const liveFloorOwnerIds = collected.floorOwnerIds;
  const validFloorPath = 'packages/main/src/core/valid-full-path.ts';
  const semanticallyUnavailableProjections = [
    { paths: [], rejectedEntryCount: 0, floorOwnerIds: liveFloorOwnerIds },
    { paths: [validFloorPath], rejectedEntryCount: 1, floorOwnerIds: liveFloorOwnerIds },
  ];
  const malformedProjectionShapes = [
    { paths: [validFloorPath], rejectedEntryCount: Number.NaN, floorOwnerIds: liveFloorOwnerIds },
    { paths: [validFloorPath], rejectedEntryCount: 'many', floorOwnerIds: liveFloorOwnerIds },
    { paths: 'not-an-array', rejectedEntryCount: 0, floorOwnerIds: liveFloorOwnerIds },
    { paths: [validFloorPath], rejectedEntryCount: 0 },
  ];
  const availableProjection = {
    paths: [validFloorPath],
    rejectedEntryCount: 0,
    floorOwnerIds: liveFloorOwnerIds,
  };
  assert.deepEqual(
    classifySensitiveStoryPaths([], { projection: availableProjection }),
    [],
    'a shape-valid, non-empty, fully owned projection must not report registry unavailability',
  );
  for (const unavailable of semanticallyUnavailableProjections) {
    assert.deepEqual(
      classifySensitiveStoryPaths([], { projection: unavailable }),
      ['validation_floor_registry_unavailable'],
      'an empty or rejected shape-valid registry floor must widen independently of changed paths',
    );
    const decision = selectValidationTiers({
      storyId: 'B-floor-unavailable',
      requestedTier: 'story-fast',
      universeCommandIds: ['unit-suite', 'lint-suite'],
      changedPaths: [],
      pinnedCommandIds: [],
      forceFullReasons: [],
      commandSetDigest: 'floor-unavailable-command-set-v1',
      snapshotDigest: 'floor-unavailable-snapshot-v1',
      impactIndex: {
        schema: VALIDATION_IMPACT_INDEX_SCHEMA,
        version: 'floor-unavailable-index-v1',
        commandSetDigest: 'floor-unavailable-command-set-v1',
        entries: [
          { commandId: 'unit-suite', selection: 'story-fast', inputPatterns: ['packages/module-a/**'], coverage: 'complete' },
          { commandId: 'lint-suite', selection: 'always', inputPatterns: [], coverage: 'complete' },
        ],
      },
    }, { registryFloorProjection: unavailable });
    assert.equal(decision.effectiveTier, 'repository-full');
    assert.ok(decision.escalationReasonCodes.includes('validation_floor_registry_unavailable'));
  }
  for (const malformed of malformedProjectionShapes) {
    assert.deepEqual(
      classifySensitiveStoryPaths([], { projection: malformed }),
      ['validation_floor_registry_unavailable'],
      'a malformed projection shape must widen independently of changed paths',
    );
  }
  const invalidDependenciesInput: SelectValidationTiersInput = {
      storyId: 'B-invalid-dependencies',
      requestedTier: 'story-fast',
      universeCommandIds: ['unit-suite'],
      changedPaths: [],
      pinnedCommandIds: [],
      forceFullReasons: [],
      commandSetDigest: 'invalid-dependencies-command-set-v1',
      snapshotDigest: 'invalid-dependencies-snapshot-v1',
      impactIndex: {
        schema: VALIDATION_IMPACT_INDEX_SCHEMA,
        version: 'invalid-dependencies-index-v1',
        commandSetDigest: 'invalid-dependencies-command-set-v1',
        entries: [
          { commandId: 'unit-suite', selection: 'always', inputPatterns: [], coverage: 'complete' },
        ],
      },
    };
  for (const invalidDependencies of [null, [], 'x', 0, true]) {
    assert.throws(
      () => selectValidationTiers(invalidDependenciesInput, invalidDependencies as never),
      /selectValidationTiers: dependencies must be an object/,
      `invalid dependency seam shape must be refused: ${JSON.stringify(invalidDependencies)}`,
    );
  }
  for (const invalidPath of [null, [], 0, true, {}]) {
    assert.throws(
      () => pathIsLegacyValidationSensitive(invalidPath as never),
      /pathIsLegacyValidationSensitive: path must be a string/,
      `legacy sensitivity helper must name an invalid path: ${JSON.stringify(invalidPath)}`,
    );
  }
  for (const invalidPaths of [null, 'x', 0, true, [null]]) {
    assert.throws(
      () => classifySensitiveStoryPaths(invalidPaths as never),
      /classifySensitiveStoryPaths: paths must be an array of strings/,
      `sensitivity classifier must name invalid paths: ${JSON.stringify(invalidPaths)}`,
    );
  }
  for (const invalidInjection of [null, [], 'x', 0, true, {}]) {
    assert.throws(
      () => classifySensitiveStoryPaths([], invalidInjection as never),
      /classifySensitiveStoryPaths: injection must be an object with a projection property/,
      `sensitivity classifier must name an invalid injection: ${JSON.stringify(invalidInjection)}`,
    );
  }
  const omittedDependencies = selectValidationTiers(invalidDependenciesInput);
  assert.ok(
    !omittedDependencies.escalationReasonCodes.includes('validation_floor_registry_unavailable'),
    'omitting the internal dependency seam must use the valid live registry projection',
  );
  const explicitlyUnavailableDependencies = selectValidationTiers(
    invalidDependenciesInput,
    { registryFloorProjection: undefined },
  );
  assert.equal(explicitlyUnavailableDependencies.effectiveTier, 'repository-full');
  assert.ok(
    explicitlyUnavailableDependencies.escalationReasonCodes.includes('validation_floor_registry_unavailable'),
    'an explicitly supplied undefined projection must remain distinguishable from omission and widen full',
  );

  const plannerSource = readFileSync(join(repositorySourceRoot(), 'packages/main/src/core/validation-tier-planner.ts'), 'utf8');
  const handlerSource = readFileSync(join(repositorySourceRoot(), 'packages/main/src/handlers/validation-plan.ts'), 'utf8');
  const plannerAst = ts.createSourceFile(
    'validation-tier-planner.ts',
    plannerSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const productionCallSites: ts.CallExpression[] = [];
  const visitPlanner = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'selectValidationTiers') productionCallSites.push(node);
    ts.forEachChild(node, visitPlanner);
  };
  visitPlanner(plannerAst);
  assert.equal(productionCallSites.length, 4, 'only the plan resolver and automatic-tier wrapper may call the canonical selector');
  const resolverCalls = productionCallSites.filter((call) => call.arguments.length === 1);
  const automaticCalls = productionCallSites.filter((call) => call.arguments.length === 2);
  assert.equal(resolverCalls.length, 1, 'the public plan resolver must keep the live registry seam implicit');
  assert.equal(automaticCalls.length, 3, 'the automatic wrapper owns exactly three explicit-tier calls');
  assert.ok(automaticCalls.every((call) => ts.isIdentifier(call.arguments[1]!) && call.arguments[1]!.text === 'dependencies'),
    'automatic-tier calls may forward only the named internal dependencies seam, never a fabricated literal');
  assert.doesNotMatch(handlerSource, /selectValidationTiers\(/u, 'validation-plan.ts may not call the selector seam directly');
  assert.match(
    validationWideningReasonGloss('validation_floor_registry_unavailable'),
    /could not provide a complete repository-full floor set, or declares no floor at all/,
  );
  assert.match(
    VALIDATION_WIDENING_REASONS.validation_framework_sensitive_change.condition,
    /declared repository-full process-fact path/,
    'the widening condition must describe the implemented legacy-pattern plus declared-floor boundary',
  );

  const dynamicPath = 'packages/main/src/core/finding-applicability.ts';
  const additiveDecision = selectValidationTiers({
    storyId: 'B-floor-additive',
    requestedTier: 'story-fast',
    universeCommandIds: ['unit-suite', 'lint-suite'],
    changedPaths: [dynamicPath],
    pinnedCommandIds: [],
    forceFullReasons: [],
    commandSetDigest: 'floor-additive-command-set-v1',
    snapshotDigest: 'floor-additive-snapshot-v1',
    impactIndex: {
      schema: VALIDATION_IMPACT_INDEX_SCHEMA,
      version: 'floor-additive-index-v1',
      commandSetDigest: 'floor-additive-command-set-v1',
      entries: [
        { commandId: 'unit-suite', selection: 'story-fast', inputPatterns: [dynamicPath], coverage: 'complete' },
        { commandId: 'lint-suite', selection: 'always', inputPatterns: [], coverage: 'complete' },
      ],
    },
  }, {
    registryFloorProjection: {
      paths: ['packages/main/src/core/unrelated-injected.ts'],
      rejectedEntryCount: 0,
      floorOwnerIds: collected.floorOwnerIds,
    },
  });
  assert.equal(additiveDecision.effectiveTier, 'repository-full');
  assert.ok(additiveDecision.escalationReasonCodes.includes('validation_framework_sensitive_change'));
  assert.ok(!additiveDecision.escalationReasonCodes.includes('validation_floor_registry_unavailable'));

  assert.ok(
    gatePatterns.some((path) => !pathIsLegacyValidationSensitive(path)),
    'at least one declared floor path must lie outside the legacy sensitivity list',
  );
  for (const gatePattern of gatePatterns) {
    const result = planForPath(gatePattern);
    assert.equal(result.status, 'plan', gatePattern);
    if (result.status !== 'plan') continue;
    assert.equal(result.effectiveTier, 'repository-full', `declared full path must force full: ${gatePattern}`);
    assert.ok(reasonCodes(result).includes('validation_framework_sensitive_change'), gatePattern);
  }

  for (const unrelatedPath of [
    'packages/main/src/core/certification-window.ts.bak',
    'packages/module-a/src/unrelated.ts',
  ]) {
    const result = planForPath(unrelatedPath);
    assert.equal(result.status, 'plan', unrelatedPath);
    if (result.status !== 'plan') continue;
    assert.equal(result.effectiveTier, 'story-fast', `unrelated path must remain fast: ${unrelatedPath}`);
    assert.ok(!reasonCodes(result).includes('validation_framework_sensitive_change'), unrelatedPath);
  }

  const providerAdmissionFact = getProcessFactRegistryEntry('runtime:machine_provider_admission');
  const explicitUnflooredL4Path = 'packages/main/src/core/provider-process-admission.ts';
  assert.equal(providerAdmissionFact?.level, 'L4');
  assert.equal(providerAdmissionFact?.validationTierFloor, undefined);
  assert.ok(providerAdmissionFact?.producerSourceRefs?.includes(explicitUnflooredL4Path));
  const providerAdmissionResult = planForPath(explicitUnflooredL4Path);
  assert.equal(providerAdmissionResult.status, 'plan');
  if (providerAdmissionResult.status === 'plan') {
    assert.equal(providerAdmissionResult.effectiveTier, 'story-fast');
    assert.ok(!reasonCodes(providerAdmissionResult).includes('validation_framework_sensitive_change'));
  }
});


testCase('an indexed repository-full request always selects the non-empty universe with or without material seeds', () => {
  const impactIndex = {
    schema: VALIDATION_IMPACT_INDEX_SCHEMA,
    version: 'full-index-v1',
    commandSetDigest: 'full-command-set-v1',
    entries: [
      { commandId: 'docs-fast', selection: 'story-fast' as const, inputPatterns: ['docs/**'], coverage: 'complete' as const },
      { commandId: 'docs-wide', selection: 'story-intermediate' as const, inputPatterns: ['docs/**'], coverage: 'complete' as const },
    ],
  };
  for (const changedPaths of [[], ['docs/guide.md']]) {
    const decision = selectValidationTiers({
      storyId: 'B-full',
      requestedTier: 'repository-full',
      universeCommandIds: ['docs-fast', 'docs-wide'],
      changedPaths,
      pinnedCommandIds: [],
      forceFullReasons: [],
      commandSetDigest: 'full-command-set-v1',
      snapshotDigest: 'full-snapshot-v1',
      impactIndex,
    });
    assert.equal(decision.effectiveTier, 'repository-full');
    assert.deepEqual(decision.selectedUnitIds, ['docs-fast', 'docs-wide']);
    assert.deepEqual(decision.escalationReasonCodes, []);
  }
});


testCase('no pruning exists: a story that changed nothing still selects the complete universe', () => {
  const result = planFor('story-intermediate');
  assert.equal(result.status, 'plan');
  if (result.status !== 'plan') return;
  assert.deepEqual(result.selectedUnitIds, ['unit-suite', 'lint-suite']);
  assert.ok(
    reasonCodes(result).includes('command_exclusion_unproven'),
    'without a positive exclusion proof no command may be dropped',
  );
  assert.ok(
    reasonCodes(result).includes('impact_index_unusable'),
    'there is no impact index in this increment, and the plan must say so',
  );
});


// ---------------------------------------------------------------------------
// (28) ALL FOUR SOURCE KINDS.
// ---------------------------------------------------------------------------
testCase('configured is the command-set path', () => {
  const result = planFor('repository-full', { routine: { sourceKind: 'configured', commands: RELEVANCE_COMMANDS } });
  assert.equal(result.status, 'plan');
  if (result.status !== 'plan') return;
  assert.equal(result.executionMode, 'command-set');
  assert.ok(!reasonCodes(result).includes('source_kind_atomic'));
});


for (const atomicKind of ['fallback', 'validate-file'] as const) {
  testCase(`${atomicKind} reports source_kind_atomic and executes its atomic repository-full path`, () => {
    const result = planFor('story-fast', { routine: { sourceKind: atomicKind, commands: RELEVANCE_COMMANDS } });
    assert.equal(result.status, 'plan');
    if (result.status !== 'plan') return;
    assert.equal(result.effectiveTier, 'repository-full');
    assert.equal(result.executionMode, 'atomic');
    assert.equal(result.selectedUnitIds.length, 1, 'an opaque source kind is ONE atomic unit');
    assert.equal(result.universe[0].kind, 'atomic');
    assert.ok(reasonCodes(result).includes('source_kind_atomic'));
  });
}


testCase('an atomic source with a configured index reports atomicity rather than claiming the index is absent', () => {
  const input = planInput({
    routine: { sourceKind: 'validate-file', commands: RELEVANCE_COMMANDS },
    readers: { changedFileStatuses: statusReader({ 'docs/guide.md': 'M' }), hashSnapshot: fixtureHashSnapshot },
  });
  const result = resolveValidationTierPlan({
    input,
    requestedTier: 'story-fast',
    impactIndex: {
      schema: VALIDATION_IMPACT_INDEX_SCHEMA,
      version: 'atomic-index-v1',
      commandSetDigest: input.executionInventory.commandSetDigest,
      entries: RELEVANCE_COMMANDS.map((entry) => ({
        commandId: entry.id!,
        selection: 'story-fast' as const,
        inputPatterns: ['docs/**'],
        coverage: 'complete' as const,
      })),
    },
  });
  assert.equal(result.status, 'plan');
  if (result.status !== 'plan') return;
  assert.equal(result.effectiveTier, 'repository-full');
  assert.ok(reasonCodes(result).includes('source_kind_atomic'));
  assert.ok(!reasonCodes(result).includes('impact_index_unusable'));
  assert.ok(!reasonCodes(result).includes('command_exclusion_unproven'));
  assert.deepEqual(result.unclassifiedInputs, []);

  const malformed = resolveValidationTierPlan({
    input,
    requestedTier: 'story-fast',
    impactIndex: {} as ValidationImpactIndex,
  });
  assert.equal(malformed.status, 'plan');
  assert.ok(reasonCodes(malformed).includes('impact_index_unusable'));
  assert.ok(malformed.unclassifiedInputs.every((entry) =>
    entry.detail.includes('configured impact index is malformed') && !entry.detail.includes('no impact index maps')));
});


testCase('configured-index stop and no-validator results never fall back to missing-index prose', () => {
  const changedPath = 'docs/guide.md';
  const indexedInput = planInput({
    readers: { changedFileStatuses: statusReader({ [changedPath]: 'M' }), hashSnapshot: fixtureHashSnapshot },
  });
  const impactIndex = {
    schema: VALIDATION_IMPACT_INDEX_SCHEMA,
    version: 'all-outcomes-index-v1',
    commandSetDigest: indexedInput.executionInventory.commandSetDigest,
    entries: [
      { commandId: 'unit-suite', selection: 'story-fast' as const, inputPatterns: ['docs/**'], coverage: 'complete' as const },
      { commandId: 'lint-suite', selection: 'story-intermediate' as const, inputPatterns: ['docs/**'], coverage: 'complete' as const },
    ],
  };
  const stopInput = {
    ...indexedInput,
    escalations: [...indexedInput.escalations, { code: 'pinned_command_missing' as const, detail: 'fixture missing pin' }],
  };
  const stop = resolveValidationTierPlan({ input: stopInput, requestedTier: 'story-fast', impactIndex });
  assert.equal(stop.status, 'stop');
  assert.deepEqual(stop.unclassifiedInputs, []);

  const noValidatorInput = planInput({
    routine: { sourceKind: 'no-validator', commands: [] },
    readers: { changedFileStatuses: statusReader({ [changedPath]: 'M' }), hashSnapshot: fixtureHashSnapshot },
  });
  const noValidator = resolveValidationTierPlan({ input: noValidatorInput, requestedTier: 'story-fast', impactIndex });
  assert.equal(noValidator.status, 'no-tier-pass');
  assert.deepEqual(noValidator.unclassifiedInputs, []);
  for (const result of [stop, noValidator]) {
    assert.ok(result.unclassifiedInputs.every((entry) => !entry.detail.includes('no impact index maps')));
  }
});


testCase('material dirty paths participate in indexed selection and cannot receive false non-intersection proofs', () => {
  const dirtyPath = 'packages/module-a/src/index.ts';
  const dirtySnapshot = (): EvidenceHashSnapshot => ({
    ...FIXTURE_HEAD_SNAPSHOT,
    materialHash: 'dirty-material-hash',
    materialDirtyFiles: [dirtyPath],
  });
  const input = planInput({
    readers: { changedFileStatuses: statusReader({}), hashSnapshot: dirtySnapshot },
  });
  const result = resolveValidationTierPlan({
    input,
    requestedTier: 'story-fast',
    impactIndex: {
      schema: VALIDATION_IMPACT_INDEX_SCHEMA,
      version: 'dirty-index-v1',
      commandSetDigest: input.executionInventory.commandSetDigest,
      entries: [
        { commandId: 'unit-suite', selection: 'story-fast', inputPatterns: ['packages/module-a/**'], coverage: 'complete' },
        { commandId: 'lint-suite', selection: 'repository-full', inputPatterns: ['docs/**'], coverage: 'complete' },
      ],
    },
  });
  assert.equal(result.status, 'plan');
  if (result.status !== 'plan') return;
  assert.equal(result.effectiveTier, 'story-fast');
  assert.deepEqual(result.selectedUnitIds, ['unit-suite']);
  assert.ok(!(result.exclusionProofs ?? []).some((proof) => proof.commandId === 'unit-suite'));
});


testCase('selector proof digests ignore capture time and absolute checkout paths', () => {
  const baseInput = planInput({
    readers: { changedFileStatuses: statusReader({ 'docs/guide.md': 'M' }), hashSnapshot: fixtureHashSnapshot },
  });
  const impactIndex = {
    schema: VALIDATION_IMPACT_INDEX_SCHEMA,
    version: 'portable-proof-index-v1',
    commandSetDigest: baseInput.executionInventory.commandSetDigest,
    entries: [
      { commandId: 'unit-suite', selection: 'story-fast' as const, inputPatterns: ['docs/**'], coverage: 'complete' as const },
      { commandId: 'lint-suite', selection: 'repository-full' as const, inputPatterns: ['other/**'], coverage: 'complete' as const },
    ],
  };
  const movedInput = {
    ...baseInput,
    hashes: baseInput.hashes.status === 'available'
      ? {
          status: 'available' as const,
          head: {
            ...baseInput.hashes.head,
            capturedAt: '2030-01-01T00:00:00.000Z',
            gitCwd: '/another/checkout',
            metadataRoot: '/another/metadata-root',
          },
        }
      : baseInput.hashes,
  };
  const first = resolveValidationTierPlan({ input: baseInput, requestedTier: 'story-fast', impactIndex });
  const second = resolveValidationTierPlan({ input: movedInput, requestedTier: 'story-fast', impactIndex });
  assert.equal(first.status, 'plan');
  assert.equal(second.status, 'plan');
  if (first.status !== 'plan' || second.status !== 'plan') return;
  assert.equal(first.selectorDecisionDigest, second.selectorDecisionDigest);
  assert.deepEqual(
    (first.exclusionProofs ?? []).map((proof) => proof.snapshotDigest),
    (second.exclusionProofs ?? []).map((proof) => proof.snapshotDigest),
  );
});


testCase('no-validator preserves the existing skip/warn and produces NO tier pass', () => {
  const result = planFor('story-fast', { routine: { sourceKind: 'no-validator', commands: [] } });
  assert.equal(result.status, 'no-tier-pass');
  if (result.status !== 'no-tier-pass') return;
  assert.equal(result.reason.code, 'no_validator');
  assert.equal((result as { effectiveTier?: unknown }).effectiveTier, undefined, 'a skip must not carry an effective tier');
  assert.equal((result as { selectedUnitIds?: unknown }).selectedUnitIds, undefined);
  assert.equal(result.finalAuthority, false);
});


// ---------------------------------------------------------------------------
// (29) AN UNCLASSIFIED MATERIAL INPUT.
//      It must appear BOTH as an escalation reason and in `unclassifiedInputs`:
//      a reason with nothing behind it cannot be acted on, and an entry that
//      never escalates is a silent narrowing.
// ---------------------------------------------------------------------------
testCase('an unclassified material input escalates AND is listed', () => {
  const result = planFor('story-fast', {
    readers: {
      changedFileStatuses: statusReader({ 'src/core/unmapped-thing.ts': 'M' }),
      hashSnapshot: fixtureHashSnapshot,
    },
  });
  assert.equal(result.status, 'plan');
  if (result.status !== 'plan') return;
  assert.ok(reasonCodes(result).includes('unclassified_material_input'));
  const listed = result.unclassifiedInputs.filter((entry) => entry.value === 'src/core/unmapped-thing.ts');
  assert.equal(listed.length, 1, 'the unclassified path itself must be listed, not just counted');
  assert.equal(listed[0].kind, 'material-path');
});


testCase('an unresolvable explicit commandId collected upstream becomes a classified stop, never a plan', () => {
  const result = planFor('story-fast', {
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationEvidence: [
            {
              intentRef: 'CHK-001:happy:0',
              kind: 'integration_test',
              commandId: 'gone-suite',
              command: 'npm run gone',
              result: 'pass',
              note: 'fixture evidence',
            },
          ],
        }),
      ],
    },
  });
  assert.equal(result.status, 'stop');
  if (result.status !== 'stop') return;
  assert.equal(result.reason.code, 'pinned_command_missing');
  assert.equal((result as { effectiveTier?: unknown }).effectiveTier, undefined);
});


// ---------------------------------------------------------------------------
// (29b) B-a745 F-001 — a NON-INVENTORY legacy pin widens; it never stops and it
//       never prunes. Written so the outcome is checked on both halves: the plan
//       must exist AND it must still select the complete universe, because the
//       whole justification for not stopping is that nothing is omitted.
// ---------------------------------------------------------------------------
testCase('a non-inventory legacy pin plans repository-full instead of stopping, and seeds no command', () => {
  const overrides = {
    checklist: {
      items: [
        checklistItem({
          id: 'CHK-001',
          verificationEvidence: [
            { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm run gone', result: 'pass', note: 'fixture evidence' },
          ],
        }),
      ],
    },
  };
  const input = planInput(overrides);
  assert.deepEqual(input.commandSeedEdges, [], 'a non-inventory pin adds no command-to-seed edge');

  const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
  assert.equal(result.status, 'plan', 'a free-form pin naming a non-inventory command must not stop the plan');
  if (result.status !== 'plan') return;
  assert.equal(result.effectiveTier, 'repository-full');
  assert.ok(
    reasonCodes(result).includes('pinned_command_non_inventory'),
    'the classification must reach the operator as a glossed escalation reason',
  );
  assert.deepEqual(
    result.selectedUnitIds,
    result.universe.map((unit) => unit.id),
    'nothing may be omitted on a non-inventory pin account: that is why it is allowed not to stop',
  );
  assert.ok(result.selectedUnitIds.length > 0);
});


// ---------------------------------------------------------------------------
// (30) EXHAUSTIVE BRANCH COVERAGE (load-bearing).
//      `story-fast` and `story-intermediate` are never returned as an EFFECTIVE
//      tier. This is proven by sweeping the resolver's whole input space, not by
//      a comment promising it.
// ---------------------------------------------------------------------------
testCase('no input in the resolver space yields a reduced effective tier', () => {
  const observedStatuses = new Set<string>();
  const observedReasons = new Set<string>();
  let combinations = 0;
  const nonInventoryPin = [
    checklistItem({
      id: 'CHK-001',
      verificationEvidence: [
        { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm run gone', result: 'pass', note: 'fixture evidence' },
      ],
    }),
  ];
  const unresolvableIdPin = [
    checklistItem({
      id: 'CHK-001',
      verificationEvidence: [
        {
          intentRef: 'CHK-001:happy:0',
          kind: 'integration_test',
          commandId: 'gone-suite',
          command: 'npm run gone',
          result: 'pass',
          note: 'fixture evidence',
        },
      ],
    }),
  ];
  const pinKinds = {
    none: [] as ChecklistItem[],
    'legacy-non-inventory': nonInventoryPin,
    'unresolvable-id': unresolvableIdPin,
  };

  for (const requestedTier of VALIDATION_TIERS) {
    for (const sourceKind of SOURCE_KINDS) {
      for (const changedFilesReadable of [true, false]) {
        for (const pinKind of Object.keys(pinKinds) as Array<keyof typeof pinKinds>) {
          for (const emptyUniverse of [true, false]) {
            combinations += 1;
            const result = planFor(requestedTier, {
              routine: {
                sourceKind,
                commands: sourceKind === 'no-validator' || emptyUniverse ? [] : RELEVANCE_COMMANDS,
              },
              checklist: { items: pinKinds[pinKind] },
              readers: {
                changedFileStatuses: changedFilesReadable
                  ? statusReader({ 'src/core/foo.ts': 'M' })
                  : throwingStatusReader,
                hashSnapshot: fixtureHashSnapshot,
              },
            });
            observedStatuses.add(result.status);
            for (const code of reasonCodes(result)) observedReasons.add(code);
            const effective = (result as { effectiveTier?: unknown }).effectiveTier;
            assert.ok(
              effective === undefined || effective === 'repository-full',
              `effectiveTier ${String(effective)} escaped for ${requestedTier}/${sourceKind}`,
            );
            assert.notEqual(effective, 'story-fast');
            assert.notEqual(effective, 'story-intermediate');
            if (result.status === 'plan') {
              assert.equal(result.reductionApplied, false);
              assert.ok(result.selectedUnitIds.length > 0, 'a plan may never carry an empty selection');
              assert.deepEqual(result.selectedUnitIds, result.universe.map((unit) => unit.id));
            }
            assert.equal((result as { allPass?: unknown }).allPass, undefined, 'the planner never asserts a pass');
          }
        }
      }
    }
  }

  assert.equal(combinations, 144, 'the sweep must cover the full cartesian product');
  assert.deepEqual([...observedStatuses].sort(), ['no-tier-pass', 'plan', 'stop']);
  for (const expected of [
    'impact_index_unusable',
    'command_exclusion_unproven',
    'changed_files_unavailable',
    'source_kind_atomic',
    'pinned_command_non_inventory',
  ]) {
    assert.ok(observedReasons.has(expected), `the sweep never exercised ${expected}`);
  }
});


// ---------------------------------------------------------------------------
// (31) AN EMPTY UNIVERSE IS A CLASSIFIED STOP, NEVER A PASSING EMPTY PLAN.
//      Written so an implementation returning `{allPass: true, selected: []}`
//      fails: the status must be a stop, the reason must be named, and no
//      pass-shaped field may exist.
// ---------------------------------------------------------------------------
testCase('an empty universe stops as empty_selection_unclassified rather than passing empty', () => {
  const result = planFor('repository-full', { routine: { sourceKind: 'configured', commands: [] } });
  assert.equal(result.status, 'stop', 'an empty universe must STOP, not produce an empty plan');
  assert.notEqual(result.status, 'plan');
  if (result.status !== 'stop') return;
  assert.equal(result.reason.code, 'empty_selection_unclassified');
  assert.ok(result.reason.gloss.trim().length > 0);
  assert.equal((result as { allPass?: unknown }).allPass, undefined, 'no pass-shaped field may exist on a stop');
  assert.equal((result as { selectedUnitIds?: unknown }).selectedUnitIds, undefined, 'a stop selects nothing at all');
  assert.equal((result as { effectiveTier?: unknown }).effectiveTier, undefined);
});


// ---------------------------------------------------------------------------
// (31b) B-a745 F-006 — THE TABLE IS THE ONLY SOURCE OF TRUTH FOR "THIS STOPS".
//       The resolver used to branch on a hand-written pair of code names, which
//       is a second copy of a fact the widening matrix already declares through
//       `outcome: 'stop'`. F-001 changed which pin codes stop, so this is
//       exactly the duplication a future edit would drift. These cases drive the
//       resolver by ENUMERATING the table, so a row whose outcome becomes (or
//       stops being) `stop` is honoured without editing the resolver at all.
// ---------------------------------------------------------------------------
testCase('the stop-code list is derived from the table and the resolver consults it', () => {
  const derived = VALIDATION_WIDENING_REASON_CODES
    .filter((code) => VALIDATION_WIDENING_REASONS[code].outcome === 'stop')
    .sort();
  assert.deepEqual([...VALIDATION_STOP_REASON_CODES].sort(), derived, 'the stop list must be derived, not written');
  assert.ok(derived.length > 0, 'the table must declare at least one stop row for this case to mean anything');

  for (const code of VALIDATION_WIDENING_REASON_CODES) {
    assert.equal(
      isValidationStopReasonCode(code),
      VALIDATION_WIDENING_REASONS[code].outcome === 'stop',
      `${code}: the predicate must agree with the table row, never with a second list`,
    );
  }
  assert.equal(isValidationStopReasonCode('not_a_widening_code'), false, 'an unknown code is not a stop');
  assert.equal(isValidationStopReasonCode(undefined), false);

  // Drive the resolver through a schema-bypassing input for EVERY escalation
  // code the collector can emit, and require the outcome to follow the table.
  const collectorCodes = [
    'changed_files_unavailable',
    'hash_snapshot_unavailable',
    'pinned_command_missing',
    'pinned_command_ambiguous',
    'pinned_command_non_inventory',
  ] as const;
  for (const code of collectorCodes) {
    const input = {
      ...planInput(),
      escalations: [{ code, detail: `fixture escalation for ${code}` }],
    } as StoryRelevanceInput;
    const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
    if (isValidationStopReasonCode(code)) {
      assert.equal(result.status, 'stop', `${code} declares outcome stop, so the resolver must stop`);
      assert.equal(result.status === 'stop' && result.reason.code, code);
    } else {
      assert.notEqual(result.status, 'stop', `${code} does not declare outcome stop, so the resolver may not stop`);
    }
  }

  // Both stop RETURNS are bound to the table, not only the escalation branch.
  const emptyUniverse = planFor('repository-full', { routine: { sourceKind: 'configured', commands: [] } });
  assert.equal(emptyUniverse.status, 'stop');
  assert.ok(
    emptyUniverse.status === 'stop' && isValidationStopReasonCode(emptyUniverse.reason.code),
    'the empty-universe stop must carry a code the table declares as a stop',
  );
  assert.equal(emptyUniverse.status === 'stop' && emptyUniverse.reason.outcome, 'stop');
});


// ---------------------------------------------------------------------------
// (32) HANDLER ENCODING CONVENTION — the planner core re-validates its inputs,
//      because a schema constraint upstream is only the first line of defence.
// ---------------------------------------------------------------------------
testCase('the planner core rejects a schema-bypassing tier and a malformed input', () => {
  assert.throws(
    () => resolveValidationTierPlan({ input: planInput(), requestedTier: 'story-quick' as ValidationTier }),
    /story-quick/,
    'an unknown tier must be rejected by name at the core entry',
  );
  assert.throws(
    () => resolveValidationTierPlan({ input: planInput(), requestedTier: '' as ValidationTier }),
    /tier/,
    'an empty tier must be rejected at the core entry',
  );
  assert.throws(
    () => resolveValidationTierPlan({ input: undefined as unknown as StoryRelevanceInput, requestedTier: 'story-fast' }),
    /input/,
    'a missing StoryRelevanceInput must be rejected at the core entry',
  );
  assert.equal(assertValidationTier('story-fast', 'fixture'), 'story-fast');
  assert.throws(() => assertValidationTier(7, 'fixture'), /fixture/);
});
}

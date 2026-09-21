import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { buildValidationCommandInventory } from '../../core/validation-command-identity.js';
import { type StoryRelevanceInputArgs } from '../../core/validation-relevance-input.js';



import { configuredValidationCommands } from '../../handlers/verifier.js';
import { VALIDATION_IMPACT_INDEX_SCHEMA, VALIDATION_TIERS, buildAutomaticValidationTierSelectionBinding, resolveValidationTierPlan, validationWideningReasonGloss, type ValidationTier, type ValidationImpactIndex, type ValidationWideningReasonCode } from '../../core/validation-tier-planner.js';
import type { ValidationCommand } from '../../core/validation-types.js';
import { VALIDATION_PLAN_OUTCOME_BEARING_LINE_PREFIXES, VALIDATION_PLAN_STATUS_LINES, VALIDATION_PLAN_TIER_ALIASES, attachImpactProjectionFailure, assertValidationPlanStatusInvariant, buildValidationPlanReport, renderValidationPlanReport, renderValidationPlanText, projectValidationImpactIndexForPlan, resolveValidationPlanRequest } from '../../handlers/validation-plan.js';
import type { HandlerContext } from '../../handlers/context.js';


import { getCommandPolicy } from '../../core/command-policy.js';




import { compileValidationCatalog, discoverValidationInventory } from '../../core/story-aware-validation.js';




import { beginSection, testCase, planCliRoot, planCli, PLAN_CLI_STORY_ID, planInput, checklistItem, gitOutput, planCliTool, treeBytes, refuseWritesStore, buildStoryWorktreeFixture, planFromRoot, unclassifiedValues, WORKTREE_FIXTURE_CHANGED_FILE, WORKTREE_FIXTURE_STORY_COMMAND_ID, escalationCodes } from "./support.js";
export function runCliIntegration(): void {



// ---------------------------------------------------------------------------
// CHK-005 — the read-only `validation_plan` CLI.
//
// Spec: section "Proposed CLI and UX" (owned by story B-ccf4, not yet on main).
//
// The CLI is the only surface of this Story a human ever touches, so these cases
// assert the OUTPUT CONTRACT, not merely that a function returns something:
// every field the spec's "Human output must show" list names has to be present
// and LABELLED, the counts have to be derived at runtime, and every escalation
// code has to arrive with its gloss attached — a bare code is exactly what the
// product review rejected.
// ---------------------------------------------------------------------------

beginSection('CHK-005 validation_plan CLI cases');


// ---------------------------------------------------------------------------
// (33) HUMAN OUTPUT (load-bearing) — every labelled field the spec's output list
//      names, with runtime-derived counts and `finalAuthority: no`.
// ---------------------------------------------------------------------------
testCase('validation_plan --tier=fast prints every labelled field including finalAuthority: no', () => {
  const { ctx } = planCliRoot();
  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });

  assert.match(text, /^requestedTier: story-fast \(requested as "fast"\)$/m);
  assert.match(text, /^effectiveTier: repository-full$/m);
  assert.match(text, /^selected: 2 of 2 validation unit\(s\)$/m);
  assert.match(text, /^finalAuthority: no$/m);
  assert.match(text, /^sourceKind: configured$/m);
  assert.match(text, /^status: plan$/m);

  // Per-command inclusion reasons, GROUPED BY COMMAND.
  assert.match(text, /^inclusion reasons by unit \(2\):$/m);
  assert.match(text, /^ {2}unit-suite \[unit\]$/m);
  assert.match(text, /^ {2}lint-suite \[lint\]$/m);
  assert.match(text, /\[command_exclusion_unproven\] outcome=repository-full/);
  assert.match(text, /included: repository-full:fail-closed/);

  // Unclassified inputs are LISTED under their own label.
  assert.match(text, /^unclassified inputs \(\d+\):$/m);

  // Every escalation code is followed by its plain-language gloss.
  assert.match(text, /^escalation reasons \(\d+\):$/m);
  for (const code of ['changed_files_unavailable', 'hash_snapshot_unavailable', 'command_exclusion_unproven']) {
    const gloss = validationWideningReasonGloss(code as ValidationWideningReasonCode);
    assert.ok(text.includes(`[${code}]`), `escalation code ${code} is not printed`);
    assert.ok(text.includes(gloss.slice(0, 60)), `escalation code ${code} is printed without its gloss`);
  }

  // Estimated duration WITH its basis.
  assert.match(text, /^estimatedDuration: /m);
  assert.match(text, /^ {2}basis: /m);

  // No reader may mistake this for a written selection artifact.
  assert.match(text, /^artifact: none /m);

  // Inventory warnings are surfaced, not swallowed.
  assert.match(text, /^inventoryWarnings \(\d+\):$/m);
});


testCase('the provisional-id migration warning reaches the operator instead of being swallowed', () => {
  const { ctx } = planCliRoot({
    commands: [
      { label: 'unit', command: 'npm', args: ['test'] },
      { label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' },
    ],
  });
  const report = JSON.parse(planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
  assert.ok(report.inventoryWarnings.length > 0, 'a project still on provisional ids must warn');
  assert.ok(
    report.inventoryWarnings.some((warning: string) => warning.includes('1')),
    'the warning must name the count of commands still lacking a declared id',
  );
  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });
  for (const warning of report.inventoryWarnings) assert.ok(text.includes(warning), 'every warning is printed');
});


testCase('a failed explain-side catalog projection falls back with the bounded parse error', () => {
  const projection = projectValidationImpactIndexForPlan({
    projectRoot: '/tmp/explain-projection-failure',
    routine: { sourceKind: 'configured', commands: [] },
    commandSetDigest: 'fixture-command-set',
  }, {
    discover: () => { throw new Error('fixture malformed validation resources'); },
  });
  assert.equal(projection.impactIndex, undefined);
  assert.equal(projection.failure, 'fixture malformed validation resources');
  const compatibility = resolveValidationTierPlan({ input: planInput(), requestedTier: 'story-fast' });
  assert.ok(compatibility.escalationReasons.some((reason) => reason.code === 'impact_index_unusable'));
  const diagnosed = attachImpactProjectionFailure(compatibility, projection.failure);
  assert.ok(diagnosed.escalationReasons.some((reason) =>
    reason.code === 'impact_index_unusable'
      && reason.detail.includes('catalog projection failed: fixture malformed validation resources')));
  const withoutImpactReason = {
    ...compatibility,
    escalationReasons: compatibility.escalationReasons.filter((reason) => reason.code !== 'impact_index_unusable'),
  };
  const appended = attachImpactProjectionFailure(withoutImpactReason, projection.failure);
  assert.ok(appended.escalationReasons.some((reason) =>
    reason.code === 'impact_index_unusable'
      && reason.detail === 'catalog projection failed: fixture malformed validation resources'),
  'projection failure remains visible even when the underlying result did not already carry its reason code');
});


testCase('A21 configured impact index cannot diverge from runtime catalog ownership', () => {
  const commands: ValidationCommand[] = [
    { id: 'local', label: 'local', command: 'node', args: ['task.js'], inputRoots: ['src/**'], inputsComplete: true, assurance: 'story-selectable', riskTier: 'local' },
  ];
  const configuredImpactIndex: ValidationImpactIndex = {
    schema: VALIDATION_IMPACT_INDEX_SCHEMA, version: 'legacy-independent-index',
    commandSetDigest: buildValidationCommandInventory({ commands }).commandSetDigest,
    entries: [{ commandId: 'local', selection: 'always', inputPatterns: ['unrelated/**'], coverage: 'complete' }],
  };
  const { root, ctx } = planCliRoot({ commands, impactIndex: configuredImpactIndex });
  const routine = { sourceKind: 'configured' as const, commands: configuredValidationCommands(root) };
  const input = planInput({ projectRoot: root, gitCwd: root, routine });
  const binding = buildAutomaticValidationTierSelectionBinding({
    input, catalog: compileValidationCatalog(discoverValidationInventory(root)),
  });
  const projection = projectValidationImpactIndexForPlan({
    projectRoot: root, routine, commandSetDigest: input.executionInventory.commandSetDigest, configuredImpactIndex,
  });
  assert.equal(binding.input.impactIndex?.entries.length, 1);
  assert.notDeepEqual(configuredImpactIndex, binding.input.impactIndex, 'the legacy map must disagree before testing parity');
  assert.deepEqual(projection.impactIndex, binding.input.impactIndex, 'A21 explain and runtime must use the same catalog ownership');
  const report = JSON.parse(planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true }));
  assert.ok(report.inventoryWarnings.some((warning: string) => /impactIndex.*deprecated.*ignored/.test(warning)),
    'the ignored legacy index must be disclosed in operator output');
});


testCase('without --explain the unit list is previewed, and --explain lists every unit', () => {
  const commands = Array.from({ length: 8 }, (_unused, index) => ({
    label: `suite-${index}`,
    command: 'npm',
    args: ['run', `suite-${index}`],
    id: `suite-${index}`,
  }));
  const { ctx } = planCliRoot({ commands });
  const preview = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast' });
  const full = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });
  // Both modes label every field; only the LIST length differs.
  assert.match(preview, /^selected: 8 of 8 validation unit\(s\)$/m);
  assert.match(preview, /^finalAuthority: no$/m);
  assert.match(preview, /^ {2}\.\.\. 3 more unit\(s\); rerun with --explain to list every one$/m);
  assert.equal(preview.includes('suite-7 [suite-7]'), false, 'the preview stops at the limit');
  assert.equal(full.includes('suite-7 [suite-7]'), true, '--explain lists every unit');
  assert.doesNotMatch(full, /rerun with --explain/);
});


testCase('the printed counts are derived at runtime, not written into the renderer', () => {
  const three = planCliRoot({
    commands: [
      { label: 'unit', command: 'npm', args: ['test'], id: 'unit-suite' },
      { label: 'lint', command: 'npm', args: ['run', 'lint'], id: 'lint-suite' },
      { label: 'types', command: 'npx', args: ['tsc', '--noEmit'], id: 'types-suite' },
    ],
  });
  const text = planCli(three.ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'intermediate', explain: true });
  assert.match(text, /^selected: 3 of 3 validation unit\(s\)$/m);
  assert.match(text, /^inclusion reasons by unit \(3\):$/m);
  assert.match(text, /^requestedTier: story-intermediate \(requested as "intermediate"\)$/m);
});


testCase('the real config-to-CLI path renders a narrowed plan with bound exclusion proofs', () => {
  const commands: ValidationCommand[] = [
    { label: 'build', command: 'npm', args: ['run', 'build'], id: 'build', assurance: 'always', riskTier: 'local', inputRoots: ['src/**'], inputsComplete: true },
    { label: 'docs contract', command: 'npm', args: ['run', 'docs'], id: 'docs-contract', assurance: 'story-selectable', riskTier: 'shared', inputRoots: ['docs/**'], inputsComplete: true },
  ];
  const commandSetDigest = buildValidationCommandInventory({ commands }).commandSetDigest;
  const impactIndex: ValidationImpactIndex = {
    schema: VALIDATION_IMPACT_INDEX_SCHEMA,
    version: 'cli-index-v1',
    commandSetDigest,
    entries: [
      { commandId: 'build', selection: 'always', inputPatterns: [], coverage: 'complete' },
      { commandId: 'docs-contract', selection: 'story-intermediate', inputPatterns: ['docs/**'], coverage: 'complete' },
    ],
  };
  const { root, ctx } = planCliRoot({ commands, impactIndex });
  const runFixtureGit = (args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proof-or-Stop Smoke', ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/guide.md'), 'before\n', 'utf-8');
  runFixtureGit(['init', '-q', '-b', 'main']);
  runFixtureGit(['add', '-A']);
  runFixtureGit(['commit', '-qm', 'fixture baseline']);
  writeFileSync(join(root, 'docs/guide.md'), 'after\n', 'utf-8');

  const report = JSON.parse(planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
  assert.equal(report.status, 'plan');
  assert.equal(report.effectiveTier, 'story-fast');
  assert.equal(report.reductionApplied, true);
  assert.deepEqual(report.counts, { selected: 1, total: 2 });
  assert.equal(typeof report.selectorDecisionDigest, 'string');
  assert.equal(report.exclusionProofs.length, 1);
  assert.equal(report.exclusionProofs[0].commandId, 'docs-contract');
  const omitted = report.units.find((unit: Record<string, unknown>) => unit.id === 'docs-contract');
  assert.equal(omitted.selected, false);
  assert.ok(omitted.inclusionReasons.every((reason: string) => reason.startsWith('omitted:')));

  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });
  assert.match(text, /^effectiveTier: story-fast$/m);
  assert.match(text, /^selected: 1 of 2 validation unit\(s\)$/m);
  assert.match(text, /^exclusion proofs \(1\):$/m);
  assert.ok(text.includes(report.selectorDecisionDigest));
});


testCase('a no-validator project reports no tier pass instead of an empty plan', () => {
  const { ctx } = planCliRoot({ commands: [] });
  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'full' });
  assert.match(text, /^status: no-tier-pass$/m);
  assert.match(text, /^finalAuthority: no$/m);
  assert.ok(text.includes('[no_validator]'), 'the no-validator reason code must be printed');
  assert.ok(
    text.includes(validationWideningReasonGloss('no_validator').slice(0, 60)),
    'the no-validator code must be printed with its gloss',
  );
  assert.doesNotMatch(text, /^effectiveTier: /m, 'a no-tier-pass result carries no effective tier at all');
});


// ---------------------------------------------------------------------------
// (33b) B-a745 F-002 — THE STATUS LINE IS THE DISCRIMINATOR, and it is the only
//       thing a selector may key on to tell a produced plan from a refusal.
//
//       This case exists because a real recorded receipt for this Story's own
//       flagship claim pinned the selector `finalAuthority: no`, which the
//       renderer prints on EVERY branch. The command was stopping with
//       `selected: 0 of 0`, the selector matched anyway, and the evidence was
//       stamped `result: pass` while its own outputTail contained the failure.
//
//       `finalAuthority: no` is deliberately KEPT on every branch — a stop is
//       not final authority either — so the fix is not to remove it but to
//       guarantee a discriminating line exists and that no shared line can be
//       mistaken for one.
// ---------------------------------------------------------------------------
testCase('a plan render and a stop render differ on the documented status discriminator', () => {
  const stopItems = [
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
  const planText = planCli(planCliRoot().ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });
  const stopText = planCli(planCliRoot({ items: stopItems }).ctx)(
    { storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true },
  );

  assert.equal(VALIDATION_PLAN_STATUS_LINES.plan, 'status: plan');
  assert.equal(VALIDATION_PLAN_STATUS_LINES.stop, 'status: stop');

  const planLines = planText.split('\n');
  const stopLines = stopText.split('\n');
  assert.ok(planLines.includes(VALIDATION_PLAN_STATUS_LINES.plan), 'a produced plan must print its own status line');
  assert.ok(stopLines.includes(VALIDATION_PLAN_STATUS_LINES.stop), 'a stop must print its own status line');
  // Substring, not line membership: a naive selector greps the whole output, so
  // the other outcome's discriminator may not appear even inside prose.
  assert.ok(!stopText.includes(VALIDATION_PLAN_STATUS_LINES.plan), 'no stop render may contain "status: plan"');
  assert.ok(!planText.includes(VALIDATION_PLAN_STATUS_LINES.stop), 'no plan render may contain "status: stop"');

  // Every line the two renders SHARE is non-discriminating BY CONSTRUCTION: no
  // shared line may start with an outcome-bearing prefix. This is the mechanical
  // form of "a selector must not be able to pick a line that matches both".
  const shared = planLines.filter((line) => stopLines.includes(line));
  for (const line of shared) {
    for (const prefix of VALIDATION_PLAN_OUTCOME_BEARING_LINE_PREFIXES) {
      assert.ok(
        !line.startsWith(prefix),
        `shared line ${JSON.stringify(line)} starts with the outcome-bearing prefix ${JSON.stringify(prefix)}, ` +
        'so a selector could match it on a failing run',
      );
    }
  }

  // The exact selector that produced the false positive. It stays printed on
  // every branch on purpose, which is precisely why it may never be reachable as
  // the discriminator.
  assert.ok(shared.includes('finalAuthority: no'), 'finalAuthority: no must keep printing on every branch');
  assert.ok(
    !(Object.values(VALIDATION_PLAN_STATUS_LINES) as readonly string[]).includes('finalAuthority: no'),
    'finalAuthority: no is not, and must never become, the status discriminator',
  );
});


testCase('every planner outcome renders only its own status line, and a forged plan status is refused', () => {
  const request = resolveValidationPlanRequest({ storyId: PLAN_CLI_STORY_ID, tier: 'fast' });
  const outcomes: Array<{ label: string; overrides: Partial<StoryRelevanceInputArgs> }> = [
    { label: 'plan', overrides: {} },
    {
      label: 'stop (unresolvable commandId)',
      overrides: {
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
      },
    },
    { label: 'stop (empty universe)', overrides: { routine: { sourceKind: 'configured', commands: [] } } },
    { label: 'no-tier-pass', overrides: { routine: { sourceKind: 'no-validator', commands: [] } } },
  ];

  const seen = new Set<string>();
  for (const outcome of outcomes) {
    const input = planInput(outcome.overrides);
    const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
    const rendered = renderValidationPlanText(
      buildValidationPlanReport({ request, storyPhase: 'DEV', input, result }),
      true,
    );
    seen.add(result.status);
    assert.ok(
      rendered.split('\n').includes(VALIDATION_PLAN_STATUS_LINES[result.status]),
      `${outcome.label} must render ${VALIDATION_PLAN_STATUS_LINES[result.status]}`,
    );
    for (const [status, line] of Object.entries(VALIDATION_PLAN_STATUS_LINES)) {
      if (status === result.status) continue;
      assert.ok(!rendered.includes(line), `${outcome.label} leaked another outcome's discriminator: ${line}`);
    }
  }
  assert.deepEqual([...seen].sort(), ['no-tier-pass', 'plan', 'stop'], 'all three outcomes must be exercised');

  // A report that CLAIMS a plan while carrying refusal-shaped facts is refused
  // at the render boundary, so no stop branch can ever emit `status: plan`.
  const planInputForForgery = planInput();
  const planReport = buildValidationPlanReport({
    request,
    storyPhase: 'DEV',
    input: planInputForForgery,
    result: resolveValidationTierPlan({ input: planInputForForgery, requestedTier: 'story-fast' }),
  });
  assertValidationPlanStatusInvariant(planReport);
  for (const forged of [
    { ...planReport, counts: { selected: 0, total: 0 } },
    { ...planReport, effectiveTier: null },
    { ...planReport, executionMode: null },
  ]) {
    assert.throws(
      () => renderValidationPlanText(forged, true),
      /status: plan/,
      'a refusal-shaped report claiming status: plan must be refused, not rendered',
    );
  }
});


// ---------------------------------------------------------------------------
// (33b) B-a745 F-024 / F-025: the status invariant guards EVERY consumption
//       point. A schema-bypassing report that contradicts itself is refused
//       on the --json path with the same message the text path throws, and a
//       consistent report renders on both.
// ---------------------------------------------------------------------------
testCase('F-024/F-025: the --json render path refuses an inconsistent report exactly as the text path does', () => {
  const request = resolveValidationPlanRequest({ storyId: 'B-a745', tier: 'fast' });
  const input = planInput();
  const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
  const report = buildValidationPlanReport({ request, storyPhase: 'DEV', input, result });
  assert.equal(report.status, 'plan');

  // A consistent report renders on BOTH paths, and the JSON path emits the report itself.
  const json = renderValidationPlanReport(report, { json: true, explain: false });
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(report)), 'the JSON path must emit the report unchanged');
  assert.doesNotThrow(() => renderValidationPlanReport(report, { json: false, explain: true }));
  assert.equal(
    renderValidationPlanReport(report, { json: false, explain: true }),
    renderValidationPlanText(report, true),
    'the text path must be the same render whichever entry point is used',
  );

  const forgeries: Array<{ label: string; forged: unknown; expect: RegExp }> = [
    {
      label: 'status: plan over an empty universe with no escalation reason',
      forged: { ...report, counts: { selected: 0, total: 0 }, units: [], escalationReasons: [] },
      expect: /status: plan/,
    },
    {
      label: 'status: stop that still carries a selection',
      forged: { ...report, status: 'stop' },
      expect: /stop result may not carry plan-shaped facts/,
    },
    {
      label: 'a reduced plan whose omitted unit has no positive exclusion proof',
      forged: {
        ...report,
        counts: { selected: 1, total: report.units.length },
        reductionApplied: true,
        units: report.units.map((unit, index) => index === 0
          ? unit
          : { ...unit, selected: false, inclusionReasons: ['omitted:fixture'] }),
        exclusionProofs: [],
      },
      expect: /exactly one positive exclusion proof/,
    },
    {
      label: 'reductionApplied contradicts selected-versus-total counts',
      forged: { ...report, reductionApplied: true },
      expect: /reductionApplied must equal selected < total/,
    },
    {
      label: 'freshnessBinding "bound" with a null headHash',
      forged: {
        ...report,
        freshnessBinding: {
          status: 'bound',
          headHash: null,
          materialHash: 'material00000000000000000000000000000000',
          storyFilesHash: 'storyfiles000000000000000000000000000000',
        },
      },
      expect: /headHash/,
    },
    {
      label: 'no freshnessBinding at all',
      forged: (() => { const { freshnessBinding: _dropped, ...rest } = report; return rest; })(),
      expect: /freshnessBinding/,
    },
  ];

  for (const { label, forged, expect } of forgeries) {
    let textError: unknown = null;
    try {
      renderValidationPlanReport(forged as Parameters<typeof renderValidationPlanReport>[0], { json: false, explain: true });
    } catch (error) {
      textError = error;
    }
    assert.ok(textError instanceof Error, `${label}: the text path must refuse the report`);
    assert.match(textError.message, expect, `${label}: the text path must name the contradiction`);

    let jsonError: unknown = null;
    let emitted: string | null = null;
    try {
      emitted = renderValidationPlanReport(forged as Parameters<typeof renderValidationPlanReport>[0], { json: true, explain: false });
    } catch (error) {
      jsonError = error;
    }
    assert.ok(
      jsonError instanceof Error,
      `${label}: the --json path must refuse the report instead of emitting ${emitted === null ? 'nothing' : emitted.slice(0, 80)}`,
    );
    assert.equal(jsonError.message, textError.message, `${label}: both paths must throw the SAME message`);
  }

  // ONE choke point, not one per output shape (F-006 class): the handler source
  // invokes the invariant exactly once, inside renderValidationPlanReport.
  const repoRoot = (gitOutput(['rev-parse', '--show-toplevel']) ?? '').trim();
  assert.ok(repoRoot, 'this guard reads the real handler source; a missing repository is a failure, not a skip');
  const handlerSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/validation-plan.ts'), 'utf-8');
  const callSites = handlerSource
    .split('\n')
    .filter((line) => line.includes('assertValidationPlanStatusInvariant(') && !line.includes('export function assertValidationPlanStatusInvariant('));
  assert.equal(callSites.length, 1, `the invariant must be invoked from exactly one place, found:\n${callSites.join('\n')}`);
  assert.match(callSites[0], /const statusLine = assertValidationPlanStatusInvariant\(report\);/);
});


// ---------------------------------------------------------------------------
// (34) --json — one parseable object carrying the SAME facts.
// ---------------------------------------------------------------------------
testCase('validation_plan --json emits one parseable object carrying the same facts', () => {
  const { ctx } = planCliRoot();
  const raw = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true });
  const report = JSON.parse(raw) as Record<string, any>;

  assert.equal(report.storyId, PLAN_CLI_STORY_ID);
  assert.equal(report.status, 'plan');
  assert.equal(report.requestedTierInput, 'fast');
  assert.equal(report.requestedTier, 'story-fast');
  assert.equal(report.effectiveTier, 'repository-full');
  assert.equal(report.finalAuthority, false);
  assert.equal(report.sourceKind, 'configured');
  assert.equal(report.counts.selected, 2);
  assert.equal(report.counts.total, 2);
  assert.equal(report.units.length, 2);
  assert.deepEqual(report.units.map((unit: any) => unit.id).sort(), ['lint-suite', 'unit-suite']);
  for (const unit of report.units) {
    assert.ok(Array.isArray(unit.inclusionReasons) && unit.inclusionReasons.length > 0);
    assert.ok(typeof unit.duration.basis === 'string' && unit.duration.basis.length > 0);
  }
  assert.ok(Array.isArray(report.unclassifiedInputs));
  assert.ok(report.escalationReasons.length > 0);
  for (const reason of report.escalationReasons) {
    assert.ok(typeof reason.gloss === 'string' && reason.gloss.trim().length > 0, `${reason.code} has no gloss`);
    assert.equal(reason.gloss, validationWideningReasonGloss(reason.code));
  }
  assert.ok(typeof report.durationEstimate.basis === 'string' && report.durationEstimate.basis.length > 0);
  assert.equal(report.artifact.written, false);
  assert.equal(report.artifact.path, null);

  // The same facts, not a second computation: the human text agrees.
  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });
  assert.match(text, new RegExp(`^selected: ${report.counts.selected} of ${report.counts.total} `, 'm'));
  assert.match(text, new RegExp(`^effectiveTier: ${report.effectiveTier}$`, 'm'));
});


testCase('duration history from prior signed validation artifacts reaches the report with its basis', () => {
  const { ctx } = planCliRoot({
    doneRequiredEvidence: {
      schema: 'proofOrStop.done-required-evidence',
      version: 1,
      storyId: PLAN_CLI_STORY_ID,
      status: 'pass',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:05:00.000Z',
      durationMs: 300000,
      policyHash: 'fixture',
      commandSetHash: 'fixture',
      reasons: [],
      receipts: [
        { label: 'unit', command: 'npm', args: ['test'], cwd: '.', status: 'pass', exitCode: 0, durationMs: 4000, outputDigest: 'x', outputTail: '', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:04.000Z' },
      ],
    },
  });
  const report = JSON.parse(planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
  const unit = report.units.find((entry: any) => entry.id === 'unit-suite');
  const lint = report.units.find((entry: any) => entry.id === 'lint-suite');
  assert.equal(unit.duration.status, 'known');
  assert.equal(unit.duration.estimateMs, 4000);
  assert.match(unit.duration.basis, /prior signed validation receipt/);
  assert.equal(lint.duration.status, 'unknown-duration');
  assert.equal(
    Object.prototype.hasOwnProperty.call(lint.duration, 'estimateMs'),
    false,
    'an unknown duration carries no numeric field at all; a 0 would read as instant',
  );
  assert.equal(report.durationEstimate.knownCount, 1);
  assert.equal(report.durationEstimate.unknownCount, 1);
  assert.equal(report.durationEstimate.knownTotalMs, 4000);
});


// ---------------------------------------------------------------------------
// (35) REJECTIONS BY NAME — nothing silently defaults.
// ---------------------------------------------------------------------------
testCase('a missing storyId and an unknown tier are each rejected BY NAME, never defaulted', () => {
  const { ctx } = planCliRoot();
  const call = planCli(ctx);

  assert.throws(
    () => call({ tier: 'fast' } as never),
    /validation_plan: storyId is required/,
    'a missing storyId must be rejected naming storyId',
  );
  assert.throws(() => call({ storyId: '   ', tier: 'fast' }), /storyId is required/);
  assert.throws(
    () => call({ storyId: PLAN_CLI_STORY_ID } as never),
    /validation_plan: tier is required/,
    'an omitted tier must be rejected, never silently defaulted to fast',
  );
  assert.throws(
    () => call({ storyId: PLAN_CLI_STORY_ID, tier: 'quick' }),
    /unknown tier "quick"/,
    'an unknown tier must be rejected naming the value that was passed',
  );
  assert.throws(() => call({ storyId: PLAN_CLI_STORY_ID, tier: 'quick' }), /fast, intermediate, full/);
});


testCase('the catalog schema constrains storyId and tier as the first line of defence', () => {
  const tool = planCliTool();
  const schema = z.object(tool.schema);
  assert.equal(schema.safeParse({ storyId: PLAN_CLI_STORY_ID, tier: 'fast' }).success, true);
  assert.equal(schema.safeParse({ storyId: '', tier: 'fast' }).success, false, 'an empty storyId must fail the schema');
  assert.equal(schema.safeParse({ storyId: PLAN_CLI_STORY_ID, tier: '' }).success, false, 'an empty tier must fail the schema');
});


// ---------------------------------------------------------------------------
// (36) COMMAND POLICY — the row exists and classifies the command read-only.
// ---------------------------------------------------------------------------
testCase('validation_plan is classified readOnly / none / all phases in command-policy', () => {
  const policy = getCommandPolicy('validation_plan');
  assert.ok(policy, 'validation_plan must have a CommandPolicy row');
  assert.equal(policy!.ownershipClass, 'readOnly');
  assert.equal(policy!.destructiveRisk, 'none');
  assert.equal(policy!.allowedPhases, 'all');
  assert.match(policy!.reason, /executes no validation command/);
  assert.match(policy!.reason, /writes nothing/);
});


// ---------------------------------------------------------------------------
// (37) THE LOAD-BEARING ONE — the command is read-only BY MEASUREMENT.
//      Every byte under the project root is snapshotted before and after, so
//      adding ANY store write to the handler fails this case. And no
//      write/persist/execute/run-shaped flag is accepted, at either layer.
// ---------------------------------------------------------------------------
testCase('invoking validation_plan leaves every byte under the project root identical', () => {
  const { root, store, ctx } = planCliRoot({
    items: [
      checklistItem({
        id: 'CHK-001',
        files: { modify: ['src/core/foo.ts'], create: [], test: ['tests/foo.test.ts'] },
        verificationEvidence: [
          { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm test', result: 'pass', note: 'fixture evidence' },
        ],
      }),
    ],
  });
  const before = treeBytes(root);
  const beforeStory = JSON.stringify(store.readStory(PLAN_CLI_STORY_ID));
  const beforeChecklist = JSON.stringify(store.readChecklist(PLAN_CLI_STORY_ID));

  // Two independent proofs: no store write at all, and no byte changed anywhere.
  const guardedCtx = { ...ctx, store: refuseWritesStore(store) } as HandlerContext;
  for (const tier of ['fast', 'intermediate', 'full']) {
    planCli(guardedCtx)({ storyId: PLAN_CLI_STORY_ID, tier, explain: true });
    planCli(guardedCtx)({ storyId: PLAN_CLI_STORY_ID, tier, json: true });
  }

  assert.deepEqual(treeBytes(root), before, 'validation_plan wrote to the project root; it is contractually read-only');
  assert.equal(JSON.stringify(store.readStory(PLAN_CLI_STORY_ID)), beforeStory, 'the story record must be byte-identical');
  assert.equal(JSON.stringify(store.readChecklist(PLAN_CLI_STORY_ID)), beforeChecklist, 'the checklist must be byte-identical');
});


testCase('no write / persist / execute / run flag is accepted, at the schema OR the handler', () => {
  const tool = planCliTool();
  const schema = z.object(tool.schema);
  const { ctx } = planCliRoot();
  const call = planCli(ctx);

  for (const flag of ['write', 'persist', 'execute', 'run', 'launch', 'apply', 'capture', 'refresh', 'runCommands', 'writeEvidence', 'advancePhase']) {
    assert.equal(
      schema.safeParse({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', [flag]: true }).success,
      false,
      `the catalog schema must reject --${flag}`,
    );
    // Handler encoding convention: the schema is only the FIRST line of defence.
    assert.throws(
      () => call({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', [flag]: true } as never),
      new RegExp(flag),
      `the handler must refuse ${flag} even when the schema is bypassed`,
    );
  }
});


// ---------------------------------------------------------------------------
// (38) HANDLER ENCODING CONVENTION — the zod bypass is still rejected, at BOTH
//      the handler entry and the planner-core entry.
// ---------------------------------------------------------------------------
testCase('a schema-bypassing invalid tier and empty storyId are rejected at handler AND core entry', () => {
  // Handler entry, called directly with no schema in the path at all.
  assert.throws(() => resolveValidationPlanRequest({ storyId: '', tier: 'fast' }), /storyId is required/);
  assert.throws(() => resolveValidationPlanRequest({ storyId: PLAN_CLI_STORY_ID, tier: 'story-quick' }), /unknown tier "story-quick"/);
  assert.throws(() => resolveValidationPlanRequest({ storyId: 7 as never, tier: 'fast' }), /storyId/);
  assert.throws(() => resolveValidationPlanRequest({ storyId: PLAN_CLI_STORY_ID, tier: 3 as never }), /tier/);
  assert.deepEqual(
    resolveValidationPlanRequest({ storyId: ` ${PLAN_CLI_STORY_ID} `, tier: 'full', explain: true }),
    { storyId: PLAN_CLI_STORY_ID, tierInput: 'full', requestedTier: 'repository-full', explain: true, json: false },
  );

  // Planner core entry, reached with no handler and no schema in the path.
  assert.throws(
    () => resolveValidationTierPlan({ input: planInput(), requestedTier: 'fast' as ValidationTier }),
    /unknown tier "fast"/,
    'the CLI alias is NOT the core vocabulary; the core must still reject it by name',
  );
  assert.throws(
    () => resolveValidationTierPlan({ input: { ...planInput(), storyId: '' }, requestedTier: 'story-fast' }),
    /storyId/,
    'an empty storyId must be rejected at the planner-core entry too',
  );
});


testCase('the CLI tier aliases map onto the canonical vocabulary and add no fourth tier', () => {
  assert.deepEqual(
    VALIDATION_PLAN_TIER_ALIASES,
    {
      fast: 'story-fast',
      intermediate: 'story-intermediate',
      full: 'repository-full',
      'story-fast': 'story-fast',
      'story-intermediate': 'story-intermediate',
      'repository-full': 'repository-full',
    },
  );
  const targets = new Set(Object.values(VALIDATION_PLAN_TIER_ALIASES));
  assert.deepEqual([...targets].sort(), [...VALIDATION_TIERS].sort());
});


testCase('F-010: validation_plan invoked from the main checkout plans the SAME tree as from the story worktree', () => {
  const { metadataRoot, worktreePath } = buildStoryWorktreeFixture('plain');

  const worktreeBytesBefore = treeBytes(worktreePath);
  const mainBytesBefore = treeBytes(metadataRoot);

  const fromWorktree = planFromRoot(worktreePath);
  const fromMainCheckout = planFromRoot(metadataRoot);

  // The fixture is only meaningful if the story really changed something that the
  // worktree view sees: the story-branch commit must surface as an input, and so
  // must the worktree-only evidence pin recorded in the story-branch checklist.
  assert.ok(
    unclassifiedValues(fromWorktree).includes(WORKTREE_FIXTURE_CHANGED_FILE),
    `the worktree view must see the story's own change (got ${JSON.stringify(unclassifiedValues(fromWorktree))})`,
  );
  assert.ok(
    (fromWorktree.units as Array<{ id: string }>).some((unit) => unit.id === WORKTREE_FIXTURE_STORY_COMMAND_ID),
    'the worktree view must select from the inventory the story branch registered',
  );
  assert.equal(
    escalationCodes(fromWorktree).includes('pinned_command_non_inventory'),
    false,
    'the worktree-only evidence pin must resolve against the story branch inventory',
  );
  assert.equal(fromWorktree.status, 'plan');

  // Reading the story's tree from the main checkout must stay read-only for BOTH trees.
  assert.deepEqual(treeBytes(worktreePath), worktreeBytesBefore, 'validation_plan wrote into the story worktree');
  assert.deepEqual(treeBytes(metadataRoot), mainBytesBefore, 'validation_plan wrote into the main checkout');

  // Same story, same dist, different cwd: the relevance input must be IDENTICAL.
  assert.deepEqual(
    unclassifiedValues(fromMainCheckout),
    unclassifiedValues(fromWorktree),
    'invoked from the main checkout, the planner must list the story worktree’s changed files, not main’s',
  );
  assert.deepEqual(escalationCodes(fromMainCheckout), escalationCodes(fromWorktree));
  assert.equal(
    fromMainCheckout.selectionDigest,
    fromWorktree.selectionDigest,
    'the selectionDigest must describe the requested story’s tree regardless of the invocation root',
  );
  assert.deepEqual(fromMainCheckout, fromWorktree, 'the whole report must be identical from both roots');
});


testCase('F-010: on a configured wrapper-root layout validation_plan reads the story worktree, not the non-git wrapper', () => {
  const { metadataRoot } = buildStoryWorktreeFixture('wrapper-root');

  // The only legitimate invocation root on this layout is the wrapper itself,
  // which is NOT a git repository. Before the fix the planner diffed and hashed
  // the wrapper and degraded to the unavailable classifications; it must instead
  // resolve the configured gitRoot's linked story worktree and read that tree.
  const fromWrapper = planFromRoot(metadataRoot);

  assert.equal(fromWrapper.status, 'plan');
  for (const code of ['changed_files_unavailable', 'hash_snapshot_unavailable']) {
    assert.equal(
      escalationCodes(fromWrapper).includes(code),
      false,
      `the wrapper root is not a git repository, but the story's tree is: ${code} must not be reported`,
    );
  }
  assert.ok(
    unclassifiedValues(fromWrapper).includes(WORKTREE_FIXTURE_CHANGED_FILE),
    `the story-branch change must be visible from the wrapper root (got ${JSON.stringify(unclassifiedValues(fromWrapper))})`,
  );
});
}

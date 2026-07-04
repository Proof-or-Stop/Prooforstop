/**
 * B-7ba7 — milestone_status read-only progress report.
 *
 * Run after build:
 *
 *   npm --prefix packages/main run build
 *   node packages/main/tests/milestone-status.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const cliPath = join(distRoot, 'cli.js');
const { buildMilestoneStatusReport, renderMilestoneStatusReport } = await import(join(distRoot, 'core/milestone-status.js'));
const { createMilestoneStatusHandlers } = await import(join(distRoot, 'handlers/milestone-status.js'));

function story(storyId = 'B-7ba7') {
  return {
    storyId,
    name: 'milestone-status',
    title: 'Milestone status',
    description: 'Read-only grouped milestone status',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: '2026-07-04T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
  };
}

function intent(desc, id = undefined) {
  return {
    happy: [{ ...(id ? { id } : {}), desc, type: 'logic' }],
    edge: [],
    adversarial: [],
  };
}

function checklistItem(id, status, evidence = [], verificationIntent = undefined) {
  return {
    id,
    title: `${id} title`,
    status,
    startTime: null,
    endTime: null,
    ...(verificationIntent ? { verificationIntent } : {}),
    ...(evidence.length > 0 ? { verificationEvidence: evidence } : {}),
  };
}

function evidence(intentRef, result = 'pass', overrides = {}) {
  return {
    intentRef,
    kind: 'logic_test',
    result,
    note: `${intentRef} ${result}`,
    command: `node ${intentRef}.test.mjs`,
    timestamp: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function ledger(milestones, storyId = 'B-7ba7') {
  return {
    schemaVersion: 'proofstory.milestone_ledger.v1',
    storyId,
    state: 'confirmed',
    ledgerHash: 'abc123',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    milestones,
  };
}

function milestone(overrides) {
  return {
    id: 'M-default',
    sourceRequirementId: 'REQ-default',
    claim: 'Default claim',
    doneMeans: 'Default done means',
    checklistRefs: [],
    verificationIntentRefs: [],
    status: 'planned',
    ...overrides,
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertTextContract(text) {
  for (const label of [
    'Milestone Status - B-7ba7',
    'Mode: read-only',
    'Completed',
    'Current',
    'Remaining',
    '| Milestone | Purpose | Status: | Sub-objectives: | Evidence: | Risks: | Next action: |',
    'Status:',
    'Sub-objectives:',
    'Evidence:',
    'Risks:',
    'Next action:',
  ]) {
    assert.ok(text.includes(label), `text output must include ${label}`);
  }
}

function assertReportShape(report) {
  assert.deepEqual(Object.keys(report).sort(), [
    'groups',
    'ledger',
    'milestones',
    'mode',
    'nextActions',
    'phase',
    'risks',
    'schemaVersion',
    'storyId',
  ]);
  assert.deepEqual(Object.keys(report.groups).sort(), ['completed', 'current', 'remaining']);
}

function assertRowShape(row) {
  assert.deepEqual(Object.keys(row).sort(), [
    'checklistRefs',
    'claim',
    'doneMeans',
    'evidenceRefs',
    'id',
    'ledgerStatus',
    'nextAction',
    'requiredEvidence',
    'risks',
    'sourceRequirementId',
    'status',
    'statusDetail',
    'subObjectives',
    'verificationIntentRefs',
  ]);
  for (const subObjective of row.subObjectives) {
    assert.deepEqual(Object.keys(subObjective).sort(), ['id', 'kind', 'label', 'risks', 'status']);
  }
}

function assertEvidenceRefShape(evidenceRef) {
  assert.deepEqual(Object.keys(evidenceRef).sort(), ['command', 'intentRef', 'kind', 'note', 'status', 'timestamp']);
}

{
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: { items: [] },
    milestoneLedger: null,
  });

  assert.equal(report.schemaVersion, 'proofbound.milestone_status.v1');
  assertReportShape(report);
  assert.equal(report.storyId, 'B-7ba7');
  assert.equal(report.phase, 'DEV');
  assert.equal(report.ledger.present, false);
  assert.deepEqual(report.mode, {
    readOnly: true,
    runCommands: false,
    writeEvidence: false,
    advancePhase: false,
    launchReviewers: false,
  });
  assert.deepEqual(report.groups, { completed: [], current: [], remaining: [] });
  assert.match(report.risks.join('\n'), /Missing milestone ledger/);
  assert.match(report.nextActions.join('\n'), /lattice milestone_ledger_set --storyId=B-7ba7/);

  const text = renderMilestoneStatusReport(report);
  assertTextContract(text);
  assert.match(text, /Ledger: missing/);
  assert.doesNotMatch(text, /all ledger rows are completed/i, 'missing ledger must not pretend progress is complete');
}

{
  const cl = {
    items: [
      checklistItem('CHK-001', 'done', [evidence('CHK-001:happy:0')], intent('completed intent')),
      checklistItem('CHK-002', 'done', [evidence('CHK-002:happy:0', 'fail')], intent('failing intent')),
      checklistItem('CHK-003', 'done'),
      checklistItem('CHK-004', 'done'),
    ],
  };
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M1',
        sourceRequirementId: 'REQ-1',
        claim: 'Completed with scoped verification evidence',
        doneMeans: 'Checklist done and verification evidence passes',
        checklistRefs: ['CHK-001'],
        verificationIntentRefs: ['CHK-001:happy:0'],
        status: 'covered',
      }),
      milestone({
        id: 'M2',
        sourceRequirementId: 'REQ-2',
        claim: 'Ledger done but verification failed',
        doneMeans: 'Failing verification must not complete the milestone',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-002'],
        verificationIntentRefs: ['CHK-002:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M3',
        sourceRequirementId: 'REQ-3',
        claim: 'Empty verification refs do not count',
        doneMeans: 'Normal milestones need mapped verification refs',
        requiredEvidence: [],
        checklistRefs: ['CHK-003'],
        verificationIntentRefs: [],
        status: 'done',
      }),
      milestone({
        id: 'M4',
        sourceRequirementId: 'REQ-4',
        claim: 'Not applicable milestone',
        doneMeans: 'Explicitly not applicable',
        requiredEvidence: [],
        checklistRefs: [],
        verificationIntentRefs: [],
        status: 'not_applicable',
      }),
    ]),
  });

  assert.equal(report.schemaVersion, 'proofbound.milestone_status.v1');
  assertReportShape(report);
  assert.deepEqual(report.groups.completed, ['M1', 'M4']);
  assert.deepEqual(report.groups.current, ['M2']);
  assert.deepEqual(report.groups.remaining, ['M3']);

  const m1 = report.milestones.find((row) => row.id === 'M1');
  const m2 = report.milestones.find((row) => row.id === 'M2');
  const m3 = report.milestones.find((row) => row.id === 'M3');
  assert.ok(m1);
  assert.ok(m2);
  assert.ok(m3);
  assertRowShape(m1);
  assertRowShape(m2);
  assertRowShape(m3);
  assert.deepEqual(m1.requiredEvidence, [], 'missing requiredEvidence field falls back to an empty array');
  assert.equal(m1.subObjectives.some((sub) => sub.kind === 'requiredEvidence'), false);
  assert.equal(m1.subObjectives[0].kind, 'checklist');
  assert.equal(m1.subObjectives[1].kind, 'verificationIntent');
  assert.equal(m1.evidenceRefs[0].intentRef, 'CHK-001:happy:0');
  assert.equal(m1.evidenceRefs[0].status, 'pass');
  assertEvidenceRefShape(m1.evidenceRefs[0]);

  assert.equal(m2.status, 'current');
  assert.equal(m2.ledgerStatus, 'done');
  assert.equal(m2.evidenceRefs[0].status, 'fail');
  assert.match(m2.statusDetail, /evidence=not-passing/);
  assert.match(m2.risks.join('\n'), /no passing evidence or permanent non-failing waiver on owning checklist item CHK-002/);
  assert.match(m2.risks.join('\n'), /Required evidence kind "logic_test" has no fresh covering evidence/);
  assert.match(m2.nextAction, /Re-run or replace verificationEvidence/);
  assert.deepEqual(
    m2.subObjectives.filter((sub) => sub.kind === 'requiredEvidence').map((sub) => [sub.id, sub.status]),
    [['logic_test', 'missing-evidence-kind']],
  );

  assert.equal(m3.status, 'remaining');
  assert.match(m3.risks.join('\n'), /no verificationIntentRefs mapped/);

  const text = renderMilestoneStatusReport(report);
  assertTextContract(text);
  const completedSection = text.slice(text.indexOf('Completed'), text.indexOf('\nCurrent'));
  const currentSection = text.slice(text.indexOf('Current'), text.indexOf('\nRemaining'));
  const remainingSection = text.slice(text.indexOf('Remaining'));
  assert.match(completedSection, /\| M1 \| Completed with scoped verification evidence \|/);
  assert.match(completedSection, /\| M4 \| Not applicable milestone \|/);
  assert.match(currentSection, /\| M2 \| Ledger done but verification failed \|/);
  assert.doesNotMatch(currentSection, /\| M3 \|/);
  assert.match(remainingSection, /\| M3 \| Empty verification refs do not count \|/);
  assert.match(text, /CHK-001:happy:0 \[pass\/logic_test\]/);
}

{
  const currentEvidenceBinding = {
    headHash: 'head-current',
    materialHash: 'material-current',
    storyFilesHash: 'story-current',
  };
  const cl = {
    items: [
      checklistItem('CHK-STALE', 'done', [
        evidence('CHK-STALE:happy:0', 'pass', {
          headHash: 'head-old',
          materialHash: 'material-old',
          storyFilesHash: 'story-old',
        }),
      ], intent('fresh evidence required')),
    ],
  };
  const staleLedger = ledger([
    milestone({
      id: 'M-stale',
      sourceRequirementId: 'REQ-stale',
      claim: 'Stale passing evidence must not complete',
      doneMeans: 'Evidence must pass and match the current binding',
      requiredEvidence: [],
      checklistRefs: ['CHK-STALE'],
      verificationIntentRefs: ['CHK-STALE:happy:0'],
      status: 'done',
    }),
  ]);

  const legacyReport = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: staleLedger,
  });
  assert.deepEqual(legacyReport.groups.completed, ['M-stale'], 'without a current binding, legacy pass evidence remains covering');

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: staleLedger,
    currentEvidenceBinding,
  });
  assert.deepEqual(report.groups.completed, []);
  assert.deepEqual(report.groups.current, ['M-stale']);
  assert.deepEqual(report.groups.remaining, []);

  const row = report.milestones.find((candidate) => candidate.id === 'M-stale');
  assert.ok(row);
  assert.equal(row.status, 'current');
  assert.match(row.statusDetail, /evidence=stale/);
  assert.equal(row.subObjectives.find((sub) => sub.id === 'CHK-STALE:happy:0')?.status, 'stale-evidence');
  assert.match(row.risks.join('\n'), /stale passing or permanent waiver evidence/);
  assert.doesNotMatch(row.risks.join('\n'), /stale headHash/);
  assert.match(row.risks.join('\n'), /stale materialHash/);
  assert.match(row.risks.join('\n'), /stale storyFilesHash/);
  assert.match(row.nextAction, /current evidence binding/);

  const text = renderMilestoneStatusReport(report);
  const currentSection = text.slice(text.indexOf('Current'), text.indexOf('\nRemaining'));
  assert.match(currentSection, /\| M-stale \| Stale passing evidence must not complete \|/);
  assert.match(currentSection, /stale-evidence/);
}

{
  const currentEvidenceBinding = {
    headHash: 'head-current',
    materialHash: 'material-current',
    storyFilesHash: 'story-current',
  };
  const cl = {
    items: [
      checklistItem('CHK-HEAD-DRIFT', 'done', [
        evidence('CHK-HEAD-DRIFT:happy:0', 'pass', {
          headHash: 'head-before-metadata-commit',
          materialHash: 'material-current',
          storyFilesHash: 'story-current',
        }),
      ], intent('head-only metadata drift is not stale')),
    ],
  };

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-head-only',
        sourceRequirementId: 'REQ-head-only',
        claim: 'Head-only metadata drift does not block completion',
        doneMeans: 'Evidence with current material and story file hashes remains covering',
        requiredEvidence: [],
        checklistRefs: ['CHK-HEAD-DRIFT'],
        verificationIntentRefs: ['CHK-HEAD-DRIFT:happy:0'],
        status: 'done',
      }),
    ]),
    currentEvidenceBinding,
  });

  assert.deepEqual(report.groups.completed, ['M-head-only']);
  assert.deepEqual(report.groups.current, []);
  const row = report.milestones.find((candidate) => candidate.id === 'M-head-only');
  assert.ok(row);
  assert.equal(row.status, 'completed');
  assert.match(row.statusDetail, /evidence=covered/);
  assert.equal(row.subObjectives.find((sub) => sub.id === 'CHK-HEAD-DRIFT:happy:0')?.status, 'covered');
  assert.doesNotMatch(row.risks.join('\n'), /headHash/);
}

{
  const currentEvidenceBinding = {
    headHash: 'head-current',
    materialHash: 'material-current',
    storyFilesHash: 'story-current',
  };
  const cl = {
    items: [
      checklistItem('CHK-LEGACY-FRESH', 'done', [
        evidence('CHK-LEGACY-FRESH:happy:0', 'pass', {
          headHash: 'head-current',
        }),
      ], intent('legacy matching head evidence remains covering')),
      checklistItem('CHK-LEGACY-STALE', 'done', [
        evidence('CHK-LEGACY-STALE:happy:0', 'pass', {
          headHash: 'head-old',
        }),
      ], intent('legacy stale head evidence is rejected')),
    ],
  };

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-legacy-fresh',
        sourceRequirementId: 'REQ-legacy-fresh',
        claim: 'Legacy head-only evidence can complete through the fallback',
        doneMeans: 'Evidence lacking material/story hashes must match current head',
        requiredEvidence: [],
        checklistRefs: ['CHK-LEGACY-FRESH'],
        verificationIntentRefs: ['CHK-LEGACY-FRESH:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-legacy-stale',
        sourceRequirementId: 'REQ-legacy-stale',
        claim: 'Legacy stale head-only evidence must not complete',
        doneMeans: 'Evidence lacking material/story hashes falls back to head freshness',
        requiredEvidence: [],
        checklistRefs: ['CHK-LEGACY-STALE'],
        verificationIntentRefs: ['CHK-LEGACY-STALE:happy:0'],
        status: 'done',
      }),
    ]),
    currentEvidenceBinding,
  });

  assert.deepEqual(report.groups.completed, ['M-legacy-fresh']);
  assert.deepEqual(report.groups.current, ['M-legacy-stale']);
  const stale = report.milestones.find((candidate) => candidate.id === 'M-legacy-stale');
  assert.ok(stale);
  assert.equal(stale.subObjectives.find((sub) => sub.id === 'CHK-LEGACY-STALE:happy:0')?.status, 'stale-evidence');
  assert.match(stale.risks.join('\n'), /stale headHash/);
  assert.doesNotMatch(stale.risks.join('\n'), /missing materialHash/);
  assert.doesNotMatch(stale.risks.join('\n'), /missing storyFilesHash/);
}

{
  const cl = {
    items: [
      checklistItem('CHK-NOREF', 'done', [evidence('CHK-NOREF:happy:0')], intent('covered but unlinked')),
    ],
  };
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-no-checklistRefs',
        sourceRequirementId: 'REQ-no-checklistRefs',
        claim: 'No checklistRefs must not complete',
        doneMeans: 'Normal milestones require at least one valid checklistRef',
        requiredEvidence: [],
        checklistRefs: [],
        verificationIntentRefs: ['CHK-NOREF:happy:0'],
        status: 'done',
      }),
    ]),
  });

  assert.deepEqual(report.groups.completed, []);
  assert.deepEqual(report.groups.current, ['M-no-checklistRefs']);
  const row = report.milestones.find((candidate) => candidate.id === 'M-no-checklistRefs');
  assert.ok(row);
  assert.match(row.statusDetail, /checklist=missing/);
  assert.match(row.risks.join('\n'), /missing-checklistRefs/);
  assert.match(row.nextAction, /valid checklistRef/);
}

{
  const cl = {
    items: [
      checklistItem('CHK-A', 'done', [], intent('owner intent', 'misplaced-intent')),
      checklistItem('CHK-B', 'done', [evidence('misplaced-intent')]),
      checklistItem('CHK-C', 'done', [evidence('duplicate-intent')], intent('first duplicate', 'duplicate-intent')),
      checklistItem('CHK-D', 'done', [evidence('duplicate-intent')], intent('second duplicate', 'duplicate-intent')),
    ],
  };
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-misplaced',
        sourceRequirementId: 'REQ-misplaced',
        claim: 'Misplaced evidence is not scoped evidence',
        doneMeans: 'Evidence must be on the owning checklist item',
        requiredEvidence: [],
        checklistRefs: ['CHK-A'],
        verificationIntentRefs: ['misplaced-intent'],
        status: 'done',
      }),
      milestone({
        id: 'M-duplicate',
        sourceRequirementId: 'REQ-duplicate',
        claim: 'Duplicate custom intent ids are ambiguous',
        doneMeans: 'Ambiguous intent ids must not complete a milestone',
        requiredEvidence: [],
        checklistRefs: ['CHK-C'],
        verificationIntentRefs: ['duplicate-intent'],
        status: 'done',
      }),
    ]),
  });

  assert.deepEqual(report.groups.completed, []);
  assert.deepEqual(report.groups.current, ['M-misplaced']);
  assert.deepEqual(report.groups.remaining, ['M-duplicate']);

  const misplaced = report.milestones.find((row) => row.id === 'M-misplaced');
  const duplicate = report.milestones.find((row) => row.id === 'M-duplicate');
  assert.ok(misplaced);
  assert.ok(duplicate);
  assert.equal(misplaced.evidenceRefs.length, 0, 'evidence on another checklist item must not be attached as scoped evidence');
  assert.match(misplaced.risks.join('\n'), /no evidence on owning checklist item CHK-A/);
  assert.equal(duplicate.evidenceRefs.length, 0, 'ambiguous duplicate intent ids must not pick an arbitrary evidence owner');
  assert.match(duplicate.risks.join('\n'), /ambiguous across 2 checklist items/);
  assert.equal(
    duplicate.subObjectives.find((sub) => sub.id === 'duplicate-intent')?.status,
    'ambiguous-intent',
  );
}

{
  const cl = {
    items: [
      checklistItem('CHK-REQ-LOGIC', 'done', [
        evidence('CHK-REQ-LOGIC:happy:0', 'pass', { kind: 'logic_test' }),
      ], intent('wrong kind is still scoped intent coverage')),
      checklistItem('CHK-REQ-BROWSER', 'done', [
        evidence('CHK-REQ-BROWSER:happy:0', 'pass', { kind: 'browser_test' }),
      ], intent('required browser evidence is present')),
      checklistItem('CHK-REQ-CUSTOM', 'done', [
        evidence('CHK-REQ-CUSTOM:happy:0', 'pass', { kind: 'logic_test' }),
      ], intent('custom required evidence label is advisory')),
    ],
  };
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-required-missing',
        sourceRequirementId: 'REQ-required-missing',
        claim: 'Required evidence kind must be present',
        doneMeans: 'A browser_test requirement cannot be completed by logic_test evidence',
        requiredEvidence: ['browser_test'],
        checklistRefs: ['CHK-REQ-LOGIC'],
        verificationIntentRefs: ['CHK-REQ-LOGIC:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-required-covered',
        sourceRequirementId: 'REQ-required-covered',
        claim: 'Required evidence kind can complete',
        doneMeans: 'A fresh browser_test evidence item satisfies the required kind',
        requiredEvidence: ['browser_test'],
        checklistRefs: ['CHK-REQ-BROWSER'],
        verificationIntentRefs: ['CHK-REQ-BROWSER:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-required-custom-label',
        sourceRequirementId: 'REQ-required-custom-label',
        claim: 'Custom requiredEvidence labels remain mapping hints',
        doneMeans: 'Historical non-kind labels do not block when mapped verification refs are covered',
        requiredEvidence: ['cli_smoke'],
        checklistRefs: ['CHK-REQ-CUSTOM'],
        verificationIntentRefs: ['CHK-REQ-CUSTOM:happy:0'],
        status: 'done',
      }),
    ]),
  });

  assert.deepEqual(report.groups.completed, ['M-required-covered', 'M-required-custom-label']);
  assert.deepEqual(report.groups.current, ['M-required-missing']);
  const missing = report.milestones.find((row) => row.id === 'M-required-missing');
  assert.ok(missing);
  assert.equal(missing.subObjectives.find((sub) => sub.id === 'CHK-REQ-LOGIC:happy:0')?.status, 'covered');
  assert.equal(missing.subObjectives.find((sub) => sub.id === 'browser_test')?.status, 'missing-evidence-kind');
  assert.match(missing.statusDetail, /requiredEvidence=missing/);
  assert.match(missing.risks.join('\n'), /Required evidence kind "browser_test" has no fresh covering evidence/);

  const covered = report.milestones.find((row) => row.id === 'M-required-covered');
  assert.ok(covered);
  assert.equal(covered.subObjectives.find((sub) => sub.id === 'browser_test')?.status, 'covered');
  assert.match(covered.statusDetail, /requiredEvidence=covered/);

  const custom = report.milestones.find((row) => row.id === 'M-required-custom-label');
  assert.ok(custom);
  assert.equal(custom.subObjectives.find((sub) => sub.id === 'cli_smoke')?.status, 'mapped');
  assert.match(custom.statusDetail, /requiredEvidence=covered/);
}

{
  const cl = {
    items: [
      checklistItem('CHK-WAIVE-PERM', 'done', [
        evidence('CHK-WAIVE-PERM:happy:0', 'pass', { kind: 'waiver', waiverType: 'permanent' }),
      ], intent('permanent waiver may cover')),
      checklistItem('CHK-WAIVE-DEFER', 'done', [
        evidence('CHK-WAIVE-DEFER:happy:0', 'pass', { kind: 'waiver', waiverType: 'deferred_gate_evidence' }),
      ], intent('deferred waiver must not cover')),
      checklistItem('CHK-WAIVE-FAIL', 'done', [
        evidence('CHK-WAIVE-FAIL:happy:0', 'fail', { kind: 'waiver', waiverType: 'permanent' }),
      ], intent('failed waiver must not cover')),
    ],
  };
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-waiver-permanent',
        sourceRequirementId: 'REQ-waiver-permanent',
        claim: 'Permanent waiver can cover',
        doneMeans: 'Permanent non-failing waiver is explicit coverage',
        requiredEvidence: [],
        checklistRefs: ['CHK-WAIVE-PERM'],
        verificationIntentRefs: ['CHK-WAIVE-PERM:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-waiver-deferred',
        sourceRequirementId: 'REQ-waiver-deferred',
        claim: 'Deferred waiver cannot cover',
        doneMeans: 'Deferred gate evidence must be replaced',
        requiredEvidence: [],
        checklistRefs: ['CHK-WAIVE-DEFER'],
        verificationIntentRefs: ['CHK-WAIVE-DEFER:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-waiver-failed',
        sourceRequirementId: 'REQ-waiver-failed',
        claim: 'Failed waiver cannot cover',
        doneMeans: 'Failed waiver evidence must not complete',
        requiredEvidence: [],
        checklistRefs: ['CHK-WAIVE-FAIL'],
        verificationIntentRefs: ['CHK-WAIVE-FAIL:happy:0'],
        status: 'done',
      }),
    ]),
  });

  assert.deepEqual(report.groups.completed, ['M-waiver-permanent']);
  assert.deepEqual(report.groups.current, ['M-waiver-deferred']);
  assert.deepEqual(report.groups.remaining, ['M-waiver-failed']);
  const deferred = report.milestones.find((row) => row.id === 'M-waiver-deferred');
  const failed = report.milestones.find((row) => row.id === 'M-waiver-failed');
  assert.ok(deferred);
  assert.ok(failed);
  assert.equal(deferred.evidenceRefs[0].status, 'waived');
  assert.equal(deferred.subObjectives.find((sub) => sub.id === 'CHK-WAIVE-DEFER:happy:0')?.status, 'not-passing');
  assert.match(deferred.risks.join('\n'), /no passing evidence or permanent non-failing waiver/);
  assert.equal(failed.evidenceRefs[0].status, 'fail');
  assert.equal(failed.subObjectives.find((sub) => sub.id === 'CHK-WAIVE-FAIL:happy:0')?.status, 'not-passing');
  assert.match(failed.statusDetail, /evidence=not-passing/);
}

{
  let readCount = 0;
  const handlers = createMilestoneStatusHandlers({
    root: '/tmp/lattice-milestone-status',
    scanRoot: '/tmp/lattice-milestone-status',
    store: {
      readStory() {
        readCount += 1;
        throw new Error('readStory should not be called');
      },
      readChecklist() {
        readCount += 1;
        throw new Error('readChecklist should not be called');
      },
      readMilestoneLedger() {
        readCount += 1;
        throw new Error('readMilestoneLedger should not be called');
      },
      readSummary() {
        readCount += 1;
        throw new Error('readSummary should not be called');
      },
    },
  });

  assert.throws(
    () => handlers.milestone_status({ storyId: 'B-7ba7', surpriseFlag: true }),
    /read-only.*unexpected keys: surpriseFlag/s,
  );
  assert.equal(readCount, 0, 'unexpected args must be rejected before reading story facts');
}

{
  const reads = [];
  const handlers = createMilestoneStatusHandlers({
    root: '/tmp/lattice-milestone-status',
    scanRoot: '/tmp/lattice-milestone-status',
    store: {
      readStory() {
        reads.push('story');
        return story();
      },
      readChecklist() {
        reads.push('checklist');
        throw new SyntaxError('missing checklist json');
      },
      readMilestoneLedger() {
        reads.push('ledger');
        return null;
      },
      readSummary() {
        reads.push('summary');
        return null;
      },
    },
  });

  const report = handlers.milestone_status({ storyId: 'B-7ba7', json: true });
  assert.equal(report.schemaVersion, 'proofbound.milestone_status.v1');
  assert.equal(report.mode.readOnly, true);
  assert.equal(report.mode.runCommands, false);
  assert.equal(report.ledger.present, false);
  assert.deepEqual(report.groups, { completed: [], current: [], remaining: [] });
  assert.match(report.risks.join('\n'), /Missing milestone ledger/);
  assert.deepEqual(reads, ['story', 'ledger', 'summary'], 'missing ledger report must not require checklist reads');
}

{
  const reads = [];
  const handlers = createMilestoneStatusHandlers({
    root: '/tmp/lattice-milestone-status',
    scanRoot: '/tmp/lattice-milestone-status',
    store: {
      readStory() {
        reads.push('story');
        return story();
      },
      readChecklist() {
        reads.push('checklist');
        throw new SyntaxError('corrupt checklist json');
      },
      readMilestoneLedger() {
        reads.push('ledger');
        return ledger([]);
      },
      readSummary() {
        reads.push('summary');
        return null;
      },
    },
  });

  assert.throws(
    () => handlers.milestone_status({ storyId: 'B-7ba7', json: true }),
    /corrupt checklist json/,
  );
  assert.deepEqual(reads, ['story', 'ledger', 'summary', 'checklist'], 'corrupt checklist must surface when a ledger exists');
}

{
  const storyId = 'B-cli-ms';
  const root = mkdtempSync(join(tmpdir(), 'lattice-milestone-status-'));
  try {
    const storyDir = join(root, '.lattice', 'story', 'actives', storyId);
    mkdirSync(storyDir, { recursive: true });
    writeJson(join(root, 'lattice.config.json'), {
      scanRoot: '.',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      flows: { defaults: {}, patterns: [] },
    });
    writeJson(join(storyDir, 'index.json'), story(storyId));
    writeJson(join(storyDir, 'checklist.json'), {
      items: [
        checklistItem('CHK-CLI', 'done', [evidence('CHK-CLI:happy:0')], intent('CLI-covered intent')),
      ],
    });
    writeJson(join(storyDir, 'milestone-ledger.json'), ledger([
      milestone({
        id: 'M-cli',
        sourceRequirementId: 'REQ-cli',
        claim: 'CLI report milestone',
        doneMeans: 'The built CLI renders milestone headings',
        requiredEvidence: [],
        checklistRefs: ['CHK-CLI'],
        verificationIntentRefs: ['CHK-CLI:happy:0'],
        status: 'covered',
      }),
    ], storyId));

    const stdout = execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      storyId,
    ], { cwd: root, encoding: 'utf8' });
    assert.match(stdout, /Milestone Status - B-cli-ms/);
    assert.match(stdout, /Completed/);
    assert.match(stdout, /Current/);
    assert.match(stdout, /Remaining/);
    assert.match(stdout, /\| M-cli \| CLI report milestone \|/);

    const unknownFlag = spawnSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      storyId,
      '--format=json',
      '--surpriseFlag=true',
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(unknownFlag.status, 0, 'CLI parser must reject unknown milestone_status flags');
    assert.equal(unknownFlag.stdout, '', 'unknown flags must fail before story facts are printed');
    assert.match(unknownFlag.stderr, /Argument validation failed[\s\S]*surpriseFlag/);

    {
      const activeStoryId = 'B-preflight';
      const activeRoot = mkdtempSync(join(tmpdir(), 'lattice-milestone-status-preflight-'));
      try {
        const activeStoryDir = join(activeRoot, '.lattice', 'story', 'actives', activeStoryId);
        mkdirSync(activeStoryDir, { recursive: true });
        writeJson(join(activeRoot, 'lattice.config.json'), {
          scanRoot: '.',
          testsDir: 'tests',
          fixturesDir: 'tests/fixtures',
          storyDir: '.lattice/story/actives',
          requirementsDir: 'docs/requirements',
          storyPrefix: 'B',
          flows: { defaults: {}, patterns: [] },
        });
        execFileSync('git', ['init', '-b', 'main'], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('git', ['config', 'user.name', 'Milestone Status Test'], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('git', ['config', 'user.email', 'milestone-status@example.com'], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('git', ['add', 'lattice.config.json'], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('git', ['checkout', '-b', `story/${activeStoryId}`], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('mkfifo', [join(activeStoryDir, 'index.json')], { cwd: activeRoot, stdio: ['pipe', 'pipe', 'pipe'] });

        const rejectedBeforeActiveRead = spawnSync(process.execPath, [
          cliPath,
          'milestone_status',
          '--root',
          activeRoot,
          '--storyId',
          activeStoryId,
          '--surpriseFlag=true',
        ], { cwd: activeRoot, encoding: 'utf8', timeout: 2000 });
        assert.notEqual(rejectedBeforeActiveRead.error?.code, 'ETIMEDOUT', 'malformed milestone_status args must reject before active-story metadata reads');
        assert.notEqual(rejectedBeforeActiveRead.status, 0, 'malformed milestone_status args must be rejected');
        assert.match(rejectedBeforeActiveRead.stderr, /Argument validation failed[\s\S]*surpriseFlag/);
      } finally {
        rmSync(activeRoot, { recursive: true, force: true });
      }
    }

    for (const flag of [
      'runCommands',
      'writeEvidence',
      'advancePhase',
      'launchReviewers',
      'write',
      'apply',
      'execute',
      'run',
      'launch',
      'capture',
      'refresh',
      'authorityDone',
      'productionDone',
    ]) {
      const rejected = spawnSync(process.execPath, [
        cliPath,
        'milestone_status',
        '--root',
        root,
        '--storyId',
        storyId,
        `--${flag}=true`,
      ], { cwd: root, encoding: 'utf8' });
      assert.notEqual(rejected.status, 0, `CLI parser must reject ${flag} for milestone_status`);
      assert.match(rejected.stderr, new RegExp(`Argument validation failed[\\s\\S]*${flag}`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('ok milestone-status');

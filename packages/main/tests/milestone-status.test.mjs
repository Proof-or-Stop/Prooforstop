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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const cliPath = join(distRoot, 'cli.js');
const {
  buildMilestoneCloseoutSnapshot,
  buildMilestoneStatusReport,
  buildMilestoneStatusReportFromCloseoutSnapshot,
  milestoneStatusReportDigest,
  renderMilestoneCloseoutSnapshot,
  renderMilestoneStatusReport,
} = await import(join(distRoot, 'core/milestone-status.js'));
const {
  EMPTY_STORY_FILES_HASH,
  currentMaterialHash,
} = await import(join(distRoot, 'core/evidence-freshness.js'));
const { signDeliveryCheck } = await import(join(distRoot, 'core/delivery-check-hash.js'));
const { StoryStore } = await import(join(distRoot, 'core/store.js'));
const {
  captureMilestoneCloseoutSnapshotFromStore,
  createMilestoneStatusHandlers,
} = await import(join(distRoot, 'handlers/milestone-status.js'));
const { createStoryAdvanceHandlers } = await import(join(distRoot, 'handlers/story-advance.js'));

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

function writeTestConfig(root) {
  writeJson(join(root, 'lattice.config.json'), {
    scanRoot: '.',
    testsDir: 'tests',
    fixturesDir: 'tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
    flows: { defaults: {}, patterns: [] },
  });
}

{
  const markerStoryId = 'B-marker-icons';
  const markerChecklist = {
    items: [
      checklistItem('CHK-MARKER-DONE', 'done', [evidence('CHK-MARKER-DONE:happy:0')], intent('marker completed intent')),
      checklistItem('CHK-MARKER-REVIEW', 'done', [evidence('CHK-MARKER-REVIEW:happy:0')], intent('marker review intent')),
      checklistItem('CHK-MARKER-PLANNED-REVIEW', 'done', [evidence('CHK-MARKER-PLANNED-REVIEW:happy:0')], intent('marker planned review intent')),
      checklistItem('CHK-MARKER-CURRENT', 'in_progress', [], intent('marker current intent')),
      checklistItem('CHK-MARKER-REMAINING', 'pending', [], intent('marker remaining intent')),
      checklistItem('CHK-MARKER-FAILED', 'done', [evidence('CHK-MARKER-FAILED:happy:0', 'fail')], intent('marker failed intent')),
    ],
  };
  const markerLedger = ledger([
    milestone({
      id: 'M-marker-done',
      sourceRequirementId: 'REQ-marker-done',
      claim: 'Marker completed milestone',
      doneMeans: 'Completed rows show the success marker',
      requiredEvidence: [],
      checklistRefs: ['CHK-MARKER-DONE'],
      verificationIntentRefs: ['CHK-MARKER-DONE:happy:0'],
      status: 'done',
    }),
    milestone({
      id: 'M-marker-review',
      sourceRequirementId: 'REQ-marker-review',
      claim: 'Marker pending review milestone',
      doneMeans: 'Covered rows awaiting final ledger acceptance show pending review',
      requiredEvidence: [],
      checklistRefs: ['CHK-MARKER-REVIEW'],
      verificationIntentRefs: ['CHK-MARKER-REVIEW:happy:0'],
      status: 'covered',
    }),
    milestone({
      id: 'M-marker-planned-review',
      sourceRequirementId: 'REQ-marker-planned-review',
      claim: 'Marker planned pending review milestone',
      doneMeans: 'Implementation-complete planned rows awaiting ledger acceptance show pending review',
      requiredEvidence: ['logic_test'],
      checklistRefs: ['CHK-MARKER-PLANNED-REVIEW'],
      verificationIntentRefs: ['CHK-MARKER-PLANNED-REVIEW:happy:0'],
      status: 'planned',
    }),
    milestone({
      id: 'M-marker-current',
      sourceRequirementId: 'REQ-marker-current',
      claim: 'Marker current milestone',
      doneMeans: 'The first incomplete row shows the incomplete marker',
      requiredEvidence: [],
      checklistRefs: ['CHK-MARKER-DONE', 'CHK-MARKER-CURRENT', 'CHK-MARKER-REMAINING'],
      verificationIntentRefs: ['CHK-MARKER-DONE:happy:0'],
      status: 'planned',
    }),
    milestone({
      id: 'M-marker-remaining',
      sourceRequirementId: 'REQ-marker-remaining',
      claim: 'Marker remaining milestone',
      doneMeans: 'Later incomplete rows show the incomplete marker',
      requiredEvidence: [],
      checklistRefs: ['CHK-MARKER-REMAINING'],
      verificationIntentRefs: ['CHK-MARKER-REMAINING:happy:0'],
      status: 'planned',
    }),
    milestone({
      id: 'M-marker-blocked',
      sourceRequirementId: 'REQ-marker-blocked',
      claim: 'Marker blocked milestone',
      doneMeans: 'Missing refs show the blocked marker',
      requiredEvidence: [],
      checklistRefs: ['CHK-MARKER-MISSING'],
      verificationIntentRefs: ['CHK-MARKER-MISSING:happy:0'],
      status: 'planned',
    }),
    milestone({
      id: 'M-marker-failed',
      sourceRequirementId: 'REQ-marker-failed',
      claim: 'Marker failed milestone',
      doneMeans: 'Failing evidence shows the failed marker',
      requiredEvidence: [],
      checklistRefs: ['CHK-MARKER-FAILED'],
      verificationIntentRefs: ['CHK-MARKER-FAILED:happy:0'],
      status: 'done',
    }),
  ], markerStoryId);
  const markerReport = buildMilestoneStatusReport({
    story: story(markerStoryId),
    checklist: markerChecklist,
    milestoneLedger: markerLedger,
  });
  const markerText = renderMilestoneStatusReport(markerReport);
  assert.match(markerText, /\| M-marker-done \| Marker completed milestone \| ✅ Done \(ledger=done;/);
  assert.match(markerText, /\| M-marker-review \| Marker pending review milestone \| 🟡 Pending Review \(ledger=covered;/);
  assert.match(markerText, /\| M-marker-planned-review \| Marker planned pending review milestone \| 🟡 Pending Review \(ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered\)/);
  assert.match(markerText, /\| M-marker-current \| Marker current milestone \| ⏳ In Progress \(ledger=planned;/);
  assert.match(markerText, /\| M-marker-remaining \| Marker remaining milestone \| ⬜ Not Started \(ledger=planned;/);
  assert.match(markerText, /\| M-marker-blocked \| Marker blocked milestone \| 🔴 Blocked \(ledger=planned;/);
  assert.match(markerText, /\| M-marker-failed \| Marker failed milestone \| ❌ Failed \(ledger=done;/);
  assert.match(markerText, /✅ Done CHK-MARKER-DONE \[done\] CHK-MARKER-DONE title/);
  assert.match(markerText, /⏳ In Progress CHK-MARKER-CURRENT \[in_progress\] CHK-MARKER-CURRENT title/);
  assert.match(markerText, /⬜ Not Started CHK-MARKER-REMAINING \[pending\] CHK-MARKER-REMAINING title/);
  assert.match(markerText, /🔴 Blocked CHK-MARKER-MISSING \[missing\] CHK-MARKER-MISSING/);
  assert.match(markerText, /✅ Done CHK-MARKER-DONE:happy:0 \[covered\]/);
  assert.match(markerText, /✅ Done CHK-MARKER-DONE:happy:0 \[pass\/logic_test\]/);
  assert.match(markerText, /❌ Failed CHK-MARKER-FAILED:happy:0 \[fail\/logic_test\]/);

  const missingText = renderMilestoneStatusReport(buildMilestoneStatusReport({
    story: story('B-marker-missing-ledger'),
    checklist: { items: [] },
    milestoneLedger: null,
  }));
  assert.match(missingText, /\| ledger \| milestone ledger required \| 🔴 Blocked \(ledger=missing\) \|/);
  assert.match(missingText, /\| none \| none \| none \| none \| none \| none \| none \|/);
  assert.doesNotMatch(missingText, /\| none \| none \| [✅⏳🟡⬜🔴❌] none \|/, 'placeholder none rows stay unmarked');

  const cliMarkerStoryId = 'B-cli-marker-icons';
  const root = mkdtempSync(join(tmpdir(), 'lattice-milestone-status-icons-'));
  try {
    const storyDir = join(root, '.lattice', 'story', 'actives', cliMarkerStoryId);
    mkdirSync(storyDir, { recursive: true });
    writeTestConfig(root);
    writeJson(join(storyDir, 'index.json'), story(cliMarkerStoryId));
    writeJson(join(storyDir, 'checklist.json'), markerChecklist);
    writeJson(join(storyDir, 'milestone-ledger.json'), ledger(markerLedger.milestones, cliMarkerStoryId));

    const cliText = execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      cliMarkerStoryId,
    ], { cwd: root, encoding: 'utf8' });
    assert.match(cliText, /\| M-marker-done \| Marker completed milestone \| ✅ Done \(ledger=done;/);
    assert.match(cliText, /\| M-marker-review \| Marker pending review milestone \| 🟡 Pending Review \(ledger=covered;/);
    assert.match(cliText, /\| M-marker-planned-review \| Marker planned pending review milestone \| 🟡 Pending Review \(ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered\)/);
    assert.match(cliText, /\| M-marker-current \| Marker current milestone \| ⏳ In Progress \(ledger=planned;/);
    assert.match(cliText, /\| M-marker-remaining \| Marker remaining milestone \| ⬜ Not Started \(ledger=planned;/);
    assert.match(cliText, /\| M-marker-blocked \| Marker blocked milestone \| 🔴 Blocked \(ledger=planned;/);
    assert.match(cliText, /\| M-marker-failed \| Marker failed milestone \| ❌ Failed \(ledger=done;/);
    assert.match(cliText, /✅ Done CHK-MARKER-DONE \[done\] CHK-MARKER-DONE title/);
    assert.match(cliText, /⏳ In Progress CHK-MARKER-CURRENT \[in_progress\] CHK-MARKER-CURRENT title/);
    assert.match(cliText, /⬜ Not Started CHK-MARKER-REMAINING \[pending\] CHK-MARKER-REMAINING title/);
    assert.match(cliText, /🔴 Blocked CHK-MARKER-MISSING \[missing\] CHK-MARKER-MISSING/);
    assert.match(cliText, /❌ Failed CHK-MARKER-FAILED:happy:0 \[fail\/logic_test\]/);

    const autoAppendText = execFileSync(process.execPath, [
      cliPath,
      'checklist_update',
      '--root',
      root,
      '--storyId',
      cliMarkerStoryId,
      '--itemId',
      'CHK-MARKER-CURRENT',
      '--status',
      'pending',
    ], { cwd: root, encoding: 'utf8' });
    assert.match(autoAppendText, /Milestone Status - B-cli-marker-icons/);
    assert.match(autoAppendText, /\| M-marker-done \| Marker completed milestone \| ✅ Done \(ledger=done;/);
    assert.match(autoAppendText, /\| M-marker-review \| Marker pending review milestone \| 🟡 Pending Review \(ledger=covered;/);
    assert.match(autoAppendText, /\| M-marker-planned-review \| Marker planned pending review milestone \| 🟡 Pending Review \(ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered\)/);
    assert.match(autoAppendText, /\| M-marker-current \| Marker current milestone \| ⏳ In Progress \(ledger=planned;/);
    assert.match(autoAppendText, /\| M-marker-remaining \| Marker remaining milestone \| ⬜ Not Started \(ledger=planned;/);
    assert.match(autoAppendText, /\| M-marker-blocked \| Marker blocked milestone \| 🔴 Blocked \(ledger=planned;/);
    assert.match(autoAppendText, /\| M-marker-failed \| Marker failed milestone \| ❌ Failed \(ledger=done;/);
    assert.match(autoAppendText, /✅ Done CHK-MARKER-DONE \[done\] CHK-MARKER-DONE title/);
    assert.match(autoAppendText, /⬜ Not Started CHK-MARKER-CURRENT \[pending\] CHK-MARKER-CURRENT title/);
    assert.match(autoAppendText, /⬜ Not Started CHK-MARKER-REMAINING \[pending\] CHK-MARKER-REMAINING title/);
    assert.match(autoAppendText, /❌ Failed CHK-MARKER-FAILED:happy:0 \[fail\/logic_test\]/);

    const noLedgerStoryId = 'B-cli-marker-no-ledger';
    const noLedgerStoryDir = join(root, '.lattice', 'story', 'actives', noLedgerStoryId);
    mkdirSync(noLedgerStoryDir, { recursive: true });
    writeJson(join(noLedgerStoryDir, 'index.json'), story(noLedgerStoryId));
    writeJson(join(noLedgerStoryDir, 'checklist.json'), {
      items: [
        checklistItem('CHK-MARKER-NO-LEDGER', 'pending'),
      ],
    });
    const noLedgerStdout = execFileSync(process.execPath, [
      cliPath,
      'checklist_update',
      '--root',
      root,
      '--storyId',
      noLedgerStoryId,
      '--itemId',
      'CHK-MARKER-NO-LEDGER',
      '--status',
      'in_progress',
    ], { cwd: root, encoding: 'utf8' });
    assert.match(noLedgerStdout, /Checklist CHK-MARKER-NO-LEDGER:/);
    assert.equal(
      noLedgerStdout.includes(`Milestone Status - ${noLedgerStoryId}`),
      false,
      'missing-ledger story mutations must not fabricate a milestone status table',
    );

    const jsonStoryId = 'B-cli-marker-json';
    const jsonStoryDir = join(root, '.lattice', 'story', 'actives', jsonStoryId);
    mkdirSync(jsonStoryDir, { recursive: true });
    writeJson(join(jsonStoryDir, 'index.json'), story(jsonStoryId));
    const jsonStdout = execFileSync(process.execPath, [
      cliPath,
      'milestone_ledger_add',
      '--root',
      root,
      '--storyId',
      jsonStoryId,
      '--id',
      'M-json',
      '--sourceRequirementId',
      'REQ-json',
      '--claim',
      'JSON stdout remains parseable',
      '--doneMeans',
      'The command writes only JSON when --json is set',
      '--status',
      'planned',
      '--json',
    ], { cwd: root, encoding: 'utf8' });
    const jsonLedger = JSON.parse(jsonStdout);
    assert.equal(jsonLedger.storyId, jsonStoryId);
    assert.equal(jsonLedger.milestones.at(-1).id, 'M-json');
    assert.equal(
      jsonStdout.includes(`Milestone Status - ${jsonStoryId}`),
      false,
      'machine JSON stdout must not be contaminated with a milestone table',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

function assertCloseoutTextContract(text) {
  for (const label of [
    'Milestone Closeout',
    'Mode: read-only historical snapshot',
    '| Milestone | Status | Solved Problem | Acceptance | Evidence | Risks | Next Action |',
  ]) {
    assert.ok(text.includes(label), `closeout text output must include ${label}`);
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

  assert.throws(
    () => buildMilestoneCloseoutSnapshot({ report }),
    /incomplete milestone rows: M2=current, M3=remaining/,
    'closeout snapshots must reject incomplete live milestone reports',
  );
}

{
  const closeoutStory = story('B-closeout');
  closeoutStory.phase = 'TEST';
  const cl = {
    items: [
      checklistItem('CHK-CLOSE', 'done', [
        evidence('CHK-CLOSE:happy:0', 'pass', {
          headHash: 'head-closeout',
          materialHash: 'material-closeout',
          storyFilesHash: 'story-closeout',
        }),
      ], intent('closeout evidence')),
    ],
  };
  const report = buildMilestoneStatusReport({
    story: closeoutStory,
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-closeout',
        sourceRequirementId: 'REQ-closeout',
        claim: 'Users can read the final solved problem',
        doneMeans: 'A completed risk-free report can be frozen',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-CLOSE'],
        verificationIntentRefs: ['CHK-CLOSE:happy:0'],
        status: 'done',
      }),
    ], 'B-closeout'),
    currentEvidenceBinding: {
      headHash: 'head-closeout',
      materialHash: 'material-closeout',
      storyFilesHash: 'story-closeout',
    },
  });

  const snapshot = buildMilestoneCloseoutSnapshot({
    report,
    bindings: {
      headHash: 'head-closeout',
      materialHash: 'material-closeout',
      storyFilesHash: 'story-closeout',
    },
    generatedAt: '2026-07-04T12:00:00.000Z',
  });

  assert.equal(snapshot.schemaVersion, 'proofbound.milestone_closeout.v1');
  assert.equal(snapshot.storyId, 'B-closeout');
  assert.equal(snapshot.phase, 'TEST');
  assert.equal(snapshot.generatedAt, '2026-07-04T12:00:00.000Z');
  assert.equal(snapshot.sourceReport.schemaVersion, 'proofbound.milestone_status.v1');
  assert.equal(snapshot.sourceReport.digest, milestoneStatusReportDigest(report));
  assert.deepEqual(snapshot.sourceReport.groups, { completed: ['M-closeout'], current: [], remaining: [] });
  assert.deepEqual(snapshot.bindings, {
    headHash: 'head-closeout',
    materialHash: 'material-closeout',
    storyFilesHash: 'story-closeout',
  });
  assert.equal(snapshot.rows.length, 1);
  assert.deepEqual(Object.keys(snapshot.rows[0]).sort(), [
    'acceptance',
    'evidence',
    'milestone',
    'nextAction',
    'risks',
    'solvedProblem',
    'status',
  ]);
  assert.equal(snapshot.rows[0].milestone, 'M-closeout');
  assert.match(snapshot.rows[0].status, /^completed /);
  assert.equal(snapshot.rows[0].solvedProblem, 'Users can read the final solved problem');
  assert.equal(snapshot.rows[0].acceptance, 'A completed risk-free report can be frozen');
  assert.match(snapshot.rows[0].evidence.join('\n'), /CHK-CLOSE:happy:0 \[pass\/logic_test\]/);
  assert.deepEqual(snapshot.rows[0].risks, []);
  assert.equal(snapshot.rows[0].nextAction, 'No action for this milestone.');

  const text = renderMilestoneCloseoutSnapshot(snapshot);
  assertCloseoutTextContract(text);
  assert.match(text, /Source milestone_status digest:/);
  assert.match(text, /\| M-closeout \| completed \(ledger=done; checklist=complete; evidence=covered; requiredEvidence=covered\) \| Users can read the final solved problem \|/);

  const snapshotBackedReport = buildMilestoneStatusReportFromCloseoutSnapshot(snapshot, { phase: 'DONE' });
  assert.equal(snapshotBackedReport.schemaVersion, 'proofbound.milestone_status.v1');
  assertReportShape(snapshotBackedReport);
  assert.equal(snapshotBackedReport.storyId, 'B-closeout');
  assert.equal(snapshotBackedReport.phase, 'DONE');
  assert.deepEqual(snapshotBackedReport.ledger, report.ledger);
  assert.deepEqual(snapshotBackedReport.groups, { completed: ['M-closeout'], current: [], remaining: [] });
  assert.deepEqual(snapshotBackedReport.risks, []);
  assert.deepEqual(snapshotBackedReport.nextActions, ['No milestone action; all ledger rows are completed or not applicable.']);
  assert.equal(snapshotBackedReport.milestones.length, 1);
  assertRowShape(snapshotBackedReport.milestones[0]);
  assert.equal(snapshotBackedReport.milestones[0].status, 'completed');
  assert.equal(snapshotBackedReport.milestones[0].statusDetail, 'ledger=done; checklist=complete; evidence=covered; requiredEvidence=covered');
  assert.equal(snapshotBackedReport.milestones[0].ledgerStatus, 'done');
  assert.equal(snapshotBackedReport.milestones[0].evidenceRefs[0].intentRef, 'CHK-CLOSE:happy:0');
  assert.equal(snapshotBackedReport.milestones[0].evidenceRefs[0].status, 'pass');
  const snapshotBackedText = renderMilestoneStatusReport(snapshotBackedReport);
  assertTextContract(snapshotBackedText.replaceAll('B-closeout', 'B-7ba7'));
  assert.match(snapshotBackedText, /Milestone Status - B-closeout/);
  assert.match(snapshotBackedText, /\| M-closeout \| Users can read the final solved problem \| ✅ Done \(ledger=done; checklist=complete; evidence=covered; requiredEvidence=covered\) \|/);

  const plannedLedgerStoryId = 'B-closeout-planned-ledger';
  const plannedLedgerReport = buildMilestoneStatusReport({
    story: story(plannedLedgerStoryId),
    checklist: {
      items: [
        checklistItem('CHK-PLANNED-CLOSEOUT', 'done', [
          evidence('CHK-PLANNED-CLOSEOUT:happy:0'),
        ], intent('planned ledger evidence is covered')),
      ],
    },
    milestoneLedger: ledger([
      milestone({
        id: 'M-planned-closeout',
        sourceRequirementId: 'REQ-planned-closeout',
        claim: 'Closeout completed rows render done even when frozen detail says ledger planned',
        doneMeans: 'The completed closeout group is display-final',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-PLANNED-CLOSEOUT'],
        verificationIntentRefs: ['CHK-PLANNED-CLOSEOUT:happy:0'],
        status: 'planned',
      }),
    ], plannedLedgerStoryId),
  });
  assert.deepEqual(plannedLedgerReport.groups, { completed: ['M-planned-closeout'], current: [], remaining: [] });
  const activePlannedText = renderMilestoneStatusReport(plannedLedgerReport);
  assert.match(
    activePlannedText,
    /\| M-planned-closeout \| Closeout completed rows render done even when frozen detail says ledger planned \| 🟡 Pending Review \(ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered\) \|/,
    'active live planned+covered rows still render Pending Review',
  );
  assert.doesNotMatch(activePlannedText, /✅ Done \(ledger=planned;/);

  const plannedLedgerSnapshot = buildMilestoneCloseoutSnapshot({
    report: plannedLedgerReport,
    bindings: { headHash: 'head-planned-closeout' },
    generatedAt: '2026-07-04T12:30:00.000Z',
  });
  assert.equal(
    plannedLedgerSnapshot.rows[0].status,
    'completed (ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered)',
  );
  const plannedSnapshotBackedReport = buildMilestoneStatusReportFromCloseoutSnapshot(
    plannedLedgerSnapshot,
    { phase: 'DONE' },
  );
  assert.equal(plannedSnapshotBackedReport.milestones[0].status, 'completed');
  assert.equal(plannedSnapshotBackedReport.milestones[0].statusDetail, 'ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered');
  assert.equal(plannedSnapshotBackedReport.milestones[0].ledgerStatus, 'done');
  const plannedSnapshotBackedText = renderMilestoneStatusReport(plannedSnapshotBackedReport);
  assert.match(
    plannedSnapshotBackedText,
    /\| M-planned-closeout \| Closeout completed rows render done even when frozen detail says ledger planned \| ✅ Done \(ledger=planned; checklist=complete; evidence=covered; requiredEvidence=covered\) \|/,
    'DONE closeout-backed completed rows render Done even when frozen ledger detail is planned',
  );
  assert.doesNotMatch(plannedSnapshotBackedText, /🟡 Pending Review \(ledger=planned;/);

  const laterLiveReport = buildMilestoneStatusReport({
    story: closeoutStory,
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-closeout',
        sourceRequirementId: 'REQ-closeout',
        claim: 'Users can read the final solved problem',
        doneMeans: 'A completed risk-free report can be frozen',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-CLOSE'],
        verificationIntentRefs: ['CHK-CLOSE:happy:0'],
        status: 'done',
      }),
    ], 'B-closeout'),
    currentEvidenceBinding: {
      headHash: 'head-later',
      materialHash: 'material-later',
      storyFilesHash: 'story-later',
    },
  });
  assert.deepEqual(laterLiveReport.groups.completed, [], 'later live milestone_status can become stale');
  assert.equal(snapshot.rows[0].milestone, 'M-closeout', 'closeout snapshot preserves the accepted row');
  assert.match(snapshot.rows[0].status, /^completed /, 'closeout snapshot remains the historical completed state');
}

{
  const missingReport = buildMilestoneStatusReport({
    story: story('B-closeout-missing-ledger'),
    checklist: { items: [] },
    milestoneLedger: null,
  });
  assert.throws(
    () => buildMilestoneCloseoutSnapshot({ report: missingReport }),
    /missing milestone ledger.*cannot fabricate success/s,
  );

  const emptyReport = buildMilestoneStatusReport({
    story: story('B-closeout-empty'),
    checklist: { items: [] },
    milestoneLedger: ledger([], 'B-closeout-empty'),
  });
  assert.throws(
    () => buildMilestoneCloseoutSnapshot({ report: emptyReport }),
    /has no rows/,
  );

  const riskyChecklist = {
    items: [
      checklistItem('CHK-RISKY', 'done', [evidence('CHK-RISKY:happy:0')], intent('covered but candidate ledger')),
    ],
  };
  const candidateLedger = ledger([
    milestone({
      id: 'M-risky',
      sourceRequirementId: 'REQ-risky',
      claim: 'Candidate ledgers are risky',
      doneMeans: 'Confirmed ledgers are required',
      requiredEvidence: [],
      checklistRefs: ['CHK-RISKY'],
      verificationIntentRefs: ['CHK-RISKY:happy:0'],
      status: 'done',
    }),
  ], 'B-closeout-risky');
  candidateLedger.state = 'candidate';
  const riskyReport = buildMilestoneStatusReport({
    story: story('B-closeout-risky'),
    checklist: riskyChecklist,
    milestoneLedger: candidateLedger,
  });
  assert.deepEqual(riskyReport.groups.completed, ['M-risky']);
  assert.match(riskyReport.risks.join('\n'), /candidate/);
  assert.throws(
    () => buildMilestoneCloseoutSnapshot({ report: riskyReport }),
    /has risks.*candidate/s,
  );
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
  assert.match(row.risks.join('\n'), /stale storyFilesHash/);
  assert.doesNotMatch(row.risks.join('\n'), /stale materialHash/);
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
    materialHash: 'material-after-metadata-commit',
    storyFilesHash: 'story-current',
  };
  const cl = {
    items: [
      checklistItem('CHK-STORY-FRESH-MATERIAL-DRIFT', 'done', [
        evidence('CHK-STORY-FRESH-MATERIAL-DRIFT:happy:0', 'pass', {
          headHash: 'head-before-metadata-commit',
          materialHash: 'material-before-metadata-commit',
          storyFilesHash: 'story-current',
        }),
      ], intent('story files freshness accepts material-only drift')),
    ],
  };

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-story-fresh-material-drift',
        sourceRequirementId: 'REQ-story-fresh-material-drift',
        claim: 'Material-only drift with matching story files does not block status convergence',
        doneMeans: 'Comparable matching storyFilesHash is blocking-fresh even when materialHash changed',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-STORY-FRESH-MATERIAL-DRIFT'],
        verificationIntentRefs: ['CHK-STORY-FRESH-MATERIAL-DRIFT:happy:0'],
        status: 'done',
      }),
    ]),
    currentEvidenceBinding,
  });

  assert.deepEqual(report.groups.completed, ['M-story-fresh-material-drift']);
  assert.deepEqual(report.groups.current, []);
  assert.deepEqual(report.groups.remaining, []);
  assert.deepEqual(report.risks, []);
  assert.doesNotMatch(report.risks.join('\n'), /stale materialHash/);
  assert.doesNotMatch(report.risks.join('\n'), /stale storyFilesHash/);

  const row = report.milestones.find((candidate) => candidate.id === 'M-story-fresh-material-drift');
  assert.ok(row);
  assert.equal(row.status, 'completed');
  assert.match(row.statusDetail, /evidence=covered/);
  assert.match(row.statusDetail, /requiredEvidence=covered/);
  assert.equal(row.subObjectives.find((sub) => sub.id === 'CHK-STORY-FRESH-MATERIAL-DRIFT:happy:0')?.status, 'covered');
  assert.equal(row.subObjectives.find((sub) => sub.id === 'logic_test')?.status, 'covered');
  assert.deepEqual(row.risks, []);
}

{
  const currentEvidenceBinding = {
    headHash: 'head-current',
    materialHash: 'material-current',
    storyFilesHash: EMPTY_STORY_FILES_HASH,
  };
  const cl = {
    items: [
      checklistItem('CHK-EMPTY-STORY-FILES-HASH', 'done', [
        evidence('CHK-EMPTY-STORY-FILES-HASH:happy:0', 'pass', {
          headHash: 'head-current',
          materialHash: 'material-old',
          storyFilesHash: EMPTY_STORY_FILES_HASH,
        }),
      ], intent('empty story files hash is not an authoritative freshness signal')),
    ],
  };

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-empty-story-files-hash',
        sourceRequirementId: 'REQ-empty-story-files-hash',
        claim: 'Empty story files hash does not hide material drift',
        doneMeans: 'The empty-diff sentinel falls through to strict materialHash freshness',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-EMPTY-STORY-FILES-HASH'],
        verificationIntentRefs: ['CHK-EMPTY-STORY-FILES-HASH:happy:0'],
        status: 'done',
      }),
    ]),
    currentEvidenceBinding,
  });

  assert.deepEqual(report.groups.completed, []);
  assert.deepEqual(report.groups.current, ['M-empty-story-files-hash']);
  assert.deepEqual(report.groups.remaining, []);
  assert.match(report.risks.join('\n'), /stale materialHash/);
  assert.doesNotMatch(report.risks.join('\n'), /stale storyFilesHash/);

  const row = report.milestones.find((candidate) => candidate.id === 'M-empty-story-files-hash');
  assert.ok(row);
  assert.equal(row.status, 'current');
  assert.match(row.statusDetail, /evidence=stale/);
  assert.match(row.statusDetail, /requiredEvidence=missing/);
  assert.equal(row.subObjectives.find((sub) => sub.id === 'CHK-EMPTY-STORY-FILES-HASH:happy:0')?.status, 'stale-evidence');
  assert.equal(row.subObjectives.find((sub) => sub.id === 'logic_test')?.status, 'missing-evidence-kind');
  assert.match(row.risks.join('\n'), /stale materialHash/);
  assert.doesNotMatch(row.risks.join('\n'), /headHash/);
  assert.doesNotMatch(row.risks.join('\n'), /storyFilesHash/);
}

{
  const currentEvidenceBinding = {
    headHash: 'head-current',
    materialHash: 'material-current',
    storyFilesHash: 'story-current',
  };
  const cl = {
    items: [
      checklistItem('CHK-MATERIAL-STALE', 'done', [
        evidence('CHK-MATERIAL-STALE:happy:0', 'pass', {
          headHash: 'head-current',
          materialHash: 'material-old',
        }),
      ], intent('stale material-only evidence must not fall back to head')),
      checklistItem('CHK-STORY-STALE', 'done', [
        evidence('CHK-STORY-STALE:happy:0', 'pass', {
          headHash: 'head-current',
          storyFilesHash: 'story-old',
        }),
      ], intent('stale story-only evidence must not fall back to head')),
      checklistItem('CHK-MATERIAL-FRESH', 'done', [
        evidence('CHK-MATERIAL-FRESH:happy:0', 'pass', {
          headHash: 'head-old',
          materialHash: 'material-current',
        }),
      ], intent('fresh material-only evidence remains covering without storyFilesHash')),
      checklistItem('CHK-STORY-FRESH', 'done', [
        evidence('CHK-STORY-FRESH:happy:0', 'pass', {
          headHash: 'head-old',
          storyFilesHash: 'story-current',
        }),
      ], intent('fresh story-only evidence ignores head drift')),
    ],
  };

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger([
      milestone({
        id: 'M-material-stale',
        sourceRequirementId: 'REQ-material-stale',
        claim: 'Material-only stale evidence must not complete',
        doneMeans: 'Comparable materialHash drift blocks even when storyFilesHash is absent',
        requiredEvidence: [],
        checklistRefs: ['CHK-MATERIAL-STALE'],
        verificationIntentRefs: ['CHK-MATERIAL-STALE:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-story-stale',
        sourceRequirementId: 'REQ-story-stale',
        claim: 'Story-files-only stale evidence must not complete',
        doneMeans: 'Comparable storyFilesHash drift blocks even when materialHash is absent',
        requiredEvidence: [],
        checklistRefs: ['CHK-STORY-STALE'],
        verificationIntentRefs: ['CHK-STORY-STALE:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-material-fresh',
        sourceRequirementId: 'REQ-material-fresh',
        claim: 'Material-only fresh evidence can complete',
        doneMeans: 'Comparable materialHash freshness covers when storyFilesHash is absent',
        requiredEvidence: [],
        checklistRefs: ['CHK-MATERIAL-FRESH'],
        verificationIntentRefs: ['CHK-MATERIAL-FRESH:happy:0'],
        status: 'done',
      }),
      milestone({
        id: 'M-story-fresh',
        sourceRequirementId: 'REQ-story-fresh',
        claim: 'Story-files-only fresh evidence can complete',
        doneMeans: 'Comparable storyFilesHash freshness is checked before head fallback',
        requiredEvidence: [],
        checklistRefs: ['CHK-STORY-FRESH'],
        verificationIntentRefs: ['CHK-STORY-FRESH:happy:0'],
        status: 'done',
      }),
    ]),
    currentEvidenceBinding,
  });

  assert.deepEqual(report.groups.completed, ['M-material-fresh', 'M-story-fresh']);
  assert.deepEqual(report.groups.current, ['M-material-stale']);
  assert.deepEqual(report.groups.remaining, ['M-story-stale']);

  const materialStale = report.milestones.find((candidate) => candidate.id === 'M-material-stale');
  const storyStale = report.milestones.find((candidate) => candidate.id === 'M-story-stale');
  const materialFresh = report.milestones.find((candidate) => candidate.id === 'M-material-fresh');
  const storyFresh = report.milestones.find((candidate) => candidate.id === 'M-story-fresh');
  assert.ok(materialStale);
  assert.ok(storyStale);
  assert.ok(materialFresh);
  assert.ok(storyFresh);

  assert.equal(materialStale.subObjectives.find((sub) => sub.id === 'CHK-MATERIAL-STALE:happy:0')?.status, 'stale-evidence');
  assert.match(materialStale.risks.join('\n'), /stale materialHash/);
  assert.doesNotMatch(materialStale.risks.join('\n'), /headHash/);
  assert.doesNotMatch(materialStale.risks.join('\n'), /storyFilesHash/);

  assert.equal(storyStale.subObjectives.find((sub) => sub.id === 'CHK-STORY-STALE:happy:0')?.status, 'stale-evidence');
  assert.match(storyStale.risks.join('\n'), /stale storyFilesHash/);
  assert.doesNotMatch(storyStale.risks.join('\n'), /headHash/);
  assert.doesNotMatch(storyStale.risks.join('\n'), /materialHash/);

  assert.equal(materialFresh.status, 'completed');
  assert.equal(materialFresh.subObjectives.find((sub) => sub.id === 'CHK-MATERIAL-FRESH:happy:0')?.status, 'covered');
  assert.doesNotMatch(materialFresh.risks.join('\n'), /headHash/);

  assert.equal(storyFresh.status, 'completed');
  assert.equal(storyFresh.subObjectives.find((sub) => sub.id === 'CHK-STORY-FRESH:happy:0')?.status, 'covered');
  assert.doesNotMatch(storyFresh.risks.join('\n'), /headHash/);
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
      ], intent('unsupported required evidence label must be fixed')),
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

  assert.throws(
    () => handlers.milestone_closeout({ storyId: 'B-7ba7', surpriseFlag: true }),
    /read-only.*unexpected keys: surpriseFlag/s,
  );
  assert.equal(readCount, 0, 'unexpected closeout args must be rejected before reading story facts');
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
  const reads = [];
  const writes = [];
  const skipped = captureMilestoneCloseoutSnapshotFromStore({
    readMilestoneLedger() {
      reads.push('ledger');
      return null;
    },
    readStory() {
      reads.push('story');
      throw new Error('readStory should not be called when ledger is missing');
    },
    readChecklist() {
      reads.push('checklist');
      throw new Error('readChecklist should not be called when ledger is missing');
    },
    readSummary() {
      reads.push('summary');
      throw new Error('readSummary should not be called when ledger is missing');
    },
    writeMilestoneCloseout() {
      writes.push('write');
    },
  }, 'B-capture-missing');
  assert.deepEqual(skipped, {
    status: 'skipped',
    reason: 'missing_milestone_ledger',
    message: 'No milestone-ledger.json exists for B-capture-missing; DONE milestone closeout capture skipped.',
  });
  assert.deepEqual(reads, ['ledger']);
  assert.deepEqual(writes, []);
}

{
  const storyId = 'B-capture';
  const captureStory = story(storyId);
  captureStory.phase = 'TEST';
  const captureChecklist = {
    items: [
      checklistItem('CHK-CAPTURE', 'done', [
        evidence('CHK-CAPTURE:happy:0', 'pass', {
          headHash: 'head-capture',
          materialHash: 'material-capture',
          storyFilesHash: 'story-capture',
        }),
      ], intent('capture helper evidence')),
    ],
  };
  const captureLedger = ledger([
    milestone({
      id: 'M-capture',
      sourceRequirementId: 'REQ-capture',
      claim: 'DONE path writes closeout before phase metadata',
      doneMeans: 'Completed risk-free report produces a snapshot',
      requiredEvidence: ['logic_test'],
      checklistRefs: ['CHK-CAPTURE'],
      verificationIntentRefs: ['CHK-CAPTURE:happy:0'],
      status: 'done',
    }),
  ], storyId);
  const writes = [];
  const result = captureMilestoneCloseoutSnapshotFromStore({
    readMilestoneLedger() {
      return captureLedger;
    },
    readStory() {
      return captureStory;
    },
    readChecklist() {
      return captureChecklist;
    },
    readSummary() {
      return null;
    },
    writeMilestoneCloseout(id, snapshot) {
      writes.push({ id, snapshot });
    },
  }, storyId, {
    currentEvidenceBinding: {
      headHash: 'head-capture',
      materialHash: 'material-capture',
      storyFilesHash: 'story-capture',
    },
    generatedAt: '2026-07-04T13:00:00.000Z',
  });
  assert.equal(result.status, 'written');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, storyId);
  assert.equal(writes[0].snapshot.generatedAt, '2026-07-04T13:00:00.000Z');
  assert.equal(writes[0].snapshot.rows[0].milestone, 'M-capture');
  assert.equal(writes[0].snapshot.phase, 'TEST', 'capture happens before DONE phase metadata is written');
}

{
  const storyId = 'B-done-closeout';
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-closeout-'));
  const originalCwd = process.cwd();
  const originalSettlementEnabled = process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED;
  const originalCandidateIngestEnabled = process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED;
  const git = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  try {
    process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED = '0';
    process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED = '0';
    process.chdir(root);
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Milestone Status Test']);
    git(['config', 'user.email', 'milestone-status@example.com']);
    writeJson(join(root, 'lattice.config.json'), {
      scanRoot: '.',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      workflow: { profile: 'light' },
      proofStory: { doneGateMode: 'observe', reviewGateMode: 'observe' },
      flows: { defaults: {}, patterns: [] },
    });
    git(['add', 'lattice.config.json']);
    git(['commit', '-m', 'init']);

    const store = new StoryStore(root);
    const preEvidenceHead = git(['rev-parse', 'HEAD']);
    const preEvidenceMaterialHash = currentMaterialHash(root, 'HEAD', root);
    assert.ok(preEvidenceMaterialHash, 'fixture must be able to compute a material hash');
    const doneStory = {
      ...story(storyId),
      phase: 'TEST',
      priority: 'low',
      currentReviewRound: '2026-07-04T10:00:00.000Z',
    };
    const closeoutChecklist = {
      items: [
        checklistItem('CHK-DONE-CLOSEOUT', 'done', [
          evidence('CHK-DONE-CLOSEOUT:happy:0', 'pass', {
            headHash: preEvidenceHead,
            materialHash: preEvidenceMaterialHash,
          }),
        ], intent('DONE handler evidence')),
      ],
    };
    const docsPromises = [];
    const realMachineTests = [
      {
        featureId: 'milestone-closeout-done-transition',
        transcript: 'Focused temp-repo story_advance DONE fixture reached the closeout capture path.',
      },
    ];
    const closingSelfCheck = {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'The DONE transition fixture has enough signed delivery context for the orchestrator gate.',
    };
    const reviewRound = doneStory.currentReviewRound;

    store.writeStory(storyId, doneStory);
    store.writeChecklist(storyId, closeoutChecklist);
    store.writeMilestoneLedger(storyId, ledger([
      milestone({
        id: 'M-done-closeout',
        sourceRequirementId: 'REQ-done-closeout',
        claim: 'The real DONE transition writes milestone-closeout.json',
        doneMeans: 'A completed milestone snapshot is persisted during story_advance DONE',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-DONE-CLOSEOUT'],
        verificationIntentRefs: ['CHK-DONE-CLOSEOUT:happy:0'],
        status: 'done',
      }),
    ], storyId));
    store.writeTestEvidence(storyId, {
      command: `lattice validate --story=${storyId} --json`,
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-07-04T11:00:00.000Z',
      headHash: preEvidenceHead,
      materialHash: preEvidenceMaterialHash,
    });
    store.writeDeliveryCheck(storyId, {
      storyId,
      checkedAt: '2026-07-04T11:30:00.000Z',
      headHash: preEvidenceHead,
      materialHash: preEvidenceMaterialHash,
      reviewRound,
      agentId: 'lattice-review-delivery',
      docsPromises,
      realMachineTests,
      closingSelfCheck,
      _hash: signDeliveryCheck(
        storyId,
        docsPromises,
        realMachineTests,
        closingSelfCheck,
        reviewRound,
        preEvidenceMaterialHash,
      ),
    });
    git(['add', '.']);
    git(['commit', '-m', 'ready for DONE']);
    assert.equal(git(['status', '--porcelain']), '', 'fixture must be clean before the DONE gate runs');
    assert.equal(currentMaterialHash(root, 'HEAD', root), preEvidenceMaterialHash);
    const doneHead = git(['rev-parse', 'HEAD']);

    const logs = [];
    const handlers = createStoryAdvanceHandlers({
      root,
      scanRoot: root,
      store,
      log: (msg) => logs.push(msg),
    });
    const output = await handlers.story_advance({ storyId, phase: 'DONE' });

    assert.match(output, new RegExp(`Story ${storyId} advanced to DONE`));
    assert.equal(store.readStory(storyId).phase, 'DONE');
    assert.ok(
      existsSync(store.storyFilePath(storyId, 'milestone-closeout.json')),
      'story_advance DONE must persist milestone-closeout.json through transition-orchestrator wiring',
    );
    assert.ok(
      logs.some((line) => line.includes(`milestone closeout snapshot captured for ${storyId}`)),
      'story_advance DONE should report the closeout capture path',
    );
    const snapshot = store.readMilestoneCloseout(storyId);
    assert.ok(snapshot);
    assert.equal(snapshot.schemaVersion, 'proofbound.milestone_closeout.v1');
    assert.equal(snapshot.storyId, storyId);
    assert.equal(snapshot.phase, 'TEST', 'closeout is captured before DONE phase metadata is persisted');
    assert.equal(snapshot.bindings.headHash, doneHead);
    assert.equal(snapshot.bindings.materialHash, preEvidenceMaterialHash);
    assert.equal(snapshot.rows[0].milestone, 'M-done-closeout');
  } finally {
    process.chdir(originalCwd);
    if (originalSettlementEnabled === undefined) {
      delete process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED;
    } else {
      process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED = originalSettlementEnabled;
    }
    if (originalCandidateIngestEnabled === undefined) {
      delete process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED;
    } else {
      process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED = originalCandidateIngestEnabled;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const storyId = 'B-done-closeout-worktree';
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-closeout-worktree-'));
  const mainRoot = join(root, 'main');
  const worktreeRoot = join(root, 'story-worktree');
  const originalCwd = process.cwd();
  const originalSettlementEnabled = process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED;
  const originalCandidateIngestEnabled = process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED;
  const gitMain = (args) => execFileSync('git', args, {
    cwd: mainRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const gitWorktree = (args) => execFileSync('git', args, {
    cwd: worktreeRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  try {
    process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED = '0';
    process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED = '0';
    mkdirSync(mainRoot, { recursive: true });
    gitMain(['init', '-b', 'main']);
    gitMain(['config', 'user.name', 'Milestone Status Test']);
    gitMain(['config', 'user.email', 'milestone-status@example.com']);
    writeJson(join(mainRoot, 'lattice.config.json'), {
      scanRoot: '.',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      workflow: { profile: 'light' },
      proofStory: { doneGateMode: 'observe', reviewGateMode: 'observe' },
      flows: { defaults: {}, patterns: [] },
    });
    gitMain(['add', 'lattice.config.json']);
    gitMain(['commit', '-m', 'init']);
    gitMain(['worktree', 'add', '-b', `story/${storyId}`, worktreeRoot]);

    process.chdir(worktreeRoot);
    const store = new StoryStore(worktreeRoot);
    const preEvidenceHead = gitWorktree(['rev-parse', 'HEAD']);
    const preEvidenceMaterialHash = currentMaterialHash(worktreeRoot, 'HEAD', worktreeRoot);
    assert.ok(preEvidenceMaterialHash, 'worktree fixture must be able to compute a material hash');
    const doneStory = {
      ...story(storyId),
      phase: 'TEST',
      priority: 'low',
      currentReviewRound: '2026-07-04T10:00:00.000Z',
    };
    const closeoutChecklist = {
      items: [
        checklistItem('CHK-DONE-CLOSEOUT', 'done', [
          evidence('CHK-DONE-CLOSEOUT:happy:0', 'pass', {
            headHash: preEvidenceHead,
            materialHash: preEvidenceMaterialHash,
          }),
        ], intent('DONE handler worktree cleanup evidence')),
      ],
    };
    const docsPromises = [];
    const realMachineTests = [
      {
        featureId: 'milestone-closeout-done-worktree-transition',
        transcript: 'Focused worktree story_advance DONE fixture must leave closeout readable from canonical main.',
      },
    ];
    const closingSelfCheck = {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'The worktree DONE transition fixture has enough signed delivery context for the orchestrator gate.',
    };
    const reviewRound = doneStory.currentReviewRound;

    store.writeStory(storyId, doneStory);
    store.writeChecklist(storyId, closeoutChecklist);
    store.writeMilestoneLedger(storyId, ledger([
      milestone({
        id: 'M-done-closeout-worktree',
        sourceRequirementId: 'REQ-done-closeout-worktree',
        claim: 'The real DONE worktree cleanup path preserves milestone-closeout.json in canonical main',
        doneMeans: 'After story_advance DONE removes the story worktree, main-root milestone_closeout reads the frozen snapshot',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-DONE-CLOSEOUT'],
        verificationIntentRefs: ['CHK-DONE-CLOSEOUT:happy:0'],
        status: 'done',
      }),
    ], storyId));
    store.writeTestEvidence(storyId, {
      command: `lattice validate --story=${storyId} --json`,
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-07-04T11:00:00.000Z',
      headHash: preEvidenceHead,
      materialHash: preEvidenceMaterialHash,
    });
    store.writeDeliveryCheck(storyId, {
      storyId,
      checkedAt: '2026-07-04T11:30:00.000Z',
      headHash: preEvidenceHead,
      materialHash: preEvidenceMaterialHash,
      reviewRound,
      agentId: 'lattice-review-delivery',
      docsPromises,
      realMachineTests,
      closingSelfCheck,
      _hash: signDeliveryCheck(
        storyId,
        docsPromises,
        realMachineTests,
        closingSelfCheck,
        reviewRound,
        preEvidenceMaterialHash,
      ),
    });
    gitWorktree(['add', '.']);
    gitWorktree(['commit', '-m', 'ready for DONE in story worktree']);
    assert.equal(gitWorktree(['status', '--porcelain']), '', 'story worktree fixture must be clean before the DONE gate runs');
    assert.equal(gitMain(['status', '--porcelain']), '', 'main worktree fixture must be clean before the DONE merge runs');
    assert.equal(currentMaterialHash(worktreeRoot, 'HEAD', worktreeRoot), preEvidenceMaterialHash);
    const doneHead = gitWorktree(['rev-parse', 'HEAD']);

    const logs = [];
    const handlers = createStoryAdvanceHandlers({
      root: worktreeRoot,
      scanRoot: worktreeRoot,
      store,
      log: (msg) => logs.push(msg),
    });
    const output = await handlers.story_advance({ storyId, phase: 'DONE' });
    process.chdir(mainRoot);

    assert.match(output, new RegExp(`Story ${storyId} advanced to DONE`));
    assert.ok(!existsSync(worktreeRoot), 'story_advance DONE should remove the story worktree after merging to main');
    assert.ok(
      logs.some((line) => line.includes(`milestone closeout snapshot captured for ${storyId}`)),
      'story_advance DONE should report the closeout capture path before cleanup',
    );
    const mainStore = new StoryStore(mainRoot);
    const snapshot = mainStore.readMilestoneCloseout(storyId);
    assert.ok(snapshot, 'canonical main must retain milestone-closeout.json after worktree cleanup');
    assert.equal(snapshot.schemaVersion, 'proofbound.milestone_closeout.v1');
    assert.equal(snapshot.storyId, storyId);
    assert.equal(snapshot.phase, 'TEST', 'closeout is captured before DONE phase metadata is persisted');
    assert.equal(snapshot.bindings.headHash, doneHead);
    assert.equal(snapshot.bindings.materialHash, preEvidenceMaterialHash);
    assert.equal(snapshot.rows[0].milestone, 'M-done-closeout-worktree');

    const closeoutJson = JSON.parse(execFileSync(process.execPath, [
      cliPath,
      'milestone_closeout',
      '--root',
      mainRoot,
      '--storyId',
      storyId,
      '--format=json',
    ], { cwd: mainRoot, encoding: 'utf8' }));
    assert.equal(closeoutJson.schemaVersion, 'proofbound.milestone_closeout.v1');
    assert.equal(closeoutJson.rows[0].milestone, 'M-done-closeout-worktree');
    assert.equal(
      gitMain(['status', '--porcelain', '--untracked-files=no']),
      '',
      'DONE merge cleanup should leave canonical main without tracked dirt',
    );
  } finally {
    process.chdir(originalCwd);
    if (originalSettlementEnabled === undefined) {
      delete process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED;
    } else {
      process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED = originalSettlementEnabled;
    }
    if (originalCandidateIngestEnabled === undefined) {
      delete process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED;
    } else {
      process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED = originalCandidateIngestEnabled;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const storyId = 'B-capture-incomplete';
  const writes = [];
  assert.throws(
    () => captureMilestoneCloseoutSnapshotFromStore({
      readMilestoneLedger() {
        return ledger([
          milestone({
            id: 'M-incomplete',
            sourceRequirementId: 'REQ-incomplete',
            claim: 'Incomplete rows block closeout',
            doneMeans: 'Missing evidence cannot be frozen as success',
            requiredEvidence: [],
            checklistRefs: ['CHK-INCOMPLETE'],
            verificationIntentRefs: ['CHK-INCOMPLETE:happy:0'],
            status: 'done',
          }),
        ], storyId);
      },
      readStory() {
        return story(storyId);
      },
      readChecklist() {
        return {
          items: [
            checklistItem('CHK-INCOMPLETE', 'done', [], intent('missing evidence')),
          ],
        };
      },
      readSummary() {
        return null;
      },
      writeMilestoneCloseout() {
        writes.push('write');
      },
    }, storyId),
    /incomplete milestone rows: M-incomplete=current/,
  );
  assert.deepEqual(writes, [], 'incomplete capture must fail before writing a closeout');
}

{
  const storyId = 'B-done-cli-append';
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-cli-append-'));
  const mainRoot = join(root, 'main');
  const worktreeRoot = join(root, 'story-worktree');
  const originalSettlementEnabled = process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED;
  const originalCandidateIngestEnabled = process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED;
  const gitMain = (args) => execFileSync('git', args, {
    cwd: mainRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const gitWorktree = (args) => execFileSync('git', args, {
    cwd: worktreeRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  try {
    process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED = '0';
    process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED = '0';
    mkdirSync(mainRoot, { recursive: true });
    gitMain(['init', '-b', 'main']);
    gitMain(['config', 'user.name', 'Milestone Status Test']);
    gitMain(['config', 'user.email', 'milestone-status@example.com']);
    writeJson(join(mainRoot, 'lattice.config.json'), {
      scanRoot: '.',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      workflow: { profile: 'light' },
      proofStory: { doneGateMode: 'observe', reviewGateMode: 'observe' },
      flows: { defaults: {}, patterns: [] },
    });
    writeFileSync(join(mainRoot, '.gitignore'), '**/owner-lease.json\n', 'utf8');
    gitMain(['add', 'lattice.config.json', '.gitignore']);
    gitMain(['commit', '-m', 'init']);
    gitMain(['worktree', 'add', '-b', `story/${storyId}`, worktreeRoot]);

    const store = new StoryStore(worktreeRoot);
    const preEvidenceHead = gitWorktree(['rev-parse', 'HEAD']);
    const preEvidenceMaterialHash = currentMaterialHash(worktreeRoot, 'HEAD', worktreeRoot);
    assert.ok(preEvidenceMaterialHash, 'CLI worktree fixture must be able to compute a material hash');
    const doneStory = {
      ...story(storyId),
      phase: 'TEST',
      priority: 'low',
      currentReviewRound: '2026-07-04T10:00:00.000Z',
      worktree: {
        path: worktreeRoot,
        branch: `story/${storyId}`,
        createdAt: '2026-07-04T09:00:00.000Z',
      },
    };
    const closeoutChecklist = {
      items: [
        checklistItem('CHK-DONE-CLI-APPEND', 'done', [
          evidence('CHK-DONE-CLI-APPEND:happy:0', 'pass', {
            headHash: preEvidenceHead,
            materialHash: preEvidenceMaterialHash,
          }),
        ], intent('DONE CLI append evidence')),
      ],
    };
    const docsPromises = [];
    const realMachineTests = [
      {
        featureId: 'milestone-status-done-cli-append',
        transcript: 'Built CLI story_advance DONE fixture removed the story worktree and still printed milestone_status.',
      },
    ];
    const closingSelfCheck = {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'The runCli DONE fixture has enough signed delivery context for the orchestrator gate.',
    };
    const reviewRound = doneStory.currentReviewRound;

    store.writeStory(storyId, doneStory);
    store.writeChecklist(storyId, closeoutChecklist);
    store.writeMilestoneLedger(storyId, ledger([
      milestone({
        id: 'M-done-cli-append',
        sourceRequirementId: 'REQ-done-cli-append',
        claim: 'The built CLI appends milestone status after DONE worktree cleanup',
        doneMeans: 'story_advance DONE stdout includes milestone_status even after the story worktree is removed',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-DONE-CLI-APPEND'],
        verificationIntentRefs: ['CHK-DONE-CLI-APPEND:happy:0'],
        status: 'done',
      }),
    ], storyId));
    store.writeTestEvidence(storyId, {
      command: `lattice validate --story=${storyId} --json`,
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-07-04T11:00:00.000Z',
      headHash: preEvidenceHead,
      materialHash: preEvidenceMaterialHash,
    });
    store.writeDeliveryCheck(storyId, {
      storyId,
      checkedAt: '2026-07-04T11:30:00.000Z',
      headHash: preEvidenceHead,
      materialHash: preEvidenceMaterialHash,
      reviewRound,
      agentId: 'lattice-review-delivery',
      docsPromises,
      realMachineTests,
      closingSelfCheck,
      _hash: signDeliveryCheck(
        storyId,
        docsPromises,
        realMachineTests,
        closingSelfCheck,
        reviewRound,
        preEvidenceMaterialHash,
      ),
    });
    gitWorktree(['add', '.']);
    gitWorktree(['commit', '-m', 'ready for CLI DONE append']);
    assert.equal(gitWorktree(['status', '--porcelain']), '', 'CLI story worktree fixture must be clean before DONE');
    assert.equal(gitMain(['status', '--porcelain']), '', 'CLI main fixture must be clean before DONE');
    assert.equal(currentMaterialHash(worktreeRoot, 'HEAD', worktreeRoot), preEvidenceMaterialHash);

    const result = spawnSync(process.execPath, [
      cliPath,
      'story_advance',
      '--root',
      worktreeRoot,
      '--storyId',
      storyId,
      '--phase',
      'DONE',
    ], { cwd: worktreeRoot, encoding: 'utf8' });

    assert.equal(result.status, 0, `story_advance DONE should succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(
      !existsSync(worktreeRoot),
      `runCli story_advance DONE should remove the story worktree\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, new RegExp(`Story ${storyId} advanced to DONE`));
    assert.match(result.stdout, new RegExp(`Milestone Status - ${storyId}`));
    assert.match(result.stdout, /\| M-done-cli-append \| The built CLI appends milestone status after DONE worktree cleanup \|/);
    assert.doesNotMatch(result.stdout, /milestone ledger required/);
  } finally {
    if (originalSettlementEnabled === undefined) {
      delete process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED;
    } else {
      process.env.PLAYBOOK_DONE_SETTLEMENT_ENABLED = originalSettlementEnabled;
    }
    if (originalCandidateIngestEnabled === undefined) {
      delete process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED;
    } else {
      process.env.PLAYBOOK_DONE_CANDIDATE_INGEST_ENABLED = originalCandidateIngestEnabled;
    }
    rmSync(root, { recursive: true, force: true });
  }
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
    const cliStory = story(storyId);
    const cliChecklist = {
      items: [
        checklistItem('CHK-CLI', 'done', [evidence('CHK-CLI:happy:0')], intent('CLI-covered intent')),
      ],
    };
    const cliLedger = ledger([
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
    ], storyId);
    writeJson(join(storyDir, 'index.json'), cliStory);
    writeJson(join(storyDir, 'checklist.json'), cliChecklist);
    writeJson(join(storyDir, 'milestone-ledger.json'), cliLedger);

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

    const missingCloseout = execFileSync(process.execPath, [
      cliPath,
      'milestone_closeout',
      '--root',
      root,
      '--storyId',
      storyId,
    ], { cwd: root, encoding: 'utf8' });
    assertCloseoutTextContract(missingCloseout);
    assert.match(missingCloseout, /Snapshot: missing/);
    assert.match(missingCloseout, /No milestone-closeout\.json snapshot exists for B-cli-ms/);
    assert.match(missingCloseout, /Next action:/);

    const missingCloseoutJson = JSON.parse(execFileSync(process.execPath, [
      cliPath,
      'milestone_closeout',
      '--root',
      root,
      '--storyId',
      storyId,
      '--json',
    ], { cwd: root, encoding: 'utf8' }));
    assert.equal(missingCloseoutJson.schemaVersion, 'proofbound.milestone_closeout_missing.v1');
    assert.equal(missingCloseoutJson.snapshotPresent, false);
    assert.match(missingCloseoutJson.diagnostic, /No milestone-closeout\.json snapshot exists/);

    const cliReport = buildMilestoneStatusReport({
      story: cliStory,
      checklist: cliChecklist,
      milestoneLedger: cliLedger,
    });
    const cliSnapshot = buildMilestoneCloseoutSnapshot({
      report: cliReport,
      bindings: { headHash: 'head-cli', materialHash: 'material-cli', storyFilesHash: 'story-cli' },
      generatedAt: '2026-07-04T14:00:00.000Z',
    });
    writeJson(join(storyDir, 'milestone-closeout.json'), cliSnapshot);

    const closeoutText = execFileSync(process.execPath, [
      cliPath,
      'milestone_closeout',
      '--root',
      root,
      '--storyId',
      storyId,
    ], { cwd: root, encoding: 'utf8' });
    assertCloseoutTextContract(closeoutText);
    assert.match(closeoutText, /Generated: 2026-07-04T14:00:00\.000Z/);
    assert.match(closeoutText, /Bindings: headHash=head-cli materialHash=material-cli storyFilesHash=story-cli/);
    assert.match(closeoutText, /\| M-cli \| completed \(ledger=covered; checklist=complete; evidence=covered; requiredEvidence=covered\) \| CLI report milestone \|/);

    const closeoutJson = JSON.parse(execFileSync(process.execPath, [
      cliPath,
      'milestone_closeout',
      '--root',
      root,
      '--storyId',
      storyId,
      '--format=json',
    ], { cwd: root, encoding: 'utf8' }));
    assert.equal(closeoutJson.schemaVersion, 'proofbound.milestone_closeout.v1');
    assert.equal(closeoutJson.sourceReport.digest, milestoneStatusReportDigest(cliReport));
    assert.equal(closeoutJson.rows[0].milestone, 'M-cli');

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

    const unknownCloseoutFlag = spawnSync(process.execPath, [
      cliPath,
      'milestone_closeout',
      '--root',
      root,
      '--storyId',
      storyId,
      '--format=json',
      '--surpriseFlag=true',
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(unknownCloseoutFlag.status, 0, 'CLI parser must reject unknown milestone_closeout flags');
    assert.equal(unknownCloseoutFlag.stdout, '', 'unknown closeout flags must fail before story facts are printed');
    assert.match(unknownCloseoutFlag.stderr, /Argument validation failed[\s\S]*surpriseFlag/);

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

        const rejectedCloseoutBeforeActiveRead = spawnSync(process.execPath, [
          cliPath,
          'milestone_closeout',
          '--root',
          activeRoot,
          '--storyId',
          activeStoryId,
          '--surpriseFlag=true',
        ], { cwd: activeRoot, encoding: 'utf8', timeout: 2000 });
        assert.notEqual(rejectedCloseoutBeforeActiveRead.error?.code, 'ETIMEDOUT', 'malformed milestone_closeout args must reject before active-story metadata reads');
        assert.notEqual(rejectedCloseoutBeforeActiveRead.status, 0, 'malformed milestone_closeout args must be rejected');
        assert.match(rejectedCloseoutBeforeActiveRead.stderr, /Argument validation failed[\s\S]*surpriseFlag/);
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
      for (const command of ['milestone_status', 'milestone_closeout']) {
        const rejected = spawnSync(process.execPath, [
          cliPath,
          command,
          '--root',
          root,
          '--storyId',
          storyId,
          `--${flag}=true`,
        ], { cwd: root, encoding: 'utf8' });
        assert.notEqual(rejected.status, 0, `CLI parser must reject ${flag} for ${command}`);
        assert.match(rejected.stderr, new RegExp(`Argument validation failed[\\s\\S]*${flag}`));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-milestone-status-done-snapshot-'));
  const git = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  try {
    writeTestConfig(root);
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Milestone Status Test']);
    git(['config', 'user.email', 'milestone-status@example.com']);
    git(['add', 'lattice.config.json']);
    git(['commit', '-m', 'init']);

    const frozenBinding = {
      headHash: 'head-frozen',
      materialHash: 'material-frozen',
    };
    const completeChecklist = (itemId, intentText) => ({
      items: [
        checklistItem(itemId, 'done', [
          evidence(`${itemId}:happy:0`, 'pass', frozenBinding),
        ], intent(intentText)),
      ],
    });
    const staleChecklist = (itemId, intentText) => ({
      items: [
        checklistItem(itemId, 'done', [
          evidence(`${itemId}:happy:0`, 'pass', frozenBinding),
        ], intent(intentText)),
      ],
    });
    const doneMilestone = (id, itemId, claim) => milestone({
      id,
      sourceRequirementId: `REQ-${id}`,
      claim,
      doneMeans: 'DONE milestone_status uses the frozen closeout status report',
      requiredEvidence: ['logic_test'],
      checklistRefs: [itemId],
      verificationIntentRefs: [`${itemId}:happy:0`],
      status: 'done',
    });

    const doneStoryId = 'B-cli-done-snapshot-status';
    const doneStoryDir = join(root, '.lattice', 'story', 'actives', doneStoryId);
    const doneItemId = 'CHK-DONE-SNAPSHOT';
    const doneLedger = ledger([
      doneMilestone(
        'M-done-snapshot',
        doneItemId,
        'DONE milestone_status reports the frozen closeout row',
      ),
    ], doneStoryId);
    const frozenReport = buildMilestoneStatusReport({
      story: { ...story(doneStoryId), phase: 'TEST' },
      checklist: completeChecklist(doneItemId, 'frozen DONE closeout evidence'),
      milestoneLedger: doneLedger,
      currentEvidenceBinding: frozenBinding,
    });
    assert.deepEqual(frozenReport.groups, { completed: ['M-done-snapshot'], current: [], remaining: [] });
    const frozenSnapshot = buildMilestoneCloseoutSnapshot({
      report: frozenReport,
      bindings: frozenBinding,
      generatedAt: '2026-07-04T15:00:00.000Z',
    });
    mkdirSync(doneStoryDir, { recursive: true });
    writeJson(join(doneStoryDir, 'index.json'), { ...story(doneStoryId), phase: 'DONE' });
    writeJson(join(doneStoryDir, 'checklist.json'), staleChecklist(doneItemId, 'stale live evidence after cleanup'));
    writeJson(join(doneStoryDir, 'milestone-ledger.json'), doneLedger);
    writeJson(join(doneStoryDir, 'milestone-closeout.json'), frozenSnapshot);

    const liveStaleReport = buildMilestoneStatusReport({
      story: { ...story(doneStoryId), phase: 'DONE' },
      checklist: staleChecklist(doneItemId, 'stale live evidence after cleanup'),
      milestoneLedger: doneLedger,
      currentEvidenceBinding: {
        headHash: 'head-current',
        materialHash: 'material-current',
      },
    });
    assert.deepEqual(liveStaleReport.groups, { completed: [], current: ['M-done-snapshot'], remaining: [] });
    assert.match(liveStaleReport.milestones[0].statusDetail, /evidence=stale/);

    const activeStoryId = 'B-cli-active-live-status';
    const activeStoryDir = join(root, '.lattice', 'story', 'actives', activeStoryId);
    const activeItemId = 'CHK-ACTIVE-SNAPSHOT';
    const activeLedger = ledger([
      doneMilestone(
        'M-active-snapshot',
        activeItemId,
        'Active milestone_status ignores closeout snapshots',
      ),
    ], activeStoryId);
    const activeFrozenReport = buildMilestoneStatusReport({
      story: { ...story(activeStoryId), phase: 'TEST' },
      checklist: completeChecklist(activeItemId, 'active snapshot should be ignored'),
      milestoneLedger: activeLedger,
      currentEvidenceBinding: frozenBinding,
    });
    const activeSnapshot = buildMilestoneCloseoutSnapshot({
      report: activeFrozenReport,
      bindings: frozenBinding,
      generatedAt: '2026-07-04T15:05:00.000Z',
    });
    mkdirSync(activeStoryDir, { recursive: true });
    writeJson(join(activeStoryDir, 'index.json'), { ...story(activeStoryId), phase: 'DEV' });
    writeJson(join(activeStoryDir, 'checklist.json'), staleChecklist(activeItemId, 'stale active live evidence'));
    writeJson(join(activeStoryDir, 'milestone-ledger.json'), activeLedger);
    writeJson(join(activeStoryDir, 'milestone-closeout.json'), activeSnapshot);

    const missingCloseoutStoryId = 'B-cli-done-missing-closeout-status';
    const missingCloseoutStoryDir = join(root, '.lattice', 'story', 'actives', missingCloseoutStoryId);
    const missingItemId = 'CHK-MISSING-CLOSEOUT';
    const missingLedger = ledger([
      doneMilestone(
        'M-missing-closeout',
        missingItemId,
        'DONE milestone_status without closeout remains live and fail-closed',
      ),
    ], missingCloseoutStoryId);
    mkdirSync(missingCloseoutStoryDir, { recursive: true });
    writeJson(join(missingCloseoutStoryDir, 'index.json'), { ...story(missingCloseoutStoryId), phase: 'DONE' });
    writeJson(join(missingCloseoutStoryDir, 'checklist.json'), staleChecklist(missingItemId, 'stale missing-closeout live evidence'));
    writeJson(join(missingCloseoutStoryDir, 'milestone-ledger.json'), missingLedger);

    git(['add', '.']);
    git(['commit', '-m', 'milestone status snapshot fixtures']);

    const doneText = execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      doneStoryId,
    ], { cwd: root, encoding: 'utf8' });
    assert.match(doneText, new RegExp(`Milestone Status - ${doneStoryId}`));
    assert.match(doneText, /Completed\n\| Milestone \| Purpose \| Status:/);
    assert.match(doneText, /\| M-done-snapshot \| DONE milestone_status reports the frozen closeout row \| ✅ Done \(ledger=done; checklist=complete; evidence=covered; requiredEvidence=covered\) \|/);
    assert.doesNotMatch(doneText, /🔴 Blocked/);
    assert.doesNotMatch(doneText, /stale-evidence/);
    assert.doesNotMatch(doneText, /evidence=stale/);

    const doneJson = JSON.parse(execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      doneStoryId,
      '--json',
    ], { cwd: root, encoding: 'utf8' }));
    assert.equal(doneJson.schemaVersion, 'proofbound.milestone_status.v1');
    assert.equal(doneJson.phase, 'DONE');
    assert.deepEqual(doneJson.groups, { completed: ['M-done-snapshot'], current: [], remaining: [] });
    assert.equal(doneJson.milestones[0].status, 'completed');
    assert.equal(doneJson.milestones[0].ledgerStatus, 'done');
    assert.equal(doneJson.milestones[0].evidenceRefs[0].status, 'pass');

    const activeText = execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      activeStoryId,
    ], { cwd: root, encoding: 'utf8' });
    assert.match(activeText, /\| M-active-snapshot \| Active milestone_status ignores closeout snapshots \| 🔴 Blocked \(ledger=done; checklist=complete; evidence=stale; requiredEvidence=missing\) \|/);
    const activeJson = JSON.parse(execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      activeStoryId,
      '--json',
    ], { cwd: root, encoding: 'utf8' }));
    assert.deepEqual(activeJson.groups, { completed: [], current: ['M-active-snapshot'], remaining: [] });

    const missingCloseoutText = execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      missingCloseoutStoryId,
    ], { cwd: root, encoding: 'utf8' });
    assert.match(missingCloseoutText, /\| M-missing-closeout \| DONE milestone_status without closeout remains live and fail-closed \| 🔴 Blocked \(ledger=done; checklist=complete; evidence=stale; requiredEvidence=missing\) \|/);
    const missingCloseoutJson = JSON.parse(execFileSync(process.execPath, [
      cliPath,
      'milestone_status',
      '--root',
      root,
      '--storyId',
      missingCloseoutStoryId,
      '--json',
    ], { cwd: root, encoding: 'utf8' }));
    assert.deepEqual(missingCloseoutJson.groups, { completed: [], current: ['M-missing-closeout'], remaining: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('ok milestone-status');

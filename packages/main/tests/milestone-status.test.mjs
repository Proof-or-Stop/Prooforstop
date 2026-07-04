/**
 * B-7ba7 — milestone_status read-only progress report.
 *
 * Run after build:
 *
 *   npm --prefix packages/main run build
 *   node packages/main/tests/milestone-status.test.mjs
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
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

function evidence(intentRef, result = 'pass') {
  return {
    intentRef,
    kind: 'logic_test',
    result,
    note: `${intentRef} ${result}`,
    command: `node ${intentRef}.test.mjs`,
    timestamp: '2026-07-04T00:00:00.000Z',
  };
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

{
  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: { items: [] },
    milestoneLedger: null,
  });

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
      checklistItem('CHK-001', 'done', [evidence('CHK-001:happy:0')]),
      checklistItem('CHK-002', 'in_progress', [], {
        happy: [{ desc: 'current intent', type: 'logic' }],
        edge: [],
        adversarial: [],
      }),
      checklistItem('CHK-003', 'pending'),
    ],
  };
  const ledger = {
    schemaVersion: 'proofstory.milestone_ledger.v1',
    storyId: 'B-7ba7',
    state: 'confirmed',
    ledgerHash: 'abc123',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    milestones: [
      {
        id: 'M1',
        sourceRequirementId: 'REQ-1',
        claim: 'Finished via checklist evidence',
        doneMeans: 'Checklist done with evidence on the item',
        requiredEvidence: [],
        checklistRefs: ['CHK-001'],
        verificationIntentRefs: [],
        status: 'covered',
      },
      {
        id: 'M2',
        sourceRequirementId: 'REQ-2',
        claim: 'Current incomplete milestone',
        doneMeans: 'Checklist item and verification evidence complete',
        requiredEvidence: ['logic_test'],
        checklistRefs: ['CHK-002'],
        verificationIntentRefs: ['CHK-002:happy:0'],
        status: 'planned',
      },
      {
        id: 'M3',
        sourceRequirementId: 'REQ-3',
        claim: 'Later milestone',
        doneMeans: 'Pending work complete',
        requiredEvidence: [],
        checklistRefs: ['CHK-003'],
        verificationIntentRefs: [],
        status: 'planned',
      },
      {
        id: 'M4',
        sourceRequirementId: 'REQ-4',
        claim: 'Not applicable milestone',
        doneMeans: 'Explicitly not applicable',
        requiredEvidence: [],
        checklistRefs: [],
        verificationIntentRefs: [],
        status: 'not_applicable',
      },
    ],
  };

  const report = buildMilestoneStatusReport({
    story: story(),
    checklist: cl,
    milestoneLedger: ledger,
  });

  assert.deepEqual(report.groups.completed, ['M1', 'M4']);
  assert.deepEqual(report.groups.current, ['M2']);
  assert.deepEqual(report.groups.remaining, ['M3']);
  assert.equal(report.milestones.find((row) => row.id === 'M1')?.evidenceRefs[0]?.intentRef, 'CHK-001:happy:0');
  assert.match(report.risks.join('\n'), /M2: Checklist item CHK-002 is in_progress/);

  const text = renderMilestoneStatusReport(report);
  assertTextContract(text);
  assert.match(text, /\| M1 \| Finished via checklist evidence \|/);
  assert.match(text, /CHK-001:happy:0 \[pass\/logic_test\]/);
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
    () => handlers.milestone_status({ storyId: 'B-7ba7', runCommands: true }),
    /read-only.*runCommands/s,
  );
  assert.equal(readCount, 0, 'mutation-like flags must be rejected before reading story facts');
}

{
  const handlers = createMilestoneStatusHandlers({
    root: '/tmp/lattice-milestone-status',
    scanRoot: '/tmp/lattice-milestone-status',
    store: {
      readStory: () => story(),
      readChecklist: () => ({ items: [] }),
      readMilestoneLedger: () => null,
      readSummary: () => null,
    },
  });

  const report = handlers.milestone_status({ storyId: 'B-7ba7', json: true });
  assert.equal(report.mode.readOnly, true);
  assert.equal(report.mode.runCommands, false);
}

console.log('ok milestone-status');

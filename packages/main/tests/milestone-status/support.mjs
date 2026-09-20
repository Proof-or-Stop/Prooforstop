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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { fileURLToPath } from 'node:url';


const distRoot = fileURLToPath(new URL('../../dist/', import.meta.url));

const cliPath = join(distRoot, 'cli.js');

const {
  buildMilestoneCloseoutSnapshot,
  buildMilestoneStatusReport,
  buildMilestoneStatusReportFromCloseoutSnapshot,
  milestoneStatusReportDigest,
  renderMilestoneCloseoutSnapshot,
  renderMilestoneStatusReport,
  renderChecklistDerivedLedger,
} = await import(join(distRoot, 'core/milestone-status.js'));

const {
  EMPTY_STORY_FILES_HASH,
  currentMaterialHash,
} = await import(join(distRoot, 'core/evidence-freshness.js'));

const { signDeliveryCheck } = await import(join(distRoot, 'core/delivery-check-hash.js'));

const { evaluateDoneIntentEquivalence } = await import(join(distRoot, 'core/proofstory.js'));

const { StoryStore } = await import(join(distRoot, 'core/store.js'));

const {
  captureMilestoneCloseoutSnapshotFromStore,
  createMilestoneStatusHandlers,
} = await import(join(distRoot, 'handlers/milestone-status.js'));

const { createStoryAdvanceHandlers } = await import(join(distRoot, 'handlers/story-advance.js'));

const { createPlaybookRuntimeMemoryHandlers } = await import(join(distRoot, 'handlers/playbook-runtime-memory.js'));


/**
 * B-a7c5 CHK-003: canFinishGuard now ALSO requires a dev_memory_finish_decision
 * record. `.proof-or-stop/dev-memory/` is git-tracked (unlike `.proof-or-stop/story/`, which
 * is materialHash-EXCLUDED), so this write must be committed BEFORE a fixture
 * computes/signs its `preEvidenceMaterialHash` — never after — so it cannot
 * retroactively invalidate a delivery-check/test-evidence materialHash binding
 * already signed against an earlier HEAD.
 */
function satisfyDevMemoryFinishDecisionAndCommit(root, store, storyId, git) {
  createPlaybookRuntimeMemoryHandlers({ store, root, scanRoot: root })
    .dev_memory_finish_decision({ storyId, decision: 'no-reusable-lesson', reason: 'milestone-status.test.mjs fixture; no lesson to capture' });
  if (git(['status', '--porcelain', '--', '.proof-or-stop/dev-memory'])) {
    git(['add', '.proof-or-stop/dev-memory']);
    git(['commit', '-m', 'dev-memory finish decision']);
  }
}


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
  writeJson(join(root, 'proof-or-stop.config.json'), {
    scanRoot: '.',
    testsDir: 'tests',
    fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
    flows: { defaults: {}, patterns: [] },
  });
}


function validStoryBackground(label) {
  return [
    '## Trigger Event',
    `2026-07-07 B-auto-ledger ${label} verifies automatic milestone ledger creation at explicit planning write boundaries only.`,
    '',
    '## Key Insights',
    'The ledger rows must come from structured milestone input, not from prose, checklist titles, or read-only reports.',
    '',
    '## Solution Tradeoffs',
    'Persist a complete candidate ledger in one write so hashes and later intent-collision confirmation stay mechanical.',
    '',
    '## Conversational Texture',
    'The operator wants the planning workflow to remove a manual step without turning status views into hidden repair commands.',
  ].join('\n');
}


function runJsonCommand(root, command, payload) {
  const stdout = execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    command,
    JSON.stringify({ ...payload, json: true }),
  ], { cwd: root, encoding: 'utf8' });
  return JSON.parse(stdout);
}


function runTextCommand(root, command, payload) {
  return execFileSync(process.execPath, [
    cliPath,
    '--root',
    root,
    command,
    JSON.stringify(payload),
  ], { cwd: root, encoding: 'utf8' });
}


function storyDirs(root) {
  const dir = join(root, '.proof-or-stop', 'story', 'actives');
  return existsSync(dir) ? readdirSync(dir).filter((entry) => entry.startsWith('B-')).sort() : [];
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
    'observability only',
    'NOT a lifecycle DONE',
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
    'observability only',
    'NOT a lifecycle DONE',
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
export { assert, execFileSync, spawnSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, tmpdir, join, fileURLToPath, distRoot, cliPath, buildMilestoneCloseoutSnapshot, buildMilestoneStatusReport, buildMilestoneStatusReportFromCloseoutSnapshot, milestoneStatusReportDigest, renderMilestoneCloseoutSnapshot, renderMilestoneStatusReport, renderChecklistDerivedLedger, EMPTY_STORY_FILES_HASH, currentMaterialHash, signDeliveryCheck, evaluateDoneIntentEquivalence, StoryStore, captureMilestoneCloseoutSnapshotFromStore, createMilestoneStatusHandlers, createStoryAdvanceHandlers, createPlaybookRuntimeMemoryHandlers, satisfyDevMemoryFinishDecisionAndCommit, story, intent, checklistItem, evidence, ledger, writeTestConfig, validStoryBackground, runJsonCommand, runTextCommand, storyDirs, milestone, writeJson, assertTextContract, assertCloseoutTextContract, assertReportShape, assertRowShape, assertEvidenceRefShape };

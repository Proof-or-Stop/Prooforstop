#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import {
  PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
  evaluateParentRoadmapClaim,
  evaluateParentRoadmapLedger,
  type ParentRoadmapLedger,
  type ParentRoadmapRow,
  type ParentRollupResult,
} from '../core/parent-roadmap-totality.js';

const GROUP_ID = 'G05';
const REQUIRED_ROW_COUNT = 15;
const CLOSED_ROW_COUNT = 12;
const EVALUATED_AT = '2026-07-01T00:00:00.000Z';
const CURRENT_HEAD_HASH = 'g05-head-hash';
const CURRENT_MATERIAL_HASH = 'g05-material-hash';
const CURRENT_STORY_FILES_HASH = 'g05-story-files-hash';
const SMOKE_COMMAND = 'node packages/main/dist/tasks/parent-roadmap-large-ledger-g05-baseline-smoke.js';
const BASELINE_DOC = 'docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md';
const LOCAL_CLAIM_BOUNDARY = 'Local G05 deterministic ledger proof only; deferred rows remain visible and are not runtime closure.';

const milestoneMeanings = [
  'Original intent snapshot preserved',
  'Milestone ledger complete',
  'Intent coverage check',
  'Scope shrinkage guard',
  'Child/story slicing boundary',
  'Acceptance contract binding',
  'Machine evidence present',
  'Evidence freshness',
  'Negative control',
  'Review assurance',
  'Delivery check',
  'Claim boundary',
  'DONE intent equivalence',
  'Rollup status',
  'Handoff summary',
] as const;

assert.equal(milestoneMeanings.length, REQUIRED_ROW_COUNT, 'G05 milestone template must stay at exactly 15 rows');

function rowId(index: number): string {
  return `${GROUP_ID}-M${String(index + 1).padStart(2, '0')}`;
}

function requiredRowIds(): string[] {
  return Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => rowId(index));
}

function buildClosedRow(index: number): ParentRoadmapRow {
  const id = rowId(index);
  return {
    rowId: id,
    title: `${id} ${milestoneMeanings[index]} closed evidence`,
    intentText: `${GROUP_ID} deferred-row baseline closed evidence for ${milestoneMeanings[index]}.`,
    status: 'closed-by-existing-evidence',
    childStoryId: 'B-d278',
    closureEvidence: [
      {
        kind: 'deterministic_smoke',
        ref: `B-d278:${id}:parent-roadmap-large-ledger-g05-baseline-smoke`,
        result: 'pass',
        command: SMOKE_COMMAND,
        artifactRef: `${BASELINE_DOC}#g05`,
        headHash: CURRENT_HEAD_HASH,
        materialHash: CURRENT_MATERIAL_HASH,
        storyFilesHash: CURRENT_STORY_FILES_HASH,
        observedAt: EVALUATED_AT,
      },
    ],
    materialRefs: [
      BASELINE_DOC,
      'packages/main/src/tasks/parent-roadmap-large-ledger-g05-baseline-smoke.ts',
      'packages/main/src/core/parent-roadmap-totality.ts',
    ],
    updatedAt: EVALUATED_AT,
    headHash: CURRENT_HEAD_HASH,
    materialHash: CURRENT_MATERIAL_HASH,
    storyFilesHash: CURRENT_STORY_FILES_HASH,
    claimBoundary: LOCAL_CLAIM_BOUNDARY,
  };
}

function buildDeferredRow(index: number): ParentRoadmapRow {
  const id = rowId(index);
  return {
    rowId: id,
    title: `${id} ${milestoneMeanings[index]} human-approved deferral`,
    intentText: `${GROUP_ID} valid deferral baseline for ${milestoneMeanings[index]}.`,
    status: 'deferred-with-human-approval',
    closureEvidence: [],
    materialRefs: [BASELINE_DOC],
    updatedAt: EVALUATED_AT,
    claimBoundary: LOCAL_CLAIM_BOUNDARY,
    deferral: {
      approvedBy: 'human-reviewer',
      approvedAt: EVALUATED_AT,
      reason: `${id} is intentionally deferred from this local deterministic baseline.`,
      revisitTrigger: `Revisit ${id} before any broader delivery claim.`,
      nonRuntimeBehaviorStatement: 'This does not implement runtime behavior.',
    },
  };
}

function buildG05Ledger(): ParentRoadmapLedger {
  const inventory = requiredRowIds();
  return {
    schemaVersion: PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
    ledgerId: 'UDM-no-false-done-G05-deferred-rows-negative-control',
    parentStoryId: 'UDM-no-false-done-baseline',
    originalIntentSnapshot: 'G05 deferral negative control: 12 rows have fresh closure evidence while 3 rows have valid human-approved deferrals that remain visible.',
    sourceRefs: [`${BASELINE_DOC}#g05`],
    requiredRowIds: inventory,
    rows: Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => (
      index < CLOSED_ROW_COUNT ? buildClosedRow(index) : buildDeferredRow(index)
    )),
    createdByStoryId: 'B-d278',
    updatedByStoryIds: ['B-d278'],
    proofstoryContract: {
      acceptanceBindings: [
        { id: 'udm-no-false-done-g05-deferred-rows-negative-control', milestoneIds: inventory },
      ],
    },
  };
}

function evaluate(ledger: ParentRoadmapLedger): ParentRollupResult {
  return evaluateParentRoadmapLedger(ledger, {
    evaluatedAt: EVALUATED_AT,
    currentHeadHash: CURRENT_HEAD_HASH,
    currentMaterialHash: CURRENT_MATERIAL_HASH,
    currentStoryFilesHash: CURRENT_STORY_FILES_HASH,
  });
}

function closedRowCount(rollup: ParentRollupResult): number {
  return rollup.rowResults.filter((row) => row.closed).length;
}

const ledger = buildG05Ledger();
const deferredIds = requiredRowIds().slice(CLOSED_ROW_COUNT);
assert.equal(ledger.requiredRowIds?.length, REQUIRED_ROW_COUNT, 'G05 required inventory has exactly 15 row ids');
assert.equal(ledger.rows.length, REQUIRED_ROW_COUNT, 'G05 generates exactly 15 ledger rows');

const rollup = evaluate(ledger);
assert.equal(rollup.rowResults.length, REQUIRED_ROW_COUNT, 'rollup reports exactly 15 required rows');
assert.equal(closedRowCount(rollup), CLOSED_ROW_COUNT, 'only 12 evidence-backed rows count as closed');
assert.deepEqual(rollup.deferredRows, deferredIds, 'G05 keeps exactly 3 deferred rows visible');
assert.deepEqual(rollup.staleEvidenceRows, [], 'G05 has zero stale rows');
assert.deepEqual(rollup.invalidRows, [], 'G05 has zero invalid rows');
assert.deepEqual(rollup.migrationRows, [], 'G05 has zero migration rows');
assert.equal(rollup.summaryClass, 'partial_parent_done');
assert.equal(rollup.claimType, 'no-full-roadmap-claim');
assert.notEqual(rollup.summaryClass, 'full_roadmap_complete');
assert.notEqual(rollup.claimType, 'full-roadmap-claim');
assert.equal(rollup.allRowsClosed, false);

for (const row of rollup.rowResults) {
  if (deferredIds.includes(row.rowId)) {
    assert.equal(row.closed, false, `${row.rowId} deferral does not close runtime work`);
    assert.equal(row.evidenceState, 'not-required', `${row.rowId} has no runtime evidence requirement while deferred`);
    assert.ok(row.reasonCodes.includes('human_approved_deferral'), `${row.rowId} reports human_approved_deferral`);
  } else {
    assert.equal(row.closed, true, `${row.rowId} is closed by evidence`);
    assert.equal(row.evidenceState, 'fresh', `${row.rowId} evidence is fresh`);
  }
}

const claim = evaluateParentRoadmapClaim({
  rollup,
  summaryText: 'Full roadmap complete.',
  mode: 'enforce',
});
assert.equal(claim.allowed, false, 'full completion wording is blocked when G05 deferrals remain');
assert.equal(claim.blocking, true, 'enforce mode blocks G05 deferral overclaim');

console.log('parent-roadmap large-ledger G05 baseline smoke PASS');

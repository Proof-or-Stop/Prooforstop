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

const GROUP_ID = 'G09';
const REQUIRED_ROW_COUNT = 15;
const EVALUATED_AT = '2026-07-01T00:00:00.000Z';
const BASELINE_DOC = 'docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md';
const LOCAL_CLAIM_BOUNDARY = 'Local G09 child-assignment proof only; assignment is not delivery evidence.';

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

assert.equal(milestoneMeanings.length, REQUIRED_ROW_COUNT, 'G09 milestone template must stay at exactly 15 rows');

function rowId(index: number): string {
  return `${GROUP_ID}-M${String(index + 1).padStart(2, '0')}`;
}

function requiredRowIds(): string[] {
  return Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => rowId(index));
}

function buildG09Row(index: number): ParentRoadmapRow {
  const id = rowId(index);
  return {
    rowId: id,
    title: `${id} ${milestoneMeanings[index]} active child assignment`,
    intentText: `${GROUP_ID} child-story-active negative control for ${milestoneMeanings[index]}.`,
    status: 'child-story-active',
    childStoryId: `B-d278-child-${String(index + 1).padStart(2, '0')}`,
    closureEvidence: [],
    materialRefs: [BASELINE_DOC],
    updatedAt: EVALUATED_AT,
    claimBoundary: LOCAL_CLAIM_BOUNDARY,
  };
}

function buildG09Ledger(): ParentRoadmapLedger {
  const inventory = requiredRowIds();
  return {
    schemaVersion: PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
    ledgerId: 'UDM-no-false-done-G09-child-assignment-negative-control',
    parentStoryId: 'UDM-no-false-done-baseline',
    originalIntentSnapshot: 'G09 child-assignment negative control: all 15 rows have childStoryId assignments, but assignment without closure evidence is not delivery.',
    sourceRefs: [`${BASELINE_DOC}#g09`],
    requiredRowIds: inventory,
    rows: Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => buildG09Row(index)),
    createdByStoryId: 'B-d278',
    updatedByStoryIds: ['B-d278'],
    proofstoryContract: {
      acceptanceBindings: [
        { id: 'udm-no-false-done-g09-child-assignment-negative-control', milestoneIds: inventory },
      ],
    },
  };
}

function closedRowCount(rollup: ParentRollupResult): number {
  return rollup.rowResults.filter((row) => row.closed).length;
}

const ledger = buildG09Ledger();
const inventory = requiredRowIds();
assert.equal(ledger.requiredRowIds?.length, REQUIRED_ROW_COUNT, 'G09 required inventory has exactly 15 row ids');
assert.equal(ledger.rows.length, REQUIRED_ROW_COUNT, 'G09 generates exactly 15 ledger rows');

const rollup = evaluateParentRoadmapLedger(ledger, { evaluatedAt: EVALUATED_AT });
assert.equal(rollup.rowResults.length, REQUIRED_ROW_COUNT, 'rollup reports exactly 15 required rows');
assert.equal(closedRowCount(rollup), 0, 'child-story-active assignment closes zero rows');
assert.deepEqual(rollup.openRows, inventory, 'G09 keeps all active child-story rows open');
assert.deepEqual(rollup.deferredRows, [], 'G09 has zero deferred rows');
assert.deepEqual(rollup.staleEvidenceRows, [], 'G09 has zero stale rows');
assert.deepEqual(rollup.invalidRows, [], 'G09 has zero invalid rows because childStoryId is present');
assert.deepEqual(rollup.migrationRows, [], 'G09 has zero migration rows');
assert.equal(rollup.summaryClass, 'partial_parent_done');
assert.equal(rollup.claimType, 'no-full-roadmap-claim');
assert.equal(rollup.allRowsClosed, false);

for (const row of rollup.rowResults) {
  assert.equal(row.closed, false, `${row.rowId} remains open`);
  assert.ok(row.reasonCodes.includes('child_story_active'), `${row.rowId} reports child_story_active`);
}

const claim = evaluateParentRoadmapClaim({
  rollup,
  summaryText: 'Full roadmap complete.',
  mode: 'enforce',
});
assert.equal(claim.allowed, false, 'full completion wording is blocked for G09 child assignments');
assert.equal(claim.blocking, true, 'enforce mode blocks G09 child assignment overclaim');

console.log('parent-roadmap large-ledger G09 baseline smoke PASS');

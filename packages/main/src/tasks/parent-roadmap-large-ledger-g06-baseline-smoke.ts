#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import {
  evaluateParentRoadmapClaim,
  evaluateParentRoadmapLedger,
  type ParentRoadmapLedger,
  type ParentRoadmapRow,
  type ParentRollupResult,
} from '../core/parent-roadmap-totality.js';

const GROUP_ID = 'G06';
const REQUIRED_ROW_COUNT = 15;
const EVALUATED_AT = '2026-07-01T00:00:00.000Z';
const BASELINE_DOC = 'docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md';
const LOCAL_CLAIM_BOUNDARY = 'Local G06 migration sample only; migration rows are not delivery evidence.';

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

assert.equal(milestoneMeanings.length, REQUIRED_ROW_COUNT, 'G06 milestone template must stay at exactly 15 rows');

function rowId(index: number): string {
  return `${GROUP_ID}-M${String(index + 1).padStart(2, '0')}`;
}

function requiredRowIds(): string[] {
  return Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => rowId(index));
}

function buildG06Row(index: number): ParentRoadmapRow {
  const id = rowId(index);
  return {
    rowId: id,
    title: `${id} ${milestoneMeanings[index]} migration sample`,
    intentText: `${GROUP_ID} migration-only sample for ${milestoneMeanings[index]}.`,
    status: 'child-story-needed',
    closureEvidence: [],
    materialRefs: [],
    updatedAt: EVALUATED_AT,
    claimBoundary: LOCAL_CLAIM_BOUNDARY,
  };
}

function buildG06Ledger(): ParentRoadmapLedger {
  const inventory = requiredRowIds();
  return {
    schemaVersion: 'legacy.parent_roadmap.candidate',
    ledgerId: 'UDM-no-false-done-G06-migration-sample-negative-control',
    parentStoryId: 'UDM-no-false-done-baseline',
    originalIntentSnapshot: 'G06 migration/sample negative control: all 15 rows are historical migration rows and cannot satisfy live completion.',
    sourceRefs: [`${BASELINE_DOC}#g06`],
    requiredRowIds: inventory,
    rows: Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => buildG06Row(index)),
    createdByStoryId: 'B-d278',
    updatedByStoryIds: ['B-d278'],
    proofstoryContract: {
      acceptanceBindings: [
        { id: 'udm-no-false-done-g06-migration-sample-negative-control', milestoneIds: inventory },
      ],
    },
    migration: { sourceStoryId: 'legacy-sample', reason: 'Synthetic migration/sample rows must remain non-completion evidence.' },
  };
}

function closedRowCount(rollup: ParentRollupResult): number {
  return rollup.rowResults.filter((row) => row.closed).length;
}

const ledger = buildG06Ledger();
const inventory = requiredRowIds();
assert.equal(ledger.requiredRowIds?.length, REQUIRED_ROW_COUNT, 'G06 required inventory has exactly 15 row ids');
assert.equal(ledger.rows.length, REQUIRED_ROW_COUNT, 'G06 generates exactly 15 ledger rows');

const rollup = evaluateParentRoadmapLedger(ledger, { evaluatedAt: EVALUATED_AT });
assert.equal(rollup.rowResults.length, REQUIRED_ROW_COUNT, 'rollup reports exactly 15 required rows');
assert.equal(closedRowCount(rollup), 0, 'migration sample closes zero rows');
assert.deepEqual(rollup.openRows, inventory, 'G06 keeps all migration rows open');
assert.deepEqual(rollup.migrationRows, inventory, 'G06 reports exactly 15 migration rows');
assert.deepEqual(rollup.deferredRows, [], 'G06 has zero deferred rows');
assert.deepEqual(rollup.staleEvidenceRows, [], 'G06 has zero stale rows');
assert.deepEqual(rollup.invalidRows, [], 'G06 has zero invalid rows');
assert.equal(rollup.summaryClass, 'migration_needed');
assert.equal(rollup.claimType, 'no-full-roadmap-claim');
assert.equal(rollup.allRowsClosed, false);

const claim = evaluateParentRoadmapClaim({
  rollup,
  summaryText: 'Full roadmap complete.',
  mode: 'enforce',
});
assert.equal(claim.allowed, false, 'full completion wording is blocked for G06 migration rows');
assert.equal(claim.blocking, true, 'enforce mode blocks G06 migration overclaim');

console.log('parent-roadmap large-ledger G06 baseline smoke PASS');

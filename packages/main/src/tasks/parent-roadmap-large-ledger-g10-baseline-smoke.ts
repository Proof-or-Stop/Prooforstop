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

const GROUP_ID = 'G10';
const REQUIRED_ROW_COUNT = 15;
const EVALUATED_AT = '2026-07-01T00:00:00.000Z';
const CURRENT_HEAD_HASH = 'g10-head-hash';
const CURRENT_MATERIAL_HASH = 'g10-material-hash';
const CURRENT_STORY_FILES_HASH = 'g10-story-files-hash';
const STALE_HEAD_HASH = 'g10-stale-head-hash';
const STALE_MATERIAL_HASH = 'g10-stale-material-hash';
const STALE_STORY_FILES_HASH = 'g10-stale-story-files-hash';
const SMOKE_COMMAND = 'node packages/main/dist/tasks/parent-roadmap-large-ledger-g10-baseline-smoke.js';
const BASELINE_DOC = 'docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md';
const LOCAL_CLAIM_BOUNDARY = 'Local G10 refresh-recovery proof only; completion is allowed only after fresh evidence binding.';

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

assert.equal(milestoneMeanings.length, REQUIRED_ROW_COUNT, 'G10 milestone template must stay at exactly 15 rows');

function rowId(index: number): string {
  return `${GROUP_ID}-M${String(index + 1).padStart(2, '0')}`;
}

function requiredRowIds(): string[] {
  return Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => rowId(index));
}

function buildG10Row(index: number, fresh: boolean): ParentRoadmapRow {
  const id = rowId(index);
  const headHash = fresh ? CURRENT_HEAD_HASH : STALE_HEAD_HASH;
  const materialHash = fresh ? CURRENT_MATERIAL_HASH : STALE_MATERIAL_HASH;
  const storyFilesHash = fresh ? CURRENT_STORY_FILES_HASH : STALE_STORY_FILES_HASH;
  return {
    rowId: id,
    title: `${id} ${milestoneMeanings[index]} ${fresh ? 'fresh' : 'stale'} evidence`,
    intentText: `${GROUP_ID} stale-then-refreshed recovery baseline for ${milestoneMeanings[index]}.`,
    status: 'closed-by-existing-evidence',
    childStoryId: 'B-d278',
    closureEvidence: [
      {
        kind: 'deterministic_smoke',
        ref: `B-d278:${id}:parent-roadmap-large-ledger-g10-baseline-smoke:${fresh ? 'fresh' : 'stale'}`,
        result: 'pass',
        command: SMOKE_COMMAND,
        artifactRef: `${BASELINE_DOC}#g10`,
        headHash,
        materialHash,
        storyFilesHash,
        observedAt: EVALUATED_AT,
      },
    ],
    materialRefs: [
      BASELINE_DOC,
      'packages/main/src/tasks/parent-roadmap-large-ledger-g10-baseline-smoke.ts',
      'packages/main/src/core/parent-roadmap-totality.ts',
    ],
    updatedAt: EVALUATED_AT,
    headHash,
    materialHash,
    storyFilesHash,
    claimBoundary: LOCAL_CLAIM_BOUNDARY,
  };
}

function buildG10Ledger(fresh: boolean): ParentRoadmapLedger {
  const inventory = requiredRowIds();
  return {
    schemaVersion: PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
    ledgerId: `UDM-no-false-done-G10-${fresh ? 'fresh-refreshed' : 'stale-before-refresh'}-control`,
    parentStoryId: 'UDM-no-false-done-baseline',
    originalIntentSnapshot: 'G10 recovery control: 15 stale rows block completion before refresh, then the same 15 rows permit completion only after fresh binding.',
    sourceRefs: [`${BASELINE_DOC}#g10`],
    requiredRowIds: inventory,
    rows: Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => buildG10Row(index, fresh)),
    createdByStoryId: 'B-d278',
    updatedByStoryIds: ['B-d278'],
    proofstoryContract: {
      acceptanceBindings: [
        { id: 'udm-no-false-done-g10-stale-then-refreshed-recovery-control', milestoneIds: inventory },
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

const staleLedger = buildG10Ledger(false);
const freshLedger = buildG10Ledger(true);
const inventory = requiredRowIds();
assert.equal(staleLedger.requiredRowIds?.length, REQUIRED_ROW_COUNT, 'G10 stale required inventory has exactly 15 row ids');
assert.equal(freshLedger.requiredRowIds?.length, REQUIRED_ROW_COUNT, 'G10 fresh required inventory has exactly 15 row ids');
assert.equal(staleLedger.rows.length, REQUIRED_ROW_COUNT, 'G10 stale state generates exactly 15 ledger rows');
assert.equal(freshLedger.rows.length, REQUIRED_ROW_COUNT, 'G10 fresh state generates exactly 15 ledger rows');

const staleRollup = evaluate(staleLedger);
assert.equal(staleRollup.rowResults.length, REQUIRED_ROW_COUNT, 'stale rollup reports exactly 15 required rows');
assert.equal(closedRowCount(staleRollup), 0, 'before refresh, stale evidence closes zero rows');
assert.deepEqual(staleRollup.staleEvidenceRows, inventory, 'before refresh, all 15 rows are stale');
assert.equal(staleRollup.summaryClass, 'stale_parent_rollup');
assert.equal(staleRollup.claimType, 'no-full-roadmap-claim');
assert.equal(staleRollup.allRowsClosed, false);
const staleClaim = evaluateParentRoadmapClaim({
  rollup: staleRollup,
  summaryText: 'Full roadmap complete.',
  mode: 'enforce',
});
assert.equal(staleClaim.allowed, false, 'full completion wording is blocked before G10 refresh');

const freshRollup = evaluate(freshLedger);
assert.equal(freshRollup.rowResults.length, REQUIRED_ROW_COUNT, 'fresh rollup reports exactly 15 required rows');
assert.equal(closedRowCount(freshRollup), REQUIRED_ROW_COUNT, 'after refresh, all 15 rows close');
assert.deepEqual(freshRollup.staleEvidenceRows, [], 'after refresh, no rows are stale');
assert.deepEqual(freshRollup.openRows, [], 'after refresh, no rows remain open');
assert.equal(freshRollup.summaryClass, 'full_roadmap_complete');
assert.equal(freshRollup.claimType, 'full-roadmap-claim');
assert.equal(freshRollup.allRowsClosed, true);
const freshClaim = evaluateParentRoadmapClaim({
  rollup: freshRollup,
  summaryText: 'Full roadmap complete.',
  mode: 'enforce',
});
assert.equal(freshClaim.allowed, true, 'full completion wording is allowed only after G10 refresh');

console.log('parent-roadmap large-ledger G10 baseline smoke PASS');

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

const GROUP_ID = 'G08';
const REQUIRED_ROW_COUNT = 15;
const EVALUATED_AT = '2026-07-01T00:00:00.000Z';
const CURRENT_HEAD_HASH = 'g08-head-hash';
const CURRENT_MATERIAL_HASH = 'g08-material-hash';
const CURRENT_STORY_FILES_HASH = 'g08-story-files-hash';
const SMOKE_COMMAND = 'node packages/main/dist/tasks/parent-roadmap-large-ledger-g08-baseline-smoke.js';
const BASELINE_DOC = 'docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md';
const LOCAL_CLAIM_BOUNDARY = 'Local G08 malformed-row proof only; invalid generated entries cannot satisfy required rows.';

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

assert.equal(milestoneMeanings.length, REQUIRED_ROW_COUNT, 'G08 milestone template must stay at exactly 15 rows');

function rowId(index: number): string {
  return `${GROUP_ID}-M${String(index + 1).padStart(2, '0')}`;
}

function requiredRowIds(): string[] {
  return Array.from({ length: REQUIRED_ROW_COUNT }, (_, index) => rowId(index));
}

function buildValidRow(index: number): ParentRoadmapRow {
  const id = rowId(index);
  return {
    rowId: id,
    title: `${id} ${milestoneMeanings[index]} valid generated row`,
    intentText: `${GROUP_ID} malformed-row baseline valid row for ${milestoneMeanings[index]}.`,
    status: 'closed-by-existing-evidence',
    childStoryId: 'B-d278',
    closureEvidence: [
      {
        kind: 'deterministic_smoke',
        ref: `B-d278:${id}:parent-roadmap-large-ledger-g08-baseline-smoke`,
        result: 'pass',
        command: SMOKE_COMMAND,
        artifactRef: `${BASELINE_DOC}#g08`,
        headHash: CURRENT_HEAD_HASH,
        materialHash: CURRENT_MATERIAL_HASH,
        storyFilesHash: CURRENT_STORY_FILES_HASH,
        observedAt: EVALUATED_AT,
      },
    ],
    materialRefs: [
      BASELINE_DOC,
      'packages/main/src/tasks/parent-roadmap-large-ledger-g08-baseline-smoke.ts',
      'packages/main/src/core/parent-roadmap-totality.ts',
    ],
    updatedAt: EVALUATED_AT,
    headHash: CURRENT_HEAD_HASH,
    materialHash: CURRENT_MATERIAL_HASH,
    storyFilesHash: CURRENT_STORY_FILES_HASH,
    claimBoundary: LOCAL_CLAIM_BOUNDARY,
  };
}

function buildG08Ledger(): ParentRoadmapLedger {
  const inventory = requiredRowIds();
  const rows: unknown[] = [
    ...Array.from({ length: REQUIRED_ROW_COUNT - 1 }, (_, index) => buildValidRow(index)),
    {
      rowId: rowId(REQUIRED_ROW_COUNT - 1),
      title: '',
      intentText: `${GROUP_ID} malformed row keeps the required id present but invalid.`,
      status: 'closed-by-existing-evidence',
      closureEvidence: [],
      materialRefs: [BASELINE_DOC],
    },
  ];
  return {
    schemaVersion: PARENT_ROADMAP_LEDGER_SCHEMA_VERSION,
    ledgerId: 'UDM-no-false-done-G08-malformed-row-negative-control',
    parentStoryId: 'UDM-no-false-done-baseline',
    originalIntentSnapshot: 'G08 malformed-row negative control: 15 generated entries cannot falsely satisfy all required rows when one entry is invalid.',
    sourceRefs: [`${BASELINE_DOC}#g08`],
    requiredRowIds: inventory,
    rows: rows as ParentRoadmapRow[],
    createdByStoryId: 'B-d278',
    updatedByStoryIds: ['B-d278'],
    proofstoryContract: {
      acceptanceBindings: [
        { id: 'udm-no-false-done-g08-malformed-row-negative-control', milestoneIds: inventory },
      ],
    },
  };
}

function buildDuplicateGuardLedger(): ParentRoadmapLedger {
  const ledger = buildG08Ledger();
  const rows = [
    ...Array.from({ length: REQUIRED_ROW_COUNT - 1 }, (_, index) => buildValidRow(index)),
    buildValidRow(REQUIRED_ROW_COUNT - 2),
  ];
  return { ...ledger, ledgerId: 'UDM-no-false-done-G08-duplicate-row-guard', rows };
}

function closedRowCount(rollup: ParentRollupResult): number {
  return rollup.rowResults.filter((row) => row.closed).length;
}

const ledger = buildG08Ledger();
assert.equal(ledger.requiredRowIds?.length, REQUIRED_ROW_COUNT, 'G08 required inventory has exactly 15 row ids');
assert.equal(ledger.rows.length, REQUIRED_ROW_COUNT, 'G08 generates exactly 15 ledger entries');

const rollup = evaluateParentRoadmapLedger(ledger, {
  evaluatedAt: EVALUATED_AT,
  currentHeadHash: CURRENT_HEAD_HASH,
  currentMaterialHash: CURRENT_MATERIAL_HASH,
  currentStoryFilesHash: CURRENT_STORY_FILES_HASH,
});
assert.equal(rollup.rowResults.length, REQUIRED_ROW_COUNT, 'malformed G08 rollup still evaluates the 15-row required matrix');
assert.equal(closedRowCount(rollup), REQUIRED_ROW_COUNT - 1, 'malformed row does not count as closed');
assert.deepEqual(rollup.invalidRows, [rowId(REQUIRED_ROW_COUNT - 1)], 'G08 reports the malformed required row as invalid');
assert.equal(rollup.summaryClass, 'invalid_parent_rollup');
assert.equal(rollup.claimType, 'no-full-roadmap-claim');
assert.equal(rollup.allRowsClosed, false);
assert.ok(rollup.rowResults.some((row) => row.rowId === rowId(REQUIRED_ROW_COUNT - 1) && row.reasonCodes.includes('invalid_row')));

const duplicateLedger = buildDuplicateGuardLedger();
assert.equal(duplicateLedger.rows.length, REQUIRED_ROW_COUNT, 'duplicate guard still has 15 generated entries');
const duplicateRollup = evaluateParentRoadmapLedger(duplicateLedger, {
  evaluatedAt: EVALUATED_AT,
  currentHeadHash: CURRENT_HEAD_HASH,
  currentMaterialHash: CURRENT_MATERIAL_HASH,
  currentStoryFilesHash: CURRENT_STORY_FILES_HASH,
});
assert.ok(duplicateRollup.invalidRows.includes(rowId(REQUIRED_ROW_COUNT - 1)), 'duplicate generated entry cannot cover the missing required row');
assert.equal(duplicateRollup.claimType, 'no-full-roadmap-claim', 'duplicate generated entry cannot produce full-roadmap claim');

const claim = evaluateParentRoadmapClaim({
  rollup,
  summaryText: 'Full roadmap complete.',
  mode: 'enforce',
});
assert.equal(claim.allowed, false, 'full completion wording is blocked for G08 invalid rows');
assert.equal(claim.blocking, true, 'enforce mode blocks G08 invalid rows');

console.log('parent-roadmap large-ledger G08 baseline smoke PASS');
